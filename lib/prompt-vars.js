// 系统提示词里的占位符：宿主只认一种写法 —— `{{变量名}}`。
//
// 关键事实（`@deepseek-ai/dsh-system-prompt/lib/index.js:110-186`）：
//   · 插值发生在 `renderPrompt()` 里，也就是**在 `system-prompt/assemble` 瀑布之后**；
//     本插件改的是瀑布里的 `section.text`，所以覆写里写 `{{model}}` 照样会被换掉。
//   · 名字必须匹配 `^[a-z][a-z0-9_]*$`；未知变量、坏写法会在渲染时**抛错**，
//     整轮对话直接失败 —— 所以要在保存时就拦住，不能等它炸在装配里。
//   · `interpolate: false` 的段落是字面量，里面的 `{{...}}` 原样留着，不替换。
//   · 孤零零一个 `{{` （后面再没有 `}}`）当普通文字，不算引用。

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const GROUP_AT = /^\{\{([^{}]*)\}\}/;

/**
 * 扫一段文字里的 `{{...}}` 引用与坏写法。
 * @returns {{refs: Array<{name: string, start: number, end: number}>, problems: Array<object>}}
 */
export function scanPromptVars(text) {
    const src = String(text ?? '');
    const refs = [];
    const problems = [];
    let last = 0;
    for (let open = src.indexOf('{{'); open >= 0; open = src.indexOf('{{', last)) {
        const group = GROUP_AT.exec(src.slice(open));
        if (group === null) {
            if (src.indexOf('}}', open + 2) >= 0) {
                problems.push({
                    kind: 'malformed',
                    snippet: src.slice(open, open + 16),
                    message: `「${src.slice(open, open + 16)}…」不是完整的 {{名字}} 写法（里面不能有别的花括号）`,
                });
            }
            // 孤零零的 `{{` 是普通文字，宿主也当文字，不算问题。
            last = open + 2;
            continue;
        }
        const name = group[0].slice(2, -2);
        if (!VARIABLE_NAME.test(name)) {
            problems.push({
                kind: 'bad-name',
                name,
                message: `变量名「${name}」不合法（只能是 a-z、0-9、下划线，且以字母开头）`,
            });
        }
        else {
            refs.push({ name, start: open, end: open + group[0].length });
        }
        last = open + group[0].length;
    }
    return { refs, problems };
}

/**
 * 保存前检查：未知变量必须拦住 —— 宿主是在渲染时抛错的，那时候这一轮已经废了。
 * `known` 为空（还没装配过、拿不到变量表）时只查写法，不查存在性。
 * @returns {{ok: boolean, unknown: string[], problems: Array<object>, message: string}}
 */
export function validatePromptVars(text, known) {
    const { refs, problems } = scanPromptVars(text);
    const table = known instanceof Set ? known : new Set(known ?? []);
    const unknown = [];
    if (table.size > 0) {
        for (const ref of refs) {
            if (!table.has(ref.name) && !unknown.includes(ref.name)) {
                unknown.push(ref.name);
            }
        }
    }
    const parts = [];
    if (problems.length > 0) {
        parts.push(problems.map((p) => p.message).join('；'));
    }
    if (unknown.length > 0) {
        parts.push(`没有这些变量：${unknown.map((n) => `{{${n}}}`).join('、')}`);
    }
    return {
        ok: parts.length === 0,
        unknown,
        problems,
        message: parts.join('。'),
    };
}

/**
 * 本插件自己提供的占位符。
 *
 * 为什么需要：有些段落的正文是**动态**的（`mcp-resource-servers` 的服务器名单
 * 每轮现算），可一旦用户覆写就冻住了。给它一个变量，覆写里写 `{{mcp_servers}}`
 * 就能既保留自己的排版、又跟着服务器增减走。
 *
 * 这些名字宿主不认识 —— 所以由本插件在写入 `section.text` **之前**替换掉；
 * 换上真实值之后宿主根本看不到 `{{…}}`，也就不会因为「未知变量」把整轮渲染搞崩。
 * （宿主插值发生在 assemble 之后，见本文件顶部说明。）
 */
export const SCM_VAR_NAMES = ['mcp_servers'];

/**
 * 每一段都能用的「本段原文」：装配时把这一段的原文（覆写之前的那份）塞回去。
 *
 * 为什么需要它而不是「差分抽变量」：有些段落的正文是现算的（服务器名单、
 * 工作目录…），但你没法给每一处变动起一个稳定的名字 —— 今天抽出来叫 a1、
 * 明天结构变了就叫 a2，覆写里存着的名字会莫名其妙失效。
 * `{{original}}` 是确定性的：它永远等于「这一段此刻的原文」，
 * 于是「在原文外面加一层自己的排版」这件事就不再有冻结问题。
 */
export const SELF_VAR = 'original';

/**
 * 从这次装配里算出本插件变量的值。
 * `mcp_servers` 优先取 `mcp-resource-servers` 段落的实时正文（那是权威口径），
 * 取不到再退回「工具表里出现过的 MCP 服务器」。
 * @param {Array<{name?: string, text?: string}>} sections 覆写之前的段落（宿主原文）
 * @param {Array<{name?: string}>} tools
 * @param {(name: string) => string|null} mcpServerOf
 * @returns {Record<string, string>}
 */
export function scmVarsFromSections(sections, tools, mcpServerOf) {
    let names = null;
    if (Array.isArray(sections)) {
        const serverSection = sections.find((s) => s?.name === 'mcp-resource-servers');
        const text = typeof serverSection?.text === 'string' ? serverSection.text : '';
        const match = /server argument:\s*(\[[^\]]*\])/.exec(text);
        if (match) {
            try {
                const parsed = JSON.parse(match[1]);
                if (Array.isArray(parsed)) {
                    names = parsed.filter((n) => typeof n === 'string');
                }
            }
            catch {
                names = null;
            }
        }
    }
    if (names === null && Array.isArray(tools) && typeof mcpServerOf === 'function') {
        const seen = new Set();
        for (const tool of tools) {
            const server = mcpServerOf(tool?.name);
            if (server) {
                seen.add(server);
            }
        }
        names = [...seen].sort();
    }
    return { mcp_servers: JSON.stringify(names ?? []) };
}

/**
 * 一段文字里用到的占位符名字（去重、排好序）。
 * 用来「自动认领」某一段自己的变量：原文里怎么写，编辑这一段时就能怎么用。
 */
export function tokensInText(text) {
    const { refs } = scanPromptVars(text);
    return [...new Set(refs.map((r) => r.name))].sort();
}

/**
 * 把认识的变量换成真实值；不认识的 `{{…}}` 原样留着（那些归宿主管）。
 * `values` 里既可以有宿主注册的变量，也可以有本插件自己算的（`mcp_servers`）。
 */
export function applyVars(text, values) {
    const src = String(text ?? '');
    if (!src.includes('{{')) {
        return src;
    }
    return src.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (whole, name) => {
        if (!Object.prototype.hasOwnProperty.call(values ?? {}, name)) {
            return whole;
        }
        const value = values[name];
        // 宿主是 `result += value`（隐式转字符串）；undefined 它自己会抛错，这里保持原样。
        return value === undefined ? whole : String(value);
    });
}
