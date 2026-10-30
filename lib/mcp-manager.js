// MCP 连接器管理 · 宿主那一半的「门面」。
//
// lib/mcp.js 负责**纯函数**（补丁怎么读写、一行长什么样）；这里负责**现场事实**：
//   · 两层补丁分别在哪儿（全局 $DSH_HOME / 本 profile）；
//   · 宿主到底挂上了哪几台（loader 里的 entry）；
//   · 哪台真的连上了（工具注册表里的 `mcp__<server>__<tool>`）。
//
// 「用户说配了 MCP 却没被识别」这件事，只有把**补丁里的行**、**loader 里的 entry**、
// **工具表里的工具**这三样摆在一起看才能说清楚：
//   补丁有、loader 无      → 宿主没认这行（多半是这行被别的补丁盖掉了）
//   loader 有、工具无      → 挂上了但没连上（服务器地址/鉴权/网络的问题）
//   三样都有              → 正常
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    MCP_PLUGIN,
    PATCH_FILE_NAME,
    STATUS,
    checkServer,
    collectMcpRows,
    inputToRow,
    parsePatch,
    readPatch,
    removeRow,
    rowToServer,
    serializePatch,
    setRowDisabled,
    upsertServer,
    validateServerInput,
} from './mcp.js';
import { writeAtomic } from './atomic.js';
import { resolveDshHome } from './paths.js';
import { mcpServerOf } from './tool-owner.js';

/** 两层补丁的标识。 */
const LAYER_GLOBAL = 'global';
const LAYER_PROFILE = 'profile';

/** 工具名 → 服务器名（`mcp__<server>__<tool>`）。和插件页用的是同一个函数，避免两处口径不一致。 */
function serverOfTool(name) {
    return mcpServerOf(String(name ?? '')) ?? '';
}

/** 等一会儿（毫秒）。 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
    });
}

/**
 * 创建 MCP 管理器。
 *
 * @param {object} options
 * @param {object} options.ctx 插件 ctx
 * @param {() => Promise<Array<object>>} options.listSchemas 全量工具表
 * @returns {object} 管理器
 */
export function createMcpManager({ ctx, listSchemas }) {
    const logger = ctx?.logger;

    /** 本 profile 的目录与补丁路径（宿主服务优先，环境变量兜底）。 */
    function profileFacts() {
        let profile;
        try {
            profile = ctx?.get?.('profileContext', false);
        }
        catch {
            profile = undefined;
        }
        const home = profile?.home ?? resolveDshHome();
        const dir = profile?.dir
            ?? process.env.DSH_PROFILE_DIR
            ?? join(home, 'profiles', 'web');
        const patchPath = profile?.patchPath ?? join(dir, PATCH_FILE_NAME);
        return { home, dir, patchPath };
    }

    /** 两层补丁的位置。 */
    function layers() {
        const { home, dir, patchPath } = profileFacts();
        return [
            {
                key: LAYER_GLOBAL,
                label: '全局',
                hint: `${home}/${PATCH_FILE_NAME}`,
                path: join(home, PATCH_FILE_NAME),
                scope: '所有 profile 共用',
            },
            {
                key: LAYER_PROFILE,
                label: '本 profile',
                hint: patchPath,
                path: patchPath,
                scope: `只影响 ${dir}`,
            },
        ];
    }

    function layerByKey(key) {
        return layers().find((layer) => layer.key === key) ?? layers()[1];
    }

    /** 读一层补丁里的 MCP 行（读不到就当空）。 */
    async function readLayer(layerKey) {
        const layer = layerByKey(layerKey);
        const patch = await readPatch(layer.path);
        if (!patch.exists || !patch.doc) {
            return { layer, rows: [], exists: patch.exists };
        }
        return { layer, rows: collectMcpRows(patch.doc).map(rowToServer), exists: true };
    }

    /** loader 里挂着的 MCP entry。 */
    function loaderEntries() {
        const out = new Map();
        let loader;
        try {
            loader = ctx?.get?.('loader', false);
        }
        catch {
            loader = undefined;
        }
        if (!loader?.entries) {
            // 拿不到 loader ≠ 宿主没挂上，这两件事必须分开说。
            return { available: false, entries: out };
        }
        try {
            for (const entry of loader.entries()) {
                const options = entry?.options ?? {};
                if (options.name !== MCP_PLUGIN) {
                    continue;
                }
                let disabled = false;
                try {
                    disabled = entry.disabled === true;
                }
                catch {
                    // disabled 可能是表达式（!!js），求值失败时按「没停用」处理，
                    // 但绝不因此把整页 MCP 列表变成报错。
                    disabled = false;
                }
                out.set(String(options.id ?? ''), {
                    id: String(options.id ?? ''),
                    serverName: String(options.config?.serverName ?? ''),
                    disabled,
                    active: entry?.fiber?.state === 2,
                    // fiber 的原始状态：0=PENDING 1=LOADING 2=ACTIVE 3=FAILED 4=DISPOSED 5=UNLOADING
                    // 「停用后启用」的那一瞬间就是 PENDING/LOADING —— 那是「正在起来」，
                    // 不是「挂着但没激活」。分不清这两种，用户就会以为坏了。
                    state: entry?.fiber?.state ?? null,
                });
            }
        }
        catch (e) {
            logger?.warn?.(`[scope-manager] 读 loader 失败：${String(e?.message ?? e)}`);
        }
        return { available: true, entries: out };
    }

    /** 工具表里的 MCP 工具（按服务器分组）。 */
    async function toolBuckets() {
        const buckets = new Map();
        let schemas = [];
        try {
            schemas = await listSchemas?.() ?? [];
        }
        catch {
            schemas = [];
        }
        for (const schema of schemas) {
            const name = String(schema?.name ?? '');
            const server = serverOfTool(name);
            if (!server) {
                continue;
            }
            if (!buckets.has(server)) {
                buckets.set(server, []);
            }
            buckets.get(server).push({
                name,
                description: String(schema?.description ?? ''),
            });
        }
        for (const list of buckets.values()) {
            list.sort((a, b) => a.name.localeCompare(b.name));
        }
        return buckets;
    }

    /**
     * 一行的「现场状态」。
     *
     * 判据的顺序很重要：先看这行自己有没有被停用（补丁里写着 disabled），
     * 再看宿主挂没挂上（loader），最后看有没有工具（连上了没有）。
     *
     * 「停用 → 启用」之后，宿主要重新起这一台，这中间有个几十毫秒到几秒的窗口：
     * entry 在、fiber 还在 PENDING/LOADING。这时候说「挂着但没激活」是在吓人，
     * 应该说「正在启动…」—— 页面照着这个状态轮询，等它自己变成「已连接」。
     */
    function statusOf(server, entry, toolCount, loaderAvailable) {
        if (server.disabled) {
            return { status: STATUS.DISABLED, text: '已停用' };
        }
        if (!loaderAvailable) {
            return { status: STATUS.UNKNOWN, text: '拿不到宿主 loader 状态，只能确认补丁里有这一行' };
        }
        if (!entry) {
            return {
                status: STATUS.NOT_MOUNTED,
                text: '补丁里有这一行，但宿主没挂上（多半被另一层补丁盖住了）',
            };
        }
        const state = entry.state;
        if (state === 0 || state === 1) {
            return { status: STATUS.STARTING, text: '正在启动…（宿主刚把这台挂起来，等它连上）' };
        }
        if (state === 3) {
            return { status: STATUS.FAILED, text: '宿主挂它的时候出错了（看宿主日志）' };
        }
        if (state === 4 || state === 5) {
            return { status: STATUS.INACTIVE, text: '已经被宿主卸掉了（再点一次启用让它重新挂上）' };
        }
        if (!entry.active) {
            return { status: STATUS.INACTIVE, text: '宿主里挂着，但没激活' };
        }
        if (toolCount > 0) {
            return { status: STATUS.CONNECTED, text: `已连接（${toolCount} 个工具）` };
        }
        return { status: STATUS.NO_TOOLS, text: '已挂载但一个工具都没有（多半是服务器没连上）' };
    }

    /**
     * 别的插件也在管同一批 MCP 连接器。
     *
     * `dsh-mcp-connector`（插件市场里的「MCP 连接器」）把每个连接的显示名记在自己的
     * unit 状态里（`$DSH_HOME/storages/mcp_connector.json`）。这里**只读**，用来给
     * 还没在本插件起过名的连接器兜底显示名；本插件不写它，连接器一律按平台的
     * 补丁行（cordis.patch.yml）来连。
     */
    function externalOwners() {
        const { home } = profileFacts();
        const path = join(home, 'storages', 'mcp_connector.json');
        const owners = [];
        if (!existsSync(path)) {
            return owners;
        }
        let data;
        try {
            data = JSON.parse(readFileSync(path, 'utf8'));
        }
        catch (e) {
            logger?.warn?.(`[scope-manager] 读 ${path} 失败：${String(e?.message ?? e)}`);
            return owners;
        }
        const connections = data?.tables?.connections;
        if (!connections || typeof connections !== 'object') {
            return owners;
        }
        for (const [key, record] of Object.entries(connections)) {
            if (!record || typeof record !== 'object') {
                continue;
            }
            owners.push({
                owner: 'dsh-mcp-connector',
                key: String(key),
                serverName: String(record.serverName ?? ''),
                name: String(record.name ?? ''),
                url: String(record.url ?? ''),
                enabled: record.enabled === true,
            });
        }
        return owners;
    }

    /**
     * 列出全部连接器。
     *
     * @returns {Promise<{layers: Array<object>, servers: Array<object>, tools: Array<object>}>}
     */
    async function list() {
        const [global, profile] = await Promise.all([readLayer(LAYER_GLOBAL), readLayer(LAYER_PROFILE)]);
        const loader = loaderEntries();
        const buckets = await toolBuckets();
        const owners = externalOwners();
        const servers = [];
        for (const [layerKey, read] of [[LAYER_GLOBAL, global], [LAYER_PROFILE, profile]]) {
            for (const row of read.rows) {
                const entry = loader.entries.get(row.id);
                const tools = buckets.get(row.serverName) ?? [];
                const state = statusOf(row, entry, tools.length, loader.available);
                // 同名 id 两层都有：全局层生效，profile 那行是死的。
                const shadowed = layerKey === LAYER_PROFILE
                    && global.rows.some((other) => other.id === row.id);
                // 别的插件（dsh-mcp-connector）也记着这台连接器：它俩的启停必须一致，
                // 否则那个插件会把补丁行改回去（用户看到的「配了却没被识别」）。
                const owner = owners.find((item) => item.serverName === row.serverName) ?? null;
                const external = owner
                    ? {
                        ...owner,
                        agrees: owner.enabled !== row.disabled,
                    }
                    : null;
                servers.push({
                    ...row,
                    layer: layerKey,
                    layerLabel: read.layer.label,
                    shadowed,
                    toolCount: tools.length,
                    status: state.status,
                    statusText: state.text,
                    mounted: Boolean(entry),
                    active: entry?.active === true,
                    external,
                });
            }
        }
        const tools = [];
        for (const [server, list2] of buckets) {
            tools.push({ server, count: list2.length, tools: list2 });
        }
        tools.sort((a, b) => a.server.localeCompare(b.server));
        return {
            layers: layers().map((layer) => ({
                ...layer,
                exists: layer.key === LAYER_GLOBAL ? global.exists : profile.exists,
            })),
            servers,
            tools,
        };
    }

    /** 落盘：写补丁文件（原子写 + 保住 !!js 标签）。 */
    async function writeLayer(layerKey, mutate) {
        const layer = layerByKey(layerKey);
        const patch = await readPatch(layer.path);
        const doc = patch.exists && patch.doc ? patch.doc : parsePatch('[]\n');
        const result = mutate(doc);
        // 与 dsh-config-editor 同一个做法：把 __jsExpr 还原成 !!js 标签再写。
        await writeAtomic(layer.path, serializePatch(doc));
        return result;
    }

    /**
     * 新增或更新一台服务器。
     *
     * 落在哪一层：**已有行就地改它所在的那层**（profile 里同名行会被全局盖掉，
     * 在 profile 改它等于白改）；新行默认写进全局层 —— 全局层是所有 profile 共用的，
     * 「连接器启用 = 默认启用」，具体哪个场景用哪些工具去场景页做预设。
     */
    async function save(input) {
        const id = String(input?.id ?? '').trim();
        const problem = validateServerInput(input);
        if (problem) {
            const error = new Error(problem);
            error.code = 'bad-request';
            throw error;
        }
        const global = await readLayer(LAYER_GLOBAL);
        const profile = await readLayer(LAYER_PROFILE);
        let layerKey = String(input?.layer ?? '').trim();
        let existing = null;
        if (id) {
            existing = global.rows.find((row) => row.id === id) ?? profile.rows.find((row) => row.id === id) ?? null;
        }
        if (!existing) {
            layerKey = layerKey === LAYER_PROFILE ? LAYER_PROFILE : LAYER_GLOBAL;
        }
        else {
            layerKey = global.rows.some((row) => row.id === id) ? LAYER_GLOBAL : LAYER_PROFILE;
        }
        const serverName = String(input?.serverName ?? '').trim();
        // 同一个 serverName 在宿主里只能有一台（工具前缀是 mcp__<serverName>__），
        // 所以撞名直接拦下来，别写出一个"看着保存成功、实际起不来"的补丁。
        const conflict = [...global.rows, ...profile.rows]
            .find((row) => row.serverName === serverName && row.id !== id);
        if (conflict) {
            const error = new Error(`已经有一台叫「${serverName}」的服务器了（id: ${conflict.id}），换个名字`);
            error.code = 'bad-request';
            throw error;
        }
        let result;
        try {
            result = await writeLayer(layerKey, (doc) => {
                const merged = { ...input };
                if (existing) {
                    merged.id = existing.id;
                    // 保留原行没被这次编辑碰到的字段（比如 reconnect、timeout）。
                    merged.toolCallTimeoutMs = input?.toolCallTimeoutMs ?? existing.toolCallTimeoutMs ?? undefined;
                }
                return upsertServer(doc, merged);
            });
        }
        catch (e) {
            const error = new Error(`补丁没写成功：${String(e?.message ?? e)}`);
            error.code = 'bad-request';
            throw error;
        }
        return {
            id: result.id,
            created: result.created,
            layer: layerKey,
            serverName,
            // 改名时把「原来叫什么」也报回去，调用方要把显示名一起搬过去。
            previousServerName: existing ? existing.serverName : '',
            conflict: conflict ? conflict.id : undefined,
        };
    }

    /** 停用/启用。 */
    async function toggle({ id, disabled, layer }) {
        const target = String(id ?? '').trim();
        if (!target) {
            const error = new Error('缺 id');
            error.code = 'bad-request';
            throw error;
        }
        let layerKey = String(layer ?? '').trim();
        const global = await readLayer(LAYER_GLOBAL);
        const profile = await readLayer(LAYER_PROFILE);
        if (!global.rows.some((row) => row.id === target) && !profile.rows.some((row) => row.id === target)) {
            const error = new Error(`补丁里没有 id 为「${target}」的行`);
            error.code = 'bad-request';
            throw error;
        }
        if (!layerKey) {
            layerKey = global.rows.some((row) => row.id === target) ? LAYER_GLOBAL : LAYER_PROFILE;
        }
        await writeLayer(layerKey, (doc) => setRowDisabled(doc, target, disabled !== false));
        // 启用之后等宿主真的把这台挂起来 —— 用户点一下「启用」就该看到它连上，
        // 而不是隔一会儿自己刷新才看到（更不该停在「挂着但没激活」）。
        const stopped = disabled !== false;
        const row = await findRow(target);
        let settled = { status: STATUS.DISABLED, statusText: '已停用', toolCount: 0 };
        if (!stopped && row) {
            // 先让宿主重读补丁：entry 的 disabled 是内存里的 options 算出来的，
            // 光改文件不重算，它在宿主眼里仍然是停用的。
            const refreshed = await refresh();
            settled = await settle(row, { timeoutMs: 5000 });
            // 还没连上：宿主那一轮 reconcile 不一定能救回来。
            // 看 loader 源码 entry.update() 就知道：disabled 从 true 变 false 时，
            // 如果旧 fiber 的 uid 还在，它走的是「改配置」分支 —— 只 patch 上下文、
            // 不会重新 init()，于是永远停在「挂着但没激活」。
            // 所以这里兜底手动重挂一次：先把它摘干净，再让 entry 重新 init()。
            if (settled.status !== STATUS.CONNECTED) {
                const remounted = await remount(target);
                if (remounted.ok) {
                    settled = await settle(row, { timeoutMs: 20000 });
                }
                else if (remounted.reason) {
                    settled = { ...settled, remountError: remounted.reason };
                }
                if (!refreshed.refreshed && !remounted.ok) {
                    settled = { ...settled, refreshReason: refreshed.reason };
                }
            }
        }
        else if (stopped) {
            // 停用：宿主那轮 reconcile 会把 fiber dispose 掉，这里不等它，直接摘，
            // 界面点完立刻就是「已停用」。
            dropFiber(target);
        }
        return { id: target, layer: layerKey, disabled: stopped, ...settled };
    }

    /** 按 id 在两层补丁里找那一行。 */
    async function findRow(id) {
        const [global, profile] = await Promise.all([readLayer(LAYER_GLOBAL), readLayer(LAYER_PROFILE)]);
        return global.rows.find((row) => row.id === id)
            ?? profile.rows.find((row) => row.id === id)
            ?? null;
    }

    /** 按 id 从 loader 里拿 entry（拿不到返回 null）。 */
    function findEntry(id) {
        let loader;
        try {
            loader = ctx?.get?.('loader', false);
        }
        catch {
            loader = undefined;
        }
        if (!loader?.entries) return null;
        try {
            for (const entry of loader.entries()) {
                if (String(entry?.options?.id ?? '') === id) return entry;
            }
        }
        catch (e) {
            logger?.warn?.(`[scope-manager] 找 loader entry 失败：${String(e?.message ?? e)}`);
        }
        return null;
    }

    /** 停用后立刻把它从宿主里摘掉（不等宿主自己那轮 reconcile）。 */
    function dropFiber(id) {
        const entry = findEntry(id);
        try {
            entry?.fiber?.dispose?.();
            return true;
        }
        catch (e) {
            logger?.warn?.(`[scope-manager] 摘掉 ${id} 失败：${String(e?.message ?? e)}`);
            return false;
        }
    }

    /**
     * 手动把一台重新挂起来。
     *
     * 为什么要有这个：loader 的 `entry.update()` 在 `disabled` 从 true 变 false 时，
     * 只要旧 fiber 的 uid 还在（dispose 是异步的，那一瞬间 uid 可能还没清），
     * 就会走「改配置」分支 —— 只 patch 上下文、不重新 `init()`，于是 entry 在、
     * fiber 不在，界面上就是「宿主里挂着，但没激活」。
     * 这里把它做干净：dispose 旧的（uid 同步置 null）→ 等它真的空掉 → `init()` 新建 fiber。
     */
    async function remount(id) {
        const entry = findEntry(id);
        if (!entry) return { ok: false, reason: '宿主 loader 里没有这一条 entry' };
        try {
            if (entry.fiber) {
                entry.fiber.dispose?.();
                // dispose 的第一句就是 uid = null，正常一次就过；给点余量防它异步。
                for (let i = 0; i < 60; i += 1) {
                    if (!entry.fiber || entry.fiber.uid === null) break;
                    await sleep(50);
                }
            }
            if (typeof entry.init !== 'function') {
                return { ok: false, reason: '这个版本的 loader 没暴露 entry.init()' };
            }
            await entry.init();
            return { ok: true };
        }
        catch (e) {
            return { ok: false, reason: String(e?.message ?? e) };
        }
    }

    /**
     * 把「补丁里是启用的、宿主里却没在跑」的那些重新挂一遍。
     *
     * 「刷新宿主」按钮走这里：光让宿主重读补丁救不回已经被摘掉 fiber 的 entry，
     * 得逐台 dispose + init 才有用。
     */
    async function remountStuck() {
        const [global, profile] = await Promise.all([readLayer(LAYER_GLOBAL), readLayer(LAYER_PROFILE)]);
        const rows = [...global.rows, ...profile.rows];
        const loader = loaderEntries();
        const fixed = [];
        const failed = [];
        for (const row of rows) {
            if (row.disabled) continue;
            const entry = loader.entries.get(row.id);
            // loader 里压根没有这一条：不是我们能挂的，交给宿主那轮 reconcile。
            if (!entry || entry.active) continue;
            const result = await remount(row.id);
            if (result.ok) fixed.push(row.id);
            else failed.push({ id: row.id, reason: result.reason ?? '' });
        }
        return { fixed, failed };
    }

    /**
     * 等这台连接器在宿主里稳定下来。
     *
     * 宿主挂一台 MCP 要走「起 fiber → 连服务器 → 拉工具表」三步，
     * 大几百毫秒到几秒不等。停用 → 启用之后那一瞬间，entry 在、fiber 还在 PENDING，
     * 界面上如果照那个瞬间的状态画，就是「挂着但没激活」——其实只是还没起来。
     * 所以这里轮询到状态稳定为止，把**最终**状态带回去给界面。
     */
    async function settle(row, { timeoutMs = 15000 } = {}) {
        const serverName = String(row?.serverName ?? '').trim();
        const deadline = Date.now() + timeoutMs;
        let previous = null;
        let stable = 0;
        let last = {
            status: STATUS.STARTING,
            statusText: '正在启动…（宿主刚把这台挂起来，等它连上）',
            toolCount: 0,
            active: false,
        };
        while (Date.now() < deadline) {
            const loader = loaderEntries();
            const buckets = await toolBuckets();
            const tools = buckets.get(serverName) ?? [];
            const entry = [...loader.entries.values()].find((item) => item.serverName === serverName) ?? null;
            const state = statusOf(row, entry, tools.length, loader.available);
            last = {
                status: state.status,
                statusText: state.text,
                toolCount: tools.length,
                active: entry?.active === true,
            };
            // 成了 / 挂了 / 压根没挂上：不用再等了。
            if (last.status === STATUS.CONNECTED
                || last.status === STATUS.FAILED
                || last.status === STATUS.NOT_MOUNTED
                || last.status === STATUS.DISABLED) {
                return last;
            }
            // 状态连着两轮没变 = 稳了（比如「已挂载但没连上」这种，它不会再自己变好）。
            stable = previous && previous.status === last.status ? stable + 1 : 0;
            previous = last;
            if (stable >= 1 && last.status !== STATUS.STARTING) {
                return last;
            }
            await sleep(400);
        }
        return last;
    }

    /**
     * 让宿主重新读一遍补丁。
     *
     * 宿主自己盯着补丁文件（dsh-hmr），改了它就会重载。但那要等它的防抖，
     * 而且「停用 → 启用」这种改动偶发赶不上（entry 还在、fiber 没起来）。
     * 这里直接叫宿主重算一次：能拿到 hmr 服务就用它的 reconcile，
     * 拿不到就等宿主自己的监听器（返回 refreshed:false，界面照常等状态稳定）。
     */
    async function refresh() {
        let hmr;
        try {
            hmr = ctx?.get?.('hmr', false);
        }
        catch {
            hmr = undefined;
        }
        if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') {
            return { refreshed: false, reason: '宿主没给 hmr 服务，只能等它自己发现补丁变了' };
        }
        try {
            await hmr.runExclusive(async () => {
                await hmr.reconcileProfile();
            });
            return { refreshed: true };
        }
        catch (e) {
            logger?.warn?.(`[scope-manager] 让宿主重读补丁失败：${String(e?.message ?? e)}`);
            return { refreshed: false, reason: String(e?.message ?? e) };
        }
    }

    /** 删一行。 */
    async function remove({ id, layer }) {
        const target = String(id ?? '').trim();
        let layerKey = String(layer ?? '').trim();
        const global = await readLayer(LAYER_GLOBAL);
        const profile = await readLayer(LAYER_PROFILE);
        if (!layerKey) {
            layerKey = global.rows.some((row) => row.id === target) ? LAYER_GLOBAL : LAYER_PROFILE;
        }
        let removed = false;
        let serverName = '';
        await writeLayer(layerKey, (doc) => {
            const row = collectMcpRows(doc).find((item) => item.id === target);
            if (row) serverName = rowToServer(row).serverName ?? '';
            removed = removeRow(doc, target);
        });
        if (!removed) {
            const error = new Error(`补丁里没有 id 为「${target}」的行`);
            error.code = 'bad-request';
            throw error;
        }
        // 把显示名一并带走，免得留着一条没人用的名字。
        return { id: target, layer: layerKey, serverName };
    }

    /** 复制一台：留在原来那层，服务器名自动加后缀（工具前缀必须唯一）。 */
    async function copy({ id, serverName }) {
        const target = String(id ?? '').trim();
        const global = await readLayer(LAYER_GLOBAL);
        const profile = await readLayer(LAYER_PROFILE);
        const source = global.rows.find((row) => row.id === target) ?? profile.rows.find((row) => row.id === target);
        if (!source) {
            const error = new Error(`补丁里没有 id 为「${target}」的行`);
            error.code = 'bad-request';
            throw error;
        }
        const layerKey = global.rows.some((row) => row.id === target) ? LAYER_GLOBAL : LAYER_PROFILE;
        // 名字必须全局唯一（工具前缀是 mcp__<serverName>__），撞了就继续往后加。
        const taken = new Set([...global.rows, ...profile.rows].map((row) => row.serverName));
        const base = String(serverName ?? '').trim() || `${source.serverName}-2`;
        let finalName = base;
        let suffix = 2;
        while (taken.has(finalName)) {
            finalName = `${base}-${suffix}`;
            suffix += 1;
        }
        let createdId = '';
        await writeLayer(layerKey, (doc) => {
            const result = upsertServer(doc, {
                ...source,
                id: '',
                serverName: finalName,
                disabled: source.disabled === true,
            });
            createdId = result.id;
        });
        return { id: createdId, serverName: finalName, layer: layerKey, from: target };
    }

    /** 连通性探测。 */
    async function check({ id, layer }) {
        const target = String(id ?? '').trim();
        const global = await readLayer(LAYER_GLOBAL);
        const profile = await readLayer(LAYER_PROFILE);
        const source = global.rows.find((row) => row.id === target)
            ?? profile.rows.find((row) => row.id === target)
            ?? null;
        if (!source) {
            const error = new Error(`补丁里没有 id 为「${target}」的行`);
            error.code = 'bad-request';
            throw error;
        }
        const result = await checkServer(source);
        return { id: target, ...result };
    }

    return {
        layers,
        list,
        save,
        toggle,
        remove,
        copy,
        check,
        refresh,
        remount,
        remountStuck,
        settle,
        externalOwners,
        serverOfTool,
        inputToRow,
    };
}
