// 客户端那一半的唯一入口：一条精确路由 POST /dsh-scope-manager/api。
//
// 为什么自己开路由而不走 host.call：`host.call` 只属**动态插件**，静态 client 模块没有它
// （dsh-cordis-client-runner/lib/client.js:178）。客户端那一半是静态模块，只能原生 fetch，
// 所以数据面必须落在宿主注册的一条 exact 路由上。
//
// 鉴权：优先用宿主的 `connection.admit(req)`（Host/Origin + 浏览器会话 cookie）。
// 宿主没有全局中间件，约定是每个注册方自己调。
import { GLOBAL_KEY, layerOf, setLayer, dropLayer } from './store.js';
import { resolveEffective, toolAllowedByFilter, sectionAllowedByFilter } from './resolve.js';
import { classifyToolName, CATEGORY_LABELS, CATEGORY_SYSTEM, CATEGORY_PLUGIN, CATEGORY_MCP, CATEGORY_OTHER } from './tool-owner.js';
import { isOwnerInstalled } from './installed.js';
import { associateSections, packageBaseName, sectionOwnerBase } from './section-map.js';
import { SCM_VAR_NAMES, SELF_VAR, tokensInText, validatePromptVars } from './prompt-vars.js';
import { personaSectionTexts } from './persona-parts.js';
import { PINNED_SECTIONS, isPinnedSection } from './pin-order.js';
import { ALWAYS_ON_SECTIONS, isAlwaysOnSection } from './always-on.js';
import { settleToolFilter } from './library.js';

const ROUTE = '/dsh-scope-manager/api';
const PLUGIN_ID = 'dsh-scope-manager';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers?.['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
            req.resume?.();
            reject(new Error('request body too large'));
            return;
        }
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
            size += buf.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * 组装 op 表。所有 op 都是 `async (args) => object`。
 * @param {object} deps 本插件的服务集合
 */
/** 某一层绑了什么场景：undefined = 没绑（继承）/ null = 明确用默认 / 字符串 = 场景 id。 */
function sceneOf(data, key) {
    const layer = key === '' ? data.global : layerOf(data, key);
    if (!layer || !Object.prototype.hasOwnProperty.call(layer, 'scene')) {
        return undefined;
    }
    return layer.scene ?? null;
}

export function buildOps(deps) {
    /** 把客户端带来的 sessionId / cwd 归一化成两个作用域键（realpath 归一在宿主那边做）。 */
    async function normalizeScope(args) {
        const raw = await deps.resolveScope({
            sessionId: String(args?.sessionId ?? '').trim(),
            cwd: String(args?.cwd ?? '').trim(),
        });
        return {
            sessionKey: raw.sessionKey ?? '',
            workspaceKey: raw.workspaceKey ?? '',
        };
    }

    async function keyFor(args) {
        const which = String(args?.scope ?? 'global');
        const scope = await normalizeScope(args);
        if (which === 'workspace') {
            return scope.workspaceKey;
        }
        if (which === 'session') {
            return scope.sessionKey;
        }
        return GLOBAL_KEY;
    }

    /**
     * 会话 id → 活的 agent，用来当 skills/tools 的 view scope。
     *
     * 这一步不能省：`ctx.skills.list()` / `ctx.tools.schemas()` 不传 scope 时
     * 只看插件级那一次注册（实测技能只剩 genui 一个、工具只剩 working_directory
     * 一个），会话里真正可用的东西全在 agent 那一层。
     */
    async function scopeOf(sessionId) {
        const id = String(sessionId ?? '').trim();
        try {
            if (id && deps.findAgent) {
                const agent = await deps.findAgent(id);
                if (agent) {
                    return agent;
                }
            }
            // 这个会话还没跑起来时用别的活 agent 当目录视角：
            // 候选列表全一点才挑得动。只看，不影响任何拦截决策。
            return (await deps.catalogAgent?.()) ?? undefined;
        }
        catch {
            return undefined;
        }
    }

    async function effectiveFor(args) {
        const scope = await normalizeScope(args);
        const data = deps.store.peek();
        return resolveEffective(data, deps.library.scenesById, deps.library.personasById, scope);
    }

    return {
        'plugin-version': async () => ({
            version: deps.version,
            name: PLUGIN_ID,
        }),

        /** 运行期证据：三个钩子在真实宿主里各被调了多少次。 */
        'hook-stats': async () => ({
            stats: { ...(deps.hookStats ? deps.hookStats() : {}) },
            uptimeMs: deps.startedAt ? Date.now() - deps.startedAt : 0,
        }),

        /** 界面开场要知道的：当前作用域的键 + 三层各自存了什么 + 合并后的生效值。 */
        /**
         * Agent 预设（宿主 `agentPresets` 服务）的只读概况。
         *
         * 关键限制（`dsh-agent-preset-registry/lib/index.js:750-772`）：`select()`
         * 对「已经开始过任何一轮」的会话直接抛 `agent-preset/locked`，所以预设
         * 只能在空白会话上换 —— 这是能不能跟场景预设连起来的分水岭。
         */
        /**
         * 权限预设目录（宿主 `permissionPresets` 服务）。
         *
         * 三个档位就是宿主自己的 sandbox/approval 组合：`read-only` / `workspace-write` /
         * `danger-full-access`。写入走 `permissionPresets.set(session, name)` ——
         * 它**没有**「空白会话」限制（对照 agent 预设的 `agent-preset/locked`），
         * 会话进行中也能切，这正是界面上那个权限下拉干的事。
         */
        'permission-catalog': async (args) => {
            const service = deps.permissionPresets;
            if (!service) {
                return { available: false, options: [], current: null, currentOf: {}, defaultPreset: null };
            }
            let catalog = null;
            try {
                catalog = service.catalog();
            }
            catch {
                catalog = null;
            }
            // 传了 sessionId 就直接问这个会话（插件重载后 adopt 还没跑完时，
            // 靠 liveAgents 那张表会读到空，界面就显示「未知」）。
            let current = null;
            const wanted = String(args?.sessionId ?? '');
            if (wanted) {
                try {
                    const agent = deps.agents?.get?.(wanted);
                    if (agent) {
                        current = service.current(agent.session);
                    }
                }
                catch {
                    current = null;
                }
            }
            const currentOf = {};
            for (const [sessionId, agent] of deps.liveAgents?.() ?? []) {
                try {
                    currentOf[sessionId] = service.current(agent.session);
                }
                catch {
                    currentOf[sessionId] = null;
                }
            }
            return {
                available: true,
                options: (catalog?.options ?? []).map((o) => ({
                    value: o.value,
                    name: o.name,
                    description: o.description ?? '',
                })),
                defaultPreset: catalog?.defaultPreset ?? null,
                current,
                currentOf,
            };
        },

        'preset-current': async (args) => {
            const presets = deps.agentPresets;
            const sessionId = String(args?.sessionId ?? '');
            if (!presets || !sessionId) {
                return { available: Boolean(presets), sessionId, hasAgent: false, preset: null };
            }
            const agent = deps.agents?.get?.(sessionId);
            if (!agent) {
                return { available: true, sessionId, hasAgent: false, preset: null };
            }
            let preset = null;
            try {
                preset = presets.composedPreset?.(agent.ctx) ?? null;
            }
            catch {
                preset = null;
            }
            return { available: true, sessionId, hasAgent: true, preset };
        },

        'preset-list': async () => {
            const presets = deps.agentPresets;
            if (!presets) {
                return { available: false, presets: [], current: null };
            }
            let list = [];
            try {
                list = await presets.list();
            }
            catch {
                list = [];
            }
            return {
                available: true,
                presets: (Array.isArray(list) ? list : []).map((p) => ({
                    id: p.id,
                    name: p.name ?? p.id,
                    description: p.description ?? '',
                    order: p.order ?? 0,
                    problem: p.problem ?? null,
                })),
                defaultId: (() => {
                    try {
                        return presets.defaultId ?? null;
                    }
                    catch {
                        return null;
                    }
                })(),
            };
        },

        /**
         * 一套 Agent 预设的组成（声明 YAML 原文）。
         *
         * 宿主 `readDocument(id)` 只给「这个预设挂了哪些插件」的 YAML 原文 ——
         * 不给结果层（工具名）清单。想看「这个预设实际能调哪些工具」，要靠
         * 会话跑起来之后读 `tools.schemas()`，这里不做臆测。
         */
        'preset-document': async (args) => {
            const presets = deps.agentPresets;
            const id = String(args?.id ?? '');
            if (!presets || !id) {
                return { available: Boolean(presets), id, content: '', name: '', description: '' };
            }
            try {
                const doc = await presets.readDocument(id);
                return {
                    available: true,
                    id: doc?.agentPreset ?? id,
                    name: doc?.name ?? '',
                    description: doc?.description ?? '',
                    content: String(doc?.content ?? ''),
                };
            }
            catch (e) {
                return {
                    available: true, id, content: '', name: '', description: '',
                    error: String(e?.message ?? e),
                };
            }
        },

        /**
         * 每套 Agent 预设挂了哪些插件（Loader 行），以及每行的启用状态。
         *
         * 用途：预设编辑器里选「极简模式」时，按它的插件清单去预勾选卡片。
         * 只给**插件**，不给工具 —— 一个插件注册哪个工具属于运行时事实，
         * 由归属表（`scanned.*`）提供，两边合起来才是「这套预设带来哪些工具」。
         *
         * `enabled` 可能是 `'conditional'`：该行的 `!!js` 条件在本机求不出来，
         * 这种情况照实标出来，不猜成启用。
         */
        'preset-composition': async () => {
            const presets = deps.agentPresets;
            if (!presets || typeof presets.compositionInventory !== 'function') {
                return { available: false, presets: [] };
            }
            let list = [];
            try {
                list = await presets.compositionInventory();
            }
            catch (e) {
                return { available: false, presets: [], error: String(e?.message ?? e) };
            }
            return {
                available: true,
                presets: (Array.isArray(list) ? list : []).map((p) => ({
                    id: p.id,
                    name: p.name ?? '',
                    isDefault: p.isDefault === true,
                    broken: p.broken ?? null,
                    plugins: (p.rows ?? []).map((r) => ({
                        entryId: r.entryId ?? null,
                        moduleName: r.moduleName ?? '',
                        enabled: r.enabled === true ? 'on' : (r.enabled === 'conditional' ? 'conditional' : 'off'),
                    })),
                })),
            };
        },

        'scope-context': async (args) => {
            const scope = await normalizeScope(args);
            const data = deps.store.peek();
            const effective = resolveEffective(data, deps.library.scenesById, deps.library.personasById, scope);
            return {
                scope,
                layers: {
                    global: layerOf(data, GLOBAL_KEY),
                    workspace: scope.workspaceKey ? layerOf(data, scope.workspaceKey) : {},
                    session: scope.sessionKey ? layerOf(data, scope.sessionKey) : {},
                },
                effective,
                workspaces: Object.keys(data.workspaces ?? {}),
                sessions: Object.keys(data.sessions ?? {}),
            };
        },

        /**
         * 层级树的全部数据：工作区 + 每个工作区下的会话 + 各节点的场景绑定。
         *
         * 为什么由宿主算：客户端的 `ctx.sessions.list` 只是「运行时那份」，
         * 落盘但没被加载的会话不在里面（实测 2 vs 18）。层级树要的是全量，
         * 所以这里把「活的」和「落盘的」并起来，标题也按宿主自己的规矩补。
         */
        'tree': async () => {
            const data = deps.store.peek();
            const cache = deps.sessionProjectionCache;
            const titleOf = (header) => {
                try {
                    const block = cache?.cachedSnapshot?.(header)
                        ?? cache?.cachedPredecessorTitle?.(header);
                    const t = block?.values?.title;
                    return typeof t === 'string' && t ? t : null;
                }
                catch {
                    return null;
                }
            };

            // 1) 会话：活的优先，落盘的补进来
            const rows = new Map();
            for (const session of deps.sessions?.list?.() ?? []) {
                const h = session?.header ?? session;
                if (!h?.id) {
                    continue;
                }
                let title = null;
                try {
                    title = deps.sessionTitle?.get?.(session)?.title ?? null;
                }
                catch { /* 没标题就回退到投影缓存 */ }
                rows.set(h.id, {
                    id: h.id,
                    cwd: typeof h.cwd === 'string' ? h.cwd : '',
                    title: title || titleOf(h),
                    createdAt: h.createdAt ?? null,
                    parentSession: h.parentSession ?? null,
                    origin: h.origin === 'subagent' ? 'subagent' : 'user',
                    depth: h.delegationDepth ?? 0,
                    running: true,
                });
            }
            for (const entry of (await deps.sessionPersistence?.list?.()) ?? []) {
                const h = entry?.header;
                if (!h?.id || rows.has(h.id)) {
                    continue;
                }
                rows.set(h.id, {
                    id: h.id,
                    cwd: typeof h.cwd === 'string' ? h.cwd : '',
                    title: titleOf(h),
                    createdAt: h.createdAt ?? null,
                    parentSession: h.parentSession ?? null,
                    origin: h.origin === 'subagent' ? 'subagent' : 'user',
                    depth: h.delegationDepth ?? 0,
                    running: false,
                });
            }

            const archived = new Set(deps.workspaceRegistry?.archivedSessionIds ?? []);
            const pinned = new Set(deps.workspaceRegistry?.pinnedSessionIds ?? []);

            // 2) 工作区：登记过的 + 会话用过但没登记的目录
            const groups = new Map();
            const groupFor = (path) => {
                if (!groups.has(path)) {
                    groups.set(path, { path, title: '', registered: false, workspaceId: null, sessions: [] });
                }
                return groups.get(path);
            };
            for (const ws of deps.workspaceRegistry?.list?.() ?? []) {
                const g = groupFor(ws.path);
                g.title = ws.title ?? '';
                g.registered = true;
                g.workspaceId = ws.id;
            }
            for (const row of rows.values()) {
                let path = row.cwd;
                if (!path) {
                    path = '';
                }
                const g = groupFor(path);
                g.sessions.push({
                    ...row,
                    archived: archived.has(row.id),
                    pinned: pinned.has(row.id),
                    scene: sceneOf(data, `s:${row.id}`),
                });
            }

            const workspaces = [...groups.values()]
                .filter((g) => g.registered || g.sessions.length > 0)
                .sort((a, b) => (a.registered === b.registered ? a.path.localeCompare(b.path) : a.registered ? -1 : 1));
            for (const g of workspaces) {
                g.scene = sceneOf(data, g.path ? `ws:${g.path}` : '');
                g.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            }

            return {
                global: sceneOf(data, ''),
                workspaces,
                scenes: (await deps.listScenes()).map((sc) => ({ id: sc.id, name: sc.name, description: sc.description ?? '' })),
            };
        },

        // ——————————————————— 层级作用域：只配「场景」 ———————————————————
        //
        // 作用域页只做一件事：给 全局 / 工作区 / 会话 各绑一个场景。
        // 三态：undefined = 继承上级 / null = 明确用默认场景（全开）/ 字符串 = 指定场景。

        /** 三层各自的场景绑定（原始值，未绑定就是 undefined）。 */
        'scene-bindings': async () => {
            const data = deps.store.peek();
            const out = { global: undefined, workspaces: {}, sessions: {} };
            const g = layerOf(data, GLOBAL_KEY);
            if (g && Object.prototype.hasOwnProperty.call(g, 'scene')) {
                out.global = g.scene ?? null;
            }
            for (const [key, layer] of Object.entries(data.workspaces ?? {})) {
                if (layer && Object.prototype.hasOwnProperty.call(layer, 'scene')) {
                    out.workspaces[key.slice('ws:'.length)] = layer.scene ?? null;
                }
            }
            for (const [key, layer] of Object.entries(data.sessions ?? {})) {
                if (layer && Object.prototype.hasOwnProperty.call(layer, 'scene')) {
                    out.sessions[key.slice('s:'.length)] = layer.scene ?? null;
                }
            }
            return out;
        },

        /**
         * 给某一层绑场景。scene 三态同 scene-bindings：
         * 空串 = 继承（删掉这个键）/ '__default__' = 明确默认 / 场景 id。
         */
        'scene-bind': async (args) => {
            const which = String(args?.scope ?? 'global');
            const raw = args?.scene;
            // '__default__' → 明确用默认场景（存 null）；'' / 缺席 → 继承（删键）
            const value = raw === '__default__' ? null
                : (typeof raw === 'string' && raw ? raw : undefined);
            const key = await keyFor(args);
            if (which !== 'global' && !key) {
                throw new Error('缺少作用域键：工作区要 cwd，会话要 sessionId');
            }
            const target = which === 'global' ? GLOBAL_KEY : key;
            await deps.store.mutate((data) => {
                const layer = { ...(layerOf(data, target) || {}) };
                if (value === undefined) {
                    delete layer.scene;
                }
                else {
                    layer.scene = value;
                }
                if (Object.keys(layer).length === 0) {
                    dropLayer(data, target);
                }
                else {
                    setLayer(data, target, layer);
                }
            });
            await deps.afterChange();
            return { key: target, scene: value === undefined ? null : value };
        },

        // ——————————————————— 工作区 / 会话的管理 ———————————————————

        'workspace-rename': async (args) => {
            const id = String(args?.id ?? '');
            const title = String(args?.title ?? '').trim();
            const reg = deps.workspaceRegistry;
            const entity = reg?.get?.(id);
            if (!entity) {
                throw new Error('没有这个工作区：' + id);
            }
            if (!title) {
                throw new Error('标题不能为空');
            }
            await entity.setTitle(title);
            return { id, title };
        },

        /** 移除工作区登记：目录和会话日志都保留。 */
        'workspace-remove': async (args) => {
            const id = String(args?.id ?? '');
            const reg = deps.workspaceRegistry;
            if (!reg?.delete) {
                throw new Error('宿主没有提供 workspaceRegistry.delete');
            }
            const removed = await reg.delete(id);
            return { id, removed: removed === true };
        },

        /**
         * 删会话（宿主没有这条 API，是把工件与运行时一起拆掉）。
         *
         * 危险动作，所以两条硬限制：
         *   - 只允许删**本机持久化里有记录**的会话（不认界面传来的任意 id）
         *   - force 只用于「它还在跑」这一种情况：默认拒绝，界面二次确认后才带 force
         */
        'session-delete': async (args) => {
            const id = String(args?.id ?? '').trim();
            if (!id) {
                throw new Error('缺少会话 id');
            }
            if (typeof deps.deleteSession !== 'function') {
                throw new Error('宿主没有提供删除实现');
            }
            const result = await deps.deleteSession(id, { force: args?.force === true });
            return result;
        },

        'session-archive': async (args) => {
            const id = String(args?.id ?? '');
            const reg = deps.workspaceRegistry;
            if (!reg?.archiveSession) {
                throw new Error('宿主没有提供 workspaceRegistry.archiveSession');
            }
            // stopActivity：会话还在跑也允许归档，先归档再请它停 ——
            // 归档集是 provider 的 pre-step 门禁，停了之后不会再被唤醒。
            await reg.archiveSession(id, { stopActivity: true });
            return { id, archived: true };
        },

        'session-unarchive': async (args) => {
            const id = String(args?.id ?? '');
            const reg = deps.workspaceRegistry;
            if (!reg?.unarchiveSession) {
                throw new Error('宿主没有提供 workspaceRegistry.unarchiveSession');
            }
            await reg.unarchiveSession(id);
            return { id, archived: false };
        },

        'session-pin': async (args) => {
            const id = String(args?.id ?? '');
            const pin = args?.pin !== false;
            const reg = deps.workspaceRegistry;
            if (pin) {
                await reg?.pinSession?.(id);
            }
            else {
                await reg?.unpinSession?.(id);
            }
            return { id, pinned: pin };
        },

        /** 归档集合（宿主的权威口径）＋ 置顶集合。 */
        'session-flags': async () => ({
            archived: [...(deps.workspaceRegistry?.archivedSessionIds ?? [])],
            pinned: [...(deps.workspaceRegistry?.pinnedSessionIds ?? [])],
        }),

        /** 写一层。整层替换 —— 界面一次提交的就是该层的完整内容。 */
        'layer-save': async (args) => {
            const which = String(args?.scope ?? 'global');
            const key = await keyFor(args);
            if (which === 'session' && !key) {
                throw new Error('没有会话 id，无法写会话层');
            }
            if (which === 'workspace' && !key) {
                throw new Error('没有工作目录，无法写工作区层');
            }
            const layer = (args?.layer && typeof args.layer === 'object' && !Array.isArray(args.layer))
                ? args.layer
                : {};
            await deps.store.mutate((data) => setLayer(data, key, layer));
            await deps.afterChange();
            return { key };
        },

        /** 清掉一层（回到「这一层不管」）。 */
        'layer-reset': async (args) => {
            const which = String(args?.scope ?? 'global');
            const key = await keyFor(args);
            await deps.store.mutate((data) => {
                if (which === 'global') {
                    data.global = {};
                }
                else {
                    dropLayer(data, key);
                }
                return data;
            });
            await deps.afterChange();
            return { key };
        },

        /** 工具总表：按来源大类分组（系统 / 插件 / MCP / 其他），每类再按归属者分组。MCP 那批在「MCP」页也有按连接器的视图。 */
        'tools-list': async (args) => {
            const scanned = await deps.scanner.get();
            const data = deps.store.peek();
            const scope = await normalizeScope(args);
            const effective = resolveEffective(data, deps.library.scenesById, deps.library.personasById, scope);
            const overrides = data.toolOwners ?? {};
            // scopeAll：场景预设是跨会话的资产，候选集要取「所有 agent 的并集」，
            // 不能被某一个会话看得见什么限制住（否则绑了窄场景的会话里一编辑，
            // 满屏都是「不在当前列表里」）。
            const all = args?.scopeAll === true;
            let schemas = [];
            try {
                if (all) {
                    schemas = deps.allSchemas ? await deps.allSchemas() : await deps.tools.schemas();
                }
                else {
                    // 按 agent 取：这个 profile 里工具是按 preset / agent scope 注册的，
                    // 不带 scope 的 schemas() 只看得见全局层（常常只有一个）。
                    schemas = await (deps.schemasFor ? deps.schemasFor(args?.sessionId) : deps.tools.schemas());
                }
            }
            catch {
                schemas = [];
            }
            // 名单靠装配时剔除落地（restrict 那层撤不掉），所以 schemas() 里仍然有被关掉的工具。
            //
            // 这里**不筛**：插件页要的是「这个插件到底有几个工具」的完整事实，
            // 被当前会话那套预设关掉的工具也照样列出来，只是标成「预设关掉」。
            // 筛掉的话，在绑了窄预设的会话里插件卡片上的工具会凭空少掉一大截，
            // 看着像插件只剩几个工具。
            const rawSchemas = schemas.slice();
            const filter = all ? null : effective.toolFilter;
            const rows = rawSchemas.map((schema) => ({
                schema,
                allowed: all ? true : toolAllowedByFilter(filter, schema.name),
            }));
            const groups = new Map();
            for (const { schema, allowed } of rows) {
                const meta = classifyToolName(schema.name, overrides, scanned);
                const note = effective.tools?.[schema.name] ?? null;
                const key = `${meta.category}::${meta.owner}`;
                let group = groups.get(key);
                if (!group) {
                    group = {
                        category: meta.category,
                        categoryLabel: CATEGORY_LABELS[meta.category] ?? meta.category,
                        owner: meta.owner,
                        overridden: meta.overridden === true,
                        tools: [],
                    };
                    groups.set(key, group);
                }
                group.tools.push({
                    name: schema.name,
                    description: schema.description ?? '',
                    alias: note?.alias ?? '',
                    note: note?.description ?? '',
                    inject: note?.inject === true,
                    injectSource: note?.injectSource ?? null,
                    aliasSource: note?.aliasSource ?? null,
                    // 当前会话这套预设有没有关掉它。false = 模型看不见（界面标出来，但不隐藏）
                    allowed,
                });
            }
            const order = [CATEGORY_SYSTEM, CATEGORY_PLUGIN, CATEGORY_MCP, CATEGORY_OTHER];
            const byCategoryThenOwner = (a, b) => {
                const d = order.indexOf(a.category) - order.indexOf(b.category);
                return d !== 0 ? d : a.owner.localeCompare(b.owner);
            };
            const list = [...groups.values()].sort(byCategoryThenOwner);

            // 生效工具集合（按名单筛过）与「归属者 → 它名下全部工具」（按名单筛之前）。
            // 段落关联要靠这两张表判断「关联着的工具是不是全被关掉了」。
            const visibleNames = new Set(rows.filter((r) => r.allowed).map((r) => r.schema?.name).filter(Boolean));
            const toolsByOwner = new Map();
            for (const schema of rawSchemas) {
                const meta = classifyToolName(schema.name, overrides, scanned);
                const base = packageBaseName(meta.owner);
                if (!base) {
                    continue;
                }
                if (!toolsByOwner.has(base)) {
                    toolsByOwner.set(base, []);
                }
                toolsByOwner.get(base).push(schema.name);
            }

            // —— 段落 ↔ 工具组 关联 ——
            // 段落本身没有归属（宿主只给 {name,text}），靠两条线索接回工具组：
            // 名字前缀 `tool:bash` 对上工具真名；来源插件包名对上归属者。
            // 第三条：认得来源插件、但那个包一个工具都没注册（如 dsh-kaomoji）——
            // 这时给它补一个只带段落的空工具组，归到「插件工具」下。
            // 接不上的不藏起来，单独列成「未归组」。
            // `mcp:<server>` 那些段落是 MCP 服务器自己推过来的，已经搬进「MCP」页
            // 跟对应的连接器长在一起了（那边能直接改、能关注入）。这里不重复列，
            // 免得同一个东西在两页各有一份、改哪份都不对。
            // 人点出来的归属（段落名 → 归属包名）：宿主不给归属，反查源码也猜不出来时，
            // 这是把「未归组」的段落挂到某个插件名下的唯一办法。点过名的按点名的归。
            const sectionOwners = data.sectionOwners ?? {};
            // 第二道防线：段落目录里的记录是「只增不减」的，插件卸载后那条记录还在，
            // 于是 section-map.js 会给它补出一个「只有段落、没有工具」的空组，
            // 界面上就多出一张已经卸掉的插件的卡片。
            // 索引侧已经按清单清过一遍（reconcileUninstalled），这里再挡一次：
            // 来源包已经不在「当前装着什么」清单里的段落，直接不参与关联。
            const installed = await deps.installedNames?.().catch?.(() => null) ?? null;
            const catalog = (deps.sectionCatalog ? deps.sectionCatalog.list() : [])
                .filter((section) => !String(section?.name ?? '').startsWith('mcp:'))
                .filter((section) => {
                    const plugin = String(section?.plugin ?? '').trim();
                    if (!plugin) {
                        return true;
                    }
                    return isOwnerInstalled(plugin, installed);
                })
                .map((section) => {
                    const pinned = String(sectionOwners[section?.name] ?? '').trim();
                    return pinned
                        ? { ...section, plugin: pinned, owner: pinned, pinnedOwner: pinned }
                        : section;
                });
            const { byGroup, ungrouped, sectionOnlyGroups } = associateSections(list, catalog, sectionOwners);
            // 只注入段落的插件补出来的空组：并进列表再排一次序，界面上才有它们的位置。
            if (sectionOnlyGroups.length > 0) {
                list.push(...sectionOnlyGroups);
                list.sort(byCategoryThenOwner);
            }

            // 正在编辑的那一层（全局/工作区/会话）自己存了什么。
            // 工具列表按**当前会话**算（那是模型真正看到的那份），
            // 但「这一层点没点名这一段」得看被编辑层自己的表 —— 否则在全局层
            // 看到的是会话层的决定，改起来会对不上号。
            // 备注/逐段开关/逐段覆写都是全局一份，所以「这一层自己存了什么」
            // 就直接看全局层 —— 界面上没有层选择。
            const editLayer = layerOf(data, GLOBAL_KEY) ?? {};
            const ownStates = editLayer.sectionStates ?? {};
            const ownOverrides = editLayer.sectionOverrides ?? {};

            // 「系统提示词覆盖」模式的角色卡会直接盖掉那几条段落 —— 面板上显示的
            // 「生效文字」必须连这一层算进去，否则用户改了行为约束、这里还是旧文字。
            const personaTexts = personaSectionTexts(effective.persona);

            const decorate = (section) => {
                const name = section?.name;
                const personaText = personaTexts.get(name) ?? null;
                const state = effective.sectionStates?.[name] ?? null;
                const layerOverride = effective.sectionOverrides?.[name] ?? null;
                const injected = state
                    ? state.enabled
                    : sectionAllowedByFilter(effective.sectionFilter, name);
                const ownState = Object.prototype.hasOwnProperty.call(ownStates, name)
                    ? ownStates[name]
                    : null;
                return {
                    name,
                    owner: section.owner ?? '',
                    plugin: section.plugin ?? null,
                    // 这个归属是人点出来的（不是扫源码猜的）
                    pinnedOwner: section.pinnedOwner ?? null,
                    file: section.file ?? null,
                    line: section.line ?? null,
                    snippet: section.snippet ?? '',
                    text: section.text ?? '',
                    // 宿主标了 interpolate: false 的段落：宿主不插值。
                    // （覆写里写 `{{…}}` 仍可用 —— 那是本插件在装配时替换的。）
                    literal: section.literal === true,
                    // 正文每轮会变（服务器名单、工作目录…）：覆写会冻住，界面上要提醒。
                    dynamic: section.dynamic === true,
                    // 这一段**原文里自己用到**的占位符：自动认领，编辑它时就能直接引用。
                    textVars: tokensInText(section.text),
                    stale: section.stale === true,
                    // 生效文字：角色卡（系统提示词覆盖）> 层内覆写 > 目录里的全局覆写 > 原文
                    overrideText: personaText ?? layerOverride?.text ?? section.override ?? null,
                    overrideSource: personaText !== null
                        ? `角色卡「${effective.persona?.name ?? ''}」`
                        : layerOverride?.source ?? null,
                    // 角色卡注入：面板上单独标一句，跟「有人手改过这段」区分开。
                    personaInjected: personaText !== null,
                    // 名次是不是被固定住的（装配时钉到前三条之一）。
                    pinned: isPinnedSection(section.name),
                    // 白名单常开：这一段永远注入，预设/场景的名单摘不掉它。
                    alwaysOn: isAlwaysOnSection(section.name),
                    position: Number(section.position) > 0 ? Number(section.position) : null,
                    catalogOverride: typeof section.override === 'string' && section.override !== ''
                        ? section.override
                        : null,
                    // 改写要不要真的注入（false = 留着改写但用原文）
                    overrideInjected: section.overrideInjected !== false,
                    // 关联到哪几个工具：null = 默认关联来源插件（那个包下的全部工具）
                    bindTools: Array.isArray(section.bindTools) ? section.bindTools : null,
                    // 注入状态：显式逐段决定 > 整体名单 > 默认注入
                    injected,
                    injectExplicit: state !== null,
                    injectSource: state?.source ?? effective.sectionFilter?.source ?? null,
                    // 被编辑层**自己**的决定（null = 这一层没点名，听上面的）
                    ownEnabled: ownState === null ? null : ownState === true,
                    ownOverrideText: typeof ownOverrides[name] === 'string' ? ownOverrides[name] : null,
                };
            };
            const groupNotes = data.groupNotes ?? {};
            for (const group of list) {
                // 归属者那一行自己的备注（跟单个工具的备注分开存）。
                group.note = typeof groupNotes[`${group.category}::${group.owner}`] === 'string'
                    ? groupNotes[`${group.category}::${group.owner}`]
                    : '';
                // 这个归属者名下有哪些工具 —— 关联编辑器的候选就限定在插件自己的工具里。
                const ownerTools = (group.tools ?? []).map((t) => t?.name).filter(Boolean);
                group.sections = (byGroup.get(`${group.category}::${group.owner}`) ?? [])
                    .map(decorate)
                    .map((sec) => {
                        const explicit = Array.isArray(sec.bindTools) && sec.bindTools.length > 0
                            ? sec.bindTools
                            : null;
                        const ownerBase = sectionOwnerBase(sec);
                        // 默认关联 = 这个包下的**全部**工具（含被名单关掉的），
                        // 否则「全关」永远算不出来 —— 关掉的那些根本不在 group.tools 里。
                        // 与装配时的关联口径保持一致：`tool:bash` 段落绑 bash。
                        const fromName = String(sec.name ?? '').startsWith('tool:')
                            ? [String(sec.name).slice('tool:'.length)]
                            : null;
                        const bound = explicit ?? fromName ?? (toolsByOwner.get(ownerBase) ?? []);
                        const allOff = bound.length > 0 && !bound.some((n) => visibleNames.has(n));
                        const bindLabel = explicit
                            ? `关联：${explicit.length > 3
                                ? `${explicit.slice(0, 3).join('、')} 等 ${explicit.length} 个`
                                : explicit.join('、')}`
                            : fromName
                                ? `关联：工具 ${fromName[0]}`
                                : `关联：插件 ${ownerBase || '（未知）'}`;
                        const sourceHint = sec.source
                            ? null
                            : (String(sec.name ?? '').startsWith('mcp:') && ownerBase
                                ? `MCP 服务器 ${ownerBase}`
                                : null);
                        return { ...sec, ownerTools, bindTools: explicit, boundCount: bound.length, bindLabel, bindAllOff: allOff, sourceHint };
                    });
            }
            return {
                groups: list,
                // total = 这个会话里注册的工具总数（含被预设关掉的）；
                // offTotal = 其中被当前预设关掉、模型看不见的那部分。
                total: rows.length,
                offTotal: rows.filter((r) => !r.allowed).length,
                // 「插件」页要的包元信息（版本 / 简介 / 装在哪）：宿主没这个服务，
                // 是扫包时顺手从各自 package.json 读的。
                plugins: [...(scanned?.packages?.values?.() ?? [])],
                ungroupedSections: ungrouped.map(decorate),
                // 归属识别的健康度：让界面能告诉人「哪些结论是猜的、
                // 哪些是实测的、哪些该重新测了」。
                attribution: {
                    // 实测（深度排查观测到）的工具名集合。
                    probed: [...(scanned?.probed?.keys?.() ?? [])],
                    // 被剔掉的幽灵条目（源码里有、运行时没有）。
                    droppedGhosts: scanned?.droppedGhosts ?? [],
                    // 官方表里运行时已不存在的条目（表漂移了）。
                    expiredOfficial: scanned?.expiredOfficial ?? [],
                    // 各插件的验证状态：verified / unverified / unverifiable。
                    probeStatus: deps.probeStatus ? await deps.probeStatus() : [],
                    // 这份归属结果是「读缓存」还是「刚扫的」。
                    // 页面打开慢的时候先看这里：正常情况应该是 cached:true。
                    scan: deps.scanInfo ? deps.scanInfo() : null,
                },
            };
        },

        /**
         * 快速刷新归属：**核对插件集合有没有变**，变了才重扫。
         *
         * 归属表是落盘的，插件没装没卸没升级的时候重扫一万遍结果都一样 ——
         * 所以先比指纹（十几毫秒），一样就直接回「没变化，秒回」；
         * 全量重扫要读 294 个官方包的源码，一次 16 秒。
         *
         * 不重启任何插件。真正让归属跟着新装插件走的是：
         *   ① 这个按钮；② 变化监测的 tick（自己会核对指纹）；
         *   ③ 页面加载时的静默核对（get() 里那条不阻塞的后台检查）。
         *
         * @param {object} [args] `force: true` = 不管指纹，强制重扫（只在怀疑缓存坏了时用）。
         */
        'tools-refresh': async (args) => {
            const force = args?.force === true;
            if (force) {
                deps.scanner.invalidate({ dropDisk: true });
            }
            const { rescanned } = deps.scanner.verify ? await deps.scanner.verify() : { rescanned: false };
            const scanned = await deps.scanner.get();
            return {
                ok: true,
                rescanned,
                forced: force,
                total: [...(scanned?.runtimeNames ?? [])].length,
                droppedGhosts: scanned?.droppedGhosts ?? [],
                expiredOfficial: scanned?.expiredOfficial ?? [],
                scan: deps.scanInfo ? deps.scanInfo() : null,
            };
        },

        /**
         * 深度排查：对还没实测过的插件逐一软重启，用「关掉看什么消失、
         * 再打开看什么回来」的差分反推它真实注册了哪些工具。
         *
         * 这是唯一能认出「工具名来自配置」那类插件的办法 ——
         * 源码里根本没有那个名字，只有运行时才知道。
         *
         * 结果存本地缓存（$DSH_HOME/scope-manager/probe-cache.json），
         * 不写第三方插件的 package.json。插件升级后版本对不上，结论自动作废。
         */
        'tools-probe': async (args) => {
            if (!deps.runProbe) {
                const error = new Error('这个宿主没有插件管理服务，没法软重启排查');
                error.code = 'unsupported';
                throw error;
            }
            const only = args?.packages && Array.isArray(args.packages)
                ? new Set(args.packages.map((p) => String(p)))
                : null;
            const result = await deps.runProbe({ only });
            // 不用作废扫描缓存：实测结论（probed）不在落盘那份里，
            // 每次 get() 都会现读 probe-cache.json 重算，测完立刻生效。
            return result;
        },

        /**
         * 插件变化监测：读现状（基线 / 事件流 / 自动排查开关）。
         *
         * 事件流回答的是「最近装了什么、升了什么、多了哪些工具和提示词段落」，
         * 不用再靠人想起来去点刷新。
         */
        'plugins-watch': async () => {
            if (!deps.pluginWatch) {
                return { available: false, autoProbe: false, baselineAt: 0, lastRunAt: 0, entries: [], events: [] };
            }
            return deps.pluginWatch.status();
        },

        /**
         * 立刻跑一轮监测。
         *
         * `probe: false` = 只看变化、不重启插件（安全，秒回）；
         * 缺省或 true = 新装/升级的那些顺手做一次软重启差分验证。
         */
        'plugins-watch-run': async (args) => {
            if (!deps.pluginWatch) {
                const error = new Error('这个宿主没有插件管理服务，没法监测插件变化');
                error.code = 'unsupported';
                throw error;
            }
            const options = args && 'probe' in args ? { probe: args.probe !== false } : {};
            const result = await deps.pluginWatch.run(options);
            if (result?.events?.length) {
                // 归属可能变了：核对指纹，变了就重扫（没变秒回）。
                // 注意不能用 invalidate() —— 那只是丢掉内存，变更的事实还在磁盘上。
                await deps.scanner.verify?.().catch?.(() => { });
            }
            return { ok: true, ...result, status: await deps.pluginWatch.status() };
        },

        /** 自动排查开关：新装/升级时要不要顺手软重启验证。 */
        'plugins-watch-auto': async (args) => {
            if (!deps.pluginWatch) {
                const error = new Error('这个宿主没有插件管理服务');
                error.code = 'unsupported';
                throw error;
            }
            return deps.pluginWatch.setAutoProbe(args?.enabled !== false);
        },

        /** 把当前状态当作基线（清空事件流）。 */
        'plugins-watch-reset': async () => {
            if (!deps.pluginWatch) {
                const error = new Error('这个宿主没有插件管理服务');
                error.code = 'unsupported';
                throw error;
            }
            return { ok: true, ...(await deps.pluginWatch.reset()) };
        },

        /**
         * 设置某一段跟哪些工具绑定。
         *
         * 不传 / 传空 = 默认关联「来源插件」：那个包下的工具**全部关掉**才不注入。
         * 传名字数组 = 只认这几个工具，一个都不在（场景里关了）就不注入。
         * 这是全局一份的关联关系，与作用域无关。
         */
        /** 段落归属到哪个插件（'' = 取消归属）。宿主不给归属，这是人点出来的那份。 */
        'section-owner-save': async (args) => {
            const name = String(args?.name ?? '').trim();
            const owner = String(args?.owner ?? '').trim();
            if (!name) {
                const error = new Error('要指定段落名');
                error.code = 'bad-request';
                throw error;
            }
            await deps.store.mutate((data) => {
                if (!data.sectionOwners || typeof data.sectionOwners !== 'object') {
                    data.sectionOwners = {};
                }
                if (owner) {
                    data.sectionOwners[name] = owner;
                }
                else {
                    delete data.sectionOwners[name];
                }
                return data;
            });
            return { name, owner };
        },

        /** 段落归属：这一段跟哪几个工具走（null = 回到默认：关联来源插件）。 */
        'section-bind-save': async (args) => {
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺段落名');
            }
            const tools = Array.isArray(args?.tools)
                ? args.tools.filter((t) => typeof t === 'string' && t !== '')
                : null;
            const ok = deps.sectionCatalog.setBind(name, tools);
            if (!ok) {
                throw new Error(`目录里没有这一段：${name}`);
            }
            return { ok: true, name, bindTools: tools && tools.length > 0 ? tools : null };
        },

        /**
         * 写某一层的「逐段注入开关」。
         *
         * enabled: true = 强制注入；false = 强制不注入；null/undefined = 删掉这个键
         * （回到「听整体名单的」）。整体名单是一层一整张的，逐段开关是点名决定的，
         * 优先级更高 —— 场景里排掉了一段，会话里可以点名把它放回来。
         */
        'section-state-save': async (args) => {
            // 全局一份：这几样设置与作用域无关，永远落在全局层。
            const key = GLOBAL_KEY;
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺段落名');
            }
            const enabled = args?.enabled === true ? true : args?.enabled === false ? false : null;
            await deps.store.mutate((data) => {
                const layer = { ...layerOf(data, key) };
                const map = { ...(layer.sectionStates ?? {}) };
                if (enabled === null) {
                    delete map[name];
                }
                else {
                    map[name] = enabled;
                }
                if (Object.keys(map).length > 0) {
                    layer.sectionStates = map;
                }
                else {
                    delete layer.sectionStates;
                }
                setLayer(data, key, layer);
                return data;
            });
            await deps.afterChange();
            return { name, enabled };
        },

        /**
         * 写某一层的「逐段文字覆写」。
         *
         * text 为空 = 删掉这一层的覆写（回到目录里的全局覆写，或者原文）。
         * 覆写不写回插件源码，只在装配那一瞬间换掉那段文字。
         */
        'section-layer-override-save': async (args) => {
            // 全局一份：这几样设置与作用域无关，永远落在全局层。
            const key = GLOBAL_KEY;
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺段落名');
            }
            const text = typeof args?.text === 'string' ? args.text : '';
            await deps.store.mutate((data) => {
                const layer = { ...layerOf(data, key) };
                const map = { ...(layer.sectionOverrides ?? {}) };
                if (text === '') {
                    delete map[name];
                }
                else {
                    map[name] = text;
                }
                if (Object.keys(map).length > 0) {
                    layer.sectionOverrides = map;
                }
                else {
                    delete layer.sectionOverrides;
                }
                setLayer(data, key, layer);
                return data;
            });
            await deps.afterChange();
            return { name, cleared: text === '' };
        },

        /** 改一个工具的备注（显示名 / 描述 / 是否作为注入描述）。 */
        'tool-note-save': async (args) => {
            // 全局一份：这几样设置与作用域无关，永远落在全局层。
            const key = GLOBAL_KEY;
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺少工具名');
            }
            const note = {
                alias: typeof args?.alias === 'string' ? args.alias : '',
                description: typeof args?.description === 'string' ? args.description : '',
                inject: args?.inject === true,
            };
            await deps.store.mutate((data) => {
                const layer = { ...layerOf(data, key) };
                const tools = { ...(layer.tools ?? {}) };
                if (note.alias === '' && note.description === '' && note.inject !== true) {
                    delete tools[name];
                }
                else {
                    tools[name] = note;
                }
                layer.tools = tools;
                setLayer(data, key, layer);
                return data;
            });
            await deps.afterChange();
            return { name };
        },

        /**
         * 归属者那一行的备注（`<类别>::<归属者>`）。
         *
         * 跟工具的备注分开存：那条算「这个插件是干什么的」，不该被工具改名/迁包带跑。
         * 全局一份，与作用域无关。
         */
        'group-note-save': async (args) => {
            // 面板内部的行号 key 会带 `o:` 前缀（`o:plugin::xxx`），存备注要去掉，
            // 否则写进去的键和 tools-list 读的键对不上，存了也看不到。
            const key = String(args?.key ?? '').trim().replace(/^o:/, '');
            if (!key || !key.includes('::')) {
                throw new Error('缺少分组键（<类别>::<归属者>）');
            }
            const text = typeof args?.text === 'string' ? args.text.trim() : '';
            await deps.store.mutate((data) => {
                const notes = { ...(data.groupNotes ?? {}) };
                if (text === '') {
                    delete notes[key];
                }
                else {
                    notes[key] = text;
                }
                data.groupNotes = notes;
                return data;
            });
            await deps.afterChange();
            return { key, cleared: text === '' };
        },

        /** 手工改工具归属（扫包猜错了的时候救场）。 */
        'tool-owner-save': async (args) => {
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺少工具名');
            }
            const category = String(args?.category ?? CATEGORY_OTHER);
            const owner = String(args?.owner ?? '未归属').trim() || '未归属';
            await deps.store.mutate((data) => {
                data.toolOwners = data.toolOwners ?? {};
                data.toolOwners[name] = { category, owner };
                return data;
            });
            deps.scanner.invalidate();
            await deps.afterChange();
            return { name, category, owner };
        },

        // —— 角色卡 ——
        // 列表要把正文一起带上：界面上的「列表」既能选，也能直接预览/编辑，
        // 只给 meta 会让编辑器打开就是空白的。角色卡数量不多，整体读回没有代价。
        'persona-list': async () => ({ personas: await deps.listPersonasWithBody() }),
        'persona-read': async (args) => {
            const persona = await deps.readPersona(String(args?.id ?? ''));
            if (!persona) {
                throw new Error('找不到这张角色卡');
            }
            return { persona };
        },
        'persona-save': async (args) => {
            const persona = await deps.savePersona({
                id: args?.id,
                name: args?.name,
                description: args?.description,
                // 三段正文 + 注入方式；老调用方只传 body 时原样透传（落到「角色设定」）。
                worldview: args?.worldview,
                character: args?.character,
                constraints: args?.constraints,
                inject: args?.inject,
                body: args?.body,
            });
            await deps.refreshLibrary();
            await deps.afterChange();
            return { persona };
        },
        'persona-delete': async (args) => {
            const id = String(args?.id ?? '');
            await deps.deletePersona(id);
            await deps.refreshLibrary();
            await deps.afterChange();
            return { id };
        },

        // —— 场景预设 ——
        'scene-list': async () => ({ scenes: await deps.listScenes() }),
        'scene-read': async (args) => {
            const scene = await deps.readScene(String(args?.id ?? ''));
            if (!scene) {
                throw new Error('找不到这个预设');
            }
            return { scene };
        },
        'scene-save': async (args) => {
            // 「新装的插件工具默认不激活」这条规矩要在保存时落成实际名单，
            // 不然基线一刷新，那个工具就悄悄恢复激活了。基线取全量目录 ——
            // 场景是跨会话的资产，不能按当前会话看得见什么来定。
            let toolFilter = args?.toolFilter ?? undefined;
            if (toolFilter && typeof toolFilter === 'object') {
                let catalogNames = [];
                try {
                    const schemas = deps.allSchemas ? await deps.allSchemas() : await deps.tools.schemas();
                    catalogNames = (Array.isArray(schemas) ? schemas : []).map((s) => String(s?.name ?? '')).filter(Boolean);
                }
                catch {
                    catalogNames = [];
                }
                toolFilter = settleToolFilter(toolFilter, catalogNames);
                // 卸掉的插件留在这里的名字等于幽灵：它永远不会再生效，却一直占着计数、
                // 让「已停用 N」越滚越大。保存时顺手清掉。目录为空（宿主刚起、工具还没挂上）
                // 时不动手，否则一次保存能把整份名单清空。
                if (catalogNames.length > 0 && Array.isArray(toolFilter?.names)) {
                    const live = new Set(catalogNames);
                    const kept = toolFilter.names.filter((n) => live.has(n));
                    if (kept.length !== toolFilter.names.length) {
                        toolFilter = { ...toolFilter, names: kept };
                    }
                }
            }
            const scene = await deps.saveScene({
                id: args?.id,
                name: args?.name,
                description: args?.description,
                persona: args?.persona,
                tools: args?.tools,
                toolFilter,
                sectionFilter: args?.sectionFilter,
                skills: args?.skills,
                permission: args?.permission,
            });
            await deps.refreshLibrary();
            await deps.afterChange();
            return { scene };
        },
        // 系统提示词段落：清单来自「见过就记下」的目录，宿主不提供归属信息。
        'sections-list': async () => ({
            // `pinned` 让界面能把「固定名次」的那几条标出来：名次是装配时钉的，
            // 不标的话用户看到数字会以为那是插件自己排的。
            sections: (deps.sectionCatalog ? deps.sectionCatalog.list() : [])
                .map((entry) => ({
                    ...entry,
                    pinned: isPinnedSection(entry?.name),
                    alwaysOn: isAlwaysOnSection(entry?.name),
                })),
            pinOrder: PINNED_SECTIONS,
            alwaysOn: ALWAYS_ON_SECTIONS,
        }),

        /**
         * 宿主认识的提示词变量（`{{名字}}`）。取自最近一次装配的 `assembly.variables` ——
         * 宿主没有「列出已注册变量」的接口，这已经是唯一的观测窗口。
         */
        'variables-list': async () => {
            const snapshot = deps.sectionCatalog?.variables?.() ?? { list: [], capturedAt: 0 };
            const hostNames = new Set((snapshot.list ?? []).map((v) => v.name));
            // 本插件自己的变量：界面上要跟宿主的那些一起列出来，并且标个来路。
            const own = SCM_VAR_NAMES
                .filter((name) => !hostNames.has(name))
                .map((name) => ({ name, value: '', scm: true }));
            return { ...snapshot, list: [...(snapshot.list ?? []), ...own] };
        },

        /**
         * 清理「上一次装配里没出现、且没有覆写」的段落条目。
         * 带覆写的留着：删了条目覆写就成孤儿，插件装回来时用户改过的文字会丢。
         */
        'sections-prune': async () => {
            if (!deps.sectionCatalog || typeof deps.sectionCatalog.prune !== 'function') {
                throw new Error('段落目录不可用');
            }
            const result = deps.sectionCatalog.prune();
            return {
                removed: result.removed,
                remaining: (deps.sectionCatalog.list() ?? []).length,
                reason: result.reason ?? null,
            };
        },

        /**
         * 段落覆写：**不写回插件源码**，只在装配那一瞬间把 text 换掉。
         * text 为空 = 清除覆写，回到插件原本那段文字。
         */
        /** 改写内容要不要注入（false = 留着改写，但装配时仍用插件原文）。 */
        'section-override-inject': async (args) => {
            const name = String(args?.name ?? '');
            if (!name) {
                throw new Error('缺段落名');
            }
            if (!deps.sectionCatalog) {
                throw new Error('段落目录不可用');
            }
            const ok = deps.sectionCatalog.setOverrideInject(name, args?.inject !== false);
            if (!ok) {
                throw new Error(`段落「${name}」不在目录里`);
            }
            return { ok: true, name, inject: args?.inject !== false };
        },

        'section-override-save': async (args) => {
            const name = String(args?.name ?? '');
            if (!name) {
                throw new Error('缺段落名');
            }
            if (!deps.sectionCatalog) {
                throw new Error('段落目录不可用');
            }
            const text = typeof args?.text === 'string' ? args.text : '';
            if (text !== '' && text !== null) {
                // 未知 `{{变量}}` 是宿主在渲染时抛错、整轮废掉的错，不能等它炸：
                // 保存这一关就拦住。字面量段落（interpolate: false）不解析，不校验。
                const entry = (deps.sectionCatalog.list() ?? []).find((x) => x.name === name);
                if (entry && entry.literal !== true) {
                    // 已知变量 = 宿主注册的那些 + 本插件自己的（`{{mcp_servers}}`）。
                    // 后者由装配时替换，宿主永远看不到，所以不算「未知变量」。
                    const hostVars = (deps.sectionCatalog.variables?.()?.list ?? []).map((v) => v.name);
                    // 这一段原文里出现过的占位符：字面量段落里它们不会被宿主校验
                    // （本插件替换不掉的才留着），所以只有字面量段落才把它们当已知。
                    // 非字面量段落不能放宽 —— 换不掉的话宿主渲染时会抛错，整轮废掉。
                    const known = [
                        ...hostVars,
                        ...SCM_VAR_NAMES,
                        // 本段原文：永远能换（装配时用这一段的原文顶上）。
                        SELF_VAR,
                        ...(entry.literal === true ? (entry.textVars ?? []) : []),
                    ];
                    const verdict = validatePromptVars(text, known);
                    if (!verdict.ok) {
                        throw new Error(`这一段没保存：${verdict.message}`);
                    }
                }
            }
            const ok = deps.sectionCatalog.setOverride(name, text);
            if (!ok) {
                throw new Error(`段落「${name}」不在目录里`);
            }
            return { ok: true, name, cleared: text === '' };
        },

        'scene-delete': async (args) => {
            const id = String(args?.id ?? '');
            await deps.deleteScene(id);
            await deps.refreshLibrary();
            await deps.afterChange();
            return { id };
        },

        // —— MCP ——
        // 真源是两层 cordis.patch.yml，不是插件内存（详见 lib/mcp.js 顶部注释）。
        // 写完宿主靠 dsh-hmr 热重载，不用另外叫它重启。

        /** 连接器总表：补丁里的行 + 宿主挂上的状态 + 工具表里的工具。 */
        'mcp-list': async (args) => {
            const result = await deps.mcp.list();
            const data = deps.store.peek();
            // 逐工具开关是跨层共用的一个键，这里一起给出去。
            const toolStates = { ...(data?.mcpTools ?? {}) };
            // 显示名也是跨层共用的（键 = serverName）。
            const names = { ...(data?.mcpNames ?? {}) };
            // 这台连接器的系统提示词：MCP 服务器自己推的那段，名字就叫 `mcp:<serverName>`。
            // 它天然属于这一台连接器 —— 所以直接绑在卡片上，别让用户去插件页找。
            const scope = await normalizeScope(args);
            const effective = resolveEffective(data, deps.library.scenesById, deps.library.personasById, scope);
            const catalog = deps.sectionCatalog ? deps.sectionCatalog.list() : [];
            const sectionsByName = new Map(catalog.map((section) => [section.name, section]));
            // 工具的备注（显示名 / 描述备注 / 是否作为注入描述）和插件页是同一张表
            // （全局层的 `tools`），所以这里照样喂给 MCP 页，改哪边都通。
            const toolNotes = data?.global?.tools ?? {};
            const tools = (result.tools ?? []).map((group) => ({
                ...group,
                tools: (group.tools ?? []).map((tool) => {
                    const note = toolNotes[tool.name] ?? null;
                    return {
                        ...tool,
                        alias: note?.alias ?? '',
                        note: note?.description ?? '',
                        inject: note?.inject === true,
                    };
                }),
            }));
            const servers = (result.servers ?? []).map((s) => {
                const sectionName = `mcp:${s.serverName}`;
                const section = sectionsByName.get(sectionName);
                let prompt = null;
                if (section) {
                    const state = effective.sectionStates?.[sectionName] ?? null;
                    const layerOverride = effective.sectionOverrides?.[sectionName] ?? null;
                    prompt = {
                        name: sectionName,
                        text: section.text ?? '',
                        // 生效文字：层内覆写 > 目录里的全局覆写 > 原文
                        overrideText: layerOverride?.text ?? section.override ?? null,
                        injected: state ? state.enabled === true : sectionAllowedByFilter(effective.sectionFilter, sectionName),
                        injectExplicit: state !== null,
                        stale: section.stale === true,
                        dynamic: section.dynamic === true,
                        textVars: tokensInText(section.text),
                        bindTools: Array.isArray(section.bindTools) ? section.bindTools : null,
                    };
                }
                return {
                    ...s,
                    // 我们起的名字优先；没有就用外部插件（mcp-connector）记的那个。
                    name: names[s.serverName] ?? s.external?.name ?? '',
                    prompt,
                };
            });
            return {
                ...result,
                toolStates,
                names,
                servers,
                tools,
            };
        },

        /**
         * 让宿主重新读一遍补丁（= 刷新宿主那侧的连接器）。
         *
         * 宿主自己也在盯着补丁文件，但那是防抖 + 异步的；用户点「刷新」想要的是
         * 「现在就重新加载一遍」。这里直接叫宿主重算一次，然后把新的现场状态带回去。
         */
        'mcp-refresh': async () => {
            const result = await deps.mcp.refresh();
            // 光让宿主重读补丁救不回「fiber 已经被摘掉」的那些（entry 在、却没起），
            // 顺手把它们逐台重挂一遍。
            const healed = typeof deps.mcp.remountStuck === 'function'
                ? await deps.mcp.remountStuck()
                : { fixed: [], failed: [] };
            return { ...result, healed, list: await deps.mcp.list() };
        },

        /**
         * 新增或改一台服务器。
         *
         * 名字（显示名）不住在补丁行里 —— 宿主的 loader entry config 有 schema，
         * 塞不认识的键有风险 —— 所以单独存在存储的 `mcpNames` 表里（键 = serverName）。
         */
        'mcp-save': async (args) => {
            const input = args ?? {};
            const result = await deps.mcp.save(input);
            const name = String(input.name ?? '').trim();
            const serverName = String(result.serverName ?? input.serverName ?? '').trim();
            const previous = String(result.previousServerName ?? '').trim();
            if (serverName) {
                await deps.store.mutate((data) => {
                    const names = { ...(data.mcpNames ?? {}) };
                    // 改名了就把名字搬过去，别留一个指向旧名的孤儿键。
                    if (previous && previous !== serverName) {
                        delete names[previous];
                    }
                    if (name) {
                        names[serverName] = name;
                    }
                    else {
                        delete names[serverName];
                    }
                    data.mcpNames = names;
                    return data;
                });
            }
            await deps.afterChange();
            return { ...result, name };
        },

        /** 删一行。 */
        'mcp-remove': async (args) => {
            const result = await deps.mcp.remove(args ?? {});
            // 连接器没了，给它起的那条显示名也一起收走。
            const serverName = result?.serverName ?? '';
            if (serverName && deps.store.peek().mcpNames?.[serverName]) {
                await deps.store.mutate((data) => {
                    if (data.mcpNames) delete data.mcpNames[serverName];
                    return data;
                });
            }
            await deps.afterChange();
            return result;
        },

        /** 停用 / 启用。 */
        'mcp-toggle': async (args) => {
            const result = await deps.mcp.toggle(args ?? {});
            await deps.afterChange();
            return result;
        },

        /** 复制一台（留在原来那层，服务器名自动加后缀）。 */
        'mcp-copy': async (args) => {
            const result = await deps.mcp.copy(args ?? {});
            await deps.afterChange();
            return result;
        },

        /** 连通性探测。 */
        'mcp-check': async (args) => {
            return await deps.mcp.check(args ?? {});
        },

        /**
         * 逐个工具开关。
         *
         * 存的是跨层共用的 `mcpTools` 键，不走层里的 toolFilter ——
         * toolFilter 是整块取第一个的，往全局写会被会话层盖掉（详见 lib/store.js 顶部注释）。
         */
        'mcp-tool-toggle': async (args) => {
            const name = String(args?.name ?? '').trim();
            if (!name) {
                throw new Error('缺少工具名');
            }
            const disabled = args?.disabled === true;
            await deps.store.mutate((data) => {
                const tools = { ...(data.mcpTools ?? {}) };
                if (disabled) {
                    tools[name] = { disabled: true };
                }
                else {
                    delete tools[name];
                }
                data.mcpTools = tools;
                return data;
            });
            await deps.afterChange();
            return { name, disabled };
        },

        // —— 技能 ——
        // 技能视图同样是 scope 相关的：把当前会话的 agent 当 scope 传进去。

        'skill-list': async (args) => {
            // 和工具表一样：不带 scope 只看得见插件级那一份（实测只剩 genui 一个），
            // 会话里真正可用的技能要按 agent 取。
            // scopeAll：编辑场景时要看全量（跨会话资产）。
            const all = args?.scopeAll === true;
            const scope = all ? undefined : await scopeOf(args?.sessionId);
            const list = all && deps.allSkills
                ? await deps.allSkills()
                : await deps.listSkills({
                    cwd: String(args?.cwd ?? '') || undefined,
                    scope,
                });
            const effective = await effectiveFor(args);
            return { skills: list, filter: effective.skills, scoped: scope !== undefined };
        },
        'skill-read': async (args) => {
            const scope = await scopeOf(args?.sessionId);
            const skill = await deps.readSkillFile(String(args?.name ?? ''), {
                cwd: String(args?.cwd ?? '') || undefined,
                scope,
            });
            return { skill };
        },
        'skill-write': async (args) => {
            const scope = await scopeOf(args?.sessionId);
            const result = await deps.writeSkillFile(String(args?.name ?? ''), String(args?.content ?? ''), {
                cwd: String(args?.cwd ?? '') || undefined,
                scope,
            });
            return result;
        },

        /**
         * 停用 / 启用一个技能。
         *
         * 宿主没有独立的开关表，语义落在 frontmatter 的两个调用面开关上
         * （`disable-model-invocation` / `user-invocable`），
         * 和 dsh-mcp-studio 的 rewriteSkillPolicy 同一个口径。
         */
        'skill-policy': async (args) => {
            const scope = await scopeOf(args?.sessionId);
            const result = await deps.setSkillPolicy(String(args?.name ?? ''), args?.enabled !== false, {
                cwd: String(args?.cwd ?? '') || undefined,
                scope,
            });
            return result;
        },

        // —— 技能市场（SkillHub）——
        // 直接接 https://api.skillhub.cn 的公开接口（不用登录），详见 lib/skillhub.js 顶部。
        // 「安装」= 下 zip → 解开到 $DSH_HOME/skills/<slug>/ → 宿主 chokidar 自己广播 skills/change。

        'skill-remove': async (args) => {
            const name = String(args?.name ?? '');
            // 先在这个上下文里把技能列出来、拿到它那条的真实路径与位置，
            // 再交给卸载那一步 —— 卸载函数自己重新 list 那一次看不全。
            // 和 skill-list 一个口径：不带 agent scope 时宿主只给插件级那一份（只剩 genui），
            // 用户级装的技能根本不在里面。
            const scope = await scopeOf(args?.sessionId);
            const listed = await deps.listSkills({ cwd: String(args?.cwd ?? '') || undefined, scope });
            const found = (listed ?? []).find((item) => item?.name === name);
            if (!found) {
                const error = new Error(`找不到技能「${name}」`);
                error.code = 'bad-request';
                throw error;
            }
            const result = await deps.uninstallSkill({
                name, file: found.path, location: found.location,
            });
            return {
                ...result,
                skills: await deps.listSkills({ cwd: String(args?.cwd ?? '') || undefined, scope }),
            };
        },
        'skill-market-list': async (args) => deps.skillMarket.list({
            page: args?.page,
            pageSize: args?.pageSize,
            keyword: args?.keyword,
            category: args?.category,
            sortBy: args?.sortBy,
            order: args?.order,
        }),
        'skill-market-categories': async () => ({
            categories: await deps.skillMarket.categories(),
            home: deps.skillMarket.home,
        }),
        'skill-market-detail': async (args) => deps.skillMarket.detail(String(args?.slug ?? '')),
        'skill-market-install': async (args) => {
            const result = await deps.skillMarket.install({
                slug: String(args?.slug ?? ''),
                overwrite: args?.overwrite === true,
                version: args?.version === undefined ? undefined : String(args.version),
                // 「装到哪儿」：user = $DSH_HOME/skills（跨项目），project = <cwd>/.dsh/skills
                target: String(args?.target ?? 'user') === 'project' ? 'project' : 'user',
                cwd: String(args?.cwd ?? '') || undefined,
            });
            // 装完顺手把最新清单带回去，界面不用再单独拉一次。
            const scope = await scopeOf(args?.sessionId);
            const list = await deps.listSkills({
                cwd: String(args?.cwd ?? '') || undefined,
                scope,
            });
            return { ...result, skills: list };
        },
    };
}

/**
 * 注册这条路由。
 * @param {object} ctx 插件 ctx
 * @param {object} deps 宿主能力（webServer / connection）与 op 表
 */
export function installHttpApi(ctx, deps) {
    if (!deps?.webServer) {
        return;
    }
    ctx.effect(() => deps.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: async (req, res) => {
            const send = (status, payload) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };
            const hdr = (name) => {
                const v = req.headers?.[name];
                return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
            };
            if (String(req.method || 'POST').toUpperCase() !== 'POST') {
                send(405, { ok: false, error: 'method not allowed' });
                return;
            }
            if (hdr('x-dsh-plugin') !== PLUGIN_ID) {
                send(403, { ok: false, error: 'missing plugin gate header' });
                return;
            }
            // 宿主栅栏：Host 必须是回环（防 DNS rebinding）+ 浏览器会话 cookie。
            const connection = (() => {
                try {
                    return ctx.get('connection', false);
                }
                catch {
                    return undefined;
                }
            })();
            if (connection && typeof connection.admit === 'function') {
                const verdict = await connection.admit(req);
                if (verdict && verdict.ok === false) {
                    send(403, { ok: false, error: verdict.error ?? '调用方不是本机所有者身份' });
                    return;
                }
            }
            let payload = {};
            try {
                const text = await readBody(req);
                if (text.trim() !== '') {
                    payload = JSON.parse(text);
                }
            }
            catch (e) {
                send(400, { ok: false, error: String(e?.message ?? e) });
                return;
            }
            const op = String(payload.op ?? '');
            const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args))
                ? payload.args
                : {};
            const handler = deps.ops[op];
            if (!handler) {
                send(404, { ok: false, error: `unknown op: ${op}` });
                return;
            }
            try {
                const result = await handler(args);
                send(200, { ok: true, ...result });
            }
            catch (e) {
                // bad-request = 入参不合法（比如会话 id 带路径），不是服务器故障。
                const status = e?.code === 'bad-request' ? 400 : 500;
                send(status, { ok: false, code: e?.code, error: String(e?.message ?? e) });
            }
        },
    }));
}
