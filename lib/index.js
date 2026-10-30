// 功能管理和预设 · 宿主那一半（插件包名 dsh-scope-manager）。
//
// 这个插件只做一件事：**把「全局 / 工作区 / 会话」三层设置，折算成模型真正能感知到的东西**。
// 它不新增能力，只改三处：
//
//   ① 改工具描述 —— ctx.on('system-prompt/assemble')
//      宿主没有「改已注册工具描述」的 API（tools 服务只有 register/restrict/guard/get/schemas，
//      没有 update），而 systemPrompt.tools(provider) 的多个 provider 结果是**直接拼接不去重**的
//      （orderTools 只排序不去重），再挂一个 provider 只会让同名 schema 出现两次。
//      唯一合法的钩子是 assemble 瀑布：它拿到的是**即将发出去的那份 schema 数组**。
//      注意：只换 description，不换 parameters —— 工具的入参契约一个字不动。
//      （complete:true 的预设会把 sections 压成一段，但 **tools 保留 transformed 的值**，
//        所以描述改写在那种预设下照样生效。）
//
//   ② 减工具 —— 在同一个 assemble 钩子里把名单外的工具从 tools 数组里剔除。
//      不用 tools.restrict()：那一层撤不掉（disposer 只在本实例手里，插件热重载后
//      就成孤儿层，工具被永久锁死）。剔除是按次算的，可逆。
//      名单要从**未受限的插件级视图**算：在 agent scope 里取 schemas()，
//      第一次限制生效后表里已经没有被停用的工具，第二次重放会把它从 deny 名单里筛掉 ——
//      停用会「静默复活」。
//
//   ③ 拦调用 —— tools.guard()，不改定义，只在调用时逐条判
//
// 另外注入角色卡正文：ctx.on('agent/pre-step') 插一条合成 user 消息。
// 为什么不用 systemPrompt.section()：任一 section 带 complete:true 时，assemble 末尾会把
// sections 还原成只剩那一个，逐 agent 注册也救不回来；而官方的 persona 只能挂在 preset 组合里
// （需要 agent scope），第三方插件拿不到 —— 所以走 pre-step 这条路（与官方 skill-catalog 同款）。
import { realpath } from 'node:fs/promises';

// 运行期计数：证明三处钩子在真实宿主里**真的被调到**了。
// 光看代码「挂上了」不等于「被调用」—— 钩子签名写错、scope 过滤掉、
// 宿主换了方法名，都只在运行时才露出来。
const HOOK_STATS = {
    assemble: 0,          // 系统提示词组装（改描述的那次）
    assembleChanged: 0,   // 其中真的替换了至少一条描述的
    guard: 0,             // 工具调用守卫
    guardDenied: 0,       // 其中拒绝的
    restrictions: 0,      // 撤回过多少层旧的 restrict
    persona: 0,           // 插进去的角色卡
    skill: 0,             // 技能名单拦截
    mcpUnlock: 0,         // @mcp: 手势解锁的次数
    skillAt: 0,           // @技能名 翻成 /技能名 的次数
    unboundSections: 0,   // 因为关联的工具全被关掉而没注入的段落数
    lastAssembleAt: 0,
    lastSectionsDropped: 0,   // 上一次装配摘掉几段说明
    lastSectionOverrides: 0,  // 上一次装配替换了几段文字（覆写）
    lastPersonaOverrides: 0,  // 上一次装配有几段人设是被角色卡盖掉的
    lastReordered: 0,         // 上一次装配为了固定名次挪动了几段
};
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createStore, workspaceKey, sessionKey, mcpDisabledTools } from './store.js';
import { resolveEffective, toolAllowedByFilter, skillAllowedByFilter, sectionAllowedByFilter } from './resolve.js';
import {
    loadLibrary,
    listPersonas,
    listPersonasWithBody,
    readPersona,
    savePersona,
    deletePersona,
    listScenes,
    readScene,
    saveScene,
    deleteScene,
} from './library.js';
import { listSkills, readSkillFile, writeSkillFile, setSkillPolicy, uninstallSelfInstalledSkill } from './skills.js';
import { rewriteAtSkillContent } from './at-skill.js';
import { listMarket, listCategories, skillDetail, installSkill, MARKET_HOME } from './skillhub.js';
import { join as joinPath } from 'node:path';
import { createToolScanner, classifyToolName, mcpServerOf, isOfficialPlugin, CATEGORY_OTHER } from './tool-owner.js';
import { probePlugins, runtimeToolNames } from './tool-probe.js';
import { readProbeCache, writeProbeCache, isProbeFresh } from './probe-cache.js';
import { createPluginWatch } from './plugin-watch.js';
import { createMcpManager } from './mcp-manager.js';
import { buildOps, installHttpApi } from './http-api.js';
import { createSectionCatalog } from './sections.js';
import { MCP_GESTURE_KIND, mcpGestureTokens, resolveMcpGesture, renderMcpUnlockNote } from './mcp-gesture.js';
import { SELF_VAR, applyVars, scmVarsFromSections } from './prompt-vars.js';
import { PINNED_SECTIONS } from './pin-order.js';
import { ALWAYS_ON_SECTIONS, isAlwaysOnSection } from './always-on.js';

/**
 * 钉死在最前面的段落，数组顺序 = 名次。
 *
 * 为什么写死而不是读宿主 `SECTION_ORDERS`：宿主那张表按 order 排，人设三段
 * 一个在最前（0）、一个在最后（10200），中间夹着全部工具说明。用户要的是
 * 「身份 / 角色 / 约束」这三句挨着读，所以这里把它们抽出来钉成 1、2、3。
 */
export { PINNED_SECTIONS, isPinnedSection } from './pin-order.js';
export { ALWAYS_ON_SECTIONS, isAlwaysOnSection } from './always-on.js';

/**
 * 把这一轮的段落重排成「固定名次」：
 *   1..3  PINNED_SECTIONS 里有的那些（顺序写死）；
 *   中间   其余段落保持宿主给的原顺序（宿主已按 order 排好，不重复排）；
 *   末尾   第三方插件注入的段落，相对顺序不变 —— 相当于把它们当 push 型段落。
 *
 * 官方包（`@deepseek-ai/*`）不动：它们是宿主自己的骨架，插到末尾会把工具手册
 * 和 UI 说明挤到最后，读起来是乱的。
 *
 * @param {Array<object>} list 宿主交出来的段落（已过滤）
 * @param {(name: string) => boolean} isThirdParty 段落名 → 是不是第三方插件写的
 * @returns {{ list: Array<object>, moved: number }}
 */
export function reorderSections(list, isThirdParty) {
    if (!Array.isArray(list) || list.length === 0) {
        return { list, moved: 0 };
    }
    const byName = new Map();
    for (const section of list) {
        const name = String(section?.name ?? '');
        if (name && !byName.has(name)) {
            byName.set(name, section);
        }
    }
    const head = [];
    const used = new Set();
    for (const name of PINNED_SECTIONS) {
        const section = byName.get(name);
        if (section) {
            head.push(section);
            used.add(name);
        }
    }
    const middle = [];
    const tail = [];
    for (const section of list) {
        const name = String(section?.name ?? '');
        if (used.has(name)) {
            continue;
        }
        if (isThirdParty(name)) {
            tail.push(section);
        }
        else {
            middle.push(section);
        }
    }
    const next = [...head, ...middle, ...tail];
    let moved = 0;
    for (let i = 0; i < next.length; i += 1) {
        if (next[i] !== list[i]) {
            moved += 1;
        }
    }
    return { list: next, moved };
}
import { PERSONA_LABELS, personaSectionTexts } from './persona-parts.js';
import { resolveSectionSources } from './section-source.js';
import { deleteSession } from './session-delete.js';
import { resolveDshHome } from './paths.js';
import { packageBaseName, sectionOwnerBase } from './section-map.js';
import { collectInstalledNames, isOwnerInstalled } from './installed.js';

const VERSION = '0.1.0';
/** 注入消息在 source 上留的 kind —— 界面靠它认自己的消息，去重也靠它。 */
const PERSONA_KIND = 'scope-manager-persona';
/** 子会话 → 父会话的登记上限（键只是会话 id，丢了最多退回全局）。 */
const SESSION_PARENTS_MAX = 4096;

function messageList(decision) {
    const list = decision?.messages;
    return Array.isArray(list) ? list : [];
}

/** 我插的这类消息最后一条在哪（-1 = 没有）。 */
function ownMessageIndex(messages, kind) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && typeof m === 'object' && m.source?.kind === kind) {
            return i;
        }
    }
    return -1;
}

/**
 * 最后一次上下文压缩的结账点在哪（-1 = 没压过）。
 *
 * `@deepseek-ai/dsh-compaction` 把一段历史替换成一条 `source.kind === 'compact-checkpoint'`
 * 的摘要节点 —— 这条之**前**的消息模型已经看不到了。角色卡是插在消息列表里的，
 * 所以每压一次就得在结账点之后重新插一遍，否则它会连同被压掉的历史一起消失。
 */
const COMPACT_KIND = 'compact-checkpoint';
function lastCheckpointIndex(messages) {
    return ownMessageIndex(messages, COMPACT_KIND);
}

function messageText(message) {
    const content = message?.content;
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
        .join('\n');
}

export default {
    name: 'dsh-scope-manager-host',
    // 只依赖确实会用到的服务。少一个依赖就少一个「装不上」的理由。
    inject: ['webServer', 'tools', 'skills', 'sessions', 'agents', 'workspaceRegistry'],
    apply(ctx, config) {
        const store = createStore();
        /** 最近一次归属重扫完成的时刻（界面上显示用）。 */
        let lastScanAt = 0;
        // 测试可以塞一个假 scanner 进来（真实环境永远走 createToolScanner）。
        // 第二个参数：运行时真实注册的工具名 —— 用来剔除「幽灵工具」
        //（源码里出现过、运行时根本没注册）和标记过时���官方表条目。
        const scanner = config?.scanner ?? createToolScanner(30_000, () => {
            // 运行时真实工具名 —— 必须并上**所有 agent** 的 scope。
            // 只查 `ctx.tools.schemas()`（全局层）会漏掉按 preset 注册的那一整批
            // （bash / read / edit / todo_write / job_* …），结果是把真工具当幽灵剔掉、
            // 把官方表里还在用的名字标成「已过时」。
            const names = runtimeToolNames(ctx);
            // 拿不到就交回 null → 不裁剪（宁可多列也不凭空少列）。
            return names.size > 0 ? names : null;
        }, () => {
            // 实测结论：包名 → 它真的注册了哪些工具。
            //
            // 只读缓存，**不要**在这里调 scanner.get() —— 这个回调是在
            // scanNow 里面被调的，等自己就永远回不来。
            // 「版本还对不对」由 scanner 自己拿 packages 的版本号判。
            return readProbeCache();
        }, {
            // 后台重扫完成时点一下：记时间戳，界面据此显示「归属刚更新过」。
            onScan: () => {
                lastScanAt = Date.now();
            },
        });
        // 预热：先把归属表捞进内存。
        //
        // 这一句是**毫秒级**的 —— 扫出来的结果落盘了（scan-cache.json），
        // 冷启动直接读盘，省掉读 294 个官方包源码的那 16 秒。
        // 只有在「第一次装本插件」或「缓存文件被删」时才会真的扫一遍（后台跑）。
        void scanner.get().catch(() => { });
        /** 角色卡与场景预设的内存副本（解析时要用，改了要刷新）。 */
        const library = { personasById: {}, scenesById: {} };
        // 「系统提示词段落」目录：宿主不告诉我们某段是谁 push 的，只能见一次记一次。
        const sectionCatalog = createSectionCatalog();

        /**
         * 清掉「已经卸载的插件」留下的痕迹。
         *
         * 为什么需要这一条：段落目录（sections.json）**只增不减** ——
         * `record()` 只更新本轮出现过的段落，消失的段落要靠 `prune()` 清，
         * 而 prune 只在手动调 `sections-prune` 时才跑。于是插件一卸载，
         * 它注入过的那条段落就永远留在目录里；「只注入段落、不注册工具」的插件
         * 会被 section-map.js 补出一个空工具组，界面上就多出一张幽灵卡片。
         *
         * 实测缓存（probe-cache.json）是同一个毛病：它记着已卸载包的工具清单，
         * 归属健康度那一栏会一直显示一个根本不在的插件。
         *
         * 清单从两处取（互为补充）：宿主 Loader 条目（最权威）与扫包结果
         * （各 profile 的直接依赖，一个工具都没注册的包也算「装着」）。
         * 官方包（@deepseek-ai/*）一律不动 —— 清单未必收全，误删会伤到宿主自己。
         */
        let lastReconcileAt = 0;
        async function reconcileUninstalled(options) {
            // 节流：清单对账不用每次请求都做，一分钟一次足够。
            const now = Date.now();
            if (!options?.force && now - lastReconcileAt < 60_000) {
                return { removedSections: [], removedProbe: [], skipped: true };
            }
            lastReconcileAt = now;
            const installed = await collectInstalledNames({
                pluginManager: ctx.get('pluginManager', false),
                scanned: await scanner.get().catch(() => null),
            });
            if (!installed || installed.size === 0) {
                // 拿不到清单就别动手 —— 宁可留着一条幽灵记录，也别误删真插件的段落。
                return { removedSections: [], removedProbe: [] };
            }
            const removedSections = [];
            /** @type {Set<string>} 来源包已经不在清单里的段落，按包名基名归拢 */
            const stale = new Set();
            for (const section of sectionCatalog.list()) {
                const plugin = section?.plugin;
                if (!plugin || isOwnerInstalled(plugin, installed)) {
                    continue;
                }
                const base = packageBaseName(plugin);
                if (base) {
                    stale.add(base);
                }
            }
            for (const base of stale) {
                removedSections.push(...sectionCatalog.forgetByOwner(base));
            }
            const removedProbe = [];
            try {
                const cache = await readProbeCache();
                const plugins = { ...cache.plugins };
                for (const key of Object.keys(plugins)) {
                    if (isOwnerInstalled(key, installed)) {
                        continue;
                    }
                    delete plugins[key];
                    removedProbe.push(key);
                }
                if (removedProbe.length > 0) {
                    await writeProbeCache(plugins);
                }
            }
            catch {
                /* 缓存读不了就当没这回事 */
            }
            return { removedSections, removedProbe };
        }

        /**
         * 段落来源反查：宿主不说段落是谁加的，只能扫已装插件的源码找。
         * 只在「见到没查过的段落」时跑一次，跑完落盘，之后不重复扫。
         */
        let resolvingSources = false;
        async function resolveSourcesInBackground() {
            if (resolvingSources) {
                return;
            }
            let pending = [];
            try {
                pending = sectionCatalog.unresolved();
            }
            catch {
                return;
            }
            if (pending.length === 0) {
                return;
            }
            resolvingSources = true;
            try {
                const found = await resolveSectionSources(pending);
                sectionCatalog.applySources(found);
            }
            catch {
                /* 查不到就是查不到，不影响装配 */
            }
            finally {
                resolvingSources = false;
            }
        }
        /** agent → { workspaceKey, sessionKey, effective } */
        const agentScopes = new Map();
        /** 子会话 → 父会话 */
        const sessionParents = new Map();
        /** agent → { key, dispose }（工具可见性限制） */
        const restrictions = new Map();
        /** agent → Set<name>：这个 agent 见过的全部工具名（**只增不减**，见 applyRestrictions 的注释） */
        const knownToolNames = new Map();
        /**
         * agent → Set<serverName>：**这一轮**被 `@mcp:服务名` 解锁的服务器。
         * 天然单轮：每次 pre-step 只看最后一条用户消息重算，新消息里没手势就是空集。
         */
        const mcpUnlocked = new Map();

        // ————————————————————— 作用域键 —————————————————————

        async function realpathSafe(p) {
            try {
                return await realpath(p);
            }
            catch {
                return undefined;
            }
        }

        /** 会话 id → 它的 cwd（活的先查内存，冷会话查持久化头；都不行就空）。 */
        const cwdOfSessionCache = new Map();

        async function cwdOfSession(id) {
            if (!id) {
                return '';
            }
            if (cwdOfSessionCache.has(id)) {
                return cwdOfSessionCache.get(id);
            }
            let cwd = '';
            try {
                cwd = ctx.sessions?.get?.(id)?.header?.cwd ?? '';
            }
            catch {
                cwd = '';
            }
            if (!cwd) {
                try {
                    const snap = await ctx.get('sessionPersistence', false)?.stat?.(id);
                    cwd = snap?.header?.cwd ?? '';
                }
                catch {
                    cwd = '';
                }
            }
            if (cwdOfSessionCache.size > 512) {
                cwdOfSessionCache.clear();
            }
            cwdOfSessionCache.set(id, cwd);
            return cwd;
        }

        /**
         * 客户端传来的 sessionId / cwd → 两个作用域键。
         *
         * 只给了会话 id 也必须把工作区键算出来：一个会话的生效值 = 会话层 →
         * 它 cwd 对应的工作区层 → 全局。少了这一步，选中某个会话时工作区层
         * 会被整层跳过（表现就是「工作区里设的东西在会话里不生效」）。
         */
        async function resolveScope({ sessionId, cwd }) {
            let root = String(cwd ?? '').trim();
            if (!root && sessionId) {
                root = await cwdOfSession(sessionId);
            }
            let ws = '';
            if (root) {
                const resolved = await realpathSafe(root);
                ws = workspaceKey(resolved ?? root);
            }
            return {
                sessionKey: sessionId ? sessionKey(sessionId) : '',
                workspaceKey: ws,
            };
        }

        /**
         * 用于**作用域解析**的会话 id：子代理 / 侧聊会话 → 它所属的用户会话。
         *
         * 为什么必须往上找：作用域是按「对话」记的，而子代理有**自己的** session id。
         * 直接用子会话 id 查必然查不到，于是它在全局口径下拿到父会话已经关掉的工具 / 技能 ——
         * 父会话里藏起来的东西，派个子代理就能看见。
         */
        function sessionScopeIdOf(agent) {
            const id = agent?.session?.header?.id ?? agent?.session?.id ?? null;
            if (!id) {
                return null;
            }
            const parent = agent?.session?.header?.parentSession;
            if (typeof parent === 'string' && parent !== '' && parent !== id) {
                sessionParents.set(id, parent);
                if (sessionParents.size > SESSION_PARENTS_MAX) {
                    const oldest = sessionParents.keys().next();
                    if (!oldest.done) {
                        sessionParents.delete(oldest.value);
                    }
                }
            }
            let current = id;
            const seen = new Set();
            for (;;) {
                const up = sessionParents.get(current);
                if (up === undefined || up === current || seen.has(up)) {
                    return current;
                }
                seen.add(current);
                current = up;
            }
        }

        /** agent → 它的工作区键与会话键。 */
        async function scopeForAgent(agent) {
            const cwd = agent?.session?.header?.cwd;
            let ws = '';
            if (cwd) {
                const resolved = await realpathSafe(cwd);
                ws = workspaceKey(resolved ?? cwd);
            }
            const sid = sessionScopeIdOf(agent);
            return {
                workspaceKey: ws,
                sessionKey: sid ? sessionKey(sid) : '',
            };
        }

        /** 算某个 agent 当前生效的配置（会话 > 工作区 > 全局）。 */
        async function effectiveForAgent(agent) {
            const scope = await scopeForAgent(agent);
            const data = store.peek();
            return resolveEffective(data, library.scenesById, library.personasById, scope);
        }

        // ————————————————————— 生效配置的缓存 —————————————————————

        /** 把生效配置写回 agentScopes，供同步的 guard 用。 */
        /**
         * 场景里指定了权限档位 → 落到这个会话上。
         *
         * 走宿主的 `permissionPresets.set(session, name)`（这就是界面上那个权限下拉的
         * 写入口），它**没有**「会话还没开始」的限制，中途也能切。只在值真的变了的时候
         * 调一次：`set` 会往会话日志里追加 `permission/preset`，每轮都写就是噪音。
         * 用户在输入框里手动改了权限，下一次场景值变化前不会再被我们改回去。
         */
        function applyScenePermission(agent, entry, effective) {
            const wanted = effective?.permission?.name;
            if (!wanted) {
                return;
            }
            const service = ctx.get('permissionPresets', false);
            if (!service) {
                return;
            }
            if (entry.lastPermission === wanted) {
                return;
            }
            try {
                if (typeof service.current === 'function' && service.current(agent.session) === wanted) {
                    entry.lastPermission = wanted;
                    return;
                }
                service.set(agent.session, wanted);
                entry.lastPermission = wanted;
            }
            catch {
                // 宿主没这个预设、或会话已经不接受写入：不阻断装配，下一轮再试。
            }
        }

        async function refreshAgent(agent) {
            try {
                const scope = await scopeForAgent(agent);
                const data = store.peek();
                const effective = resolveEffective(data, library.scenesById, library.personasById, scope);
                const entry = { ...scope, effective, lastPermission: agentScopes.get(agent)?.lastPermission };
                agentScopes.set(agent, entry);
                applyScenePermission(agent, entry, effective);
                return effective;
            }
            catch {
                return undefined;
            }
        }

        async function refreshAllAgents() {
            for (const agent of [...agentScopes.keys()]) {
                await refreshAgent(agent);
            }
            await applyRestrictions();
        }

        /**
         * 把**已经活着的** agent 收进来。
         *
         * `agent/created` 只在新建时触发：插件热重载、或插件晚于会话装上的时候，
         * 那些会话永远不会进 agentScopes —— 表现就是「改了备注、注入了角色卡，
         * 但当前对话一点变化都没有」。这条 bootstrap 就是补这个缺口。
         */
        function adoptLiveAgents() {
            let live = [];
            try {
                const agents = ctx.get('agents', false);
                live = agents?.list?.() ?? agents?.roots?.() ?? [];
            }
            catch {
                live = [];
            }
            if (!Array.isArray(live)) {
                live = [];
            }
            let added = 0;
            for (const agent of live) {
                if (!agent || agentScopes.has(agent)) {
                    continue;
                }
                // 同步占位，避免并发的 assemble / guard 在 refresh 完成前读到空值。
                agentScopes.set(agent, { sessionKey: '', workspaceKey: '', effective: undefined });
                added += 1;
            }
            if (added > 0) {
                void refreshAllAgents().catch(() => { });
            }
            return added;
        }

        // ————————————————————— ① 改工具描述 —————————————————————

        /**
         * assemble 瀑布：拿到即将发出去的那份 schema 数组，把描述换成用户写的那条。
         * 只换 description —— parameters 一个字不动（入参契约不能被备注改坏）。
         */
        // **必须 prepend**：别的插件（表情包的「斗图规则」就是）在 `await next()` 之后
        // 才往 `assembled.sections` 里 push，只有站在它们外层（先被调用）才看得见。
        ctx.on('system-prompt/assemble', async (assembly, context, next) => {
            HOOK_STATS.assemble += 1;
            HOOK_STATS.lastAssembleAt = Date.now();
            const assembled = await next();
            // 先记目录（过滤之前的样子）：用户得知道漏掉的是哪一段。
            sectionCatalog.record(assembled?.sections);
            // 宿主不提供「已注册变量」清单，这里顺手把这次装配的变量表存下来，
            // 界面才能提示「有哪些占位符可用」，保存覆写时也要拿它做校验。
            sectionCatalog.noteVariables(assembled?.variables);
            // 新见到的段落顺手反查一次来源（哪个插件、哪个文件哪一行），不阻塞本次装配。
            void resolveSourcesInBackground();
            // —— 固定名次与「层」无关 ——
            // 人设三条钉成 1、2、3、第三方段落挪到末尾，纯粹是结构变换，
            // 不需要知道用户绑了哪一层。早退（没 agent / 没绑层）也必须跑：
            // 否则重载插件后的第一次装配会抖回宿主原生顺序，而宿主只在
            // 提示词变化时提交 system/message —— 抖一次就是真发给模型一次。
            const pluginOf = new Map();
            for (const entry of sectionCatalog.list()) {
                if (entry?.name) {
                    pluginOf.set(entry.name, entry.plugin ?? null);
                }
            }
            const isThirdParty = (name) => {
                const plugin = pluginOf.get(name);
                return typeof plugin === 'string' && plugin !== '' && !isOfficialPlugin(plugin);
            };
            const applyPinOrder = (source) => {
                const list = source?.sections;
                if (!Array.isArray(list)) {
                    return source;
                }
                const reordered = reorderSections(list, isThirdParty);
                if (reordered.moved === 0) {
                    return source;
                }
                HOOK_STATS.lastReordered = reordered.moved;
                sectionCatalog.record(reordered.list);
                return { ...source, sections: reordered.list };
            };
            const agent = context?.agent;
            if (!agent) {
                return applyPinOrder(assembled);
            }
            const cached = agentScopes.get(agent);
            const effective = cached?.effective ?? await refreshAgent(agent);
            if (!effective) {
                return applyPinOrder(assembled);
            }
            let result = assembled;

            // —— 系统提示词段落：先按覆写换文字，再按名单整段摘掉 ——
            // 注意：宿主在瀑布之后还会做一次「有 complete 段落就只留它」的收尾，
            // 那种情况下这里的修改会被覆盖（complete 段落 = 整份提示词由它一个人决定）。
            const sections = assembled?.sections;
            if (Array.isArray(sections)) {
                let working = sections;
                // ① 覆写：不写回插件源码，只在这里把 text 换掉。
                // 优先级：**层内覆写 > 目录里的全局覆写 > 原文**。
                // 目录那份是「所有会话都改」，层内那份是「只在这一层改」——
                // 具体的那个赢，这跟工具备注的逐字段合并是同一套规则。
                // 覆写里的 `{{…}}` 由本插件在写回 `section.text` **之前**换掉：
                //   · 宿主注册的变量（model / provider / …）—— 这样连 `interpolate: false`
                //     的字面量段落里写它们也照样生效；
                //   · 本插件自己算的（`mcp_servers`）。
                // 换完宿主就看不到 `{{…}}`，不会因为「未知变量」把整轮渲染搞崩。
                // 值取**覆写之前**的原文/变量表（拿覆写后的取会自己套自己）。
                const scmVars = scmVarsFromSections(sections, assembled?.tools, mcpServerOf);
                const hostVars = {};
                for (const [name, value] of Object.entries(assembled?.variables ?? {})) {
                    if (typeof name === 'string' && value !== undefined) {
                        hostVars[name] = value;
                    }
                }
                const varEnv = { ...hostVars, ...scmVars };
                const globalOverrides = sectionCatalog.overrides();
                const layerOverrides = effective.sectionOverrides ?? {};
                const overrideCount = Object.keys(layerOverrides).length + globalOverrides.size;
                if (overrideCount > 0) {
                    let replaced = 0;
                    working = working.map((section) => {
                        const name = section?.name;
                        const layerText = layerOverrides[name]?.text;
                        const text = typeof layerText === 'string'
                            ? layerText
                            : globalOverrides.get(name);
                        if (typeof text !== 'string') {
                            return section;
                        }
                        // 每一段额外能引用 `{{original}}` = 自己此刻的原文（覆写之前那份）。
                        // 「不改内容、只加一层排版」这种覆写因此不会把动态内容冻住。
                        const resolved = applyVars(text, {
                            ...varEnv,
                            [SELF_VAR]: typeof section?.text === 'string' ? section.text : '',
                        });
                        if (section?.text === resolved) {
                            return section;
                        }
                        replaced += 1;
                        return { ...section, text: resolved };
                    });
                    HOOK_STATS.lastSectionOverrides = replaced;
                }
                // ①b 角色卡选了「系统提示词覆盖」时：三段直接盖到那三条人设段上。
                //     优先级最高 —— 用户既然选了这种方式，就是要这三段说了算。
                const personaTexts = personaSectionTexts(effective?.persona);
                if (personaTexts.size > 0) {
                    let replacedByPersona = 0;
                    working = working.map((section) => {
                        const text = personaTexts.get(section?.name);
                        if (typeof text !== 'string') {
                            return section;
                        }
                        // 同样支持 `{{original}}`（此刻的原文）与宿主变量。
                        const resolved = applyVars(text, {
                            ...varEnv,
                            [SELF_VAR]: typeof section?.text === 'string' ? section.text : '',
                        });
                        if (section?.text === resolved) {
                            return section;
                        }
                        replacedByPersona += 1;
                        return { ...section, text: resolved };
                    });
                    HOOK_STATS.lastPersonaOverrides = replacedByPersona;
                }
                // ② 关联：段落挂着的工具一个都没启用 → 这一段不注入。
                //    - 显式选了工具：那几把工具全关掉就不注入；
                //    - 默认关联「来源插件」：那个包下的工具全部关掉才不注入。
                // 好处是场景里只要关工具，它的提示词就自动消失，不用再去段落名单里挑一遍。
                const toolList = Array.isArray(assembled?.tools) ? assembled.tools : [];
                if (toolList.length > 0 && working.length > 0) {
                    const explicitBinds = sectionCatalog.bindings();
                    const toolFilter = effective.toolFilter;
                    // MCP 页里关掉的工具也算「没开」——否则段落会绑在一把调不动的工具上，
                    // 提示词里留着说明、模型一调就被守卫挡下。
                    const mcpOff = mcpDisabledTools(store.peek());
                    const visibleTools = new Set(
                        toolList
                            .map((t) => t?.name)
                            .filter((n) => typeof n === 'string' && n !== '')
                            .filter((n) => !toolFilter || toolAllowedByFilter(toolFilter, n))
                            .filter((n) => !mcpOff.has(n)),
                    );
                    const scanned = await scanner.get();
                    // MCP 工具没有包归属，归属就是那台服务器（`mcp__<server>__<tool>`）；
                    // 否则 `mcp:<server>` 这类段落永远接不上它的工具、「全关才不注入」也就永远不成立。
                    // 归属口径必须和面板**完全一致**，否则「面板说全关了、实际照样注入」
                    // 这种事就会发生。所以这里直接复用 classifyToolName 的优先级链
                    // （人点过的 > 实测（软重启差分）> 源码扫到的 > 官方表 > 前缀猜），
                    // 而不是自己挑两张表查 —— 只查 system/plugin 会漏掉
                    // scanned.probed（modlens、meme 这类只有软重启才认得出的插件），
                    // 它们的段落就永远接不上自己的工具 → 工具关光了提示词还在。
                    const toolOwners = store.peek()?.toolOwners ?? {};
                    const ownerOf = (toolName) => {
                        const server = mcpServerOf(toolName);
                        if (server) {
                            return server;
                        }
                        const meta = classifyToolName(toolName, toolOwners, scanned);
                        if (!meta || meta.category === CATEGORY_OTHER) {
                            return '';
                        }
                        return packageBaseName(meta.owner);
                    };
                    /** @type {Map<string, string[]>} 插件基名 → 它名下的工具 */
                    const toolsByPlugin = new Map();
                    for (const tool of toolList) {
                        const name = tool?.name;
                        const owner = ownerOf(name);
                        if (!owner) {
                            continue;
                        }
                        if (!toolsByPlugin.has(owner)) {
                            toolsByPlugin.set(owner, []);
                        }
                        toolsByPlugin.get(owner).push(name);
                    }
                    // `tool:bash` 这种段落名本身就是「这一段讲的是哪个工具」，
                    // 宿主没给插件归属、也接不到包，但名字就是最硬的线索。
                    const toolOfSection = (sectionName) => {
                        const n = String(sectionName ?? '');
                        return n.startsWith('tool:') ? [n.slice('tool:'.length)] : null;
                    };
                    const kept = working.filter((section) => {
                        const name = section?.name;
                        const explicit = explicitBinds.get(name);
                        const related = explicit
                            ?? toolOfSection(name)
                            ?? toolsByPlugin.get(sectionOwnerBase(section))
                            ?? [];
                        if (related.length === 0) {
                            // 接不上任何工具（不是插件带的，或那个包这轮没装）→ 不靠关联管它
                            return true;
                        }
                        return related.some((t) => visibleTools.has(t));
                    });
                    if (kept.length !== working.length) {
                        HOOK_STATS.unboundSections += working.length - kept.length;
                        working = kept;
                    }
                }

                // ③ 摘除：关掉某段说明（与工具开关无关，段落和工具是两套东西）。
                // 逐段点名优先于整体名单：场景里排掉的一段，会话里可以点名放回来。
                const sectionFilter = effective.sectionFilter;
                const sectionStates = effective.sectionStates ?? {};
                if (sectionFilter || Object.keys(sectionStates).length > 0) {
                    const kept = working.filter((section) => {
                        const name = section?.name;
                        const state = sectionStates[name];
                        if (state && typeof state.enabled === 'boolean') {
                            return state.enabled;
                        }
                        // 常开白名单：人设那几段不许被场景/预设的名单摘掉
                        // （角色卡要用它们做提示词替换，摘掉了人设就跟着没了）。
                        if (isAlwaysOnSection(name)) {
                            return true;
                        }
                        return sectionAllowedByFilter(sectionFilter, name);
                    });
                    if (kept.length !== working.length) {
                        HOOK_STATS.lastSectionsDropped = working.length - kept.length;
                        working = kept;
                    }
                }
                // ④ 固定名次：人设三条钉成 1、2、3，第三方插件注入的段落统一挪到末尾
                //    （等价于 push 型）。名次一变，面板里的序号也跟着变 —— 因为它就是
                //    模型实际读到的顺序。判第三方的口径与早退路径共用同一个 isThirdParty。
                const reordered = reorderSections(working, isThirdParty);
                if (reordered.moved > 0) {
                    working = reordered.list;
                    HOOK_STATS.lastReordered = reordered.moved;
                    // 位置以重排后的为准；不重排就不用再记一遍。
                    sectionCatalog.record(working);
                }
                if (working !== sections) {
                    result = { ...result, sections: working };
                }
            }

            const list = assembled?.tools;
            if (!Array.isArray(list)) {
                return result;
            }
            const notes = effective.tools ?? {};
            const filter = effective.toolFilter;
            // MCP 页里逐个关掉的工具：跨层共用的一个键，与层里的 toolFilter 无关
            // （toolFilter 是整块取第一个的，见 lib/store.js 顶部注释）。
            const mcpOff = mcpDisabledTools(store.peek());
            // 这一轮被 @mcp: 点名的服务：它们的工具即使在预设名单外也放行。
            // 注意只越过「预设名单」这一层；MCP 页里逐个关掉的开关仍然算数
            // （那是用户对某一把工具的明确表态，不该被一句手势盖过去）。
            const unlockedNow = mcpUnlocked.get(agent) ?? null;
            let changed = false;
            let dropped = 0;
            const nextTools = [];
            for (const tool of list) {
                const name = tool?.name;
                const server = name ? (mcpServerOf(name) ?? '') : '';
                const unlockedHere = server !== '' && unlockedNow !== null && unlockedNow.has(server);
                // 名单先过一遍：这是「工具定义真的消失」唯一可靠的一步。
                // restrict() 只能点名**全局层**注册的工具，`subagent` 这种按 agent
                // 注册的点名就整条抛错，退化成「一个都没挡住」。
                if (name && filter && !unlockedHere && !toolAllowedByFilter(filter, name)) {
                    changed = true;
                    dropped += 1;
                    continue;
                }
                if (name && mcpOff.has(name)) {
                    changed = true;
                    dropped += 1;
                    continue;
                }
                const note = name ? notes[name] : undefined;
                if (!note || typeof note.description !== 'string' || note.description.trim() === '') {
                    nextTools.push(tool);
                    continue;
                }
                if (tool.description === note.description) {
                    nextTools.push(tool);
                    continue;
                }
                changed = true;
                nextTools.push({ ...tool, description: note.description });
            }
            if (!changed) {
                return result;
            }
            HOOK_STATS.assembleChanged += 1;
            HOOK_STATS.lastDropped = dropped;
            return { ...result, tools: nextTools };
        }, { prepend: true });

        // ————————————————————— ② 减工具（可见性） —————————————————————

        function liftRestriction(agent) {
            const entry = restrictions.get(agent);
            if (!entry) {
                return;
            }
            restrictions.delete(agent);
            try {
                entry.dispose?.();
            }
            catch {
                /* 撤销失败不影响下一次装配 */
            }
        }

        /**
         * 撤回**本实例**装过的 restrict 层。
         *
         * 为什么不在 agent scope 上装 restrict：那一层撤不掉。`restrict()` 只把
         * 撤销函数交给调用方，插件一热重载，旧实例带着它一起消失，agent scope 上
         * 就留下一层没有任何人能撤销的 deny —— 工具被永久锁死，用户只能重启宿主。
         *
         * 「模型看不到这条工具定义」由 assemble 剔除保证（按次计算、无状态），
         * 「调不动」由 guard 保证。两者都能随配置即时反转，不留残迹。
         */
        async function applyRestrictions() {
            for (const agent of [...restrictions.keys()]) {
                liftRestriction(agent);
            }
        }

        // ————————————————————— ③ 拦调用 —————————————————————

        /**
         * 执行守卫。返回字符串 = 拒绝并附理由；返回 undefined = 放行。
         * 官方语义是**单调**的：任何守卫都不能把别人拒绝的调用翻回允许。
         */
        ctx.tools.guard((exec) => {
            HOOK_STATS.guard += 1;
            const name = String(exec?.name ?? '');
            if (!name) {
                return undefined;
            }
            const agent = exec?.agent;
            const effective = agent ? agentScopes.get(agent)?.effective : undefined;
            if (!effective) {
                return undefined;
            }
            if (effective.toolFilter && !toolAllowedByFilter(effective.toolFilter, name)) {
                // @mcp: 点名的服务这一轮放行（与 assemble 的放行口径保持一致）。
                const server = mcpServerOf(name) ?? '';
                const unlocked = server !== '' && (mcpUnlocked.get(agent)?.has(server) ?? false);
                if (!unlocked) {
                    HOOK_STATS.guardDenied += 1;
                    return `工具「${name}」已被${effective.toolFilter.source}的工具名单排除（该名单来自${effective.toolFilter.source}层）`;
                }
            }
            // MCP 页里逐个关掉的工具：即使模型还记得它的名字，调不动。
            if (mcpDisabledTools(store.peek()).has(name)) {
                HOOK_STATS.guardDenied += 1;
                return `工具「${name}」已在 MCP 页被关掉`;
            }
            // 技能名单：宿主没有「停用某个技能」的开关，只有 frontmatter 的调用面开关。
            // 能在本插件这一层拦的只有**模型调用 skill 工具**这条路径。
            if (name === 'skill' && effective.skills) {
                const skillName = String(exec?.arguments?.name ?? '');
                if (skillName && !skillAllowedByFilter(effective.skills, skillName)) {
                    HOOK_STATS.skill += 1;
                    HOOK_STATS.guardDenied += 1;
                    return `技能「${skillName}」已被${effective.skills.source}的技能名单排除`;
                }
            }
            return undefined;
        });

        // ————————————————————— 角色卡注入 —————————————————————

        /** 渲染成一条消息正文（上下文注入用）。只有整段 body 的卡片退回整段格式。 */
        function renderPersona(persona) {
            const blocks = [];
            for (const [key, label] of PERSONA_LABELS) {
                const text = String(persona?.[key] ?? '').trim();
                if (text) {
                    blocks.push(`## ${label}\n\n${text}`);
                }
            }
            if (blocks.length === 0) {
                const legacy = String(persona?.body ?? '').trim();
                return legacy ? `# 角色卡：${persona.name}\n\n${legacy}` : '';
            }
            return `# 角色卡：${persona.name}\n\n${blocks.join('\n\n')}`;
        }

        /**
         * 把用户消息里的 `@技能名` 就地改成 `/技能名`。
         *
         * 技能手势是 dsh-tool-skill 的私有正则，只认 `/`；它读的是 payload.messages
         * 这个数组本身，所以必须**在它之前**（prepend）把数组内容换掉，而不是等
         * next() 回来再改 decision。
         *
         * 认不出的 `@xxx` 原样保留 —— 那可能是文件引用、邮箱或者别的插件的手势。
         */
        async function applyAtSkillGesture(agent, messages, signal) {
            // 注意：宿主瀑布的 payload 只有 { messages, turn, step, signal, agent }，
            // agent 可能缺席（dsh-tool-skill 自己的 pre-step 也只是把 undefined 交给
            // workingDirectory.ensure，服务端会回落到默认工作目录），所以不把它当必需项。
            if (!Array.isArray(messages) || messages.length === 0) {
                return false;
            }
            const index = messages.findLastIndex((m) => m?.source?.kind === 'user');
            if (index < 0) {
                return false;
            }
            const message = messages[index];
            const blocks = Array.isArray(message?.content) ? message.content : [];
            if (!blocks.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes('@'))) {
                return false;
            }
            let names;
            try {
                const cwd = await ctx.workingDirectory.ensure(agent, signal);
                const list = await ctx.skills.list({ cwd, signal, scope: agent ?? undefined });
                names = new Set((Array.isArray(list) ? list : [])
                    .filter((s) => s?.invocation?.userInvocable !== false)
                    .map((s) => String(s?.name ?? ''))
                    .filter(Boolean));
            }
            catch {
                return false;
            }
            signal?.throwIfAborted?.();
            const content = rewriteAtSkillContent(blocks, names);
            if (content === null) {
                return false;
            }
            messages.splice(index, 1, { ...message, content });
            return true;
        }

        /**
         * 每一步请求前插一条合成 user 消息。
         * 去重：与会话可见表面上最后一条同类消息**逐字节比对**（比的是 source.body 指纹）——
         * 内容没变就不重发；会话被压缩后表面比不到，会自动重发一次。
         */
        ctx.on('agent/pre-step', async (payload, next) => {
            // 先于 dsh-tool-skill 跑：`@技能名` 要在它扫 `/` 手势之前就变成 `/技能名`。
            try {
                if (await applyAtSkillGesture(payload?.agent, payload?.messages, payload?.signal)) {
                    HOOK_STATS.skillAt += 1;
                }
            }
            catch (err) {
                // 改写只是锦上添花，出错也不能拦住整轮对话。
                ctx.logger?.warn?.('[scope-manager] @技能名 改写失败：' + (err?.message ?? err));
            }
            // 必须继续往下走：这个处理器只负责就地改写消息数组，
            // 漏掉 return next() 会把整条 pre-step 瀑布链截断（后面就读到 undefined）。
            return next();
        }, { prepend: true });

        ctx.on('agent/pre-step', async (payload, next) => {
            const decision = await next();
            const agent = payload?.agent;
            if (!agent) {
                return decision;
            }
            let messages = messageList(decision);
            // 空 turn 不注入：凭空插一条会白烧一次调用（官方 dsh-agent-instructions 同款守卫）。
            if (Number(payload?.step) === 1 && messages.length === 0) {
                return decision;
            }
            let dirty = false;

            // ————— ① @mcp:服务名 —— 这一轮解锁哪几台 —————
            // 手势只认**最后一条用户消息**：新消息没写 @mcp: 就是「本轮不解锁」，
            // 上一轮的解锁提醒顺手收回 —— 这样「单轮生效」不靠计时器也不靠 turn 事件。
            const unlock = await computeMcpUnlock(agent, messages);
            if (unlock) {
                messages = unlock;
                dirty = true;
            }

            // ————— ② 角色卡 —————
            const effective = agentScopes.get(agent)?.effective ?? await refreshAgent(agent);
            const persona = effective?.persona;
            // 走「系统提示词覆盖」的卡片不插对话消息 —— 它的三段在 assemble 里盖到段落上。
            if (!persona || persona.inject === 'system') {
                return dirty ? { ...decision, messages } : decision;
            }
            const text = renderPersona(persona);
            if (!text) {
                return dirty ? { ...decision, messages } : decision;
            }
            const addition = createUserMessage({
                content: [{ type: 'text', text }],
                source: {
                    kind: PERSONA_KIND,
                    form: 'instructions',
                    body: text,
                    personaId: persona.id,
                    personaName: persona.name,
                },
            });
            // 还在不在「模型看得见的那一截」里：必须有，而且必须排在最后一次
            // 上下文压缩的结账点之后 —— 压过之后它就跟被压掉的历史一起没了，
            // 得重新插一条（内容没变也不省这一步，不然角色卡会静默消失）。
            const index = ownMessageIndex(messages, PERSONA_KIND);
            const checkpoint = lastCheckpointIndex(messages);
            if (index > checkpoint) {
                if (messages[index]?.source?.body === text) {
                    return dirty ? { ...decision, messages } : decision;
                }
                // 内容改了（换了角色卡/改了正文）：就地替换，不叠第二条。
                const next = messages.slice();
                next[index] = addition;
                HOOK_STATS.persona += 1;
                return { ...decision, messages: next };
            }
            HOOK_STATS.persona += 1;
            HOOK_STATS.personaRevived = (HOOK_STATS.personaRevived ?? 0) + (checkpoint >= 0 ? 1 : 0);
            return { ...decision, messages: [...messages, addition] };
        }, { prepend: true });

        // ————————————————————— @mcp: 手势 —————————————————————

        /** 最后一条真正的用户消息（合成的注入消息各有自己的 kind）。 */
        function latestUserText(messages) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                if (messages[i]?.source?.kind === 'user') {
                    return messageText(messages[i]);
                }
            }
            return '';
        }

        /** 解锁的服务器 → 提醒正文里的分组（带上这一轮工具表里的真实工具）。 */
        function unlockGroups(agent, matched) {
            if (!Array.isArray(matched) || matched.length === 0) {
                return [];
            }
            let schemas = [];
            try {
                schemas = ctx.tools.schemas(agent ?? undefined) ?? [];
            }
            catch {
                schemas = [];
            }
            return matched.map((server) => {
                const serverName = String(server.serverName ?? '');
                const label = server.name && server.name !== serverName
                    ? `${serverName}（${server.name}）`
                    : serverName;
                const tools = schemas
                    .filter((tool) => mcpServerOf(tool?.name) === serverName)
                    .map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                    }));
                return { label, serverName, tools };
            });
        }

        /**
         * 把手势折成「这一轮解锁哪些服务器」+ 提醒消息。
         *
         * @returns {Array<object>|null} 需要替换的消息数组（null = 不动）
         */
        async function computeMcpUnlock(agent, messages) {
            const tokens = mcpGestureTokens(latestUserText(messages));
            let hit = { matched: [], unknown: [] };
            if (tokens.length > 0) {
                let servers = [];
                try {
                    servers = (await mcp.list())?.servers ?? [];
                }
                catch {
                    servers = [];
                }
                hit = resolveMcpGesture(tokens, servers);
            }
            const unlocked = new Set(
                hit.matched
                    .map((server) => String(server.serverName ?? ''))
                    .filter((name) => name !== ''),
            );
            if (unlocked.size === 0) {
                mcpUnlocked.delete(agent);
            }
            else if (unlocked.size > 0) {
                mcpUnlocked.set(agent, unlocked);
            }
            const note = unlocked.size === 0 && hit.unknown.length === 0
                ? ''
                : renderMcpUnlockNote({ groups: unlockGroups(agent, hit.matched), unknown: hit.unknown });
            const index = ownMessageIndex(messages, MCP_GESTURE_KIND);
            const checkpoint = lastCheckpointIndex(messages);
            const visible = index > checkpoint ? index : -1;
            if (note === '') {
                // 没有手势：把上一轮的提醒收掉，别让模型以为还在解锁状态。
                if (index < 0) {
                    return null;
                }
                return messages.filter((message) => message?.source?.kind !== MCP_GESTURE_KIND);
            }
            HOOK_STATS.mcpUnlock += 1;
            const addition = createUserMessage({
                content: [{ type: 'text', text: note }],
                source: { kind: MCP_GESTURE_KIND, form: 'instructions', body: note },
            });
            if (visible >= 0) {
                if (messages[visible]?.source?.body === note) {
                    return null;
                }
                const next = messages.slice();
                next[visible] = addition;
                return next;
            }
            return [...messages, addition];
        }

        // ————————————————————— agent 生命周期 —————————————————————

        ctx.on('agent/created', async (payload) => {
            const agent = payload?.agent;
            if (!agent) {
                return;
            }
            await refreshAgent(agent);
            await applyRestrictions();
        });

        ctx.on('agent/disposed', (payload) => {
            const agent = payload?.agent;
            if (!agent) {
                return;
            }
            liftRestriction(agent);
            agentScopes.delete(agent);
            knownToolNames.delete(agent);
            mcpUnlocked.delete(agent);
        });

        // ————————————————————— HTTP 面 —————————————————————

        /**
         * 全量工具表：所有活着的 agent 的并集 + 插件级。
         *
         * 场景预设是**跨会话**的资产，它的候选集不能被「当前这个会话看得见什么」
         * 限制住 —— 否则在绑了窄场景的会话里编辑场景，会有一大票工具被报成
         * 「不在当前列表里（没启动或已卸载）」，那其实是这个会话看不见而已。
         */
        const allSchemas = async () => {
            const seen = new Map();
            // 宿主的 schemas() 是同步的；这里统一 await 一下，
            // 免得遇到返回值包了一层 Promise 的实现就静默变成空表。
            const add = async (pending) => {
                const list = await pending;
                for (const schema of list ?? []) {
                    if (schema?.name && !seen.has(schema.name)) {
                        seen.set(schema.name, schema);
                    }
                }
            };
            const agents = ctx.get('agents', false);
            try {
                for (const agent of agents?.list?.() ?? []) {
                    try {
                        await add(ctx.tools.schemas(agent));
                    }
                    catch {
                        /* 单个 agent 取不到就跳过 */
                    }
                }
            }
            catch {
                /* agents 服务不可用 */
            }
            try {
                await add(ctx.tools.schemas());
            }
            catch {
                /* 插件级视图取不到就只用 agent 的 */
            }
            return [...seen.values()];
        };

        // MCP 连接器管理：真源是两层 cordis.patch.yml，判活靠 loader + 工具表。
        const mcp = createMcpManager({ ctx, listSchemas: allSchemas });

        /**
         * 装到哪个技能目录 —— 必须是宿主真会去读的那几个
         * （dsh-skill-filesystem 的 `roots()`：项目级 `<projectRoot>/.dsh/skills`、
         * 用户级 `$DSH_HOME/skills`、`~/.agents/skills`、bundled）。
         * 这里只给前两个：用户级跨项目都能用，项目级跟着仓库走。
         */
        const skillMarketRoot = (options) => {
            const target = String(options?.target ?? 'user');
            const dshHome = ctx.get('profileContext', false)?.home ?? resolveDshHome();
            if (target === 'project') {
                const cwd = String(options?.cwd ?? '').trim();
                if (!cwd) {
                    const error = new Error('要装进项目，得先知道当前会话的工作目录');
                    error.code = 'bad-request';
                    throw error;
                }
                return joinPath(cwd, '.dsh', 'skills');
            }
            return joinPath(dshHome, 'skills');
        };

        // 插件变化监测：记住上一次的「插件 × 版本 × 工具 × 提示词段落」快照，
        // 下次发现不一样就自己查 —— 新装/升级的插件顺手做一轮软重启差分。
        // probe 通过 runProbeRef 反查：runProbe 是在下面的 deps 字面量里定义的，
        // 这里只能用闭包先占位，等 buildOps 执行时再拿到。
        let runProbeRef = null;
        // 软重启排查会**临时把插件关掉再打开**。这段时间里运行时工具表是残缺的，
        // 监测要是正好在扫，就会把「半截快照」记成基线 → 下一轮凭空报一堆
        // 「多了这些工具」的假事件。所以排查期间不许监测扫表。
        let probing = false;
        const pluginWatch = createPluginWatch({
            ctx,
            pluginManager: ctx.get('pluginManager', false),
            scanner,
            sectionCatalog,
            probe: (only) => (runProbeRef ? runProbeRef({ only }) : Promise.resolve({ probed: 0 })),
        });

        const ops = buildOps({
            version: VERSION,
            hookStats: () => ({
                ...HOOK_STATS,
                agents: agentScopes.size,
                knownTools: [...knownToolNames.values()].reduce((n, set) => n + set.size, 0),
            }),
            startedAt: Date.now(),
            store,
            library,
            scanner,
            pluginWatch,
            tools: ctx.tools,
            // 工具表必须按 agent 取：这个 profile 里绝大多数工具是按 preset/agent scope
            // 注册的，插件级 schemas() 只看得见全局层那一个。
            // 面板是「浏览与挑选」的地方：某个会话还没跑起来（没有活着的 agent）时，
            // 用任意一个活着的 agent 当目录视角。这只影响**看得到什么候选**，
            // 不参与任何 restrict / guard 决策 —— 那两条路径永远用执行现场的 agent。
            catalogAgent: async () => {
                const agents = ctx.get('agents', false);
                try {
                    const roots = agents?.roots?.() ?? [];
                    if (roots.length) {
                        return roots[0];
                    }
                    const list = agents?.list?.() ?? [];
                    return list[0] ?? undefined;
                }
                catch {
                    return undefined;
                }
            },
            /**
             * 全量工具表：所有活着的 agent 的并集 + 插件级视图。
             *
             * 场景预设是**跨会话**的资产，它的候选集不能被「当前这个会话看得见什么」
             * 限制住 —— 否则在绑了窄场景的会话里编辑场景，会有一大票工具被报成
             * 「不在当前列表里（没启动或已卸载）」，那其实是这个会话看不见而已。
             */
            allSchemas,
            schemasFor: async (sessionId) => {
                const id = String(sessionId ?? '').trim();
                let agent = id ? (ctx.agents?.get?.(id) ?? ctx.get('agents', false)?.get?.(id)) : undefined;
                if (!agent) {
                    const agents = ctx.get('agents', false);
                    try {
                        agent = agents?.roots?.()?.[0] ?? agents?.list?.()?.[0] ?? undefined;
                    }
                    catch {
                        agent = undefined;
                    }
                }
                try {
                    // 关键：把 agent 作为 **scope 参数**传进去。agent.ctx.tools.schemas()
                    // 不带参数取的是全局层视图，看不见按 preset 注册的那些工具。
                    return ctx.tools.schemas(agent ?? undefined);
                }
                catch {
                    return [];
                }
            },
            workspaceRegistry: ctx.get('workspaceRegistry', false),
            sessions: ctx.get('sessions', false),
            sessionPersistence: ctx.get('sessionPersistence', false),
            // 深度排查要用宿主��插件管理服务（软重启靠它）。
            pluginManager: ctx.get('pluginManager', false),
            // 归属扫描的状态：界面要知道「这份结果是缓存读来的，还是刚扫的」。
            scanInfo: () => ({ ...(scanner.info?.() ?? {}), lastScanAt }),
            // 各插件的实测状态：给界面显示「哪些结论是实测的」。
            probeStatus: async () => {
                const cache = await readProbeCache();
                const rows = [];
                // 已卸载的包不该继续出现在「实测状态」里 —— 那是给「还在的插件」看的。
                const installed = await collectInstalledNames({
                    pluginManager: ctx.get('pluginManager', false),
                    scanned: await scanner.get().catch(() => null),
                });
                for (const [name, record] of Object.entries(cache.plugins)) {
                    if (!isOwnerInstalled(name, installed)) {
                        continue;
                    }
                    rows.push({
                        packageName: name,
                        status: record.status ?? 'verified',
                        tools: Array.isArray(record.tools) ? record.tools.length : 0,
                        version: record.version ?? '',
                        verifiedAt: record.verifiedAt ?? 0,
                        reason: record.reason ?? '',
                    });
                }
                return rows;
            },
            // 深度排查：逐一软重启，用工具差分反推真实工具集。
            // 赋值表达式顺手把函数存进 runProbeRef，给下面的插件变化监测用
            // （监测要能在新装/升级时自己触发一轮，不能在 deps 字面量里自引用）。
            runProbe: (runProbeRef = async (options) => {
                probing = true;
                try {
                const manager = ctx.get('pluginManager', false);
                if (!manager) {
                    const error = new Error('这个宿主没有插件管理服务，没法软重启排查');
                    error.code = 'unsupported';
                    throw error;
                }
                const cache = await readProbeCache();
                const scanned = await scanner.get();
                const plugins = await manager.listPlugins();
                // 包名 → 版本。**不能拿 packages 的 key 去查**：
                // packages 是按目录名（`modlens`）做键的，而 loader 的 moduleName
                // 是包名（`@liustack/modlens`），直接 `.get(moduleName)` 永远是
                // undefined → 版本存成空串 → isProbeFresh 一律判「不新鲜」→
                // 实测结论永远进不了归属表（probed 恒为 0）。
                // 所以按 packageName 建表，再补一份目录名别名。
                const versionByName = new Map();
                for (const pkg of scanned?.packages?.values?.() ?? []) {
                    if (!pkg) {
                        continue;
                    }
                    const v = typeof pkg.version === 'string' ? pkg.version : '';
                    if (pkg.packageName) {
                        versionByName.set(pkg.packageName, v);
                    }
                    if (pkg.key) {
                        versionByName.set(pkg.key, v);
                    }
                }
                const versionOf = (moduleName) => {
                    const name = String(moduleName ?? '');
                    if (versionByName.has(name)) {
                        return versionByName.get(name);
                    }
                    // 子入口（billion-context/dsh-compaction-gate）退回主包。
                    const head = name.includes('/') ? name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/') : '';
                    if (head && versionByName.has(head)) {
                        return versionByName.get(head);
                    }
                    return '';
                };
                // 只查第三方插件（官方包归属本来就准，不用折腾）。
                const targets = plugins
                    .filter((p) => p?.enabled !== false && typeof p?.entryId === 'string')
                    // `cordis:include` 这类不是 npm 包，重装不了，跳过。
                    .filter((p) => typeof p?.moduleName === 'string' && p.moduleName !== '' && !p.moduleName.startsWith('cordis:'))
                    .filter((p) => !isOfficialPlugin(p.moduleName ?? ''))
                    .filter((p) => (options?.only ? options.only.has(p.moduleName) : true))
                    .map((p) => ({
                        entryId: p.entryId,
                        moduleName: p.moduleName,
                        version: versionOf(p.moduleName),
                    }));
                // 已经测过且版本没变的，不重复折腾。
                const pending = targets.filter((t) => {
                    const record = cache.plugins[t.moduleName];
                    return !isProbeFresh(record, t.version);
                });
                const { results } = await probePlugins({
                    ctx,
                    pluginManager: manager,
                    plugins: pending,
                    cache: cache.plugins,
                    onProgress: (msg) => {
                        try {
                            ctx.logger?.info?.(msg);
                        }
                        catch {
                            /* 日志失败不影响排查 */
                        }
                    },
                });
                // 把结果并进缓存（带上版本号，升级后自动失效）。
                const merged = { ...cache.plugins };
                for (const row of results) {
                    const target = pending.find((t) => t.moduleName === row.moduleName);
                    merged[row.moduleName] = {
                        tools: row.tools,
                        status: row.status,
                        reason: row.reason ?? '',
                        version: target?.version ?? '',
                        verifiedAt: Date.now(),
                    };
                }
                await writeProbeCache(merged);
                return { results, probed: results.filter((r) => r.status === 'verified').length };
                } finally {
                    probing = false;
                }
            }),
            // 删会话要自己动盘，所以得知道 <sessions> 根在哪：jsonl 后端把这个根
            // 挂在 `root` 字段上；拿不到就按约定落到 $DSH_HOME/sessions。
            sessionsRoot: (() => {
                const persistence = ctx.get('sessionPersistence', false);
                const root = persistence?.root;
                return typeof root === 'string' && root ? root : `${resolveDshHome()}/sessions`;
            })(),
            deleteSession: (id, options) => deleteSession({
                ctx,
                persistence: ctx.get('sessionPersistence', false),
                sessions: ctx.get('sessions', false),
                workspaceRegistry: ctx.get('workspaceRegistry', false),
                sessionsRoot: (() => {
                    const persistence = ctx.get('sessionPersistence', false);
                    const root = persistence?.root;
                    return typeof root === 'string' && root ? root : `${resolveDshHome()}/sessions`;
                })(),
                logger: ctx.logger,
            }, id, options),
            sessionProjectionCache: ctx.get('sessionProjectionCache', false),
            sessionTitle: ctx.get('sessionTitle', false),
            sessionProjections: ctx.get('sessionProjections', false),
            resolveScope,
            refreshLibrary: async () => {
                Object.assign(library, await loadLibrary());
            },
            afterChange: async () => {
                await refreshAllAgents();
            },
            listPersonas,
            listPersonasWithBody,
            readPersona,
            savePersona,
            deletePersona,
            listScenes,
            readScene,
            saveScene,
            deleteScene,
            sectionCatalog,
            // 「已卸载的插件还留着痕迹」的清理：段落目录 + 实测缓存。
            reconcileUninstalled,
            // 现在还装着哪些包（包名基名集合）：界面侧用来过滤已卸载插件留下的幽灵记录。
            installedNames: async () => collectInstalledNames({
                pluginManager: ctx.get('pluginManager', false),
                scanned: await scanner.get().catch(() => null),
            }),
            // 会话 id → 活 agent：技能/工具视图都要拿它当 scope（不传只剩插件级那一份）。
            findAgent: async (sessionId) => {
                const id = String(sessionId ?? '').trim();
                if (!id) {
                    return undefined;
                }
                const agents = ctx.get('agents', false);
                const direct = agents?.get?.(id);
                if (direct) {
                    return direct;
                }
                const known = agents?.list?.() ?? [];
                for (const agent of known) {
                    const owner = sessionScopeIdOf(agent);
                    if (owner === id || agent?.session?.header?.id === id) {
                        return agent;
                    }
                }
                return undefined;
            },
            listSkills: (options) => listSkills(ctx.skills, options),
            /**
             * 全量技能：所有活着的 agent 的并集 + 插件级。
             * 场景预设要跨会话复用，候选集不能只有「当前会话能看见的技能」。
             */
            allSkills: async () => {
                const seen = new Map();
                const merge = (list) => {
                    for (const skill of list ?? []) {
                        if (skill?.name && !seen.has(skill.name)) {
                            seen.set(skill.name, skill);
                        }
                    }
                };
                const agents = (() => {
                    try {
                        return ctx.get('agents', false)?.list?.() ?? [];
                    }
                    catch {
                        return [];
                    }
                })();
                for (const agent of agents) {
                    try {
                        merge(await listSkills(ctx.skills, {
                            cwd: agent?.session?.header?.cwd,
                            scope: agent,
                        }));
                    }
                    catch {
                        /* 单个取不到就跳过 */
                    }
                }
                try {
                    merge(await listSkills(ctx.skills, {}));
                }
                catch {
                    /* 插件级取不到就算了 */
                }
                return [...seen.values()];
            },
            readSkillFile: (name, options) => readSkillFile(ctx.skills, name, options),
            writeSkillFile: (name, content, options) => writeSkillFile(ctx.skills, name, content, options),
            // 停用/启用技能：语义写在 frontmatter 的调用面开关上（宿主没有独立的开关表）。
            setSkillPolicy: (name, enabled, options) => setSkillPolicy(ctx.skills, name, enabled, options),
            // 卸载自装技能：整个技能目录硬删（rm -rf），不做回收站。
            uninstallSkill: (input) => uninstallSelfInstalledSkill(input),
            // MCP 连接器管理（读写两层补丁 + 判活）。
            mcp,
            /**
             * 技能市场：直接接 SkillHub（https://api.skillhub.cn）的公开接口。
             * 安装 = 下 zip 解开到 $DSH_HOME/skills/<slug>/，宿主自己会广播 skills/change。
             */
            skillMarket: {
                homeUrl: MARKET_HOME,
                list: (options) => listMarket(options),
                categories: () => listCategories(),
                detail: (slug) => skillDetail(slug),
                skillsRoot: skillMarketRoot,
                install: (options) => installSkill({
                    ...options,
                    skillsRoot: skillMarketRoot(options),
                }),
            },
            // 宿主有没有装 agent 预设注册表；没装就是 undefined，界面上不显示这一块。
            agentPresets: ctx.get('agentPresets', false) || null,
            agents: ctx.get('agents', false) || null,
            // 权限预设：宿主自己的读-沙箱/审批组合；没有这个服务就整块不显示。
            permissionPresets: ctx.get('permissionPresets', false) || null,
            liveAgents: () => [...agentScopes.keys()].map((a) => [a.id, a]),
        });

        installHttpApi(ctx, { webServer: ctx.webServer, ops });

        // 装上那一刻就已经开着的会话，也要进 agentScopes（热重载场景下这是唯一的入口）。
        ctx.effect(() => {
            adoptLiveAgents();
            const timer = setTimeout(() => {
                adoptLiveAgents();
            }, 1500);
            return () => clearTimeout(timer);
        }, 'scope-manager: adopt live agents');

        // 插件变化监测的心跳。
        //
        // 为什么是 2 分钟：装插件是低频动作，但用户装完往往马上回来看面板；
        // 太慢要等，太快每次都去列 Loader 条目、读扫描缓存，不值。
        // 首轮延 8 秒 —— 启动时 Loader 还在逐个挂插件，早跑只会看到半截。
        ctx.effect(() => {
            let stopped = false;
            const tick = () => {
                if (stopped || probing) {
                    // 正在软重启排查：这一轮跳过，别把半截工具表记成基线。
                    return;
                }
                void pluginWatch.run().catch((e) => {
                    try {
                        ctx.logger?.debug?.(`[scope-manager] 插件变化监测：${String(e?.message ?? e)}`);
                    }
                    catch {
                        /* 日志失败不影响主流程 */
                    }
                });
                // 顺手对一次账：插件被卸载后，它留下的段落记录和实测缓存要清掉，
                // 否则插件页会多出一张「幽灵卡片」（只有段落、没有工具的空组）。
                void reconcileUninstalled({ force: true }).catch((e) => {
                    try {
                        ctx.logger?.debug?.(`[scope-manager] 清理已卸载插件残留：${String(e?.message ?? e)}`);
                    }
                    catch {
                        /* 日志失败不影响主流程 */
                    }
                });
            };
            const first = setTimeout(tick, 8000);
            const timer = setInterval(tick, 120000);
            return () => {
                stopped = true;
                clearTimeout(first);
                clearInterval(timer);
            };
        }, 'scope-manager: plugin watch');

        // 工具注册表一变，就核对一次归属指纹（**不重扫**，只 stat）。
        //
        // 为什么还要这一条：装插件必然伴随注册工具，`tools/change` 是这件事
        // 最快的一手信号 —— 比 30 秒的 TTL 核对、2 分钟的心跳都早，用户装完
        // 插件回头刷新面板时归属已经是新的。核对本身只 stat 十几个
        // package.json（实测 ~30ms）；指纹没变就什么都不做，真变了才后台重扫。
        ctx.effect(() => {
            let timer = null;
            const onChange = () => {
                // 排查期间工具表在抖（关插件→工具消失），这时的变化不代表
                //「插件集合变了」，等它结束再说。
                if (probing) {
                    return;
                }
                if (timer) {
                    clearTimeout(timer);
                }
                timer = setTimeout(() => {
                    timer = null;
                    if (probing) {
                        return;
                    }
                    // 后台动作，失败没人接 —— 吞掉，别变成 unhandled rejection。
                    void scanner.verify().catch(() => { });
                }, 2500);
            };
            const off = ctx.on('tools/change', onChange);
            return () => {
                if (timer) {
                    clearTimeout(timer);
                }
                if (typeof off === 'function') {
                    off();
                }
            };
        }, 'scope-manager: watch tools/change');

        // ————————————————————— 启动 —————————————————————

        // 加载是异步的，但**不阻塞 apply**：插件挂上以后立刻能用，
        // 第一次真正需要数据时（pre-step / assemble）会 await 同一个 load。
        void (async () => {
            try {
                await store.load();
                Object.assign(library, await loadLibrary());
                await refreshAllAgents();
            }
            catch (e) {
                ctx.logger?.warn?.(`[scope-manager] 启动加载失败：${String(e?.message ?? e)}`);
            }
        })();

        return undefined;
    },
};
