/**
 * 插件增删 / 升级的「侦察兵」。
 *
 * 为什么需要它：工具归属靠三条通道（自报 / 静态扫描 / 软重启实测）算出来，
 * 但这三条都是**某个时刻**的快照。用户装了个新插件、或者把某个插件升了级，
 * 归属表不会自己变 —— 得有人记得去点「快速刷新」「深度排查」。
 * 忘一次，页面上就是一个新插件挂着一堆「未归属」的工具。
 *
 * 所以这里做的是一件很朴素的事：**记住上一次长什么样，下次发现不一样就自己查。**
 *
 * 记录什么（每个 loader 条目一份）：
 *   - 版本号（包变了 = 结论作废）
 *   - 这个插件名下的工具清单（来自归属表）
 *   - 这个插件注入的提示词段落清单（来自段落目录 `plugin` 字段）
 *
 * 发现什么就干什么：
 *   - 新装的插件 → 自动跑一次软重启差分（它自己的工具集立刻就是事实）
 *   - 升级的插件 → 同样跑一次（按版本号，旧结论已经作废）
 *   - 只是工具/段落多了少了 → 记一条事件，不改归属（归属会自己跟着新数据算）
 *
 * 事件流落盘，界面按时间倒序列出来 —— 用户装完插件回来看一眼就知道
 * 「这次装进来的东西干了什么」，不用再自己排查。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hubPath } from './paths.js';
import { packageBaseName } from './section-map.js';

const WATCH_FILE = 'plugin-watch.json';
const WATCH_VERSION = 1;
/** 事件最多留这么多条：这是「最近发生了什么」，不是全量审计日志。 */
const MAX_EVENTS = 80;

function emptyState() {
    return {
        version: WATCH_VERSION,
        baseline: {},
        baselineAt: 0,
        lastRunAt: 0,
        autoProbe: true,
        events: [],
    };
}

function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || raw.version !== WATCH_VERSION) {
        return emptyState();
    }
    const baseline = {};
    if (raw.baseline && typeof raw.baseline === 'object') {
        for (const [name, row] of Object.entries(raw.baseline)) {
            if (!row || typeof row !== 'object') {
                continue;
            }
            baseline[name] = {
                moduleName: name,
                entryId: typeof row.entryId === 'string' ? row.entryId : '',
                enabled: row.enabled !== false,
                version: typeof row.version === 'string' ? row.version : '',
                tools: Array.isArray(row.tools) ? row.tools.filter((t) => typeof t === 'string') : [],
                sections: Array.isArray(row.sections) ? row.sections.filter((s) => typeof s === 'string') : [],
            };
        }
    }
    const events = Array.isArray(raw.events)
        ? raw.events.filter((e) => e && typeof e === 'object' && typeof e.moduleName === 'string')
        : [];
    return {
        version: WATCH_VERSION,
        baseline,
        baselineAt: Number(raw.baselineAt) || 0,
        lastRunAt: Number(raw.lastRunAt) || 0,
        autoProbe: raw.autoProbe !== false,
        events: events.slice(0, MAX_EVENTS),
    };
}

async function readWatchState() {
    try {
        const text = await readFile(hubPath(WATCH_FILE), 'utf8');
        return normalizeState(JSON.parse(text));
    }
    catch {
        return emptyState();
    }
}

async function writeWatchState(state) {
    const file = hubPath(WATCH_FILE);
    await mkdir(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${WATCH_FILE}.${randomUUID().slice(0, 8)}.tmp`);
    try {
        await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
        await rename(tmp, file);
    }
    catch (e) {
        await rm(tmp, { force: true }).catch(() => { });
        throw e;
    }
}

/** 两个数组的差集（保持稳定顺序：以 b 的顺序为准）。 */
function added(before, after) {
    const set = new Set(before);
    return after.filter((x) => !set.has(x));
}

function removed(before, after) {
    const set = new Set(after);
    return before.filter((x) => !set.has(x));
}

/**
 * 比较两份快照，产出变化事件。
 *
 * @param {Record<string, object>} before 上一次的基线
 * @param {Record<string, object>} after 现在的快照
 * @returns {Array<object>} 事件（不含时间戳，由调用方补）
 */
export function diffSnapshots(before, after) {
    const events = [];
    for (const [name, cur] of Object.entries(after ?? {})) {
        const prev = (before ?? {})[name];
        if (!prev) {
            events.push({
                kind: 'installed',
                moduleName: name,
                version: cur.version ?? '',
                toolsAdded: [...(cur.tools ?? [])],
                toolsRemoved: [],
                sectionsAdded: [...(cur.sections ?? [])],
                sectionsRemoved: [],
            });
            continue;
        }
        const versionChanged = (prev.version ?? '') !== (cur.version ?? '');
        const toolsAdded = added(prev.tools ?? [], cur.tools ?? []);
        const toolsRemoved = removed(prev.tools ?? [], cur.tools ?? []);
        const sectionsAdded = added(prev.sections ?? [], cur.sections ?? []);
        const sectionsRemoved = removed(prev.sections ?? [], cur.sections ?? []);
        const touched = toolsAdded.length || toolsRemoved.length
            || sectionsAdded.length || sectionsRemoved.length;
        if (!versionChanged && !touched) {
            continue;
        }
        events.push({
            kind: versionChanged ? 'updated' : 'changed',
            moduleName: name,
            version: cur.version ?? '',
            versionFrom: prev.version ?? '',
            toolsAdded,
            toolsRemoved,
            sectionsAdded,
            sectionsRemoved,
        });
    }
    for (const name of Object.keys(before ?? {})) {
        if (!after || !(name in after)) {
            events.push({
                kind: 'removed',
                moduleName: name,
                version: (before[name]?.version) ?? '',
                toolsAdded: [],
                toolsRemoved: [...(before[name]?.tools ?? [])],
                sectionsAdded: [],
                sectionsRemoved: [...(before[name]?.sections ?? [])],
            });
        }
    }
    return events;
}

/**
 * @param {object} options
 * @param {object} options.ctx Cordis 上下文（只用来写日志）
 * @param {object|null} options.pluginManager 宿主插件管理服务（没有就一直空转）
 * @param {object} options.scanner 工具归属扫描器（要有 `get()`）
 * @param {object} options.sectionCatalog 段落目录（要有 `list()`）
 * @param {(only: Set<string>) => Promise<object>} [options.probe] 软重启差分；只测传入的那几个包
 */
export function createPluginWatch({ ctx, pluginManager, scanner, sectionCatalog, probe }) {
    let state = null;
    /** 同一时间只跑一轮：定时器和按钮很容易撞在一起。 */
    let running = null;

    async function ensureState() {
        if (!state) {
            state = await readWatchState();
        }
        return state;
    }

    /**
     * 当前快照：loader 条目 × 版本 × 工具 × 提示词段落。
     *
     * 归属表里的键是**包名**（`@changfenhuang/dsh-genui`），段落目录里也是包名，
     * 而 loader 的 moduleName 也是包名 —— 三边用 `packageBaseName` 归一后再比，
     * 免得 `@scope/foo` 和 `foo` 被当成两个插件。
     */
    async function snapshot() {
        const entries = {};
        if (!pluginManager?.listPlugins) {
            return entries;
        }
        let plugins = [];
        try {
            plugins = await pluginManager.listPlugins();
        }
        catch {
            return entries;
        }
        // 版本号：scanned.packages 是**目录名**做键（`modlens`），要按包名再补一份别名。
        const versions = new Map();
        let scanned = null;
        try {
            scanned = await scanner.get();
        }
        catch {
            scanned = null;
        }
        for (const pkg of scanned?.packages?.values?.() ?? []) {
            if (!pkg) {
                continue;
            }
            const v = typeof pkg.version === 'string' ? pkg.version : '';
            if (pkg.packageName) {
                versions.set(pkg.packageName, v);
            }
            if (pkg.key) {
                versions.set(pkg.key, v);
            }
        }
        // 工具：归属表是「工具名 → 包名」，反过来攒一份「包名基名 → 工具名」。
        const toolsByBase = new Map();
        const pushTool = (tool, pkg) => {
            const base = packageBaseName(pkg);
            if (!tool || !base) {
                return;
            }
            if (!toolsByBase.has(base)) {
                toolsByBase.set(base, new Set());
            }
            toolsByBase.get(base).add(tool);
        };
        for (const [map, keep] of [
            [scanned?.plugin, true],
            [scanned?.probed, true],
            [scanned?.quoted, true],
            [scanned?.system, true],
        ]) {
            if (!(map instanceof Map) || !keep) {
                continue;
            }
            for (const [tool, pkg] of map) {
                pushTool(tool, pkg);
            }
        }
        // 提示词段落：段落目录里带来源插件（`plugin`）的那些。
        const sectionsByBase = new Map();
        for (const section of sectionCatalog?.list?.() ?? []) {
            const owner = section?.plugin || section?.owner || '';
            const base = packageBaseName(owner);
            if (!base || !section?.name) {
                continue;
            }
            if (!sectionsByBase.has(base)) {
                sectionsByBase.set(base, new Set());
            }
            sectionsByBase.get(base).add(section.name);
        }

        for (const entry of plugins) {
            const moduleName = String(entry?.moduleName ?? '');
            if (!moduleName) {
                continue;
            }
            const base = packageBaseName(moduleName);
            const version = versions.get(moduleName)
                ?? versions.get(base)
                ?? '';
            entries[moduleName] = {
                moduleName,
                entryId: String(entry?.entryId ?? ''),
                enabled: entry?.enabled !== false,
                version,
                tools: [...(toolsByBase.get(base) ?? [])].sort(),
                sections: [...(sectionsByBase.get(base) ?? [])].sort(),
            };
        }
        return entries;
    }

    /**
     * 跑一轮：快照 → 比对 → 该测的测 → 记事件 → 更新基线。
     *
     * @param {{probe?: boolean}} [options] `probe` 缺省跟随 autoProbe 开关
     * @returns {Promise<{first: boolean, events: Array<object>, probed: number}>}
     */
    async function run(options) {
        if (running) {
            return running;
        }
        running = (async () => {
            const s = await ensureState();
            // 先核对「插件集合变了没有」：这一步只比指纹（十几毫秒），
            // 变了才真的重扫（16 秒，后台跑）。先做这一步，
            // 刚装/刚升的插件才能出现在**本轮**的快照里，
            // 而不是等下一轮 tick 才被看见。
            try {
                await scanner.verify?.();
            }
            catch {
                /* 核对失败不影响监测：下面的快照用现有缓存 */
            }
            const now = snapshot();
            const current = await now;
            // 第一次跑：只记基线，**不**报一堆「新装」事件（那会把全部插件都报一遍）。
            if (!s.baselineAt) {
                s.baseline = current;
                s.baselineAt = Date.now();
                s.lastRunAt = s.baselineAt;
                await writeWatchState(s);
                return { first: true, events: [], probed: 0 };
            }
            let events = diffSnapshots(s.baseline, current);
            let probed = 0;
            const wantProbe = options && 'probe' in options ? options.probe !== false : s.autoProbe;
            // 只有「新装 / 升级」值得软重启 —— 「只是多了个工具」说明归属表已经跟上了。
            const worthProbing = events
                .filter((e) => e.kind === 'installed' || e.kind === 'updated')
                .map((e) => e.moduleName);
            if (wantProbe && worthProbing.length > 0 && typeof probe === 'function') {
                try {
                    const result = await probe(new Set(worthProbing));
                    probed = Number(result?.probed) || 0;
                }
                catch (e) {
                    try {
                        ctx?.logger?.warn?.(`[scope-manager] 自动排查失败：${String(e?.message ?? e)}`);
                    }
                    catch {
                        /* 日志失败不影响主流程 */
                    }
                }
                // 探完再取一次快照：新绑定的工具要算进这一轮的事件里。
                const after = await snapshot();
                events = diffSnapshots(s.baseline, after);
                for (const name of worthProbing) {
                    if (after[name]) {
                        current[name] = after[name];
                    }
                }
            }
            const at = Date.now();
            for (const e of events) {
                e.at = at;
                e.probed = e.kind === 'installed' || e.kind === 'updated' ? probed > 0 : false;
            }
            s.events = [...events.reverse(), ...s.events].slice(0, MAX_EVENTS);
            s.baseline = current;
            s.lastRunAt = at;
            await writeWatchState(s);
            return { first: false, events, probed };
        })().finally(() => {
            running = null;
        });
        return running;
    }

    /** 只读：给界面看的当前状态（基线 + 事件流 + 开关）。 */
    async function status() {
        const s = await ensureState();
        return {
            available: Boolean(pluginManager),
            autoProbe: s.autoProbe !== false,
            baselineAt: s.baselineAt || 0,
            lastRunAt: s.lastRunAt || 0,
            entries: Object.values(s.baseline).sort((a, b) => a.moduleName.localeCompare(b.moduleName)),
            events: s.events.slice(0, 30),
        };
    }

    async function setAutoProbe(enabled) {
        const s = await ensureState();
        s.autoProbe = enabled !== false;
        await writeWatchState(s);
        return { autoProbe: s.autoProbe };
    }

    /** 把当前状态直接当基线（用户手动确认过「现在这样就是对的」）。 */
    async function reset() {
        const s = await ensureState();
        s.baseline = await snapshot();
        s.baselineAt = Date.now();
        s.lastRunAt = s.baselineAt;
        s.events = [];
        await writeWatchState(s);
        return { baselineAt: s.baselineAt, count: Object.keys(s.baseline).length };
    }

    return { run, status, setAutoProbe, reset };
}
