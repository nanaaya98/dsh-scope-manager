// MCP 连接器管理：宿主那一半。
//
// **真源是补丁文件，不是插件内存。**
// 一个 MCP 服务器 = 一条 loader 行（`name: '@deepseek-ai/dsh-mcp-client'`），
// 写在 cordis.patch.yml 里。宿主有两层补丁：
//
//   · 全局层：$DSH_HOME/cordis.patch.yml（DSH_HOME 缺省 ~/.dsh）
//   · profile 层：<profile>/cordis.patch.yml
//
// 加载顺序（dsh-app-boot/lib/index.js:1127-1137 readProfilePatches）：
//   bundle 补丁 → profile 补丁 → **全局补丁** → 命令行 overlay
// 所以同一个 id **全局层说了算**：profile 层写了同名行会被盖掉（界面标「被全局覆盖」）。
//
// 两条补丁方言（cordis-plugin-include/src/index.ts:57-105 applyEntryPatches）：
//   · `- id: xxx` 是**按 id 覆盖既有行**，不是新增；
//   · 新增行必须放进 `- insert:` 块里。
//   本模块新增服务器时一律写进 insert 块。
//
// 写盘方式与宿主自己的 dsh-config-editor 一致（lib/index.js:91-124）：
//   yaml 的 parseDocument + customTags（保住 !!js 标签）+ visit（把 __jsExpr 还原成标签）
//   + 原子写。宿主靠 dsh-hmr 盯着这两个补丁文件，改完自动热重载
//   （dsh-hmr/lib/index.js:850-872 watch profile.patchPath 与 home 的补丁），
//   所以这里**不需要**另外叫宿主重启。
//
// 判活靠两处事实：
//   · loader 里有没有这条 entry（挂上了没有、是不是被 disabled 表达式挡住）；
//   · 工具注册表里有没有 `mcp__<server>__<tool>`（真的连上了没有）。
// 只有第一处 = 挂了但没工具（多半连不上）；两处都没有 = 补丁写了宿主没认。
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Scalar, isMap, isSeq, parseDocument, visit } from 'yaml';

/** MCP 客户端插件名：一条 loader 行的 name。 */
export const MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client';
/** 服务器名：宿主要求 `[A-Za-z0-9_-]{1,32}` 且唯一。 */
const SERVER_NAME_RE = /^[\w-]{1,32}$/;
/** 传输方式。 */
const TRANSPORTS = Object.freeze(['stdio', 'streamable-http']);
/** 两层补丁文件同名。 */
export const PATCH_FILE_NAME = 'cordis.patch.yml';
/** 连通性探测超时。 */
const CHECK_TIMEOUT_MS = 5000;
/** 宿主补丁里 `!!js` 表达式的标签。 */
const JS_TAG = 'tag:yaml.org,2002:js';

/** 状态机（界面徽章用）。 */
export const STATUS = Object.freeze({
    CONNECTED: 'connected',
    NO_TOOLS: 'no-tools',
    DISABLED: 'disabled',
    INACTIVE: 'inactive',
    UNKNOWN: 'unknown',
    /** 宿主正在把这台挂起来（fiber 还没 ACTIVE）—— 等一会儿就好，别当成坏了。 */
    STARTING: 'starting',
    /** 宿主挂它的时候出错了（fiber FAILED）。 */
    FAILED: 'failed',
    /** 宿主没挂上这行（多半被另一层补丁盖住了）。 */
    NOT_MOUNTED: 'not-mounted',
});

/**
 * 解析补丁文本。
 *
 * `customTags` 里的 js 标签是关键：宿主补丁允许 `disabled: !!js "..."` 这种表达式，
 * 不给 yaml 认识它就会整份文件解析失败 —— 那等于「一行都不能碰」。
 *
 * @param {string} text 补丁文件内容
 * @returns {import('yaml').Document} 解析好的文档
 */
export function parsePatch(text) {
    const doc = parseDocument(text, { customTags: [{ tag: JS_TAG, resolve: (value) => value }] });
    if (doc.errors[0]) {
        throw new Error(`补丁 YAML 解析失败：${doc.errors[0].message}`);
    }
    if (doc.contents !== null && doc.contents !== undefined && !isSeq(doc.contents)) {
        throw new Error('补丁文件必须是顶层数组');
    }
    if (isSeq(doc.contents)) {
        doc.contents.flow = false;
    }
    return doc;
}

/**
 * 把 `__jsExpr` 还原成 `!!js` 标签再输出。
 *
 * 宿主的 include 插件用 js-yaml 读补丁，`!!js` 在它那边解析成 `{__jsExpr: '...'}`；
 * 用 yaml 库写回去时必须把那个形状重新打上标签，否则表达式会变成普通字符串，
 * `disabled` 就从一个 JS 表达式退化成「恒真/恒假」。
 *
 * @param {import('yaml').Document} doc
 */
function restoreJsTags(doc) {
    visit(doc, {
        Map(_key, node) {
            if (node.items.length !== 1 || typeof node.get('__jsExpr') !== 'string') {
                return undefined;
            }
            const expression = new Scalar(node.get('__jsExpr'));
            expression.tag = JS_TAG;
            return expression;
        },
    });
}

/**
 * 把文档序列化成补丁文本。
 *
 * 出口之前先还原 `!!js` 标签 —— 这是「改了补丁不改变宿主语义」的关键。
 *
 * @param {import('yaml').Document} doc
 * @returns {string} 补丁文本
 */
export function serializePatch(doc) {
    restoreJsTags(doc);
    return String(doc);
}

/**
 * 读一层补丁。
 *
 * @param {string} path 补丁文件路径
 * @returns {Promise<{path: string, exists: boolean, text: string, doc: import('yaml').Document|null}>}
 */
export async function readPatch(path) {
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    }
    catch (e) {
        if (e?.code !== 'ENOENT') {
            throw e;
        }
        return { path, exists: false, text: '', doc: null };
    }
    return { path, exists: true, text, doc: parsePatch(text) };
}

/** 顶层序列（空补丁也给它一个空序列，后面好写）。 */
function rootSeq(doc) {
    if (!isSeq(doc.contents)) {
        doc.contents = doc.createNode([]);
    }
    return doc.contents;
}

/**
 * 收集补丁里所有 MCP 行。
 *
 * 裸行（`- id: mcp-x`）和 insert 块里的行都要收 —— 用户手写的补丁两种都可能有。
 *
 * @param {import('yaml').Document} doc
 * @returns {Array<{id: string, name: string, node: object, list: object|null}>}
 */
function collectRows(doc) {
    const rows = [];
    const seq = rootSeq(doc);
    for (const item of seq.items ?? []) {
        if (!isMap(item)) {
            continue;
        }
        const insert = item.get('insert');
        if (isSeq(insert)) {
            for (const row of insert.items ?? []) {
                if (isMap(row)) {
                    rows.push({ id: String(row.get('id') ?? ''), name: String(row.get('name') ?? ''), node: row, list: insert });
                }
            }
            continue;
        }
        rows.push({ id: String(item.get('id') ?? ''), name: String(item.get('name') ?? ''), node: item, list: null });
    }
    return rows;
}

/** 只留 MCP 行。 */
export function collectMcpRows(doc) {
    return collectRows(doc).filter((row) => row.name === MCP_PLUGIN || row.id.startsWith('mcp-'));
}

/**
 * 一条 MCP 行 → 归一化视图。
 *
 * @param {{id: string, name: string, node: object}} row
 * @returns {object} 视图
 */
export function rowToServer(row) {
    const node = row.node;
    const config = node.get('config');
    const cfg = isMap(config) ? config : null;
    const read = (key) => {
        const value = cfg?.get(key);
        return value === undefined || value === null ? undefined : value;
    };
    const headers = read('headers');
    const env = read('env');
    return {
        id: row.id,
        name: row.name,
        serverName: String(read('serverName') ?? ''),
        transport: String(read('transport') ?? 'stdio'),
        disabled: node.get('disabled') === true,
        url: read('url') === undefined ? '' : String(read('url')),
        command: read('command') === undefined ? '' : String(read('command')),
        args: Array.isArray(read('args')) ? read('args').map((v) => String(v)) : [],
        env: mapToObject(env),
        cwd: read('cwd') === undefined ? '' : String(read('cwd')),
        headers: mapToObject(headers),
        toolCallTimeoutMs: read('toolCallTimeoutMs') === undefined ? null : Number(read('toolCallTimeoutMs')),
        maxInstructionBytes: read('maxInstructionBytes') === undefined ? null : Number(read('maxInstructionBytes')),
    };
}

/**
 * YAML 映射 → 普通对象。
 *
 * yaml 的 `items` 里放的是 Pair 节点（`pair.key` / `pair.value`），不是数组，
 * 直接解构会炸；值再套一层（多行 plain scalar、嵌套 map）也得摊平成字符串。
 *
 * @param {unknown} node yaml 节点
 * @returns {Record<string, string>} 普通对象
 */
function mapToObject(node) {
    if (!isMap(node)) {
        return {};
    }
    const out = {};
    for (const pair of node.items ?? []) {
        const key = String(pair?.key?.value ?? pair?.key ?? '');
        out[key] = scalarToString(pair?.value);
    }
    return out;
}

/** yaml 标量 → 字符串（复合节点退回 JSON 文本）。 */
function scalarToString(node) {
    if (node === undefined || node === null) {
        return '';
    }
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
        return String(node);
    }
    if (node instanceof Scalar) {
        const value = node.value;
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'object') {
            return JSON.stringify(value);
        }
        return String(value);
    }
    return String(node);
}

/**
 * 校验一份输入（新增/编辑都用它）。
 *
 * @param {object} input 输入
 * @returns {string|null} 错误说明；null = 通过
 */
export function validateServerInput(input) {
    const serverName = String(input?.serverName ?? '').trim();
    if (!serverName) {
        return '服务器名不能为空';
    }
    if (!SERVER_NAME_RE.test(serverName)) {
        return '服务器名只能用字母、数字、下划线和短横线（最长 32 个字符）';
    }
    const transport = String(input?.transport ?? 'stdio');
    if (!TRANSPORTS.includes(transport)) {
        return `传输方式只能是 ${TRANSPORTS.join(' / ')}`;
    }
    if (transport === 'streamable-http') {
        const url = String(input?.url ?? '').trim();
        if (!url) {
            return 'HTTP 传输必须填 URL';
        }
        if (!/^https?:\/\//.test(url)) {
            return 'URL 必须以 http:// 或 https:// 开头';
        }
    }
    else {
        if (!String(input?.command ?? '').trim()) {
            return 'stdio 传输必须填命令';
        }
    }
    return null;
}

/**
 * 输入 → 一行补丁（纯对象，交给 yaml 建节点）。
 *
 * 只写传输方式用得上的字段：stdio 不写 url/headers，http 不写 command/args/env/cwd。
 * 宿主那边多余的字段会被忽略，但留着会让补丁越改越花。
 */
export function inputToRow(input) {
    const transport = String(input?.transport ?? 'stdio');
    const config = {
        serverName: String(input?.serverName ?? '').trim(),
        transport,
    };
    if (transport === 'streamable-http') {
        config.url = String(input?.url ?? '').trim();
        const headers = input?.headers && typeof input.headers === 'object' ? input.headers : {};
        const clean = {};
        for (const [key, value] of Object.entries(headers)) {
            const k = String(key ?? '').trim();
            if (k !== '') {
                clean[k] = String(value ?? '');
            }
        }
        if (Object.keys(clean).length > 0) {
            config.headers = clean;
        }
    }
    else {
        config.command = String(input?.command ?? '').trim();
        const args = Array.isArray(input?.args) ? input.args.map((v) => String(v)).filter((v) => v !== '') : [];
        if (args.length > 0) {
            config.args = args;
        }
        const env = input?.env && typeof input.env === 'object' ? input.env : {};
        const clean = {};
        for (const [key, value] of Object.entries(env)) {
            const k = String(key ?? '').trim();
            if (k !== '') {
                clean[k] = String(value ?? '');
            }
        }
        if (Object.keys(clean).length > 0) {
            config.env = clean;
        }
        const cwd = String(input?.cwd ?? '').trim();
        if (cwd !== '') {
            config.cwd = cwd;
        }
    }
    const timeout = Number(input?.toolCallTimeoutMs);
    if (Number.isFinite(timeout) && timeout > 0) {
        config.toolCallTimeoutMs = Math.round(timeout);
    }
    const row = {
        id: String(input?.id ?? '').trim(),
        name: MCP_PLUGIN,
        config,
    };
    if (input?.disabled === true) {
        row.disabled = true;
    }
    return row;
}

/**
 * 找到（或新建）insert 块。
 *
 * 新增行必须进 insert 块 —— 裸 `- id:` 是「覆盖既有行」，不是新增。
 */
function managedInsert(doc) {
    const seq = rootSeq(doc);
    for (const item of seq.items ?? []) {
        if (isMap(item) && isSeq(item.get('insert'))) {
            return item.get('insert');
        }
    }
    const block = doc.createNode({ insert: [] });
    seq.add(block);
    const created = seq.items[seq.items.length - 1];
    return created.get('insert');
}

/**
 * 新增或更新一条 MCP 行。
 *
 * 更新时**只覆盖自己管的字段**：宿主那边可能还配了 reconnect 之类的东西，
 * 整块替换会把用户手写的附带配置抹掉。
 *
 * @param {import('yaml').Document} doc
 * @param {object} input 输入（带 id = 更新，不带 = 新增）
 * @returns {{id: string, created: boolean}}
 */
export function upsertServer(doc, input) {
    const id = String(input?.id ?? '').trim();
    const rows = collectMcpRows(doc);
    const existing = id ? rows.find((row) => row.id === id) : undefined;
    const serverName = String(input?.serverName ?? '').trim();
    const base = `mcp-${serverName}`;
    let targetId = id;
    let created = false;
    if (!existing) {
        const taken = new Set(rows.map((row) => row.id));
        targetId = base;
        let suffix = 2;
        while (taken.has(targetId)) {
            targetId = `${base}-${suffix}`;
            suffix += 1;
        }
        created = true;
    }
    const row = inputToRow({ ...input, id: targetId });
    const node = doc.createNode(row);
    if (existing) {
        // 就地替换：保留它在文件里的位置，也保留行内没被这次编辑涉及的字段。
        const keep = new Set(['id', 'name', 'disabled']);
        const oldConfig = existing.node.get('config');
        if (isMap(oldConfig)) {
            const wanted = isMap(node.get('config')) ? node.get('config') : null;
            const merged = doc.createNode({});
            // 注意：yaml 的 Map.items 里装的是 Pair 节点（不是 [k, v] 数组），
            // 直接解构会报 "object is not iterable"，只能按 Pair 取键值。
            for (const pair of oldConfig.items ?? []) {
                const key = String(pair.key?.value ?? '');
                if (wanted?.has(key)) {
                    continue;
                }
                merged.set(key, pair.value);
            }
            if (wanted) {
                for (const pair of wanted.items ?? []) {
                    merged.set(String(pair.key?.value ?? ''), pair.value);
                }
            }
            node.set('config', merged);
        }
        // yaml v2 的 YAMLMap 只有 items（Pair 数组），没有 keys() 方法。
        const oldKeys = (existing.node.items ?? []).map((pair) => String(pair.key?.value ?? ''));
        for (const key of oldKeys) {
            if (!keep.has(key)) {
                existing.node.delete(key);
            }
        }
        for (const pair of node.items ?? []) {
            existing.node.set(String(pair.key?.value ?? ''), pair.value);
        }
        const list = existing.list ?? rootSeq(doc);
        list.items.splice(list.items.indexOf(existing.node), 1, existing.node);
    }
    else {
        managedInsert(doc).add(node);
    }
    return { id: targetId, created };
}

/**
 * 启停一行。
 *
 * `disabled: true` = 停用；恢复时**删掉这个键**而不是写 false ——
 * 宿主那边 disabled 是计算属性，写 false 与不写等价，但删掉更干净。
 */
export function setRowDisabled(doc, id, disabled) {
    const row = collectMcpRows(doc).find((item) => item.id === id);
    if (!row) {
        return false;
    }
    if (disabled) {
        row.node.set('disabled', true);
    }
    else {
        row.node.delete('disabled');
    }
    return true;
}

/** 删一行。 */
export function removeRow(doc, id) {
    const row = collectMcpRows(doc).find((item) => item.id === id);
    if (!row) {
        return false;
    }
    const list = row.list ?? rootSeq(doc);
    const at = list.items.indexOf(row.node);
    if (at >= 0) {
        list.items.splice(at, 1);
    }
    // insert 块空了就把它整个删掉，别留个 `- insert: []` 在补丁里。
    if (row.list) {
        const seq = rootSeq(doc);
        const owner = (seq.items ?? []).find((item) => isMap(item) && item.get('insert') === row.list);
        if (owner && row.list.items.length === 0) {
            seq.items.splice(seq.items.indexOf(owner), 1);
        }
    }
    return true;
}

/**
 * 连通性探测。
 *
 * - stdio：命令在不在 PATH 上；
 * - http：真发一次请求，看 HTTP 状态码。
 *
 * @param {object} server 归一化视图
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function checkServer(server) {
    if (server.transport === 'stdio') {
        const command = String(server.command ?? '');
        if (!command) {
            return { ok: false, detail: '这一行没有命令' };
        }
        return resolveCommandOnPath(command)
            ? { ok: true, detail: `命令在 PATH 上：${command}` }
            : { ok: false, detail: `PATH 上找不到：${command}` };
    }
    const url = String(server.url ?? '');
    if (!/^https?:\/\//.test(url)) {
        return { ok: false, detail: '这一行没有 http url' };
    }
    // MCP 的 streamable-http 是 **POST 一个 JSON-RPC**，光 GET 会挂着（SSE 长连接），
    // 所以这里发一个最小的 initialize，并且带上这一行自己的请求头（很多服务器要鉴权）。
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(server.headers && typeof server.headers === 'object' ? server.headers : {}),
    };
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'dsh-scope-manager', version: '1.0.0' },
        },
    });
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        });
        // 只看状态码，不读 body：SSE 响应体是长连接，读它会一直等到超时。
        const detail = response.status === 200
            ? `HTTP 200（连上了）`
            : response.status === 401 || response.status === 403
                ? `HTTP ${response.status}（鉴权没过：检查这一行的请求头）`
                : `HTTP ${response.status}`;
        return { ok: response.status === 200, detail };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cause = error?.cause?.code;
        return { ok: false, detail: cause !== undefined ? String(cause) : message };
    }
}

/** 命令在不在 PATH 上（Windows 的可执行后缀也算）。 */
function resolveCommandOnPath(command, pathEnv = process.env.PATH ?? '', platform = process.platform) {
    if (command.includes('/') || command.includes('\\')) {
        return existsSync(command);
    }
    const exts = platform === 'win32' ? ['', '.com', '.exe', '.bat', '.cmd'] : [''];
    const separator = platform === 'win32' ? ';' : ':';
    for (const rawDir of pathEnv.split(separator)) {
        const dir = rawDir.trim().replace(/^"|"$/g, '');
        if (dir === '') {
            continue;
        }
        for (const ext of exts) {
            if (existsSync(join(dir, command + ext))) {
                return true;
            }
        }
    }
    return false;
}

