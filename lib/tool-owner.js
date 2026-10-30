// 工具归属：把一个工具名归到「系统 / 插件 / MCP / 其他」四类来源，再给出更细的归属者。
// MCP 这一类在界面上单独成页（「MCP」页按连接器列），插件页只按来源分剩下的几类。
//
// 难点：宿主没有「工具名 → 哪个插件」的现成服务。
// `pluginInventory` 的 entry 形状是 `{entryId, moduleName, meta, enabled, fiberPhase}` ——
// **没有工具字段**，所以归属只能自己建。
//
// 办法：扫已安装插件包里的 `defineTool({ name: '...' })` 调用，把「工具名 → 包名」记下来。
// 扫出来的是**事实**（那个包里确实定义了这个名字的工具），但可能重名（两个包都叫 `x`）——
// 这时取**包名最短**的那个，理由同上：同名时更具体的包更可能是真身。
//
// 三条纪律（都是踩过坑之后加的）：
//   1. 扫之前先**剥掉注释**。否则本文件自己的注释 `defineTool({ name: 'x' })`
//      会被当成真的工具定义 —— 实测产出过 `...` / `x` / `xxx` 三个假工具，
//      还把 `exit_plan_mode` 抢到了本包名下（它本该归 dsh-plan-mode）。
//   2. 工具名不一定写���字面量。除了 `name: 'lit'`，还要认：
//        - `name: SomeConst`（顶部常量）
//        - `name: TOOL_ACTIONS 的对象键`（循环注册，name 是标识符）
//        - `name: ['a','b']` 的数组元素
//      不认这些就会整条漏掉 —— dsh-cuigengji-plugin 的 4 个工具就是这么丢的。
//   3. 只扫**入口可达**的那一份源码。同一个包常有 `src/`（源码）与
//      `runtime/` / `dist/`（编译产物）两份，扫两份等于把同一行算两遍，
//      而且两边的注释不一样，产物会被错当成源码。
//   4. 源码扫不到时，**问插件自己**。有些插件不把工具名写在源码里 ——
//      名字是运行时从 HTTP manifest 拉来的（billion-context 的 acp_cache
//      就是：源码里只有 `forwardTool(base, sid, "acp_cache", …)`，
//      工具定义本身在 manifest 里）。这类必须走 manifest 通道，
//      静态扫源码永远认不出。
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveDshHome } from './paths.js';
import { OFFICIAL_TOOL_OWNERS } from './official-tools.js';
import { fetchPluginManifests } from './plugin-manifest.js';
import { freshProbeTools } from './probe-cache.js';
import { readScanCache, writeScanCache, dropScanCache } from './scan-cache.js';

export const CATEGORY_SYSTEM = 'system';
export const CATEGORY_PLUGIN = 'plugin';
export const CATEGORY_MCP = 'mcp';
export const CATEGORY_OTHER = 'other';

export const CATEGORY_LABELS = Object.freeze({
    [CATEGORY_SYSTEM]: '系统工具',
    [CATEGORY_PLUGIN]: '插件工具',
    [CATEGORY_MCP]: 'MCP 工具',
    [CATEGORY_OTHER]: '其他工具',
});

const MCP_PREFIX = 'mcp__';

/**
 * 这个包是不是宿主自带的（官方）包。
 *
 * 官方包全都发在 `@deepseek-ai/` 这个作用域下（宿主本体是 `@deepseek-ai/dsh`，
 * 官方插件是 `@deepseek-ai/dsh-tool-*` 之类）；第三方插件无论装在
 * profile 的 node_modules 还是工作区里，包名都不会落进这个作用域。
 * 所以「有没有工具的段落组该算系统还是插件」就靠作用域判，与安装位置无关 ——
 * 段落目录里记的只有包名，没有安装路径。
 */
export function isOfficialPlugin(plugin) {
    return /^@deepseek-ai\//.test(String(plugin ?? '').trim());
}

/** 从 MCP 全名里切出连接器名：`mcp__<server>__<tool>` → `<server>`。 */
export function mcpServerOf(fullName) {
    if (!fullName.startsWith(MCP_PREFIX)) {
        return undefined;
    }
    const rest = fullName.slice(MCP_PREFIX.length);
    const cut = rest.indexOf('__');
    return cut > 0 ? rest.slice(0, cut) : rest;
}

/**
 * 分类一个工具名。
 *
 * @param {string} name 工具全名
 * @param {Record<string, {category?: string, owner?: string}>} overrides 用户手工修正
 * @param {{system?: Map<string,string>, plugin?: Map<string,string>}} scanned 扫包得到的「工具名 → 包名」，官方包与第三方插件包分开
 */
export function classifyToolName(name, overrides, scanned) {
    const override = overrides?.[name];
    if (override && (override.category || override.owner)) {
        return {
            category: override.category ?? CATEGORY_OTHER,
            owner: override.owner ?? '未归属',
            overridden: true,
        };
    }
    const server = mcpServerOf(name);
    if (server) {
        return { category: CATEGORY_MCP, owner: server, overridden: false };
    }
    // **实测**结论 —— 深度排查观测到的，最可信。
    // 这是唯一一条「观测到插件注册了什么工具」的通道：把插件关掉，看什么消失；
    // 再打开，看什么回来。差集就是它的真实工具集。
    // 排在所有静态推断之前（仅次于用户手点的 override）。
    const probed = scanned?.probed?.get(name);
    if (probed) {
        return { category: CATEGORY_PLUGIN, owner: probed, overridden: false, probed: true };
    }
    // 第三方插件里**真实扫到**的工具名，比任何猜测都可靠 ——
    // 优先于官方派生名和手写表。
    //
    // 为什么：官方表的条目是「官方包可能派生出这个名字」，属于猜；
    // 而 scanned.plugin 是「这个第三方包里确实出现了这个名字」，是事实。
    // 事实优先于猜测 —— 否则官方包里一个恰好叫 `workflow` 的派生名，
    // 会把第三方插件的 `workflow` 抢走，工具被安到官方包头上。
    //
    // 注意 scanned.system 仍然排在前面：官方包扫出来的是**系统**工具，
    // 跟第三方插件是不同类别，不存在「抢」的问题。
    const fromScan = scanned?.plugin?.get(name);
    if (fromScan) {
        return { category: CATEGORY_PLUGIN, owner: fromScan, overridden: false };
    }
    // 官方包扫出来的算系统工具 —— 它比手写表可靠：手写表只能覆盖写表当时有的工具。
    const official = scanned?.system?.get(name) ?? OFFICIAL_TOOL_OWNERS[name];
    if (official) {
        return { category: CATEGORY_SYSTEM, owner: official, overridden: false };
    }
    // 兜底：有些插件不写 `defineTool({ name: 'x' })`，而是用工厂函数
    // （modlens 的 readImageTool(preferred)、ego 的 builder…），名字只以字符串
    // 字面量出现。这一档只认「这个包里确实出现过这个字符串」，且排在所有
    // 确定性命中之后，避免抢走官方工具。
    const quoted = scanned?.quoted?.get(name);
    // 只有「唯一一个包声称」才算数；两个以上包都这么写 = 认不出来。
    if (quoted instanceof Set && quoted.size === 1) {
        return { category: CATEGORY_PLUGIN, owner: [...quoted][0], overridden: false };
    }
    // 官方包名兜底：工具名来自配置、源码里没有字面量时（subagent 就是），
    // 靠包名反推。取最长的派生名，避免 dsh-tool-web 抢走 web_fetch 一类。
    //
    // 这一档排在「包内确实出现过这个名字」之后 —— 「名字像这个包」只是
    // 像，「这个包里出现过这个名字」才是事实。前缀排在前面会误伤：
    // 任何叫 `bili_xxx` 的工具都会被归给鱼塘，即使它不是鱼塘的。
    const officialByPackage = scanned?.officialByPackage;
    if (officialByPackage) {
        let best = '';
        for (const stem of officialByPackage.keys()) {
            if ((name === stem || name.startsWith(`${stem}_`)) && stem.length > best.length) {
                best = stem;
            }
        }
        if (best !== '') {
            return { category: CATEGORY_SYSTEM, owner: officialByPackage.get(best), overridden: false };
        }
    }
    // 包名前缀：工具有些是工厂函数拼出名字的（modlens → modlens_read_image），
    // 源码里搜不到 name 字面量，但「包名前缀 + 下划线」几乎不会认错。
    // 这是**最后一档猜测** —— 排在 quoted 之后，只在实在没别的线索时才用。
    const pluginByStem = scanned?.pluginByStem;
    if (pluginByStem) {
        let best = '';
        for (const stem of pluginByStem.keys()) {
            if ((name === stem || name.startsWith(`${stem}_`)) && stem.length > best.length) {
                best = stem;
            }
        }
        if (best !== '') {
            return { category: CATEGORY_PLUGIN, owner: pluginByStem.get(best), overridden: false };
        }
    }
    return { category: CATEGORY_OTHER, owner: '未归属', overridden: false };
}

/**
 * 读一个插件包的元信息：包名、版本、简介。
 *
 * 「插件」这一页要给人看的是「我装了什么、它是干什么的」，这些字只在
 * package.json 里 —— 宿主没有把 description 暴露到任何服务上。
 * 读不到就返回空串，绝不编。
 */
/**
 * 读插件自报的工具清单（package.json 的 `dsh.tools` 字段）。
 *
 * 这是层1「唯一事实来源」：插件自己声明它注册了哪些工具。
 * 声明形式两种，都认：
 *   - `"dsh": { "tools": ["a", "b"] }`
 *   - `"dsh": { "tools": { "a": {}, "b": { "description": "…" } } }`
 * 没声明就返回空 Map —— 插件没自报是正常情况，不算错。
 */
async function readDeclaredTools(dirs) {
    const out = new Map();
    for (const dir of dirs) {
        const pkgName = dir.split('/').pop();
        let raw;
        try {
            raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        }
        catch {
            continue;
        }
        const declared = raw?.dsh?.tools;
        if (!declared) {
            continue;
        }
        const names = Array.isArray(declared)
            ? declared
            : (declared && typeof declared === 'object' ? Object.keys(declared) : []);
        for (const name of names) {
            if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.\-]{1,48}$/.test(name)) {
                out.set(name, pkgName);
            }
        }
    }
    return out;
}

async function readPackageMeta(dir) {
    try {
        const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        return {
            packageName: typeof raw.name === 'string' ? raw.name : '',
            version: typeof raw.version === 'string' ? raw.version : '',
            description: typeof raw.description === 'string' ? raw.description : '',
        };
    }
    catch {
        return { packageName: '', version: '', description: '' };
    }
}

async function exists(p) {
    try {
        await stat(p);
        return true;
    }
    catch {
        return false;
    }
}

/** 递归列出目录下的 .js 文件（限深 4 层，避免把 node_modules 整棵爬一遍）。 */
async function listJsFiles(dir, depth = 0) {
    if (depth > 4) {
        return [];
    }
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
            continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...await listJsFiles(full, depth + 1));
        }
        else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * 编译产物目录 —— 扫的时候要排除。
 *
 * 一个包常常同时带着 `src/`（源码）和 `runtime/` / `dist/`（编译产物），
 * 两份是同一套代码。扫两份的后果：
 *   - 同一行算两遍（当前靠「同名取最短包名」掩盖，但那是巧合）
 *   - 两边注释不同，产物里的示例文字会被当成工具定义
 * 以 package.json 的 main / exports 指向的那一份为准，其余的不看。
 */
const BUILD_DIRS = new Set(['runtime', 'dist', 'build', 'out', 'coverage', '.output', 'esm', 'cjs']);

/**
 * 读包的入口文件（package.json 的 main / module / exports）。
 *
 * 拿不到就返回空数组 —— 那时退回「按目录扫」，只是把编译产物目录排掉。
 */
async function readEntryFiles(dir) {
    let raw;
    try {
        raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    }
    catch {
        return [];
    }
    const candidates = [];
    const push = (rel) => {
        if (typeof rel === 'string' && rel.length > 0 && !rel.endsWith('.js')) {
            candidates.push(rel);
        }
        else if (typeof rel === 'string' && rel.length > 0) {
            candidates.push(rel);
        }
    };
    if (typeof raw.main === 'string') {
        push(raw.main);
    }
    if (typeof raw.module === 'string') {
        push(raw.module);
    }
    // exports 可能是字符串，也可能是 { ".": ... } 或 { ".": { import: ... } }
    const pickExport = (v) => {
        if (typeof v === 'string') {
            push(v);
            return;
        }
        if (v && typeof v === 'object') {
            for (const key of ['import', 'module', 'default', 'require', 'node']) {
                if (typeof v[key] === 'string') {
                    push(v[key]);
                    return;
                }
            }
        }
    };
    if (typeof raw.exports === 'string') {
        push(raw.exports);
    }
    else if (raw.exports && typeof raw.exports === 'object') {
        const root = raw.exports['.'] ?? raw.exports;
        pickExport(root);
    }
    const files = [];
    const seen = new Set();
    for (const rel of candidates) {
        const clean = rel.split('#')[0].replace(/^\.\//, '');
        const full = join(dir, clean);
        if (seen.has(full)) {
            continue;
        }
        seen.add(full);
        if (await exists(full)) {
            files.push(full);
        }
    }
    return files;
}

/**
 * 列出包里该扫的 .js 文件。
 *
 * 优先走入口：main / exports 指向的那份文件，以及它同目录的兄弟文件
 * （同目录的兄弟文件通常是同一份源码的拆分）。入口找不到时退回按目录扫，
 * 但把编译产物目录排掉。
 */
async function listPackageSourceFiles(dir) {
    const entries = await readEntryFiles(dir);
    if (entries.length === 0) {
        const all = [
            ...await listJsFiles(join(dir, 'lib')),
            ...await listJsFiles(join(dir, 'dsh')),
            ...await listJsFiles(join(dir, 'src')),
        ];
        const root = await listJsFiles(dir, 0);
        const filtered = all.filter((f) => !f.includes('/runtime/')
            && !f.includes('/dist/')
            && !f.includes('/build/')
            && !f.includes('/out/')
            && !f.includes('/coverage/')
            && !f.includes('/esm/')
            && !f.includes('/cjs/'));
        return [...new Set([...filtered, ...root.filter((f) => {
            const rel = f.slice(dir.length + 1);
            const head = rel.split('/')[0];
            return !BUILD_DIRS.has(head) && !rel.includes('/lib/') && !rel.includes('/dsh/') && !rel.includes('/src/');
        })])];
    }
    // 入口已知：把入口所在目录里的兄弟文件一起算上，
    // 还要带上**整棵子目录**（不含编译产物）——
    // 工具名常常定义在另一个文件里（dsh-cuigengji-plugin 的 TOOL_ACTIONS
    // 在 runtime/contracts/actions.js，被 runtime/index.js import 进来），
    // 只扫入口的同级目录会漏掉它。
    const files = new Set(entries);
    for (const entry of entries) {
        const siblingDir = dirname(entry);
        for (const f of await listJsFiles(siblingDir)) {
            files.add(f);
        }
        // 入口所在目录下的子目录（contracts/、adapters/…），同样排除编译产物
        const rel = siblingDir.slice(dir.length + 1);
        const head = rel.split('/')[0];
        if (!BUILD_DIRS.has(head)) {
            for (const f of await listJsFiles(siblingDir, 1)) {
                files.add(f);
            }
        }
    }
    return [...files];
}

/**
 * 剥掉 JS 源码里的注释。
 *
 * 用逐字符状态机，不用正则 —— 正则分不清「注释里的 //」和「字符串里的 //」
 * （`https://example.com` 里有 // 但不是注释），状态机能同时处理
 * 字符串、模板串、注释三种状态，不误伤。
 *
 * 剥的是「注释与字符串内容」，但**保留字符串内容**：
 * 工具名本身就是字符串字面量（`name: 'bash'`），把字符串也抹掉就什么都认不出了。
 * 所以：注释 → 空格；字符串 → 保留原样。
 */
function stripComments(text) {
    const out = [];
    let i = 0;
    const n = text.length;
    // 模板串里的 ${} 可以嵌套任意表达式，单独记一个深度
    let templateDepth = 0;
    while (i < n) {
        const ch = text[i];
        const next = text[i + 1];
        // —— 行注释 ——
        if (ch === '/' && next === '/') {
            while (i < n && text[i] !== '\n') {
                i++;
            }
            continue;
        }
        // —— 块注释 ——
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
                i++;
            }
            i += 2;
            // 用空格占位，保持后续正则的偏移语义大致不变
            out.push(' ');
            continue;
        }
        // —— 普通字符串 ——
        if (ch === '"' || ch === '\'') {
            const quote = ch;
            const start = i;
            i++;
            while (i < n) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text[i] === quote) {
                    i++;
                    break;
                }
                i++;
            }
            out.push(text.slice(start, i));
            continue;
        }
        // —— 模板串 ——
        if (ch === '`') {
            const start = i;
            i++;
            let plain = '';
            while (i < n) {
                if (text[i] === '\\') {
                    plain += text.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                if (text[i] === '`') {
                    i++;
                    break;
                }
                if (text[i] === '$' && text[i + 1] === '{') {
                    // ${} 里的内容可能又是字符串/模板，递归处理
                    let depth = 1;
                    i += 2;
                    const exprStart = i;
                    while (i < n && depth > 0) {
                        if (text[i] === '{') {
                            depth++;
                        }
                        else if (text[i] === '}') {
                            depth--;
                            if (depth === 0) {
                                break;
                            }
                        }
                        else if (text[i] === '"' || text[i] === '\'') {
                            const q = text[i];
                            i++;
                            while (i < n) {
                                if (text[i] === '\\') {
                                    i += 2;
                                    continue;
                                }
                                if (text[i] === q) {
                                    i++;
                                    break;
                                }
                                i++;
                            }
                            continue;
                        }
                        i++;
                    }
                    const expr = text.slice(exprStart, i);
                    out.push('`' + plain + '${' + stripComments(expr) + '}' + '`');
                    plain = '';
                    i++;   // 吃掉 }
                    continue;
                }
                plain += text[i];
                i++;
            }
            out.push(text.slice(start, i));
            continue;
        }
        // —— 正则字面量：简单处理，避免 `/` 被误判成注释起点 ——
        // 判据：前一个非空白字符是 `( , = : [ ! & | ? { } ; return` 之一
        if (ch === '/') {
            let j = i - 1;
            while (j >= 0 && /\s/.test(text[j])) {
                j--;
            }
            const prev = j >= 0 ? text[j] : '';
            if (prev === '' || '(,=:[!&|?{};+*%^~'.includes(prev)) {
                // 可能是正则字面量，往后找未转义的 /
                let k = i + 1;
                let inClass = false;
                let found = false;
                while (k < n) {
                    if (text[k] === '\\') {
                        k += 2;
                        continue;
                    }
                    if (text[k] === '[') {
                        inClass = true;
                    }
                    else if (text[k] === ']') {
                        inClass = false;
                    }
                    else if (text[k] === '/' && !inClass) {
                        found = true;
                        k++;
                        break;
                    }
                    else if (text[k] === '\n') {
                        break;
                    }
                    k++;
                }
                if (found) {
                    while (k < n && /[a-z]/.test(text[k])) {
                        k++;
                    }
                    out.push(text.slice(i, k));
                    i = k;
                    continue;
                }
            }
        }
        out.push(ch);
        i++;
    }
    return out.join('');
}

/**
 * 从一份源码里抠出 `defineTool({ name: 'xxx' })` 的名字。
 *
 * @param {string} text 这份源码
 * @param {Map<string,string>} [siblingConsts] 同包其它文件里的「常量名 → 源码文本」，
 *   用来解析 `import { TOOL_ACTIONS as allowed } from './contracts/actions.js'`
 *   这种**跨文件**的来源 —— 工具名常常定义在另一个文件里，扫单个文件认不出来。
 */
function toolNamesInSource(text, siblingConsts) {
    const names = [];
    // 先剥注释 —— 不剥的话本文件自己的注释会产出假工具名。
    const src = stripComments(text);
    // 工具名来源有四种形态，全要认：
    //   a) `const X = 'literal'` —— 字符串常量
    //   b) `const X = { key: ... }` —— 对象字面量的键（循环注册常用）
    //   c) `const X = ['a', 'b']` —— 数组字面量的元素
    //   d) `defineTool({ name: 'literal' })` —— 直接字面量
    // 只认 (a) 的话，dsh-cuigengji-plugin 的 4 个工具会整条漏掉 ——
    // 它们的 name 是 `toolName`，真正的名字在 TOOL_ACTIONS 这个对象字面量的键里。
    const consts = new Map();
    const constRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Za-z0-9_.\-]{2,48})['"]/g;
    let c;
    while ((c = constRe.exec(src)) !== null) {
        consts.set(c[1], c[2]);
    }
    // 对象字面量的键 → 键名本身当作候选工具名
    const objKeyRe = /\b([A-Za-z_$][\w$]*)\s*:\s*(?:Object\.freeze\s*\(\s*)?[\[{]/g;
    const objKeys = new Set();
    let o;
    while ((o = objKeyRe.exec(src)) !== null) {
        objKeys.add(o[1]);
    }
    // 数组字面量的元素
    const arrRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]{0,400})\]/g;
    const arrValues = new Map();
    let a;
    while ((a = arrRe.exec(src)) !== null) {
        const list = [];
        const itemRe = /['"]([A-Za-z][A-Za-z0-9_.\-]{2,48})['"]/g;
        let it;
        while ((it = itemRe.exec(a[2])) !== null) {
            list.push(it[1]);
        }
        if (list.length > 0) {
            arrValues.set(a[1], list);
        }
    }
    /**
     * 解析一个标识符指向的对象字面量，取出它的键。
     *
     * 三个来源，按可靠性排：
     *   1. 本文件里的 `const X = { ... }`
     *   2. 跨文件：`import { TOOL_ACTIONS as allowed } from './x.js'`
     *      → 从同包的其它文件里找 `TOOL_ACTIONS = { ... }`
     *   3. 跨文件：名字来自被 import 的对象（`allowed`），
     *      需要顺着 import 关系找到原始名（TOOL_ACTIONS）再去找定义
     */
    const resolveObjectKeys = (ident) => {
        const keys = [];
        // 对象的定义形状有两种，都要认：
        //   const X = { ... }
        //   const X = Object.freeze({ ... })   ← 冻结对象，dsh-cuigengji-plugin 就是这种
        const defPattern = (name) => new RegExp(
            `\\b${name}\\s*=\\s*(?:Object\\.freeze\\s*\\(\\s*)?\\{([^}]{0,4000})\\}`,
        );
        // 对象的键：值的形态很多（数组、对象、Object.freeze([...])、函数），
        // 所以只认「键名 + 冒号」，不挑值的形状。
        const keyPattern = /['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g;
        // 1) 本文件
        const localDef = defPattern(ident).exec(src);
        if (localDef) {
            let k;
            while ((k = keyPattern.exec(localDef[1])) !== null) {
                keys.push(k[1]);
            }
            return keys;
        }
        // 2/3) 跨文件：先在 import 语句里找这个标识符的来源
        if (!siblingConsts) {
            return keys;
        }
        // `import { ORIG as ALIAS } from './x.js'` 或 `import { ORIG } from ...`
        const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]+['"]`, 'g');
        let im;
        while ((im = importRe.exec(src)) !== null) {
            for (const spec of im[1].split(',')) {
                const parts = spec.trim().split(/\s+as\s+/);
                const localName = (parts[1] ?? parts[0]).trim();
                const origName = parts[0].trim();
                if (localName !== ident) {
                    continue;
                }
                // 在同包其它文件里找 `ORIG = { ... }` 或 `ORIG = Object.freeze({ ... })`
                for (const other of siblingConsts.values()) {
                    const otherSrc = stripComments(other);
                    const def = defPattern(origName).exec(otherSrc);
                    if (!def) {
                        continue;
                    }
                    let k;
                    while ((k = keyPattern.exec(def[1])) !== null) {
                        keys.push(k[1]);
                    }
                }
            }
        }
        return keys;
    };
    const re = /defineTool\(\s*\{/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const window = src.slice(m.index, m.index + 400);
        // 形态 d：直接字面量
        const lit = /\bname:\s*['"]([A-Za-z0-9_.\-]+)['"]/.exec(window);
        if (lit) {
            names.push(lit[1]);
            continue;
        }
        // 形态 a / b / c：name 是标识符
        const ref = /\bname:\s*(?:[\w$]+\.)*([A-Za-z_$][\w$]*)/.exec(window);
        if (!ref) {
            continue;
        }
        const ident = ref[1];
        if (consts.has(ident)) {
            names.push(consts.get(ident));
            continue;
        }
        // name 指向一个数组常量 → 展开它的元素
        if (arrValues.has(ident)) {
            for (const v of arrValues.get(ident)) {
                names.push(v);
            }
            continue;
        }
        // name 指向一个对象常量（TOOL_ACTIONS 这类）→ 展开它的键
        const direct = resolveObjectKeys(ident);
        if (direct.length > 0) {
            for (const key of direct) {
                names.push(key);
            }
            continue;
        }
        // —— 循环变量 ——
        // `for (const [toolName, actions] of Object.entries(allowed))`
        //   → defineTool({ name: toolName })
        // 名字不在 name 后面，而是**被迭代的那个对象**的键。
        // 找这个 defineTool 之前最近的 `for (... of X)`，X 是谁就去展开谁。
        //
        // 解构有两种写法，都要认：
        //   for (const [k, v] of Object.entries(src))   ← 数组解构，取第 0 个
        //   for (const k of Object.keys(src))            ← 直接是键
        const before = src.slice(Math.max(0, m.index - 600), m.index);
        const loopRe = /for\s*\(\s*(?:const|let|var)\s+(?:\[([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\]|([A-Za-z_$][\w$]*))\s+of\s+((?:Object\.)?(?:entries|keys|values)\s*\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)/g;
        let lastLoop = null;
        let lp;
        while ((lp = loopRe.exec(before)) !== null) {
            lastLoop = lp;
        }
        if (lastLoop) {
            // 数组解构取第 0 个（`[toolName, actions]`），直接解构用第 3 组
            const loopVar = lastLoop[1] ?? lastLoop[3];
            // 迭代源：可能是 `Object.entries(allowed)` 这种调用，也可能就是个变量
            let source = lastLoop[4];
            const callMatch = /^\s*(?:Object\.)?(?:entries|keys|values)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(source);
            if (callMatch) {
                source = callMatch[1];
            }
            if (loopVar === ident) {
                // 迭代源是 `Object.entries(allowed)` → 展开 allowed 的键
                for (const key of resolveObjectKeys(source)) {
                    names.push(key);
                }
                continue;
            }
            // 迭代源本身就是一个常量数组 → 展开它的元素
            if (arrValues.has(source)) {
                for (const v of arrValues.get(source)) {
                    names.push(v);
                }
            }
        }
    }
    return names;
}

/**
 * 找出宿主官方工具包目录。
 *
 * 官方的工具包不在 profile 的 node_modules 里 —— 它们随 DSH 本体装在
 * `<install>/node_modules/@deepseek-ai/`。从 profile 里找不到它们，
 * 工具表就会把大半官方工具归进「未归属」。
 *
 * 收录两类：
 *   - `dsh-tool-*`  —— 纯工具包（bash / read / skill / terminal …）
 *   - `dsh-plugin-manager` / `dsh-plugin-market` —— 宿主自带的插件管理包，
 *     它们也注册工具（plugin_manager / plugin_market），但名字不是 dsh-tool-*。
 *     这两个是**宿主本体**的一部分，不是用户装的第三方插件 —— 归到「系统工具」才对。
 *
 * 定位方式：先按环境变量 DSH_INSTALL_DIR 找，再退回
 * `process.execPath` 旁边的 node_modules，最后扫全局 node_modules 根。
 */
const OFFICIAL_TOOL_PACKAGES = new Set(['dsh-plugin-manager', 'dsh-plugin-market']);

async function listOfficialToolPackageDirs() {
    const dirs = [];
    const roots = [];
    const installDir = process.env.DSH_INSTALL_DIR;
    if (installDir) {
        roots.push(join(installDir, 'node_modules', '@deepseek-ai'));
    }
    // /usr/local/bin/node -> /usr/local/lib/node_modules/@deepseek-ai
    const execDir = dirname(process.execPath);
    roots.push(join(dirname(execDir), 'lib', 'node_modules', '@deepseek-ai'));
    roots.push(join(execDir, 'node_modules', '@deepseek-ai'));
    for (const root of roots) {
        if (!await exists(root)) {
            continue;
        }
        // 全局布局：<root>/<pkg>
        await collectToolDirs(root, dirs);
        // 嵌套布局：<root>/dsh/node_modules/@deepseek-ai/<pkg>
        // 官方包是随 DSH 本体装的，本体自己又是一个 npm 包，所以工具包在它下面一层。
        const nested = join(root, 'dsh', 'node_modules', '@deepseek-ai');
        if (await exists(nested)) {
            await collectToolDirs(nested, dirs);
        }
    }
    return [...new Set(dirs)];
}

async function collectToolDirs(root, dirs) {
    let entries = [];
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        // 官方工具不是只装在 dsh-tool-* 里：plan-mode 提供 exit_plan_mode、
        // subagent 提供 subagent_fork、agent 提供一堆内核工具。凡 @deepseek-ai/dsh-*
        // 都算官方，一并收进来（它们只会进 system 表，不会污染第三方归属）。
        const isOfficial = entry.name.startsWith('dsh-tool-') || entry.name.startsWith('dsh-');
        if (!isOfficial && !OFFICIAL_TOOL_PACKAGES.has(entry.name)) {
            continue;
        }
        const dir = join(root, entry.name);
        if (await exists(join(dir, 'lib'))) {
            dirs.push(dir);
        }
    }
}

/** 找出所有 profile 里装着的第三方插件包目录。 */
async function listPluginPackageDirs() {
    const home = resolveDshHome();
    const profilesDir = join(home, 'profiles');
    const dirs = [];
    const push = (dir) => dirs.push(dir);
    let profiles = [];
    try {
        profiles = await readdir(profilesDir, { withFileTypes: true });
    }
    catch {
        return dirs;
    }
    for (const profile of profiles) {
        if (!profile.isDirectory()) {
            continue;
        }
        const root = join(profilesDir, profile.name);
        const nm = join(root, 'node_modules');
        if (!await exists(nm)) {
            continue;
        }
        // 只认 profile 的**直接依赖**：那才是「装了这个插件」的清单。
        // 顺着 .pnpm 或整棵 node_modules 扫会把传递依赖也算进来（上千个），
        // 既慢又会把别人包里的字符串误当成本包的工具。
        let deps = {};
        try {
            const raw = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
            deps = { ...(raw.dependencies ?? {}), ...(raw.devDependencies ?? {}) };
        }
        catch {
            deps = {};
        }
        for (const name of Object.keys(deps)) {
            if (name.startsWith('@deepseek-ai/')) {
                continue;
            }
            const dir = join(nm, name);
            if (await exists(join(dir, 'package.json'))) {
                push(dir);
            }
        }
        // 兜底：link: 依赖与手动软链不进 dependencies 的，也认一下顶层 dsh-* 目录。
        let entries = [];
        try {
            entries = await readdir(nm, { withFileTypes: true });
        }
        catch {
            entries = [];
        }
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) {
                continue;
            }
            if (!entry.name.startsWith('dsh-') || entry.name === 'dsh-scope-manager') {
                continue;
            }
            if (entry.name === '@deepseek-ai') {
                continue;
            }
            const dir = join(nm, entry.name);
            if (await exists(join(dir, 'package.json'))) {
                push(dir);
            }
        }
    }
    const out = [];
    const seen = new Set();
    for (const dir of dirs) {
        if (seen.has(dir)) {
            continue;
        }
        seen.add(dir);
        out.push(dir);
    }
    return out;
}

/**
 * 扫所有已装插件包，建立「工具名 → 包名」映射。
 * 结果缓存 30 秒 —— 插件装/卸不频繁，但列表页可能连着点好几次。
 */
/**
 * 建一个工具归属扫描器。
 *
 * @param {number} ttlMs - 内存缓存的**软**有效期。0 = 不按时间失效（只认指纹与 invalidate()）。
 *   注意它只是「顺手核对指纹」的节流，不等于「到点就重扫 15 秒」。
 * @param {() => Set<string>|null} [runtimeToolNames] - 返回运行时真实注册的工具名；
 *   提供后，扫描结果会用它裁剪（幽灵条目剔除）+ 标记官方表过时项。
 * @param {() => Promise<object>|object|null} [readProbeCache] - 读深度排查缓存。
 *   期望返回 `{ version, plugins: { 包名 → { tools, status, version } } }`；
 *   也兼容直接给「包名 → 工具集」的 Map。
 *
 *   ⚠️ 这个回调必须是**纯读缓存**，绝不能在里面调 `scanner.get()`：
 *   scanNow 正在跑，等自己 = 永远等不到（Promise 也不是 Map，
 *   `for…of` 会报「probedMap is not iterable」）。
 * @param {{onScan?: (base: object) => void}} [options] - `onScan`：后台重扫完成时通知
 *   （通常用来让面板知道「归属刚更新过」，好安排一次刷新）。
 */
export function createToolScanner(ttlMs = 30_000, runtimeToolNames = null, readProbeCache = null, options = {}) {
    let cache = null;
    /** 上一次**核对指纹**的时刻 —— 每 30 秒推一次，不代表重扫过。 */
    let at = 0;
    /** 上一次**真正扫源码**的时刻 —— 只有指纹变了/首次才会推。 */
    let scanAt = 0;
    let running = null;
    /** 当前 `cache` 对应哪一版插件集合；空串 = 不知道（只能靠重扫确认）。 */
    let cachedFingerprint = '';
    const onScan = options?.onScan;

    async function scanNow() {
        // 这里**不读**实测缓存：实测结论是「会变的东西」（插件升级就作废），
        // 而这一遍扫出来的是要落盘的静态事实。两者分开，落盘那份才能长期复用。
        // 实测结论统一在 applyRuntime 里现读现算。
        // 官方包与第三方插件包分两张表：混在一起会让分类优先级串 ——
        // 第三方包可能抢走官方工具的名字，官方工具就掉进「插件工具」了。
        const system = new Map();
        const plugin = new Map();
        /**
         * 兜底表：第三方包里的**定义形状**名字 → 包名。
         *
         * 只认 `name: "x"` 这种定义形状。若收「包里出现过的任何字符串字面量」，
         * 一个包里只要提到别人的工具名（dsh-im 的 bundle 里满篇 subagent / compress），
         * 就能把别人的工具算到自己头上 —— 名字短的包还优先，越短越容易抢。
         * 认不出来的让它掉进「未归属」，由用户手动归属，而不是猜一个错的。
         */
        const quoted = new Map();
        const QUOTED_RE = /\bname\s*:\s*['"]([A-Za-z][A-Za-z0-9_.-]{2,48})['"]/g;
        /**
         * `name: "x"` 这个形状太宽 —— 任何对象的 name 字段都长这样：
         * 配置项（`{ name: 'settings.section' }`）、DOM 属性、EBML 字段
         * （`{ name: 'ebmlVersion' }`）、i18n 词条，全都会被当成工具。
         * 结果是插件卡片上冒出一堆根本不存在的工具。
         *
         * 所以要求这个 `name:` 出现在**工具定义**的上下文里。
         * 认这两种：
         *   1. 紧跟着 description / inputSchema / parameters / execute 这些
         *      工具定义特有的字段 —— 顺序不限，在同一层花括号内即可；
         *   2. 出现在 defineTool( / registerTool( 的调用参数里。
         * 两条都不满足就不收 —— 宁可漏（掉进「未归属」让用户手动归），
         * 也不能多（凭空多出工具）。
         */
        const TOOL_FIELDS = /(?:description|inputSchema|input_schema|parameters|schema|execute|output|render|presentationMeta)\s*:/;
        const isToolDefinitionContext = (src, index) => {
            // —— 往后看 ——
            // `name` 后面常常紧跟 description / parameters / execute。
            // ego 的工具是 `name: "ego_space_open", get description() {…}`，
            // 描述在后面而不是前面，所以必须往后看。
            const after = src.slice(index, index + 500);
            if (TOOL_FIELDS.test(after)) {
                return true;
            }
            // —— 往前看 ——
            // 工具定义里 `name` 之前的字段（parameters / description / schema…）
            const before = src.slice(Math.max(0, index - 600), index);
            // 找出这个 name: 之前最近的未闭合 `{` 起点，看它内部有没有工具字段
            let depth = 0;
            let objStart = -1;
            for (let i = before.length - 1; i >= 0; i--) {
                const c = before[i];
                if (c === '}') {
                    depth++;
                }
                else if (c === '{') {
                    if (depth === 0) {
                        objStart = i;
                        break;
                    }
                    depth--;
                }
            }
            if (objStart >= 0) {
                const objBody = before.slice(objStart);
                if (TOOL_FIELDS.test(objBody)) {
                    return true;
                }
            }
            // 或者它就在 defineTool( / registerTool( 之后不久
            if (/\b(?:defineTool|registerTool|createTool)\s*\(\s*\{?[^{]{0,400}$/.test(before)) {
                return true;
            }
            return false;
        };
        const collect = async (dirs, map, alsoQuoted = false) => {
            for (const dir of dirs) {
                const pkgName = dir.split('/').pop();
                // 按入口定位该扫哪些文件：main/exports 指向的那一份 + 它同目录的兄弟。
                // 找不到入口时退回按目录扫，但编译产物目录（runtime/dist/…）一律排除 ——
                // 同一套代码的源码与产物不能各算一遍。
                const files = await listPackageSourceFiles(dir);
                // 同包其它文件的源码 —— 用来解析跨文件的工具名来源
                // （`import { TOOL_ACTIONS as allowed } from './contracts/actions.js'`）。
                const siblingConsts = new Map();
                for (const file of files) {
                    try {
                        siblingConsts.set(file, await readFile(file, 'utf8'));
                    }
                    catch {
                        // 读不到就跳过，不影响别的文件
                    }
                }
                for (const file of files) {
                    let text;
                    try {
                        text = await readFile(file, 'utf8');
                    }
                    catch {
                        continue;
                    }
                    for (const name of toolNamesInSource(text, siblingConsts)) {
                        const prev = map.get(name);
                        // 同名取包名最短的：更具体的包更可能是真身。
                        if (prev === undefined || pkgName.length < prev.length) {
                            map.set(name, pkgName);
                        }
                    }
                    if (alsoQuoted) {
                        // 也要先剥注释 —— 否则本文件注释里的 `name: 'x'` 会进兜底表。
                        const src = stripComments(text);
                        QUOTED_RE.lastIndex = 0;
                        let q;
                        while ((q = QUOTED_RE.exec(src)) !== null) {
                            const word = q[1];
                            // 必须是工具定义上下文 —— 否则配置项、i18n 词条、
                            // 二进制格式字段都会混进来。
                            if (!isToolDefinitionContext(src, q.index)) {
                                continue;
                            }
                            // 同一个名字可能被好几个包都写成 `name: "x"`（各自的
                            // 内部结构、别人的工具说明都可能长这样）。这时不猜，
                            // 留成「好几个包都声称」，最后掉进未归组让用户手动归。
                            let set = quoted.get(word);
                            if (!set) {
                                set = new Set();
                                quoted.set(word, set);
                            }
                            set.add(pkgName);
                        }
                        // `name: SomeConst` —— 名字放在文件顶部的字符串常量里
                        // （dsh-im 的 dsh_im_return_file 就是这样），字面量扫不到。
                        const consts = new Map();
                        const constRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Za-z][\w.-]{2,48})['"]/g;
                        let k;
                        while ((k = constRe.exec(src)) !== null) {
                            consts.set(k[1], k[2]);
                        }
                        if (consts.size > 0) {
                            const refRe = /\bname:\s*([A-Za-z_$][\w$]*)\b/g;
                            let r;
                            while ((r = refRe.exec(src)) !== null) {
                                const word = consts.get(r[1]);
                                if (!word) {
                                    continue;
                                }
                                let set = quoted.get(word);
                                if (!set) {
                                    set = new Set();
                                    quoted.set(word, set);
                                }
                                set.add(pkgName);
                            }
                        }
                    }
                }
            }
        };
        const officialDirs = await listOfficialToolPackageDirs();
        await collect(officialDirs, system);
        const pluginDirs = await listPluginPackageDirs();
        await collect(pluginDirs, plugin, true);

        // —— 层1：插件自报（package.json 的 dsh.tools）——
        // 这是**唯一的事实来源**：插件自己说它注册了哪些工具。
        // 自报的优先级高于一切扫描结果 —— 扫源码只会在插件源码里
        // 找得到名字时才准，自报永远准（哪怕工具名是运行时拼出来的）。
        // 插件没自报就走下面的通道，不影响。
        const declared = await readDeclaredTools(pluginDirs);
        for (const [name, pkgName] of declared) {
            plugin.set(name, pkgName);
        }

        // —— 层2：manifest 通道 ——
        // 插件自己公布的工具清单，比静态扫源码**更权威**：
        // 它就是插件注册的那一份，不是猜的。
        // 扫源码认不出的（名字来自运行时 manifest 的）靠它兜住。
        // manifest 说有、源码里没有的，以 manifest 为准。
        let manifestTools = new Map();
        try {
            manifestTools = await fetchPluginManifests(pluginDirs);
        }
        catch {
            // manifest 通道挂了也不能影响整页 —— 退回纯静态扫描。
            manifestTools = new Map();
        }
        for (const [name, pkgName] of manifestTools) {
            // manifest 是权威事实，直接盖掉静态扫描的结果
            plugin.set(name, pkgName);
        }

        // 包名 → 工具名前缀：有些插件用工厂函数建工具（modlens 的
        // readImageTool(preferred)），工具名只在运行时拼出来，源码里没有
        // `name: "..."`。这种时候「包名」自己就是最可靠的线索：
        // modlens 造出 modlens_read_image、dsh-im 造出 dsh_im_*。
        // 只在「某个前缀唯一属于一个包」时才认，避免撞名乱认。
        const stemOwners = new Map();
        for (const dir of pluginDirs) {
            const pkgName = dir.split('/').pop();
            const stems = new Set();
            const bare = pkgName.replace(/^dsh-/, '').replace(/-/g, '_');
            if (bare.length >= 3) {
                stems.add(bare);
            }
            const full = pkgName.replace(/-/g, '_');
            if (full.length >= 3) {
                stems.add(full);
            }
            for (const stem of stems) {
                const prev = stemOwners.get(stem);
                if (prev === undefined) {
                    stemOwners.set(stem, pkgName);
                }
                else if (prev !== pkgName) {
                    stemOwners.set(stem, null);   // 两个包同名，不认
                }
            }
        }
        const pluginByStem = new Map();
        for (const [stem, pkgName] of stemOwners) {
            if (pkgName !== null) {
                pluginByStem.set(stem, pkgName);
            }
        }

        // 官方包名兜底：有些包的工具名来自配置（`defineTool({ name: toolName })`，
        // toolName 默认值写在别处），源码里根本没有字面量 —— subagent 就这样漏了。
        // 这里按「包名 → 派生名」补一张表：dsh-tool-subagent → subagent，
        // 命中规则是「等于派生名」或「以 `派生名_` 开头」（subagent_fork）。
        const officialByPackage = new Map();
        for (const dir of officialDirs) {
            const pkgName = dir.split('/').pop();
            if (!pkgName.startsWith('dsh-tool-')) {
                continue;
            }
            const stem = pkgName.slice('dsh-tool-'.length).replace(/-/g, '_');
            if (stem.length >= 2) {
                officialByPackage.set(stem, pkgName);
            }
        }
        // —— 包元信息（给「插件」页的卡片用） ——
        // 官方包只在「确实提供了工具 / 段落」时才收：宿主自带 300 多个 @deepseek-ai 包，
        // 全列出来只会把界面淹掉。用户装的包一个不落全收 —— 那才是「我装了什么」。
        const needed = new Set();
        for (const map of [system, plugin]) {
            for (const pkgName of map.values()) {
                needed.add(pkgName);
            }
        }
        for (const map of [pluginByStem, officialByPackage]) {
            for (const pkgName of map.values()) {
                needed.add(pkgName);
            }
        }
        const packages = new Map();
        const addPackage = async (dir, official) => {
            const key = dir.split('/').pop();
            if (!key || packages.has(key)) {
                return;
            }
            const meta = await readPackageMeta(dir);
            packages.set(key, {
                key,
                dir,
                official,
                packageName: meta.packageName || key,
                version: meta.version,
                description: meta.description,
            });
        };
        for (const dir of officialDirs) {
            if (needed.has(dir.split('/').pop())) {
                await addPackage(dir, true);
            }
        }
        for (const dir of pluginDirs) {
            await addPackage(dir, false);
        }
        // 注意：这里只产出「从包文件里扫出来的事实」，**不含**两样东西 ——
        //   · probed（实测结论）：它有独立缓存和版本判据，混进来会被扫描缓存掩盖；
        //   · 运行时交叉验证的产物：取决于当前运行时，几分钟就变。
        // 那两样统一在 applyRuntime 里现算，这样落盘的那份缓存可以长期复用。
        return { system, plugin, quoted, officialByPackage, pluginByStem, packages, manifestTools };
    }

    /**
     * 在扫出来的事实上叠两样「会变的东西」：
     *   1. 实测结论（probeCache + 当前包版本 → probed）；
     *   2. 运行时交叉验证（剔幽灵、标官方表过时项）。
     *
     * 每次 get() 都现算 —— 成本是几百次 Set 查询，跟扫 15 秒完全不是一个量级。
     * 这也让「插件升级后实测结论自动作废」这件事不依赖扫描缓存是否重建。
     *
     * @param {object} base - scanNow 的产物
     * @param {object|null} [probeCache] - 覆盖 base 里的 probeCache（内存里那份可能已经旧了）
     */
    function applyRuntime(base, probeCache) {
        // 深拷贝要裁剪的两张表：crossCheckWithRuntime 会就地删键，
        // 不能让它改到缓存本体（否则第二次调用看到的是裁过的结果）。
        const scanned = {
            ...base,
            plugin: new Map(base.plugin),
            quoted: new Map([...base.quoted].map(([k, v]) => [k, new Set(v)])),
        };
        const versions = new Map();
        for (const [key, pkg] of base.packages) {
            versions.set(pkg.packageName ?? key, pkg.version ?? '');
        }
        scanned.probed = probedOwnersFrom(probeCache, versions);
        if (runtimeToolNames) {
            let runtimeNames = null;
            try {
                runtimeNames = runtimeToolNames();
            }
            catch {
                runtimeNames = null;
            }
            const checked = crossCheckWithRuntime(scanned, runtimeNames);
            checked.scanned.runtimeNames = runtimeNames;
            checked.scanned.droppedGhosts = checked.dropped;
            checked.scanned.expiredOfficial = checked.expired;
            return checked.scanned;
        }
        return scanned;
    }

    /**
     * 插件集合的指纹 —— 「这份扫描结果还能不能用」的唯一判据。
     *
     * 为什么不用「时间到了就重扫」：用户装插件是一个个装的，
     * 装完就该重扫一次；没装东西的时候重扫一万遍结果都一样（白等 15 秒）。
     * 所以判「集合变没变」，不判「过了多久」。
     *
     * 组成：
     *   · 每个第三方插件包的 `package.json` mtime + 版本号 —— 新装/卸载/
     *     升级/本地手改 都会让它们变；
     *   · 官方包那边的签名（目录数 + 本体 package.json mtime）—— DSH
     *     本体升级时官方工具表会变。
     * 全是 stat 级别的小开销（实测 ~30ms），比扫源码快两个数量级。
     *
     * @returns {Promise<string>}
     */
    async function computeFingerprint() {
        const parts = [];
        try {
            const dirs = await listPluginPackageDirs();
            for (const dir of [...dirs].sort()) {
                let sig = '';
                try {
                    const st = await stat(join(dir, 'package.json'));
                    sig = `${Math.round(st.mtimeMs)}:${st.size}`;
                }
                catch {
                    sig = 'missing';
                }
                parts.push(`p:${dir.split('/').pop()}=${sig}`);
            }
        }
        catch {
            parts.push('p:error');
        }
        // 官方包这边不逐包 stat（294 个），取两个便宜信号：
        // 目录条目数变了 = 装了/卸了官方包；本体 package.json 变了 = 升级了。
        try {
            const installDir = process.env.DSH_INSTALL_DIR;
            const execDir = dirname(process.execPath);
            const roots = [];
            if (installDir) {
                roots.push(join(installDir, 'node_modules', '@deepseek-ai'));
            }
            roots.push(join(dirname(execDir), 'lib', 'node_modules', '@deepseek-ai'));
            roots.push(join(execDir, 'node_modules', '@deepseek-ai'));
            for (const root of roots) {
                try {
                    const entries = await readdir(root);
                    let self = '';
                    try {
                        const st = await stat(join(root, 'dsh', 'package.json'));
                        self = `${Math.round(st.mtimeMs)}:${st.size}`;
                    }
                    catch {
                        self = 'n/a';
                    }
                    parts.push(`o:${root}=${entries.length}:${self}`);
                }
                catch {
                    parts.push(`o:${root}=missing`);
                }
            }
        }
        catch {
            parts.push('o:error');
        }
        return parts.join('|');
    }

    /**
     * 真正扫一遍并把结果落盘。只有「冷启动且没缓存」或「指纹变了」才会走到这里。
     */
    async function rescan() {
        const fingerprint = await computeFingerprint();
        const base = await scanNow();
        cache = base;
        at = Date.now();
        scanAt = at;
        cachedFingerprint = fingerprint;
        // 落盘失败不影响本次结果 —— 下次重新扫就是。
        void writeScanCache(fingerprint, base).catch(() => { });
        return base;
    }

    function startBackgroundRescan() {
        if (running) {
            return running;
        }
        running = rescan().then((base) => {
            running = null;
            if (typeof onScan === 'function') {
                try {
                    onScan(base);
                }
                catch {
                    /* 通知失败不影响扫描本身 */
                }
            }
            return base;
        }, (e) => {
            running = null;
            throw e;
        });
        // 后台重扫的失败没人接（调用方已经在用旧结果了），这里吞掉避免 unhandled rejection。
        running.catch(() => { });
        return running;
    }

    /**
     * 拿归属结果。**永远不为了「新」而等**：
     *   1. 内存里有 → 直接给（并按需在后台核对指纹）；
     *   2. 内存没有但有落盘缓存 → 读盘（毫秒级）直接给，指纹不对就后台重扫；
     *   3. 都没有 → 只能老实扫一遍（首次安装 / 缓存被删）。
     */
    /** 现读一份实测缓存 —— 小文件，毫秒级；读完立刻判版本新鲜度。 */
    async function currentProbeCache() {
        if (!readProbeCache) {
            return null;
        }
        try {
            // await 同时兼容同步返回 —— 回调可能是普通函数。
            return await readProbeCache();
        }
        catch {
            return null;
        }
    }

    async function get() {
        const probeCache = await currentProbeCache();
        if (cache) {
            // 按时间「顺手核对一次指纹」，不重扫：没装东西时结果根本不会变。
            if (ttlMs > 0 && Date.now() - at >= ttlMs && !running) {
                at = Date.now();
                void verify().catch(() => { });
            }
            return applyRuntime(cache, probeCache);
        }
        if (!running) {
            running = (async () => {
                const disk = await readScanCache();
                if (disk) {
                    cache = disk.base;
                    at = Date.now();
                    // 落盘缓存里记着「这份结果是什么时候扫出来的」——
                    // 界面要显示的就是它，不是刚才那次指纹核对的时刻。
                    scanAt = disk.savedAt || at;
                    cachedFingerprint = disk.fingerprint;
                    // 顺手（不阻塞）核对一下：插件集合要是变了，后台换新的。
                    // 这里**不 await** —— 页面要的是「立刻有东西看」。
                    void computeFingerprint().then((fp) => {
                        if (fp !== disk.fingerprint && !running) {
                            startBackgroundRescan();
                        }
                    }).catch(() => { });
                    return cache;
                }
                return rescan();
            })().then((base) => {
                running = null;
                return base;
            }, (e) => {
                running = null;
                throw e;
            });
        }
        const base = await running;
        return applyRuntime(base, probeCache);
    }

    /**
     * 核对指纹，变了就**等**重扫完再返回。
     *
     * 给「刚刚发生了插件变动」的路径用（变化监测的 tick、装载前预热）：
     * 那些地方本来就该看到最新事实，等一下是值得的。页面请求永远用 get()，
     * 不要用这个 —— 那会把 15 秒的等待搬到用户脸上。
     *
     * @returns {Promise<{rescanned: boolean}>}
     */
    async function verify() {
        const fp = await computeFingerprint();
        if (cache && fp === cachedFingerprint) {
            return { rescanned: false };
        }
        // 已有重扫在跑就等它，别重复扫。
        const job = running ?? startBackgroundRescan();
        await job.catch(() => { });
        return { rescanned: true };
    }

    /** 同步拿当前缓存（没有就空表）—— 给热路径用。 */
    function peek() {
        return cache ?? new Map();
    }

    /**
     * 丢掉内存里的结果。
     *
     * 默认**不删落盘缓存** —— 下一句 `get()` 会立刻读盘拿到（可能是旧一版的）
     * 结果，页面照旧秒开；真要作废旧结论就传 `{dropDisk: true}`。
     * 「插件集合变了」这种场景不需要手删磁盘：指纹对不上，get() 会自己后台重扫。
     */
    function invalidate(opts) {
        cache = null;
        at = 0;
        scanAt = 0;
        cachedFingerprint = '';
        if (opts?.dropDisk === true) {
            void dropScanCache().catch(() => { });
        }
        return { dropped: true };
    }

    /** 当前扫描状态（给界面显示「是缓存还是刚扫的」）。 */
    function info() {
        return {
            scanning: running !== null,
            cached: cache !== null,
            /** 上一次核对插件集合的时刻（每 30 秒推一次，**不代表重扫过**）。 */
            checkedAt: at,
            /** 上一次真正扫源码的时刻 —— 界面该显示这个。 */
            scannedAt: scanAt,
            fingerprint: cachedFingerprint,
        };
    }

    return { get, verify, peek, info, invalidate, startBackgroundRescan };
}

/**
 * 把深度排查缓存整理成「工具名 → 包名」。
 *
 * 输入宽容，但**输出永远是 Map** —— 这是这个函数存在的全部理由。
 * 形状不对时（比如调用方传进来的是 `async` 回调，拿回来一个 Promise），
 * `for…of` 会直接报 `probedMap is not iterable`，整个插件页连带 pre-step 全挂。
 * 所以这里把「形状不对」全部吃掉。
 *
 * 能接受的输入：
 *   - `Map<包名, string[]>` —— 调用方已经整理好的形状，原样用；
 *   - `{ version, plugins: { 包名 → {tools, status, version} } }` —— 缓存文件形状，
 *     只保留「记录版本 == 当前版本」的条目（插件升级过 → 旧结论作废）；
 *   - 其它（undefined / null / Promise 残留 / 被手改坏的 JSON）→ 空 Map。
 *
 * @param {unknown} probeCache
 * @param {Map<string, string>} [versions] - 包名 → 当前版本
 * @returns {Map<string, string>} 工具名 → 包名（歧义的不收）
 */
export function probedOwnersFrom(probeCache, versions = new Map()) {
    const out = new Map();
    /** @type {Iterable<[string, unknown]>} */
    let entries;
    if (probeCache instanceof Map) {
        // 已经是「包名 → 工具集」。
        entries = probeCache;
    }
    else if (probeCache && typeof probeCache === 'object' && !Array.isArray(probeCache)) {
        // 缓存文件形状：先按版本新鲜度过滤。
        const fresh = freshProbeTools(probeCache, versions);
        entries = fresh;
    }
    else {
        // null / undefined / Promise / 数组 / 字符串 —— 一律当没有。
        return out;
    }
    for (const [pkgName, tools] of entries) {
        if (typeof pkgName !== 'string' || !pkgName) {
            continue;
        }
        // 缓存被人手改坏时不能整页崩：跳过这一条就行。
        if (!Array.isArray(tools)) {
            continue;
        }
        for (const toolName of tools) {
            if (typeof toolName !== 'string' || toolName === '') {
                continue;
            }
            // 同一个工具被两个包声称 = 认不出来，不猜（null 标记，下面删掉）。
            if (out.has(toolName)) {
                out.set(toolName, null);
            }
            else {
                out.set(toolName, pkgName);
            }
        }
    }
    // null = 有歧义，删掉这个键（分类时当成没这条）
    for (const [key, value] of [...out]) {
        if (value === null) {
            out.delete(key);
        }
    }
    return out;
}

/**
 * 用运行时真实的工具清单裁剪静态扫描结果。
 *
 * 静态扫描只知道「源码里出现过这个名字」，不知道「运行时真的注册了它」。
 * 两者的差集就是**幽灵条目** —— 比如 dsh-ego-browser/lib/index.js:4552
 * 的 `const name = "ego-browser"`（包名常量，用于 TUI 设置命名空间），
 * 被当成了一个叫 ego-browser 的工具，但运行时根本没有它。
 *
 * 手写表 `OFFICIAL_TOOL_OWNERS` 也会随版本漂移：写表当时有的工具，
 * 升级后可能已经不存在了。运行时清单是唯一能证明「现在还有没有」的东西。
 *
 * @param {object} scanned - 扫描结果
 * @param {Set<string>|null} runtimeNames - 运行时真实注册的工具名；
 *   为 null 表示拿不到运行时清单（不裁剪，保持原样）
 * @returns {{scanned: object, dropped: string[], expired: string[]}}
 */
export function crossCheckWithRuntime(scanned, runtimeNames) {
    if (!runtimeNames || runtimeNames.size === 0) {
        // 拿不到运行时清单 = 不做裁剪。宁可多列也不要凭空少列。
        return { scanned, dropped: [], expired: [] };
    }
    const dropped = [];
    const expired = [];
    /**
     * 裁剪一张「工具名 → 包名」的表：运行时没有的名字剔掉。
     * 但要保住两类：
     *   - 官方表条目 —— 它们本来就可能是「未来才会有的工具」，不能因为
     *     当前版本没有就整个丢掉；改为标记出来（expired），让调用方决定。
     *   - 自报 / manifest —— 这两条是**插件自己声明的事实**，插件说它有
     *     就是有；运行时没看到可能是因为插件没加载或 scope 不同，
     *     那是「暂时查不到」，不是「不存在」。
     */
    const prune = (map, keepMissing = false) => {
        for (const name of [...map.keys()]) {
            if (!runtimeNames.has(name)) {
                if (keepMissing) {
                    continue;
                }
                map.delete(name);
                dropped.push(name);
            }
        }
    };
    // 插件侧：静态扫到 / 前缀猜 / quoted —— 运行时没有就是幽灵，剔掉。
    prune(scanned.plugin);
    prune(scanned.quoted);
    // 官方表：不清除，只把「运行时已不存在」的记下来。
    if (scanned.officialByPackage) {
        // officialByPackage 是 包前缀 → 包名，键是包名不是工具名，不能按工具名裁。
        // 真正的官方工具表在 classifyToolName 里读 OFFICIAL_TOOL_OWNERS（静态常量）。
        // 这里只负责把「官方表里、运行时没有」的工具名记出来。
    }
    for (const name of Object.keys(OFFICIAL_TOOL_OWNERS)) {
        if (!runtimeNames.has(name)) {
            expired.push(name);
        }
    }
    return { scanned, dropped, expired };
}
