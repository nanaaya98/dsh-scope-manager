// 技能板块：列出宿主里现成的技能，读它的 SKILL.md，手工改回去。
//
// 底座事实（都实读核对过）：
// - `ctx.skills.list(options?)` → SkillSummary[]：{name, description, path?, whenToUse?,
//   invocation{modelInvocable,userInvocable}, source, provider, resourceBase?}。
//   **没有 root 字段、没有 enabled 字段** —— 根路径只能从 path 反推。
// - `ctx.skills.get(name)` → SkillDefinition，content 是**去掉 frontmatter 之后**的正文。
//   所以要编辑必须读原始文件，不能拿 content 写回去 —— 那会把 frontmatter 抹掉。
// - **没有写盘 API**。写技能 = 直接写那个文件；宿主靠 chokidar 监视目录，
//   写完大约 200ms 才广播 `skills/change`。
// - **没有「启用 / 停用」总开关**。宿主只有 frontmatter 里的调用面开关
//   （disable-model-invocation / user-invocable），过滤发生在消费侧。
//   所以「停用某个技能」这个语义本插件不自己造，只提供名单（allow/deny）供场景与作用域使用。
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const SOURCE_LABELS = Object.freeze({
    'project-dsh': '项目 · DSH',
    'project-agents': '项目 · AGENTS',
    'runtime': '运行时',
    'user-dsh': '用户 · DSH',
    'user-agents': '用户 · AGENTS',
    'custom': '自定义目录',
    'bundled': '内置随包',
});

export function sourceLabel(source) {
    return SOURCE_LABELS[source] ?? source ?? '未知来源';
}

/** 从摘要里算出这个技能的文件落在哪儿。 */
function skillFilePath(summary) {
    if (summary?.path && typeof summary.path === 'string' && summary.path.length > 0) {
        return summary.path;
    }
    // 宿主的 `resourceBase` 是**判别对象**，不是字符串：
    //   { kind: 'directory', path } | { kind: 'url', url } | { kind: 'opaque', description }
    // 只有 directory 能拼出本地文件；url / opaque 没有可编辑的文件。
    // 直接把对象喂给 path.join 会报
    //   ERR_INVALID_ARG_TYPE: The "path" argument must be of type string。
    const base = summary?.resourceBase;
    if (base && typeof base === 'object') {
        if (base.kind === 'directory' && typeof base.path === 'string' && base.path.length > 0) {
            return join(base.path, 'SKILL.md');
        }
        return undefined;
    }
    // 宿主也可能直接给字符串，保留兼容。
    if (typeof base === 'string' && base.length > 0 && summary?.name) {
        return join(base, summary.name, 'SKILL.md');
    }
    return undefined;
}

/**
 * 文件在哪儿 —— 决定界面上给什么警告，而不是决定能不能改。
 *
 * - `project`：项目里的 `.dsh/skills` / `.agents/skills`，跟着仓库走，
 * - `user`：`~/.dsh/skills` / `~/.agents/skills`，跨项目全局，
 * - `package`：node_modules 里（内置随包 / 第三方插件自带）—— 改了升级就被覆盖，
 *   但**仍然允许改**：有人就是想临时试一把，拦着只会让他去编辑器里改同一个文件，
 *   那样还少了这里的原文件备份。
 */
function pathLocation(filePath) {
    if (!filePath) {
        return 'virtual';
    }
    if (filePath.split(/[\\/]/).includes('node_modules')) {
        return 'package';
    }
    if (/[\\/]\.(dsh|agents)[\\/]skills[\\/]/.test(filePath)) {
        return 'project';
    }
    return 'user';
}

/**
 * 位置优先按宿主报的 `source` 判 —— 路径正则靠不住：
 * `/root/.dsh/skills/xxx`（用户级）里也有 `.dsh/skills`，会被误判成「项目内」。
 *
 * 宿主的 source 取值：`project-dsh` / `project-agents` / `user-dsh` / `user-agents` /
 * `custom` / `bundled` / `runtime`（见 `dsh-skill-filesystem` 的 roots()）。
 */
export function locationFromSource(source) {
    switch (String(source ?? '')) {
        case 'project-dsh':
        case 'project-agents': return 'project';
        case 'user-dsh':
        case 'user-agents': return 'user';
        case 'bundled': return 'package';
        case 'custom': return 'custom';
        default: return '';
    }
}

/** 技能页「已安装」里的三个分类桶：内置 / 插件 / 其他。 */
const BUCKET_BUILTIN = 'builtin';
const BUCKET_PLUGIN = 'plugin';
const BUCKET_OTHER = 'other';

/**
 * 分类桶的顺序与标题 —— 界面照这个顺序折叠分组。
 * 名字短到能当标签（用户要求：预设自带→内置、插件自带→插件、自装→其他）。
 */
export const SKILL_BUCKETS = Object.freeze([
    { key: BUCKET_BUILTIN, label: '内置技能', hint: '跟着宿主 / agent 预设一起带的，改不改看你自己' },
    { key: BUCKET_PLUGIN, label: '插件技能', hint: '插件包里带的，改了升级会被覆盖' },
    { key: BUCKET_OTHER, label: '用户技能', hint: '自己装的、项目里的、额外加的目录' },
]);

/** 能不能改：只要有文件就允许，`location` 负责提示风险。 */
function isEditablePath(filePath) {
    return Boolean(filePath);
}

/**
 * 这个技能是「谁带来的」—— 决定界面上那枚来源标签。
 *
 * 必须按路径判，不能只看 `source`：宿主给预设包里的技能报的也是 `custom`，
 * 而扩展管理（dsh-plugin-tool-management）明确不列预设参考技能
 * （`lib/skills/official.js:35`：「预设参考技能（dsh-agent-preset/skills）不注入会话上下文，不列入」），
 * 两边数字对不上就是差在这 4 个。
 */
export function skillOrigin(skill) {
    const file = String(skill?.path ?? '');
    const location = skill?.location ?? '';
    if (/[\\/]dsh-agent-preset[\\/]skills[\\/]/.test(file)) {
        return {
            kind: 'preset', bucket: BUCKET_BUILTIN, label: '内置技能',
            detail: '跟着 agent 预设一起加载，扩展管理的技能页列不出来',
            packageName: packageNameOf(file) || 'dsh-agent-preset',
        };
    }
    if (/[\\/]official-skills[\\/]/.test(file)) {
        return {
            kind: 'official', bucket: BUCKET_BUILTIN, label: '内置技能',
            detail: '官方技能包里带的，扩展管理能启停', packageName: 'official-skills',
        };
    }
    if (location === 'package') {
        return {
            kind: 'plugin', bucket: BUCKET_PLUGIN, label: '插件技能',
            detail: '随插件包一起发布，改了升级会被覆盖', packageName: packageNameOf(file),
        };
    }
    if (location === 'project') {
        return {
            kind: 'project', bucket: BUCKET_OTHER, label: '用户技能',
            detail: '在仓库的 .dsh/skills 里，跟着项目走', packageName: '',
        };
    }
    if (location === 'user') {
        return {
            kind: 'user', bucket: BUCKET_OTHER, label: '用户技能',
            detail: '从技能市场装的、或用会话自己建的；删掉就没了', packageName: '',
        };
    }
    if (location === 'custom') {
        return {
            kind: 'custom', bucket: BUCKET_OTHER, label: '用户技能',
            detail: '宿主配置里额外加的技能目录', packageName: '',
        };
    }
    return {
        kind: 'other', bucket: BUCKET_OTHER, label: '用户技能',
        detail: '', packageName: '',
    };
}

/**
 * 从 node_modules 路径里取包名（pnpm 的 `.pnpm/<name>@<ver>/` 那层会自动跳过，取最后一段）。
 *
 * 作用域的包名有**两段**（`@changfenhuang/dsh-genui`），只取第一段会变成
 * `@changfenhuang` —— 标签上就成了「插件自带 · @changfenhuang」，把包名丢掉一半。
 */
export function packageNameOf(file) {
    const at = String(file ?? '').lastIndexOf('/node_modules/');
    if (at < 0) {
        return '';
    }
    const parts = String(file ?? '').slice(at + '/node_modules/'.length).split('/');
    const first = parts[0] ?? '';
    if (!first) {
        return '';
    }
    // `@scope/name` 要连上第二段；`@scope` 后面什么都没有时退回第一段。
    if (first.startsWith('@') && parts[1]) {
        return `${first}/${parts[1]}`;
    }
    return first;
}

function normalize(summary) {
    const file = skillFilePath(summary);
    const location = locationFromSource(summary.source) || pathLocation(file);
    const origin = skillOrigin({ path: file, location, source: summary.source, sourceLabel: sourceLabel(summary.source) });
    return {
        origin,
        name: summary.name,
        description: summary.description ?? '',
        whenToUse: summary.whenToUse ?? '',
        source: summary.source ?? 'unknown',
        sourceLabel: sourceLabel(summary.source),
        provider: summary.provider ?? '',
        path: file,
        // 保持宿主原样（判别对象或老宿主的字符串），只做一次浅拷贝免得被下游改。
        resourceBase: summary.resourceBase ?? null,
        modelInvocable: summary.invocation?.modelInvocable !== false,
        userInvocable: summary.invocation?.userInvocable !== false,
        editable: isEditablePath(file),
        location,
    };
}

/**
 * 卸载一个自装技能：**硬删**，把它的目录整个 `rm -rf` 掉。
 *
 * 只动「自装技能」这一类（`source` 为 user-dsh / user-agents，也就是从技能市场装的、
 * 或用会话自己建的）—— 预设自带、插件自带、官方技能包都不许删：
 * 那些是包里带出来的，删掉下次升级又回来，还会把包弄坏。
 *
 * 调用方通常已经拿到了列表里的那一条，直接把它的路径喂进来最稳
 * （换一个上下文重新 list 可能看不全：宿主的技能注册是按 agent/cwd 分层的）。
 *
 * @param {{name: string, file?: string, location?: string}} input
 */
export async function uninstallSelfInstalledSkill(input) {
    const name = String(input?.name ?? '').trim();
    const file = String(input?.file ?? '');
    const location = String(input?.location ?? '');
    if (!name) {
        const error = new Error('没说删哪个技能');
        error.code = 'bad-request';
        throw error;
    }
    if (!file) {
        const error = new Error(`找不到技能「${name}」的文件路径，没法判断能不能删`);
        error.code = 'bad-request';
        throw error;
    }
    if (location !== 'user') {
        const error = new Error(`「${name}」不是自装技能（${location || '未知位置'}），删不了 —— 删了升级会回来，还会弄坏包`);
        error.code = 'bad-request';
        throw error;
    }
    const dir = dirname(file);
    // 双保险：要删的必须是技能目录本身，不能是 `/`、也不能是技能根目录。
    const segments = dir.split(/[\\/]/).filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (segments.length < 3 || leaf === 'skills' || leaf === 'node_modules') {
        const error = new Error(`这个路径看着不像一个技能目录，不敢删：${dir}`);
        error.code = 'bad-request';
        throw error;
    }
    await rm(dir, { recursive: true, force: true });
    return { name, dir, removed: true };
}

/**
 * 按名字卸载：先在这一层 list 一遍找到真实路径，再交给 `uninstallSelfInstalledSkill`。
 * （页面走的是 http-api 那条：它先拿页面同一份列表，再按路径删。）
 *
 * @param {object} skills 宿主的 skills 服务
 * @param {string} name 技能名
 * @param {{cwd?: string, scope?: string}} options
 */
export async function removeSkill(skills, name, options = {}) {
    const target = String(name ?? '').trim();
    const summaries = await (skills?.list?.({ cwd: options.cwd, scope: options.scope }) ?? []);
    const summary = (summaries ?? []).find((item) => item?.name === target);
    if (!summary) {
        const error = new Error(`找不到技能「${target}」`);
        error.code = 'bad-request';
        throw error;
    }
    return uninstallSelfInstalledSkill({
        name: target,
        file: skillFilePath(summary),
        location: locationFromSource(summary.source) || pathLocation(skillFilePath(summary)),
    });
}

/**
 * 列技能。
 * @param {object} skills 宿主的 skills 服务
 * @param {{cwd?: string, signal?: AbortSignal}} options list 的选项
 */
export async function listSkills(skills, options = {}) {
    if (!skills || typeof skills.list !== 'function') {
        return [];
    }
    let summaries = [];
    try {
        summaries = await skills.list({ cwd: options.cwd, signal: options.signal, scope: options.scope });
    }
    catch {
        return [];
    }
    // 单条摘要坏掉不该拖垮整页（宿主改过字段名、provider 给了怪东西都会）。
    const out = [];
    for (const summary of Array.isArray(summaries) ? summaries : []) {
        try {
            out.push(normalize(summary));
        }
        catch {
            /* 这一条跳过，其余的照常列出来 */
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

/** 读技能的原始文件（带 frontmatter）—— 界面编辑器要的就是这个。 */
export async function readSkillFile(skills, name, options = {}) {
    const summaries = await listSkills(skills, options);
    const summary = summaries.find((s) => s.name === name);
    if (!summary) {
        throw new Error(`找不到技能「${name}」`);
    }
    if (!summary.path) {
        throw new Error(`技能「${name}」没有可读的文件路径`);
    }
    let content = '';
    try {
        content = await readFile(summary.path, 'utf8');
    }
    catch (e) {
        throw new Error(`读取技能文件失败：${e?.message ?? e}`);
    }
    let description = '';
    try {
        const def = await skills.get(name, { cwd: options.cwd, signal: options.signal });
        description = def?.description ?? summary.description;
    }
    catch {
        description = summary.description;
    }
    return { ...summary, content, description };
}

/**
 * 拆出 frontmatter。
 *
 * 宿主没有「启用 / 停用」API，只有 frontmatter 里的两个调用面开关
 * （`disable-model-invocation` / `user-invocable`）——
 * 停用的语义就落在这一对键上（和 dsh-mcp-studio 的 rewriteSkillPolicy 同一个口径）。
 *
 * @param {string} text 技能文件全文
 * @returns {{newline: string, lines: string[], body: string}}
 */
export function frontmatterOf(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
    if (match === null) {
        throw new Error('技能文件没有 frontmatter 块');
    }
    return {
        newline: String(text ?? '').includes('\r\n---') ? '\r\n' : '\n',
        lines: match[1].split(/\r?\n/),
        body: String(text ?? '').slice(match[0].length),
    };
}

/**
 * 改 frontmatter 里的调用面开关。
 *
 * @param {string} text 技能文件全文
 * @param {boolean} enabled true = 启用（去掉两个键），false = 停用（写上两个键）
 * @returns {string} 新的全文
 */
export function rewriteSkillPolicy(text, enabled) {
    const { newline, lines, body } = frontmatterOf(text);
    const kept = lines.filter((line) => !/^(?:disable-model-invocation|user-invocable):/.test(line));
    if (!enabled) {
        kept.push('disable-model-invocation: true', 'user-invocable: false');
    }
    return `---${newline}${kept.join(newline)}${newline}---${body}`;
}

/**
 * 停用 / 启用一个技能。
 *
 * 停用的语义写在 frontmatter 里（宿主没有独立的开关表），
 * 写完宿主大约 200ms 后广播 skills/change，界面自己会刷新。
 *
 * @param {object} skills 宿主的 skills 服务
 * @param {string} name 技能名
 * @param {boolean} enabled 是否启用
 * @param {object} options list 的选项
 */
export async function setSkillPolicy(skills, name, enabled, options = {}) {
    const current = await readSkillFile(skills, name, options);
    const next = rewriteSkillPolicy(current.content, enabled);
    const written = await writeSkillFile(skills, name, next, options);
    return { ...written, name, enabled: enabled !== false };
}

/** 写回技能文件（原子写）。frontmatter 原样保留 —— 界面给的是全文。 */
export async function writeSkillFile(skills, name, content, options = {}) {
    const summaries = await listSkills(skills, options);
    const summary = summaries.find((s) => s.name === name);
    if (!summary) {
        throw new Error(`找不到技能「${name}」`);
    }
    if (!summary.path) {
        throw new Error(`技能「${name}」没有可写的文件路径`);
    }
    if (!isEditablePath(summary.path)) {
        throw new Error(`技能「${name}」没有可写的文件路径`);
    }
    const file = summary.path;
    await mkdir(dirname(file), { recursive: true });
    // 改之前先留一份原文：node_modules 里的包文件改坏了没有 git 可回退，
    // 而界面上的「保存」看起来像件小事。
    let backup;
    try {
        const original = await readFile(file, 'utf8');
        if (original !== String(content ?? '')) {
            backup = `${file}.bak-${Date.now().toString(36)}`;
            await writeFile(backup, original, 'utf8');
        }
    }
    catch {
        backup = undefined;
    }
    const tmp = join(dirname(file), `.${file.split('/').pop()}.${randomUUID().slice(0, 8)}.tmp`);
    try {
        await writeFile(tmp, String(content ?? ''), 'utf8');
        await rename(tmp, file);
    }
    catch (e) {
        await rm(tmp, { force: true }).catch(() => { });
        throw new Error(`写入技能文件失败：${e?.message ?? e}`);
    }
    return { name, path: file, backup };
}
