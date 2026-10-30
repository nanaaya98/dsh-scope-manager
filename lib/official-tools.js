// 官方工具 → 官方包 的归属表。
//
// 这张表是**烘进插件的静态事实**：宿主包升级时工具名可能变，所以插件不假设它永远正确 ——
// 扫包的结果（lib/tool-owner.js）与这张表合并，表里没有的以扫描为准，表里有的以表为准
// （表是人工核对过的，扫描可能把同一个工具名归到两个包上）。
//
// 名字与包的对应是从宿主包目录实扫出来的（`defineTool({ name: '...' })`），
// 同名多包时取**最短且非 experimental**的那个 —— experimental 包是实验副本，
// 同一个工具在正式包里也有一份，归属应当报正式包。
export const OFFICIAL_TOOL_OWNERS = Object.freeze({
    // —— 名字不在 defineTool 字面量里的（工厂/动态命名，静态扫描扫不到）——
    // 这三条是实机核对后手工补的：plan-mode 用常量、tool-workflow 用 run.meta.name、
    // subagent_fork 由 subagent 运行时拼名字。
    exit_plan_mode: 'dsh-plan-mode',
    workflow: 'dsh-tool-workflow',
    subagent_fork: 'dsh-subagent',
    // —— 官方工具包 ——
    ask_user_question: 'dsh-tool-ask-user',
    bash: 'dsh-tool-bash',
    pwsh: 'dsh-tool-pwsh',
    cordis_inspect_list: 'dsh-tool-cordis',
    cordis_inspect_query: 'dsh-tool-cordis',
    edit: 'dsh-tool-fs',
    read: 'dsh-tool-fs',
    read_image: 'dsh-tool-fs',
    write: 'dsh-tool-fs',
    glob: 'dsh-tool-fs-search',
    grep: 'dsh-tool-fs-search',
    create_goal: 'dsh-tool-goal',
    get_goal: 'dsh-tool-goal',
    update_goal: 'dsh-tool-goal',
    job_kill: 'dsh-tool-jobs',
    job_list: 'dsh-tool-jobs',
    job_output: 'dsh-tool-jobs',
    present: 'dsh-tool-present',
    ralph: 'dsh-tool-ralph',
    schedule_create: 'dsh-tool-schedule',
    schedule_delete: 'dsh-tool-schedule',
    schedule_list: 'dsh-tool-schedule',
    schedule_update: 'dsh-tool-schedule',
    session_event_read: 'dsh-tool-session-query',
    session_event_search: 'dsh-tool-session-query',
    session_event_trace: 'dsh-tool-session-query',
    session_search: 'dsh-tool-session-query',
    session_trace: 'dsh-tool-session-query',
    skill: 'dsh-tool-skill',
    str_replace_editor: 'dsh-tool-str-replace-editor',
    list_subagent_models: 'dsh-tool-subagent',
    interrupt_agent: 'dsh-tool-subagent-control',
    list_agents: 'dsh-tool-subagent-control',
    send_message: 'dsh-tool-subagent-control',
    terminal_close: 'dsh-tool-terminal',
    terminal_create: 'dsh-tool-terminal',
    terminal_read: 'dsh-tool-terminal',
    terminal_write: 'dsh-tool-terminal',
    todo_write: 'dsh-tool-todo',
    web_fetch: 'dsh-tool-web',
    web_search: 'dsh-tool-web',
    working_directory: 'dsh-tool-working-directory',
    load_workspace_dependencies: 'dsh-tool-workspace-dependencies',

    // —— 官方 MCP 资源工具（归属 mcp-client 家族，不是连接器）——
    list_mcp_resource_templates: 'dsh-mcp-resources',
    list_mcp_resources: 'dsh-mcp-resources',
    read_mcp_resource: 'dsh-mcp-resources',

    // —— 官方插件形态的工具（官方插件，也是「系统工具」）——
    plugin_manager: 'dsh-plugin-manager',
    plugin_market: 'dsh-plugin-market',
});
