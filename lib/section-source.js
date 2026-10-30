// 给「系统提示词段落」找来源。
//
// 宿主不告诉你是谁往 `assembly.sections` 里 push 的 —— sections 元素只有 `{ name, text }`。
// 所以只能反着查：把已装插件的源码扫一遍，找谁写了这个段落名。
//
// 这是一个**纯启发式**的做法，刻意做得保守：
//   - 只扫 `lib/**` 和包根的 `index.js`（别去碰 dist、测试、node_modules）；
//   - 单个文件超过 4MB 跳过（正常插件远小于此）；
//   - 同一个名字会在多个包里出现（定义、注册、子代理覆写），所以**打分**取最高分那处，
//     不是撞见第一个就收：常量定义 > 注册点 > 子代理借用 > 别处普通引用；
//   - 扫一次结果就落盘（挂在 sections.json 的条目上），之后不重复扫。
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { resolveDshHome } from './paths.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4000;

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

/** 列出候选包目录：profile 的第三方插件 + 宿主自带的 @deepseek-ai/*。 */
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
    const selfDir = join(process.execPath, '..', '..', 'lib', 'node_modules', '@deepseek-ai');
    installs.push(selfDir);
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
    }
    const mine = /dsh-scope-manager/;
    return dirs.filter((dir) => !mine.test(dir));
}

/**
 * 反查算法的版本。改了打分规则就 +1：老条目会当成「没查过」重扫一遍。
 */
export const SOURCE_SCAN_VERSION = 2;

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
    /** 名字 → { score, hit } */
    const best = new Map();
    const settled = () => wanted.every((name) => (best.get(name)?.score ?? -1) >= SCORE_CEILING);
    const packages = await listCandidatePackages();
    const budget = { left: 64 * 1024 * 1024 };
    for (const dir of packages) {
        if (budget.left <= 0 || settled()) {
            break;
        }
        let pkgName = '';
        try {
            const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
            pkgName = String(raw?.name ?? '') || dir;
        }
        catch {
            continue;
        }
        const files = [];
        const budgetForPkg = { left: Math.min(budget.left, 24 * 1024 * 1024) };
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
            for (const name of wanted) {
                if ((best.get(name)?.score ?? -1) >= SCORE_CEILING) {
                    continue;
                }
                // 三种引号都算，取这个文件里分值最高的那处。
                const scored = [];
                for (const needle of [`'${name}'`, `"${name}"`, `\`${name}\``]) {
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
    for (const [name, entry] of best) {
        result.set(name, entry.hit);
    }
    return result;
}
