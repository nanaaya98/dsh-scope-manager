// 三层作用域的存储：一份 layers.json，三段分开存。
//
// 结构（**每层只存自己的差异，不存基线**）：
//   {
//     version: 1,
//     global:     Layer,                    // 全局层
//     workspaces: { [wsKey]: Layer },       // 工作区层，键 = 'ws:' + realpath(cwd)
//     sessions:   { [sKey]: Layer },        // 会话层，键 = 's:' + sessionId
//     toolOwners: { [toolName]: { category, owner } },  // 工具归属的手工修正（跨层共用）
//     groupNotes: { ['<类别>::<归属者>']: string }       // 归属者那一行的备注（跨层共用）
//     mcpTools:  { [toolName]: { disabled?: boolean } }, // MCP 工具的逐个开关（跨层共用）
//     mcpNames:  { [serverName]: string },               // MCP 连接器的显示名（跨层共用）
//     sectionOwners: { [sectionName]: ownerPackage },    // 段落的「归属插件」（跨层共用；宿主不给归属，靠人点）
//   }
//
// 为什么 mcpTools 不进层里的 toolFilter：toolFilter 是**整块取第一个**的
// （resolve.js:138 pickDomain 从「会话→工作区→全局」里挑第一个非空），
// 往全局层写 deny 名单会被会话层整块盖掉。MCP 页要的是「这台服务器的这个工具关掉」
// 这种精确到工具名的开关，所以单独放一个跨层共用的键，assemble 与 guard 都直接查它。
//
// Layer 的字段（全部可选；缺省 = 这一层不管这个域）：
//   {
//     scene:      string | null,     // 选中的场景预设 id
//     persona:    string | null,     // 选中的角色卡 id
//     tools:      { [toolName]: { alias?, description?, inject? } },
//     toolFilter: { mode: 'allow'|'deny', names: string[] },
//     skills:     { mode: 'allow'|'deny', names: string[] },
//     note:       string
//   }
//
// 每层只写自己改过的那几格，体积是线性的。
// 不用「给每个会话冻一份创建时的全量基线」那套叠加：
// （七域 + 场景 + 工具表名单）几十个会话 × 上百个 MCP 工具键相乘，侧车会直接涨到 104KB。
import { readFile, rename } from 'node:fs/promises';

import { hubPath } from './paths.js';
import { writeAtomic } from './atomic.js';

const LAYERS_FILE = 'layers.json';

function emptyStore() {
    return {
        version: 1, global: {}, workspaces: {}, sessions: {}, toolOwners: {}, groupNotes: {},
        mcpTools: {}, mcpNames: {}, sectionOwners: {},
    };
}

/** 读到的盘上内容不一定是本插件写的形状 —— 每一段都单独兜底。 */
function normalize(raw) {
    const out = emptyStore();
    if (!raw || typeof raw !== 'object') {
        return out;
    }
    out.version = 1;
    if (raw.global && typeof raw.global === 'object') {
        out.global = raw.global;
    }
    if (raw.workspaces && typeof raw.workspaces === 'object') {
        out.workspaces = raw.workspaces;
    }
    if (raw.sessions && typeof raw.sessions === 'object') {
        out.sessions = raw.sessions;
    }
    if (raw.toolOwners && typeof raw.toolOwners === 'object') {
        out.toolOwners = raw.toolOwners;
    }
    if (raw.groupNotes && typeof raw.groupNotes === 'object') {
        out.groupNotes = raw.groupNotes;
    }
    if (raw.mcpTools && typeof raw.mcpTools === 'object') {
        out.mcpTools = raw.mcpTools;
    }
    if (raw.mcpNames && typeof raw.mcpNames === 'object') {
        out.mcpNames = raw.mcpNames;
    }
    if (raw.sectionOwners && typeof raw.sectionOwners === 'object') {
        out.sectionOwners = raw.sectionOwners;
    }
    return out;
}

/** 原子写：同目录临时文件 → rename。rename 跨卷会 EXDEV，同目录不会。 */

/**
 * 存储句柄。
 *
 * `peek()` 给同步路径用（工具执行守卫跑在热路径上，不能等 IO）；
 * `mutate()` 是唯一的写入口：**锁内重读一次**再改再落盘 —— 外部编辑器可能在这几毫秒里
 * 把文件写坏，锁外读的那份会把它覆盖掉。
 */
export function createStore() {
    const file = hubPath(LAYERS_FILE);
    let snapshot = null;
    let queue = Promise.resolve();

    async function readFromDisk() {
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch {
            return emptyStore();
        }
        try {
            return normalize(JSON.parse(text));
        }
        catch {
            // 盘上的东西坏了：宁可从空开始，也不要拿半份状态去覆盖用户的数据。
            // 这里不静默 —— 调用方（http-api）会把「存储损坏」如实报给界面。
            return emptyStore();
        }
    }

    async function load() {
        if (snapshot) {
            return snapshot;
        }
        snapshot = await readFromDisk();
        return snapshot;
    }

    /** 同步读当前内存快照（未加载时返回空壳，不触发 IO）。 */
    function peek() {
        return snapshot ?? emptyStore();
    }

    /**
     * 串行化的写。`fn` 收到**刚从盘上读到的**数据，返回值就是要落盘的新数据；
     * 返回 undefined 表示「不改」。
     */
    function mutate(fn) {
        const run = queue.then(async () => {
            const current = await readFromDisk();
            const next = await fn(current);
            const data = next ?? current;
            await writeAtomic(file, JSON.stringify(data, null, 2));
            snapshot = data;
            return data;
        });
        // 队列本身不能被一次失败打断：写失败要报给这一次调用者，但后面的写还得能排队。
        queue = run.then(() => { }, () => { });
        return run;
    }

    /** 只在内存里换快照（用于「盘上读失败但外部已经推了一份过来」这类场景）。 */
    function adopt(data) {
        snapshot = normalize(data);
        return snapshot;
    }

    return { load, peek, mutate, adopt };
}

/**
 * 这个 MCP 工具被关掉了吗。
 *
 * @param {object} data 存储快照
 * @param {string} name 工具全名
 * @returns {boolean} 关掉了就是 true
 */
export function isMcpToolDisabled(data, name) {
    const entry = data?.mcpTools?.[String(name ?? '')];
    return entry?.disabled === true;
}

/**
 * 所有被关掉的 MCP 工具名。
 *
 * 只装「关掉的」那些（启用时就把键删了），所以这个集合很小，
 * 守卫那种热路径上重算也不心疼。
 *
 * @param {object} data 存储快照
 * @returns {Set<string>} 被关掉的工具名
 */
export function mcpDisabledTools(data) {
    const out = new Set();
    const map = data?.mcpTools;
    if (!map || typeof map !== 'object') {
        return out;
    }
    for (const [name, entry] of Object.entries(map)) {
        if (entry?.disabled === true) {
            out.add(name);
        }
    }
    return out;
}

/**
 * MCP 连接器的显示名。
 *
 * 名字是给人看的（「金山文档」），serverName 是给机器看的（工具前缀 mcp__<它>__）。
 * 两层补丁的行结构里没有「显示名」这个位置 —— 宿主那条 loader entry 的 config
 * 是有 schema 的，塞不认识的键进去有风险 —— 所以名字单独存在这一份跨层共用的表里。
 *
 * @param {object} data 存储快照
 * @param {string} serverName 服务器名
 * @returns {string} 没起过名字就是空串
 */
export function mcpNameOf(data, serverName) {
    return String(data?.mcpNames?.[String(serverName ?? '')] ?? '');
}

/** 作用域键：全局 = ''，工作区 = 'ws:' + 路径，会话 = 's:' + 会话 id。 */
export const GLOBAL_KEY = '';
const WORKSPACE_PREFIX = 'ws:';
const SESSION_PREFIX = 's:';

export function workspaceKey(cwd) {
    return `${WORKSPACE_PREFIX}${cwd}`;
}

export function sessionKey(sessionId) {
    return `${SESSION_PREFIX}${sessionId}`;
}

function isWorkspaceKey(key) {
    return typeof key === 'string' && key.startsWith(WORKSPACE_PREFIX);
}

function isSessionKey(key) {
    return typeof key === 'string' && key.startsWith(SESSION_PREFIX);
}

/** 取某一层的对象（不存在时给一个空壳，写回去时会因为没有键而被忽略）。 */
export function layerOf(data, key) {
    if (key === GLOBAL_KEY) {
        return data.global ?? {};
    }
    if (isWorkspaceKey(key)) {
        return data.workspaces?.[key] ?? {};
    }
    if (isSessionKey(key)) {
        return data.sessions?.[key] ?? {};
    }
    return {};
}

/** 写某一层（整层替换，不做深合并 —— 界面一次提交的就是该层的完整内容）。 */
export function setLayer(data, key, layer) {
    const next = layer && typeof layer === 'object' ? layer : {};
    if (key === GLOBAL_KEY) {
        data.global = next;
    }
    else if (isWorkspaceKey(key)) {
        data.workspaces = data.workspaces ?? {};
        data.workspaces[key] = next;
    }
    else if (isSessionKey(key)) {
        data.sessions = data.sessions ?? {};
        data.sessions[key] = next;
    }
    return data;
}

/** 删掉一层（会话结束 / 工作区不再使用时清账，避免侧车无限长）。 */
export function dropLayer(data, key) {
    if (isWorkspaceKey(key)) {
        if (data.workspaces) {
            delete data.workspaces[key];
        }
    }
    else if (isSessionKey(key)) {
        if (data.sessions) {
            delete data.sessions[key];
        }
    }
    return data;
}
