// 删会话：宿主没有这条 API，只能自己做，而且是**动盘**的操作，所以每一步都要
// 能挡住「删错东西」。
//
// 思路取自 dsh-session-manager（它把这件事跑在生产里很久了），但砍到本插件需要的
// 规模。核心不是 rm，而是 rm 之前那五道门：
//   1. id 必须是合法会话标识（不能带路径分隔符 / 控制字符 / 结尾点空格）
//   2. 目标目录必须正好在 <sessions>/<project>/<session> 这一层，且沿途没有符号
//      链接 —— 否则 rm -rf 就是一把没有保险的刀
//   3. 会话还活着就先停：cancel(kind:'disposed') → scope.dispose() → 停活动，
//      停不下来就**拒绝删除**（而不是硬删一个正在写的文件）
//   4. 运行时先摘干净：flush → detach → 广播 session/disposed，再动盘
//   5. 子代理会话先删、父会话后删，父删失败时能报出「已经删掉哪几个」
// 顺序反了会留下幽灵行：文件没了但客户端还记着这一行，或者反过来。
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ARTIFACT_NAMES = [
    'session.v4.jsonl.zstd',
    'session.v3.jsonl.zstd',
    'session.v2.jsonl.zstd',
    'session.jsonl.zstd',
    'session.jsonl',
];

/** 和 DSH 内核 `encodeSegment` 同构：安全字符原样，其余 ~XXXX。 */
function encodeSegment(raw) {
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error('cannot encode an empty path segment');
    }
    if (raw === '.') {
        return '~002E';
    }
    if (raw === '..') {
        return '~002E~002E';
    }
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            out += ch;
        }
        else {
            out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
        }
    }
    return out;
}

/** 项目目录键：分隔符压成 `-`，其它不安全字符转义，末段截断到 251。 */
function projectKey(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('cannot encode an empty project path');
    }
    let readable = '';
    let separatorRun = false;
    for (let i = 0; i < cwd.length; i++) {
        const code = cwd.charCodeAt(i);
        const ch = String.fromCharCode(code);
        if (ch === '/' || ch === '\\' || ch === ':') {
            if (!separatorRun) {
                readable += '-';
            }
            separatorRun = true;
        }
        else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
            readable += ch;
            separatorRun = false;
        }
        else {
            readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
            separatorRun = false;
        }
    }
    return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}

/** 会话 id 的合法性：它会被当成路径段用，所以这里必须比「非空字符串」严。 */
function assertSessionId(id) {
    if (typeof id !== 'string' || id.trim() === '' || id === '.' || id === '..'
        || /[\\/\x00-\x1f<>"|?*]/.test(id) || /[. ]$/.test(id)) {
        throw Object.assign(new Error('会话 id 不合法，已停止文件操作'), { code: 'bad-request' });
    }
    return id;
}

/**
 * 只允许 `<sessions>/<project>/<session>` 这一层，且沿途全是真目录。
 *
 * 光比对字符串不够：`<sessions>/x/../../etc` 归一化后也能「像」目标目录，
 * 软链更可以直接把 rm 引到别处。所以先按段数挡一次，再 realpath 逐段确认
 * 落在根里面。
 */
async function assertSessionDirectory(root, directory, id) {
    assertSessionId(id);
    if (typeof root !== 'string' || typeof directory !== 'string') {
        throw new Error('无法验证会话目录，已停止文件操作');
    }
    const base = resolve(root);
    const target = resolve(directory);
    const rel = relative(base, target);
    const parts = rel.split(sep);
    const validNames = [encodeSegment(id)];
    if (id !== validNames[0]) {
        validNames.push(id);
    }
    if (isAbsolute(rel) || parts.length !== 2 || parts.some((p) => p === '..' || p === '.' || p === '')
        || !validNames.includes(parts[1])) {
        throw new Error('会话目录超出允许范围，已停止文件操作');
    }
    const canonicalRoot = await realpath(base);
    let current = base;
    for (const part of parts) {
        current = join(current, part);
        const info = await lstat(current); // 不存在就让它抛，不吞
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('会话目录不能是符号链接、junction 或普通文件');
        }
        const canonical = await realpath(current);
        const child = relative(canonicalRoot, canonical);
        if (isAbsolute(child) || child === '' || child.split(sep).includes('..')) {
            throw new Error('会话目录解析到了允许范围之外');
        }
    }
    return target;
}

/** 会话工件在哪：优先问持久化后端要（它知道代次与压缩），拿不到再自己拼。 */
function artifactCandidates(root, header) {
    const out = [];
    if (!header || typeof header !== 'object') {
        return out;
    }
    if (typeof header.id !== 'string' || header.id === '') {
        return out;
    }
    const project = typeof header.cwd === 'string' && header.cwd !== ''
        ? projectKey(header.cwd)
        : '_no-cwd';
    const dir = join(root, project, encodeSegment(header.id));
    for (const name of ARTIFACT_NAMES) {
        out.push(join(dir, name));
    }
    return out;
}

/**
 * 算出这个会话的目录；拿不到返回 undefined（= 只有活会话，没有落盘工件）。
 * @param {object} deps 依赖
 * @param {string} id 会话 id
 * @param {object} [knownHeader] 已经读到过的 header，省一次 list()
 */
async function sessionDirOf(deps, id, knownHeader) {
    assertSessionId(id);
    const root = deps.sessionsRoot;
    if (typeof root !== 'string') {
        return undefined;
    }
    let header = knownHeader;
    if (header === undefined && typeof deps.persistence?.list === 'function') {
        try {
            const all = await deps.persistence.list();
            header = all.map((x) => x?.header).find((h) => h?.id === id);
        }
        catch {
            /* 拿不到就用路径候选兜底 */
        }
    }
    // 后端自己能定位（jsonl 后端有 locate）—— 它知道代次和压缩。
    if (header !== undefined && typeof deps.persistence?.locate === 'function') {
        try {
            const located = deps.persistence.locate(header);
            const path = typeof located?.path === 'string' ? located.path : '';
            if (path) {
                const dir = dirname(path);
                await assertSessionDirectory(root, dir, id);
                return dir;
            }
        }
        catch {
            /* 落到下面按名字找 */
        }
    }
    for (const candidate of artifactCandidates(root, header)) {
        try {
            await lstat(candidate);
            return dirname(candidate);
        }
        catch {
            /* 换下一个 */
        }
    }
    // 没有 header 又没匹配上：按项目目录扫（罕见，但比「以为没有工件」安全）
    if (header === undefined) {
        try {
            const projects = await readdir(root, { withFileTypes: true });
            for (const project of projects) {
                if (!project.isDirectory() || project.isSymbolicLink()) {
                    continue;
                }
                const dir = join(root, project.name, encodeSegment(id));
                try {
                    const info = await lstat(dir);
                    if (info.isDirectory() && !info.isSymbolicLink()) {
                        return dir;
                    }
                }
                catch {
                    /* 没有就是没有 */
                }
            }
        }
        catch {
            /* 根都读不了就认了 */
        }
    }
    return undefined;
}

/** 会话还活着吗？活着的定义取宿主的三个口径里任意一个。 */
function liveAgentOf(deps, id) {
    try {
        return deps.ctx?.agents?.get?.(id);
    }
    catch {
        return undefined;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 停掉会话的活动，停不下来就抛错 —— 宁可删失败，也不要删一个正在写的文件。
 * @param {object} deps 依赖
 * @param {string} id 会话 id
 * @param {boolean} isSubagent 报错文案用
 */
async function assertAndStopActive(deps, id, isSubagent) {
    const session = deps.sessions?.get?.(id);
    const agent = liveAgentOf(deps, id);
    const activeTurn = session?.activeTurn;
    const running = agent?.status === 'running' || agent?.busy === true;
    if (activeTurn === undefined && !running) {
        return;
    }
    if (agent !== undefined) {
        try {
            agent.cancel?.({ kind: 'disposed' });
        }
        catch { /* 停不下来会在下面复查 */ }
        if (typeof agent.scope?.dispose === 'function') {
            // 有界：teardown 卡住时不能把整条删除流程一起挂死。
            await Promise.race([agent.scope.dispose(), sleep(3000)]);
        }
    }
    try {
        await deps.workspaceRegistry?.stopSessionActivity?.(id);
    }
    catch (err) {
        throw new Error(`停止${isSubagent ? '子代理' : '会话'}活动失败：${String(err?.message ?? err)}`);
    }
    const after = liveAgentOf(deps, id);
    if (after?.status === 'running' || after?.busy === true) {
        throw Object.assign(
            new Error(`${isSubagent ? '子代理' : '会话'}仍在运行，无法安全删除（先停止它再删）`),
            { code: 'running' },
        );
    }
}

/** 从运行时摘掉它：flush → detach →（没有活句柄时）广播 disposed。 */
async function detachRuntime(deps, id) {
    const session = deps.sessions?.get?.(id);
    let detached = false;
    if (session !== undefined) {
        try {
            await deps.sessions?.flush?.(session);
        }
        catch { /* 尽力 */ }
        try {
            const entry = deps.sessions?.store?.get?.(id);
            if (entry !== undefined && typeof entry.detach === 'function') {
                entry.detach();
                await sleep(200);
                detached = true;
            }
        }
        catch { /* 尽力 */ }
    }
    // 没有活句柄时没人会发 session/disposed，客户端那一行就永远留着。
    if (!detached) {
        try {
            deps.ctx?.emit?.('session/disposed', { id });
        }
        catch { /* 尽力 */ }
    }
}

/** 从所有工作区抹掉它的归属，并把归档/置顶状态一起清掉。 */
async function detachFromWorkspaces(deps, id) {
    const registry = deps.workspaceRegistry;
    if (!registry || typeof registry.list !== 'function') {
        return;
    }
    for (const entity of registry.list()) {
        try {
            const ids = entity?.sessionIds ?? [];
            if (Array.isArray(ids) && ids.includes(id)) {
                await entity.detachSession?.(id);
            }
        }
        catch { /* 单条失败不影响删文件 */ }
    }
    try {
        await registry.unarchiveSession?.(id);
    }
    catch { /* 尽力 */ }
}

/**
 * 找出这个会话底下的所有子代理会话（只认 origin==='subagent' 的，普通 fork 不算）。
 * @param {object} deps 依赖
 * @param {string[]} roots 根会话 id
 */
async function findDescendantSubagents(deps, roots) {
    const headers = new Map();
    try {
        const all = await deps.persistence?.list?.();
        for (const item of all ?? []) {
            const h = item?.header;
            if (h?.id) {
                headers.set(h.id, h);
            }
        }
    }
    catch { /* 拿不到就只删自己 */ }
    try {
        for (const [id] of deps.sessions?.list?.() ?? []) {
            const s = deps.sessions.get(id);
            const h = s?.header;
            if (h?.id && !headers.has(h.id)) {
                headers.set(h.id, h);
            }
        }
    }
    catch { /* 尽力 */ }

    const out = [];
    const visited = new Set(roots);
    let parents = new Set(roots);
    while (parents.size > 0) {
        const next = new Set();
        for (const h of headers.values()) {
            if (!h?.id || !h.parentSession) {
                continue;
            }
            if (h.origin !== 'subagent' || !parents.has(h.parentSession)) {
                continue;
            }
            if (visited.has(h.id)) {
                continue;
            }
            visited.add(h.id);
            next.add(h.id);
            out.push(h);
        }
        parents = next;
    }
    return out;
}

/**
 * 删一个会话（连同它的子代理会话）。
 *
 * 顺序是刻意的：**先摘运行时、再摘归属、最后动盘**。
 * 反过来的话，文件删了但宿主还记着这一行，界面会留一个点不开的幽灵。
 *
 * @param {object} deps { ctx, persistence, sessions, workspaceRegistry, sessionsRoot, logger }
 * @param {string} sessionId 目标会话
 * @param {{force?: boolean}} [options] force=true 时对「仍在运行」不抛错（仍然会尝试停）
 * @returns {Promise<{ok: boolean, sessionId: string, subagents: string[], filesRemoved: boolean, warnings: string[]}>}
 */
export async function deleteSession(deps, sessionId, options = {}) {
    assertSessionId(sessionId);
    const warnings = [];
    const deletedSubagents = [];

    const subagents = await findDescendantSubagents(deps, [sessionId]);

    // 先停掉所有子代理，再停父会话：父会话一停，子代理的活动就查不到了。
    for (const sub of subagents) {
        try {
            await assertAndStopActive(deps, sub.id, true);
        }
        catch (err) {
            if (options.force !== true) {
                throw err;
            }
            warnings.push(`子代理 ${sub.id} 停止失败：${String(err?.message ?? err)}`);
        }
    }
    try {
        await assertAndStopActive(deps, sessionId, false);
    }
    catch (err) {
        if (options.force !== true) {
            throw err;
        }
        warnings.push(`会话停止失败：${String(err?.message ?? err)}`);
    }

    // 子代理先删、父会话最后删：父删到一半失败时，报出来的名单才有意义。
    for (const sub of [...subagents].reverse()) {
        try {
            await detachRuntime(deps, sub.id);
            await detachFromWorkspaces(deps, sub.id);
            const dir = await sessionDirOf(deps, sub.id, sub);
            if (dir !== undefined) {
                await assertSessionDirectory(deps.sessionsRoot, dir, sub.id);
                await rm(dir, { recursive: true, force: true });
            }
            deletedSubagents.push(sub.id);
        }
        catch (err) {
            const wrapped = new Error(`删除子代理会话失败：${String(err?.message ?? err)}`);
            wrapped.deletedSubagents = [...deletedSubagents];
            throw wrapped;
        }
    }

    const dir0 = await sessionDirOf(deps, sessionId);
    const wasLive = deps.sessions?.get?.(sessionId) !== undefined || liveAgentOf(deps, sessionId) !== undefined;
    await detachRuntime(deps, sessionId);
    await detachFromWorkspaces(deps, sessionId);

    // blank 会话可能在 flush/detach 过程中才第一次落盘，所以要**重新定位**，
    // 否则会漏掉刚生成的那个文件。
    const dir = await sessionDirOf(deps, sessionId);
    let filesRemoved = false;
    if (dir !== undefined) {
        await assertSessionDirectory(deps.sessionsRoot, dir, sessionId);
        await rm(dir, { recursive: true, force: true });
        filesRemoved = true;
    }
    else if (dir0 !== undefined) {
        filesRemoved = true;
    }

    return {
        ok: true,
        sessionId,
        wasLive,
        // 运行时真的摘掉了吗：界面据此判断要不要刷新会话列表。
        stillKnown: deps.sessions?.get?.(sessionId) !== undefined,
        subagents: deletedSubagents,
        filesRemoved,
        warnings,
    };
}
