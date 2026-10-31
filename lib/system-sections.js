// 宿主自带提示词段落的默认归属表。
//
// 背景：宿主不告诉你是谁往提示词里 push 的段落，只能反着查（见 lib/section-source.js）。
// 但反查是启发式的：它得扫到那个包才能确认归属，而宿主自己的官方包装在
// 宿主本体的 node_modules 里（`.../dsh/node_modules/@deepseek-ai/*`），
// 目录布局随安装方式变，扫不到就整段落查不出来 —— 界面上一片「来源不明」。
//
// 这张表兜住那部分：宿主自带的段落名和它的归属包是稳定的（段落名是宿主自己
// 起的常量，归属包是它所在的那个官方包），所以直接写死一份对照。
//
// 表与现实不一致时怎么办：**以反查为准**。反查能在源码里找到定义（常量赋值
// 或注册点），那是当下这套宿主的事实；表只是它扫不到时的兜底。
// 以后宿主新增了段落、或者把某段搬到了别的包里，反查会先给出新答案，表跟着
// 落败也没关系 —— 真正要改的是这张表，但不影响归属正确。
//
// 表里没有的名字（第三方插件的段落、宿主以后新增的段落）一律交给反查。

/**
 * 段落名 → 拥有它的官方包名。
 *
 * 值写完整的包名（`@deepseek-ai/xxx`）：界面按包名分组，
 * 归属判定也按「是不是官方包」来区分（见 lib/tool-owner.js 的 isOfficialPlugin）。
 *
 * @type {ReadonlyMap<string, string>}
 */
export const SYSTEM_SECTION_OWNERS = new Map(Object.entries(Object.freeze({
    // 运行时上下文：宿主实现 checkout 的位置、Web GUI 的使用语义
    'harness:source': '@deepseek-ai/dsh-harness-dev-context',
    'app:web-surface': '@deepseek-ai/dsh-harness-dev-context',
    // 人设三段（世界观 / 角色设定 / 收尾口径）
    'harness:identity': '@deepseek-ai/dsh-system-prompt',
    'deployment:persona-prefix': '@deepseek-ai/dsh-system-prompt',
    'deployment:persona-suffix': '@deepseek-ai/dsh-system-prompt',
    // 工具说明与策略
    'context:file-reference': '@deepseek-ai/dsh-file-reference-local',
    'plan:policy': '@deepseek-ai/dsh-plan-mode',
    'team:policy': '@deepseek-ai/dsh-experimental-tool-agent-team',
    'ui:deliverable-file-references': '@deepseek-ai/dsh-client-ui-deliverables',
    'tool:bash': '@deepseek-ai/dsh-tool-bash',
    'tool:edit': '@deepseek-ai/dsh-tool-fs',
    'tool:read': '@deepseek-ai/dsh-tool-fs',
    'tool:write': '@deepseek-ai/dsh-tool-fs',
    'tool:glob': '@deepseek-ai/dsh-tool-fs-search',
    'tool:grep': '@deepseek-ai/dsh-tool-fs-search',
    'tool:goal': '@deepseek-ai/dsh-tool-goal',
    'tool:jobs': '@deepseek-ai/dsh-tool-jobs',
    'tool:pwsh': '@deepseek-ai/dsh-tool-pwsh',
    'tool:ralph': '@deepseek-ai/dsh-tool-ralph',
    'tool:session-query': '@deepseek-ai/dsh-tool-session-query',
    'tool:pty': '@deepseek-ai/dsh-tool-terminal',
    'tool:web_fetch': '@deepseek-ai/dsh-tool-web',
    'tool:web_search': '@deepseek-ai/dsh-tool-web',
})));

/**
 * 这段的默认归属包名（没有就说没有）。
 *
 * @param {string} name 段落名
 * @returns {string} 官方包名，没有默认归属时是空串
 */
export function systemSectionOwner(name) {
    return SYSTEM_SECTION_OWNERS.get(String(name ?? '').trim()) ?? '';
}
