import { PERMISSION_MODES } from './resolve.js';
// 角色卡与场景预设的落盘。
//
// 角色卡（persona）：一整套「人设模板」，场景预设可以挑一张。
//   hub/personas/<id>.json   { id, name, description, inject, parts, updatedAt }
//   hub/personas/<id>.md     三段正文拼起来的 markdown（人看的；装配读的是 parts）
//
// 三段对应系统提示词里那三条人设段（见 PERSONA_PARTS）：
//   worldview  世界观   → harness:identity
//   character  角色设定 → deployment:persona-prefix
//   constraints 行为约束 → deployment:persona-suffix
//
// inject 决定这三段怎么进模型：
//   context（默认）—— 拼成一条合成 user 消息，插在对话里（预设在旁边坐着也不受影响）；
//   system        —— 在装配时覆盖上面那三段 systemPrompt 的文字（不占对话消息，
//                    但遇到 complete:true 的预设会跟着整份提示词一起被压掉）。
//
// 场景预设（scene）：一整套「预设包」，里面挑角色卡 + 工具名单 + 技能名单。
//   hub/scenes/<id>.json      { id, name, description, persona, tools, toolFilter, skills, updatedAt }
//
// id 生成：时间戳基36 + 随机后缀 —— 人手敲的 id 容易撞，撞了就覆盖别人的东西。
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hubPath } from './paths.js';
import { writeAtomic } from './atomic.js';

const PERSONAS_DIR = 'personas';
const SCENES_DIR = 'scenes';

function newId() {
    return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** id 只允许安全字符 —— id 会拼进文件路径。 */
function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id);
}

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}

async function readText(file) {
    try {
        return await readFile(file, 'utf8');
    }
    catch {
        return undefined;
    }
}

// ——————————————————————— 角色卡 ———————————————————————

/** 三段正文的键与标题，顺序即界面顺序。 */
const PERSONA_PARTS = [
    ['worldview', '世界观'],
    ['character', '角色设定'],
    ['constraints', '行为约束'],
];

/**
 * 把三段拼成一份 markdown —— 落盘的 `.md` 就是它，人读/导出用。
 * 空的段整段跳过，不留一个空标题在那里。
 */
function renderPersonaBody(parts) {
    const out = [];
    for (const [key, label] of PERSONA_PARTS) {
        const text = String(parts?.[key] ?? '').trim();
        if (!text) {
            continue;
        }
        out.push(`## ${label}`, '', text, '');
    }
    return out.join('\n').trimEnd();
}

/**
 * 归一化三段正文。
 * 只存了整段 body（没有 parts）的角色卡 —— 那时 body 就是「角色设定」，另两段留空，
 * 整段人设进模型的行为不变。
 */
function normalizePersonaParts(raw, body) {
    const given = raw?.parts && typeof raw.parts === 'object' ? raw.parts : null;
    const out = {};
    for (const [key] of PERSONA_PARTS) {
        const fromParts = given ? String(given[key] ?? '') : '';
        out[key] = fromParts;
    }
    if (!given && typeof body === 'string') {
        out.character = body;
    }
    return out;
}

/** 列表 + 正文：给界面用（编辑器要能直接打开）。 */
export async function listPersonasWithBody() {
    const metas = await listPersonas();
    const out = [];
    for (const meta of metas) {
        const full = await readPersona(meta.id);
        out.push(full ?? meta);
    }
    return out;
}

export async function listPersonas() {
    const dir = hubPath(PERSONAS_DIR);
    let entries = [];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }
        const meta = await readJson(join(dir, entry.name));
        if (meta && typeof meta.id === 'string') {
            out.push(meta);
        }
    }
    out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    return out;
}

export async function readPersona(id) {
    if (!isValidId(id)) {
        return undefined;
    }
    const meta = await readJson(hubPath(PERSONAS_DIR, `${id}.json`));
    if (!meta) {
        return undefined;
    }
    const body = (await readText(hubPath(PERSONAS_DIR, `${id}.md`))) ?? '';
    const parts = normalizePersonaParts(meta, body);
    return {
        ...meta,
        ...parts,
        inject: meta.inject === 'system' ? 'system' : 'context',
        body,
    };
}

export async function savePersona(input) {
    const name = String(input?.name ?? '').trim();
    if (!name) {
        throw new Error('角色卡需要一个名字');
    }
    const id = isValidId(input?.id) ? input.id : newId();
    // 没给三段（老调用方/老界面传的是整段 body）时，body 当成「角色设定」。
    const hasParts = ['worldview', 'character', 'constraints'].some((k) => typeof input?.[k] === 'string');
    const parts = hasParts
        ? normalizePersonaParts({ parts: input }, '')
        : normalizePersonaParts(null, String(input?.body ?? ''));
    const record = {
        id,
        name,
        description: String(input?.description ?? '').slice(0, 500),
        inject: input?.inject === 'system' ? 'system' : 'context',
        parts,
        updatedAt: new Date().toISOString(),
    };
    // 先写正文再写 meta：meta 是「这张卡存在」的凭据，正文写失败时宁可留下一张没有正文的卡
    // 也不能反过来（meta 在、正文缺 → 列表里出现一张空卡）。
    // `.md` 是拼出来给人看的；装配读的是 meta 里的 parts。
    await writeAtomic(hubPath(PERSONAS_DIR, `${id}.md`), renderPersonaBody(parts));
    await writeAtomic(hubPath(PERSONAS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
    // 返回给界面的是「展平」过的形状（三段在顶层），和 readPersona 一致。
    return { ...record, ...parts, body: renderPersonaBody(parts) };
}

export async function deletePersona(id) {
    if (!isValidId(id)) {
        return false;
    }
    await rm(hubPath(PERSONAS_DIR, `${id}.md`), { force: true });
    await rm(hubPath(PERSONAS_DIR, `${id}.json`), { force: true });
    return true;
}

// ——————————————————————— 场景预设 ———————————————————————

function normalizeScene(raw) {
    const out = {
        id: raw.id,
        name: String(raw.name ?? ''),
        description: String(raw.description ?? '').slice(0, 1000),
        tools: raw.tools && typeof raw.tools === 'object' ? raw.tools : {},
        toolFilter: raw.toolFilter && typeof raw.toolFilter === 'object' ? raw.toolFilter : null,
        sectionFilter: raw.sectionFilter && typeof raw.sectionFilter === 'object' ? raw.sectionFilter : null,
        skills: raw.skills && typeof raw.skills === 'object' ? raw.skills : null,
        updatedAt: raw.updatedAt ?? null,
    };
    // persona **只在真选了一张卡时才写这个键**：
    // 合并时「没有这个键」= 这个场景不带角色卡（继续往低层找），
    // 「写了 null」= 明确置空（挡住低层）。两者不能混。
    if (typeof raw.persona === 'string' && raw.persona) {
        out.persona = raw.persona;
    }
    // 权限档位同理：没选 = 不带这个键（这一层不管），选了才写。
    if (typeof raw.permission === 'string' && PERMISSION_MODES.has(raw.permission)) {
        out.permission = raw.permission;
    }
    if (out.toolFilter) {
        out.toolFilter = {
            mode: out.toolFilter.mode === 'allow' ? 'allow' : 'deny',
            names: Array.isArray(out.toolFilter.names) ? out.toolFilter.names : [],
            // 「以后新装的插件工具默认激活吗」——只对 deny（黑名单）模式有意义：
            // allow 模式本来就是「列出来的才开」，新工具自然不开。
            newToolsActive: out.toolFilter.newToolsActive !== false,
            // 保存这套场景时目录里有哪些工具名。新工具 = 不在这个基线里的。
            // 没有基线（老场景 / 没走过新版本的保存）就当「不知道什么是新的」，按老规矩放行。
            baseline: Array.isArray(out.toolFilter.baseline)
                ? out.toolFilter.baseline.filter((x) => typeof x === 'string')
                : [],
        };
    }

    if (out.sectionFilter) {
        out.sectionFilter = {
            mode: out.sectionFilter.mode === 'allow' ? 'allow' : 'deny',
            names: Array.isArray(out.sectionFilter.names) ? out.sectionFilter.names : [],
        };
    }
    if (out.skills) {
        out.skills = {
            mode: out.skills.mode === 'allow' ? 'allow' : 'deny',
            names: Array.isArray(out.skills.names) ? out.skills.names : [],
        };
    }
    return out;
}

/**
 * 保存场景时把「以后新装的工具默认停用」这条规矩**落成实际名单**。
 *
 * 为什么要在保存时落成名单、而不是每次解析时现算：
 * 基线会在每次保存时刷新。只靠「不在基线里就停用」的话，用户保存一次，
 * 那个新工具就进了基线 —— 下一次解析时它又变成「老工具」、悄悄恢复激活。
 * 保存时把它写进 deny 名单，基线怎么刷新都不影响结论。
 *
 * @param {{mode?: string, names?: string[], newToolsActive?: boolean, baseline?: string[]}} filter 界面交上来的名单
 * @param {string[]} catalogNames 当前目录里所有工具名（全量，不受任何场景影响）
 */
export function settleToolFilter(filter, catalogNames) {
    if (!filter || typeof filter !== 'object') {
        return filter;
    }
    const mode = filter.mode === 'allow' ? 'allow' : 'deny';
    const names = Array.isArray(filter.names) ? filter.names.filter((x) => typeof x === 'string') : [];
    const baseline = Array.isArray(filter.baseline)
        ? filter.baseline.filter((x) => typeof x === 'string')
        : [];
    const known = Array.isArray(catalogNames) ? catalogNames.filter((x) => typeof x === 'string') : [];
    const newToolsActive = filter.newToolsActive !== false;
    if (mode !== 'deny' || newToolsActive) {
        return { mode, names, newToolsActive, baseline: known };
    }
    // deny + 新工具不默认激活：把「基线里没有、又没被显式写过」的那些补进名单。
    // 没有基线 = 这套场景还没按新规矩存过：当前这批工具一律算「老的」，
    // 一个都不停用 —— 否则用户第一次关这个开关就会被整屏停用，那是灾难。
    const old = new Set(baseline.length > 0 ? baseline : known);
    const denied = new Set(names);
    for (const name of known) {
        if (!old.has(name)) {
            denied.add(name);
        }
    }
    return { mode, names: [...denied], newToolsActive, baseline: known };
}

export async function listScenes() {
    const dir = hubPath(SCENES_DIR);
    let entries = [];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
            continue;
        }
        const raw = await readJson(join(dir, entry.name));
        if (raw && typeof raw.id === 'string') {
            out.push(normalizeScene(raw));
        }
    }
    out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    return out;
}

export async function readScene(id) {
    if (!isValidId(id)) {
        return undefined;
    }
    const raw = await readJson(hubPath(SCENES_DIR, `${id}.json`));
    return raw ? normalizeScene(raw) : undefined;
}

export async function saveScene(input) {
    const name = String(input?.name ?? '').trim();
    if (!name) {
        throw new Error('预设需要一个名字');
    }
    const id = isValidId(input?.id) ? input.id : newId();
    const record = normalizeScene({
        id,
        name,
        description: input?.description,
        persona: input?.persona,
        tools: input?.tools,
        toolFilter: input?.toolFilter,
        sectionFilter: input?.sectionFilter,
        skills: input?.skills,
        permission: input?.permission,
        updatedAt: new Date().toISOString(),
    });
    await writeAtomic(hubPath(SCENES_DIR, `${id}.json`), JSON.stringify(record, null, 2));
    return record;
}

export async function deleteScene(id) {
    if (!isValidId(id)) {
        return false;
    }
    await rm(hubPath(SCENES_DIR, `${id}.json`), { force: true });
    return true;
}

/** 一次性把两张表读成 id → 记录 的映射（解析时要用）。 */
export async function loadLibrary() {
    const [personas, scenes] = await Promise.all([listPersonas(), listScenes()]);
    const personasById = {};
    for (const p of personas) {
        // 必须带上正文：角色卡正文在 .md 里，列表只给 meta。少了正文，
        // 注入模型的那条消息就是空的（界面上看着有卡，模型那边一个字收不到）。
        const full = await readPersona(p.id);
        if (full) {
            personasById[p.id] = full;
        }
    }
    const scenesById = {};
    for (const s of scenes) {
        scenesById[s.id] = s;
    }
    return { personasById, scenesById };
}
