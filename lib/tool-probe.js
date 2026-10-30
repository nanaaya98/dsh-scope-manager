/**
 * 深度排查：把「这个插件到底注册了哪些工具」从猜测变成观测。
 *
 * 静态扫描只能看到「源码里出现过这个名字」，猜不出工具名来自配置的情况
 * （workflow 的 name 是 z.string().default("workflow") 运行时才定的）。
 * 但运行时会说实话 —— 插件的 fiber 一停，它的工具就从 ToolRuntime 撤销；
 * fiber 一起来，工具又回来。
 *
 * 所以做法是：**关掉它，看什么消失；再打开，看什么回来。**
 * 差集就是这个插件的真实工具集 —— 事实，不是猜。
 *
 * 三条纪律：
 *   1. **一次只动一个插件。** 别的插件保持存活，差集才干净。
 *   2. **动之前先记住原状态**，动完必须还原。中间失败也不能留在半路。
 *   3. **算不出就明说算不出。** 工具集合没变化 = 分不清是「它没注册工具」
 *      还是「它注册的工具被别人遮住了」—— 不猜，标成「无法验证」。
 */

/** 等一小会儿，让插件的 fiber 完成启停。 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 取当前运行时注册的全部工具名。
 *
 * **必须把所有 agent 的 scope 都并进来。** `ctx.tools.schemas()` 不带参数
 * 取的是**全局层**视图 —— 按 preset / per-agent 注册的工具（bash、read、
 * edit、todo_write、job_*、schedule_* 这一整批）根本不在里面。只查全局层
 * 会得到一个「少了半壁江山」的清单，拿它做交叉验证就会把真工具全判成幽灵、
 * 把官方表里活得好好的名字全标成过时。
 *
 * @param {object} ctx - Cordis 上下文
 * @returns {Set<string>} 工具名集合；取不到时返回空集
 */
export function runtimeToolNames(ctx) {
    const names = new Set();
    const collect = (list) => {
        if (!Array.isArray(list)) {
            return;
        }
        for (const s of list) {
            if (typeof s?.name === 'string' && s.name !== '') {
                names.add(s.name);
            }
        }
    };
    // 每个活着的 agent 一份视图（那才是会话真正能看见的工具）。
    try {
        const agents = ctx?.get?.('agents', false);
        for (const agent of agents?.list?.() ?? []) {
            try {
                collect(ctx.tools.schemas(agent));
            }
            catch {
                /* 单个 agent 取不到就跳过，别把整张表带崩 */
            }
        }
    }
    catch {
        /* agents 服务不可用时只用下面的全局视图 */
    }
    // 插件级 / 全局层视图，补上不属于任何 agent 的那部分。
    try {
        collect(ctx?.tools?.schemas?.());
    }
    catch {
        /* 全局视图取不到就用 agent 的 */
    }
    return names;
}

/**
 * 差集：after 里多出来的 = 这个插件注册的工具。
 *
 * 只算「新增」不够 —— 有的插件注册工具时会顶掉别人的（同名覆盖）。
 * 所以同时记录「消失的」，那也是这个插件的痕迹（它把别人的挤掉了）。
 */
function diffTools(before, after) {
    const added = [];
    const removed = [];
    for (const name of after) {
        if (!before.has(name)) {
            added.push(name);
        }
    }
    for (const name of before) {
        if (!after.has(name)) {
            removed.push(name);
        }
    }
    return { added, removed };
}

/**
 * 排查一个插件的真实工具集。
 *
 * @param {object} options
 * @param {object} options.ctx - Cordis 上下文（要能取 ctx.tools）
 * @param {object} options.pluginManager - 宿主 pluginManager 服务
 * @param {string} options.entryId - 插件的 Loader entryId
 * @param {string} options.moduleName - 包名（用于报错信息）
 * @param {number} [options.settleMs] - 启停后等待时间
 * @param {number} [options.timeoutMs] - 单步超时
 * @returns {Promise<{status: string, tools: string[], removed: string[], reason?: string}>}
 *   status: 'verified' 测出来了 | 'empty' 确实没注册工具 | 'unverifiable' 测不出来
 */
export async function probeOnePlugin(options) {
    const { ctx, pluginManager, entryId, moduleName } = options;
    const settleMs = options.settleMs ?? 800;
    const timeoutMs = options.timeoutMs ?? 20_000;

    const withTimeout = async (promise, label) => {
        let timer = null;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer !== null) {
                clearTimeout(timer);
            }
        }
    };

    let restored = false;
    try {
        const before = runtimeToolNames(ctx);
        if (before.size === 0) {
            return { status: 'unverifiable', tools: [], removed: [], reason: '拿不到运行时工具清单' };
        }

        // 关掉它。
        await withTimeout(pluginManager.setPluginEnabled(entryId, false), `关闭 ${moduleName}`);
        await delay(settleMs);
        const during = runtimeToolNames(ctx);

        // 再打开。
        await withTimeout(pluginManager.setPluginEnabled(entryId, true), `打开 ${moduleName}`);
        restored = true;
        await delay(settleMs);
        const after = runtimeToolNames(ctx);

        const { added, removed } = diffTools(during, after);
        // 关掉期间消失的、再打开后回来的 —— 这些才是这个插件的。
        const vanished = diffTools(before, during).removed;
        if (added.length === 0) {
            return {
                status: 'empty',
                tools: [],
                removed: vanished,
                reason: '重启它没有带来任何新工具',
            };
        }
        // `added` 是「它开着的时候多出来的工具」，这就是它的真实工具集。
        // `vanished` 是它关掉时消失的 —— 可能是它自己的，也可能是它
        // 顶掉了别人的；两种都留着，前者是归属依据，后者是线索。
        return { status: 'verified', tools: added, removed: vanished };
    }
    catch (e) {
        return {
            status: 'unverifiable',
            tools: [],
            removed: [],
            reason: e instanceof Error ? e.message : String(e),
        };
    }
    finally {
        // 无论成败，插件必须回到「开着」的状态。
        if (!restored) {
            try {
                await pluginManager.setPluginEnabled(entryId, true);
            }
            catch {
                // 还原失败 —— 这个情况要暴露出去，不能吞掉。
            }
        }
    }
}

/**
 * 逐一排查一批插件。
 *
 * 只查「没声明过、也没被验证过」的插件 —— 已经有答案的不重复折腾。
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.pluginManager
 * @param {Array<{entryId: string, moduleName: string}>} options.plugins
 * @param {Map<string, {tools: string[], verifiedAt: number}>|Record<string, object>} [options.cache] - 已有缓存；
 *   Map 或「包名 → 记录」的普通对象都收（缓存文件读出来就是后面那种）。
 * @param {(msg: string) => void} [options.onProgress]
 * @param {boolean} [options.stopOnError]
 * @returns {Promise<{results: Array, cache: Map}>}
 */
export async function probePlugins(options) {
    const { ctx, pluginManager, plugins } = options;
    // 缓存可能是 Map，也可能是 probe-cache.json 读出来的普通对象。
    // 直接读 `cache.set` 会在后者上报「cache.set is not a function」——
    // 调用方传 `cache.plugins` 就是这种形状。这里统一成 Map。
    const cache = options.cache instanceof Map
        ? options.cache
        : new Map(Object.entries(options.cache ?? {}));
    const onProgress = options.onProgress ?? (() => { });
    const results = [];

    for (const plugin of plugins) {
        onProgress(`正在排查 ${plugin.moduleName}…`);
        const outcome = await probeOnePlugin({
            ctx,
            pluginManager,
            entryId: plugin.entryId,
            moduleName: plugin.moduleName,
            settleMs: options.settleMs,
            timeoutMs: options.timeoutMs,
        });
        const row = {
            entryId: plugin.entryId,
            moduleName: plugin.moduleName,
            status: outcome.status,
            tools: outcome.tools,
            reason: outcome.reason,
        };
        results.push(row);
        if (outcome.status === 'verified') {
            cache.set(plugin.moduleName, { tools: outcome.tools, verifiedAt: Date.now() });
        }
        else {
            cache.set(plugin.moduleName, {
                tools: cache.get(plugin.moduleName)?.tools ?? [],
                verifiedAt: cache.get(plugin.moduleName)?.verifiedAt ?? 0,
                status: outcome.status,
                reason: outcome.reason,
            });
        }
    }
    return { results, cache };
}
