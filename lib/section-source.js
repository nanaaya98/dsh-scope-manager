// 给「系统提示词段落」找来源。
//
// 宿主不告诉你是谁往 `assembly.sections` 里 push 的 —— sections 元素只有 `{ name, text }`。
// 所以只能反着查：把已装插件的源码扫一遍，找谁写了这个段落名。
//
// 查的顺序是「先查表，再判断」：
//   ① 宿主自带的段落名和它们的归属包是稳定的（段落名是宿主自己起的常量），
//      写在 lib/system-sections.js 的默认表里。命中表的那几段只在表指向的
//      那个包里扫一遍 —— 又准又快，也不依赖官方包装在哪（不同安装方式
//      目录布局不一样，扫不到就整段落查不出来）。
//   ② 表里没有的名字、或者表指向的包里已经找不到这个名字的（段落搬走了、
//      宿主以后新增了段落），退回启发式：把候选包扫一遍，按打分取最高分那处。
//
// 启发式的部分刻意做得保守：
//   - 只扫 `lib/**` 和包根的 `index.js`（别去碰 dist、测试、node_modules）；
//   - 单个文件超过 4MB 跳过（正常插件远小于此）；
//   - 同一个名字会在多个包里出现（定义、注册、子代理覆写），所以**打分**取最高分那处，
//     不是撞见第一个就收：常量定义 > 注册点 > 子代理借用 > 别处普通引用；
//   - 扫一次结果就落盘（挂在 sections.json 的条目上），之后不重复扫。
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveDshHome } from './paths.js';
import { systemSectionOwner } from './system-sections.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PKG_BYTES = 24 * 1024 * 1024;

async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}

/** 递归收集目录下的 .js / .mjs / .cjs，跳过 node_modules/dist/测试目录。 */
async function collectJsFiles(root, out, budget) {
    if (out.length >= MAX_FILES || budget.left <= 0) {
        return;
    }
    let entries = [];
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (out.length >= MAX_FILES || budget.left <= 0) {
            return;
        }
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
        }
        const full = join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'dist' || entry.name === 'test' || entry.name === 'tests') {
                continue;
            }
            await collectJsFiles(full, out, budget);
            continue;
        }
        if (!/\.(?:js|mjs|cjs)$/.test(entry.name)) {
            continue;
        }
        let info = null;
        try {
            info = await stat(full);
        }
        catch {
            continue;
        }
        if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) {
            continue;
        }
        budget.left -= info.size;
        out.push({ path: full, size: info.size });
    }
}

/**
 * 列出候选包目录：profile 里的插件 + 宿主自带的官方包。
 *
 * 官方包有两种摆法，都要收到：
 *   · 直接摆在 `@deepseek-ai/` 下面（`dsh-tool-bash` 这种）；
 *   · 装在宿主本体自己的 `node_modules/@deepseek-ai/` 下面
 *     （`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）——
 *     只看顶层会把这一整层官方包漏掉，宿主的段落就全都查不出归属了。
 */
async function listCandidatePackages() {
    const dirs = [];
    const seen = new Set();
    const push = (dir) => {
        if (!seen.has(dir)) {
            seen.add(dir);
            dirs.push(dir);
        }
    };
    const home = resolveDshHome();
    let profiles = [];
    try {
        profiles = await readdir(join(home, 'profiles'), { withFileTypes: true });
    }
    catch {
        profiles = [];
    }
    for (const profile of profiles) {
        if (!profile.isDirectory()) {
            continue;
        }
        const nm = join(home, 'profiles', profile.name, 'node_modules');
        let entries = [];
        try {
            entries = await readdir(nm, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            if (entry.name.startsWith('@')) {
                let scoped = [];
                try {
                    scoped = await readdir(join(nm, entry.name), { withFileTypes: true });
                }
                catch {
                    scoped = [];
                }
                for (const child of scoped) {
                    push(join(nm, entry.name, child.name));
                }
                continue;
            }
            push(join(nm, entry.name));
        }
    }
    // 宿主自己的安装目录（dsh 本体 + 官方插件都在这里）
    const installs = [
        join(process.cwd(), 'node_modules'),
        '/usr/local/lib/node_modules/@deepseek-ai',
    ];
    installs.push(join(process.execPath, '..', '..', 'lib', 'node_modules', '@deepseek-ai'));
    for (const base of installs) {
        let entries = [];
        try {
            entries = await readdir(base, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('dsh-')) {
                push(join(base, entry.name));
            }
        }
        // 官方包也可能装在某个包自己的 node_modules 里（宿主本体就是这种摆法）。
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const scopedDir = join(base, entry.name, 'node_modules', '@deepseek-ai');
            let scoped = [];
            try {
                scoped = await readdir(scopedDir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const child of scoped) {
                if (!child.isDirectory() || child.name.startsWith('.')) {
                    continue;
                }
                push(join(scopedDir, child.name));
            }
        }
    }
    const mine = /dsh-scope-manager/;
    return dirs.filter((dir) => !mine.test(dir));
}

/**
 * 反查算法的版本。改了打分规则就 +1：老条目会当成「没查过」重扫一遍。
 */
export const SOURCE_SCAN_VERSION = 3;

/** 单次命中的最高分（常量定义）。见 {@link scoreSectionHit}。 */
const SCORE_CEILING = 20;

function escapeLiteral(name) {
    return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 命中处值多少分。
 *
 * 同一个段落名往往出现在好几个包里，先到先得是错的：
 * `deployment:persona-prefix` 在 dsh-system-prompt 里是**定义**（常量赋值），
 * 在 dsh-subagent 里只是子代理**借用**这个名字覆写槽位。所以要打分而不是撞见就收。
 */
export function scoreSectionHit(text, at, name) {
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    const quoted = `['"\`]${escapeLiteral(name)}['"\`]`;
    let score = 3;
    // `const PERSONA_PREFIX_SECTION = "deployment:persona-prefix"` —— 常量定义，
    // 几乎只出现在真正拥有这个段落的包里。
    if (new RegExp(`^\\s*(?:const|let|var)?\\s*[A-Za-z_$][\\w$]*\\s*=\\s*${quoted}`).test(line)) {
        score = SCORE_CEILING;
    }
    else if (new RegExp(`name\\s*:\\s*${quoted}`).test(line)) {
        // `this.section({ name: 'x' })` —— 注册点，也算强证据。
        score = 15;
    }
    // 子代理 / 预设借同一个名字覆写别人的槽位（childCtx.systemPrompt.section({ name })），
    // 它只是「借用」，不是拥有者。
    const window = text.slice(Math.max(0, at - 500), at + 500);
    if (/childCtx|applyChildOverrides|composition\.persona/.test(window)) {
        score -= 9;
    }
    return score;
}

/** 读包名；读不到就当没有这个包。 */
async function readPackageName(dir) {
    try {
        const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        return String(raw?.name ?? '') || '';
    }
    catch {
        return '';
    }
}

/**
 * 在给定的包里找这些段落名。
 *
 * @param {Array<{dir:string, pkgName:string}>} packages 要扫的包
 * @param {string[]} names 要找的段落名
 * @returns {Promise<Map<string, {score:number, hit:object}>>}
 */
async function scanPackages(packages, names) {
    /** 名字 → { score, hit } */
    const best = new Map();
    const settled = () => names.every((name) => (best.get(name)?.score ?? -1) >= SCORE_CEILING);
    const budget = { left: MAX_TOTAL_BYTES };
    for (const pkg of packages) {
        if (budget.left <= 0 || settled()) {
            break;
        }
        const { dir, pkgName } = pkg;
        const files = [];
        const budgetForPkg = { left: Math.min(budget.left, MAX_PKG_BYTES) };
        if (await exists(join(dir, 'lib'))) {
            await collectJsFiles(join(dir, 'lib'), files, budgetForPkg);
        }
        if (await exists(join(dir, 'index.js'))) {
            files.push({ path: join(dir, 'index.js'), size: 0 });
        }
        if (files.length === 0) {
            continue;
        }
        for (const file of files) {
            let text = '';
            try {
                text = await readFile(file.path, 'utf8');
            }
            catch {
                continue;
            }
            for (const name of names) {
                if ((best.get(name)?.score ?? -1) >= SCORE_CEILING) {
                    continue;
                }
                // 三种引号都算，取这个文件里分值最高的那处。
                const scored = [];
                for (const needle of [`'${name}'`, `"${name}"`, `\u0060${name}\u0060`]) {
                    let from = 0;
                    while (scored.length < 64) {
                        const at = text.indexOf(needle, from);
                        if (at < 0) {
                            break;
                        }
                        from = at + needle.length;
                        scored.push({ score: scoreSectionHit(text, at, name), at });
                        if (scored[scored.length - 1].score >= SCORE_CEILING) {
                            break;
                        }
                    }
                }
                if (scored.length === 0) {
                    continue;
                }
                scored.sort((a, b) => b.score - a.score);
                const top = scored[0];
                const cur = best.get(name);
                if (cur && cur.score >= top.score) {
                    continue;
                }
                const line = text.slice(0, top.at).split('\n').length;
                const lineText = text.split('\n')[line - 1] ?? '';
                best.set(name, {
                    score: top.score,
                    hit: {
                        plugin: pkgName,
                        file: relative(dir, file.path) || file.path,
                        path: file.path,
                        line,
                        source: lineText.trim().slice(0, 200),
                    },
                });
            }
        }
    }
    return best;
}

/**
 * 扫一遍，返回 `Map<段落名, {plugin, file, line, source}>`。
 * 一次只解一批名字（调用方给未解析过的那些），扫完就丢。
 *
 * 「撞见就收」不行：同一个名字可能在多个包里出现，取分最高的那处。
 */
export async function resolveSectionSources(names) {
    const wanted = [...new Set((names ?? []).filter((n) => typeof n === 'string' && n))];
    const result = new Map();
    if (wanted.length === 0) {
        return result;
    }
    const dirs = await listCandidatePackages();
    /** 包目录 → 包名（读 package.json）。 */
    const packages = [];
    /** 包名 → 包目录。 */
    const byName = new Map();
    for (const dir of dirs) {
        const pkgName = await readPackageName(dir);
        if (!pkgName) {
            continue;
        }
        packages.push({ dir, pkgName });
        if (!byName.has(pkgName)) {
            byName.set(pkgName, dir);
        }
    }

    // ① 默认表里有的：只在表指向的那个包里找 —— 找到了就是它，找不到说明
    //    段落搬走了（或者表过时了），那些名字退回 ② 全量判断。
    const tableNames = [];
    const tablePkgs = [];
    for (const name of wanted) {
        const owner = systemSectionOwner(name);
        if (!owner) {
            continue;
        }
        const dir = byName.get(owner);
        if (!dir) {
            continue;
        }
        tableNames.push(name);
        tablePkgs.push({ dir, pkgName: owner });
    }
    const fromTable = await scanPackages(tablePkgs, tableNames);
    for (const [name, entry] of fromTable) {
        result.set(name, entry.hit);
    }

    // ② 剩下的：表里没有的、或者表指向的包里已经找不到的 —— 全量判断。
    const rest = wanted.filter((name) => !result.has(name));
    if (rest.length > 0) {
        const found = await scanPackages(packages, rest);
        for (const [name, entry] of found) {
            result.set(name, entry.hit);
        }
    }
    return result;
}
