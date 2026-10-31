// `@mcp:服务名` 手势 —— 纯函数那一半。
//
// 为什么要有这个：MCP 工具平时被预设名单挡在工具表外（模型根本看不见），
// 但用户希望「像 /技能名 那样，当场点名一台服务，这一轮就把它放出来」。
// 手势解析必须无副作用、可单测；真正改可见性的是 index.js 里的三处钩子：
//   · agent/pre-step —— 认手势、记下本轮解锁的服务器、注入工具目录
//   · system-prompt/assemble —— 过滤工具时给解锁的服务器开个口子
//   · tools.guard —— 调用侧同样放行（不然模型记得名字也调不动）
//
// 匹配口径：`@mcp:my-server` 可以命中配置里的**服务名**（serverName，工具前缀就是它）、
// 行的 id，或者用户起的**备注名**（名称那一栏，可以写中文）。三选一命中即可。

/** 注入到对话里的提醒消息的 source.kind —— 也用来找回上一条、判「要不要替换」。 */
export const MCP_GESTURE_KIND = 'scope-manager-mcp-unlock';

/**
 * 手势本体。名字到空白或常见标点为止 —— 备注名可以是中文，所以中文句读也算边界，
 * 否则「@mcp:my-server，谢谢」会把「，谢谢」一起吞进名字里。
 */
const GESTURE = /@mcp:([^\s@，。；、！？：,.;!?:）)\]】》」』"'`]+)/gi;

/** 名字尾部容易粘上的标点：中文句读、英文句读、右括号、引号。 */
const TRAILING = /[，。；、！？：,.;!?:）)\]】》」』"'`]+$/u;
/** 名字前部粘上的左括号/引号。 */
const LEADING = /^[（([【《「『"'`]+/u;

/**
 * 抽出手势里的名字。
 *
 * @param {string} text 一段正文
 * @returns {string[]} 名字（保持出现顺序，允许重复）
 */
export function mcpGestureTokens(text) {
    const out = [];
    const source = String(text ?? '');
    if (source === '') {
        return out;
    }
    for (const match of source.matchAll(GESTURE)) {
        const name = String(match[1] ?? '').replace(TRAILING, '').replace(LEADING, '');
        if (name !== '') {
            out.push(name);
        }
    }
    return out;
}

/**
 * 一台服务器能被哪些写法指到。
 *
 * @param {object} server mcp 管理器吐出来的行
 * @returns {string[]} 小写化的候选键
 */
export function serverGestureKeys(server) {
    const keys = [];
    const push = (value) => {
        const key = String(value ?? '').trim().toLowerCase();
        if (key !== '' && !keys.includes(key)) {
            keys.push(key);
        }
    };
    push(server?.serverName);
    push(server?.id);
    push(server?.name);
    return keys;
}

/**
 * 手势名 → 服务器行。
 *
 * @param {string[]} tokens mcpGestureTokens 的结果
 * @param {Array<object>} servers mcp 管理器的 servers
 * @returns {{matched: Array<object>, unknown: string[]}} matched 按出现顺序去重
 */
export function resolveMcpGesture(tokens, servers) {
    const list = Array.isArray(servers) ? servers : [];
    const byKey = new Map();
    for (const server of list) {
        for (const key of serverGestureKeys(server)) {
            // 先到先得：服务名比 id/备注名更「正式」，同一台机器不会重复登记。
            if (!byKey.has(key)) {
                byKey.set(key, server);
            }
        }
    }
    const matched = [];
    const unknown = [];
    const seen = new Set();
    for (const token of tokens) {
        const server = byKey.get(String(token ?? '').trim().toLowerCase());
        if (!server) {
            unknown.push(token);
            continue;
        }
        const key = String(server.serverName ?? '') || String(server.id ?? '');
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        matched.push(server);
    }
    return { matched, unknown };
}

/** 描述太长会把提醒撑爆，截到一句。 */
function trim(text, limit = 120) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** 工具 schema 的必填参数（宿主 schema 里就是个字符串数组）。 */
function requiredParams(tool) {
    const required = tool?.parameters?.required;
    return Array.isArray(required) ? required.map((v) => String(v)).filter(Boolean) : [];
}

/**
 * 渲染「本轮解锁」提醒正文。
 *
 * @param {object} input
 * @param {Array<{label: string, serverName: string, tools: Array<object>}>} input.groups
 * @param {string[]} [input.unknown] 没认出来的手势名
 * @returns {string} 正文（没有解锁也没有未知手势时返回空串）
 */
export function renderMcpUnlockNote({ groups, unknown }) {
    const list = Array.isArray(groups) ? groups : [];
    const misses = Array.isArray(unknown) ? unknown : [];
    if (list.length === 0 && misses.length === 0) {
        return '';
    }
    const lines = ['## 本轮解锁的 MCP 服务', '', '用户用 `@mcp:` 点名了下面这些服务。它们的工具平时不在工具表里，只在**这一轮**放开，下一轮自动收回；要调用就直接用下面这些名字。', ''];
    for (const group of list) {
        const tools = Array.isArray(group.tools) ? group.tools : [];
        if (tools.length === 0) {
            lines.push(`- \`${group.label}\`：这一轮没有拿到它的工具（多半没连上，可以先用 mcp 页的「检查」看一眼）。`);
            continue;
        }
        lines.push(`- \`${group.label}\`：`);
        for (const tool of tools) {
            const required = requiredParams(tool);
            const name = String(tool?.name ?? '');
            const desc = trim(tool?.description);
            const tail = required.length > 0 ? `（必填：${required.join('、')}）` : '';
            lines.push(`  - \`${name}\`${desc === '' ? '' : ` — ${desc}`}${tail}`);
        }
    }
    if (misses.length > 0) {
        lines.push('');
        lines.push(`没认出来的写法：${misses.map((token) => `\`@mcp:${token}\``).join('、')}（对一下服务名，或者 MCP 页里那台连接器的名称）。`);
    }
    return lines.join('\n');
}
