// 技能市场：直接接 SkillHub（https://skillhub.cn）的公开接口。
//
// 底座事实（都用 curl 实打实核过）：
// - 列表：`GET https://api.skillhub.cn/api/skills?page=1&pageSize=20&keyword=&category=&sortBy=&order=`
//   → `{code:0, data:{skills:[…], total}}`，**不需要登录**。
//   每个条目里我们用的字段：slug / name / description / description_zh / category /
//   downloads / installs / stars / score / namespace / iconUrl / labels / ownerName / source。
// - 分类：`GET https://api.skillhub.cn/api/v1/categories` → `{count, items:[{key,name,nameEn,…}]}`。
// - 下载：`GET https://api.skillhub.cn/api/v1/download?slug=<slug>` → 302 到 COS 上的 zip；
//   zip 里就是技能目录的内容（`SKILL.md` + 可选 `scripts/`、`_meta.json`）。
//
// 所以「安装」= 下 zip + 解开到 `$DSH_HOME/skills/<slug>/`。宿主 chokidar 监视这个目录，
// 写完约 200ms 广播 `skills/change`，技能页自己就会多出一条，不用重启。
//
// 解压不装第三方依赖：自己读 zip 的中央目录（stored / deflate 两种都支持），
// 并挡掉绝对路径与 `..`（zip slip）。
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MARKET_BASE = 'https://api.skillhub.cn';
export const MARKET_HOME = 'https://skillhub.cn';

const TIMEOUT_MS = 15000;

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** slug 只允许安全字符，别让它跑出 skills 目录。 */
function safeSlug(slug) {
    const value = String(slug ?? '').trim();
    if (!value || !SAFE_NAME.test(value)) {
        const error = new Error(`技能 slug 不安全：${value || '（空）'}`);
        error.code = 'bad-request';
        throw error;
    }
    return value;
}

function badRequest(message) {
    const error = new Error(message);
    error.code = 'bad-request';
    return error;
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`SkillHub 接口返回 ${response.status}`);
    }
    const body = await response.json();
    if (body && typeof body.code === 'number' && body.code !== 0) {
        throw new Error(`SkillHub 接口返回错误：${body.message ?? body.code}`);
    }
    return body;
}

/**
 * 可以往下传的排序字段。
 * `score` 是上游给的相关度分：带 keyword 时它按这次查询算，同一个技能换个关键词分值就变；
 * 不带 keyword 时它是全局评分。其余几个是装机量、下载量、收藏数。
 */
const SORT_FIELDS = new Set(['score', 'installs', 'downloads', 'stars']);

/** 市场列表。 */
export async function listMarket(options = {}) {
    const page = Math.max(1, Number(options.page ?? 1) || 1);
    const pageSize = Math.min(60, Math.max(1, Number(options.pageSize ?? 20) || 20));
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    const keyword = String(options.keyword ?? '').trim();
    if (keyword) params.set('keyword', keyword);
    const category = String(options.category ?? '').trim();
    if (category) params.set('category', category);
    const sortKey = String(options.sortBy ?? '').trim();
    // 白名单之外的排序字段不往下传 —— 上游遇到不认识的会当成没排序，
    // 悄悄给回一份热门榜，看起来就像筛选没生效。
    if (SORT_FIELDS.has(sortKey)) params.set('sortBy', sortKey);
    const order = String(options.order ?? '').trim().toLowerCase();
    if (SORT_FIELDS.has(sortKey) && (order === 'asc' || order === 'desc')) params.set('order', order);

    const body = await fetchJson(`${MARKET_BASE}/api/skills?${params.toString()}`);
    const raw = body?.data?.skills ?? [];
    const skills = raw.map((item) => ({
        slug: String(item.slug ?? ''),
        name: String(item.name ?? item.slug ?? ''),
        description: String(item.description_zh || item.description || ''),
        descriptionEn: String(item.description || ''),
        category: String(item.category ?? ''),
        subCategories: Array.isArray(item.subCategories)
            ? item.subCategories.map((sub) => String(sub?.name ?? sub?.key ?? '')).filter(Boolean)
            : [],
        downloads: Number(item.downloads ?? 0) || 0,
        installs: Number(item.installs ?? 0) || 0,
        stars: Number(item.stars ?? 0) || 0,
        // 上游的相关度分：带 keyword 时按这次查询算，同一个技能换个关键词分值会变；
        // 不带 keyword 时是全局评分。`sortBy=score` 就是按它排。
        score: Number(item.score ?? 0) || 0,
        owner: String(item.ownerName ?? item.namespace?.displayName ?? ''),
        canonicalName: String(item.namespace?.canonicalName ?? ''),
        icon: String(item.iconUrl ?? ''),
        homepage: String(item.homepage ?? ''),
        labels: item.labels && typeof item.labels === 'object' ? item.labels : {},
        source: String(item.source ?? ''),
    })).filter((item) => item.slug !== '');

    return { page, pageSize, total: Number(body?.data?.total ?? 0) || 0, skills };
}

/**
 * 一个技能的详情（弹窗用）。
 *
 * `GET https://api.skillhub.cn/api/v1/skills/<slug>` 会把东西包在 `skill` 里，
 * 顶上还有 `securityReports`（腾讯几个安全扫描的口径）与 `latestVersion`。
 */
export async function skillDetail(slug) {
    const safe = safeSlug(slug);
    const body = await fetchJson(`${MARKET_BASE}/api/v1/skills/${encodeURIComponent(safe)}`);
    const skill = body?.skill ?? {};
    const stats = skill.stats ?? {};
    const reports = body?.securityReports && typeof body.securityReports === 'object'
        ? Object.entries(body.securityReports).map(([key, value]) => ({
            key,
            status: String(value?.status ?? ''),
            statusText: String(value?.statusText ?? ''),
            reportUrl: String(value?.reportUrl ?? ''),
        }))
        : [];
    return {
        slug: String(skill.slug ?? safe),
        name: String(skill.displayName ?? safe),
        summary: String(skill.summary_zh || skill.summary || ''),
        summaryEn: String(skill.summary || ''),
        overview: String(skill.overviewMd ?? ''),
        category: String(skill.category ?? ''),
        subCategories: Array.isArray(skill.subCategories)
            ? skill.subCategories.map((sub) => String(sub?.name ?? sub?.key ?? '')).filter(Boolean)
            : [],
        labels: skill.labels && typeof skill.labels === 'object' ? skill.labels : {},
        icon: String(skill.iconUrl ?? ''),
        source: String(skill.source ?? ''),
        sourceUrl: String(skill.sourceUrl || skill.upstream_url || ''),
        owner: String(body?.owner?.displayName ?? body?.owner?.handle ?? skill.upstream_owner_login ?? ''),
        canonicalName: String(body?.namespace?.canonicalName ?? ''),
        downloads: Number(stats.downloads ?? 0) || 0,
        installs: Number(stats.installs ?? 0) || 0,
        stars: Number(stats.stars ?? 0) || 0,
        versions: Number(stats.versions ?? 0) || 0,
        version: String(body?.latestVersion?.version ?? ''),
        updatedAt: Number(skill.updatedAt ?? 0) || 0,
        security: reports,
    };
}

/** 分类（市场筛选栏用）。 */
export async function listCategories() {
    const body = await fetchJson(`${MARKET_BASE}/api/v1/categories`);
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.map((item) => ({
        key: String(item.key ?? ''),
        name: String(item.name ?? item.key ?? ''),
        sortOrder: Number(item.sortOrder ?? 0) || 0,
    })).filter((item) => item.key !== '').sort((a, b) => a.sortOrder - b.sortOrder);
}

// ——————————————————— zip ———————————————————

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** 从 zip buffer 里读出 [{name, data}]（只支持 stored / deflate，够用了）。 */
export function unzip(buffer) {
    let eocd = -1;
    const stop = Math.max(0, buffer.length - 65557);
    for (let i = buffer.length - 22; i >= stop; i -= 1) {
        if (buffer.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw badRequest('这个 zip 读不出来（找不到目录尾）');
    }
    const count = buffer.readUInt16LE(eocd + 10);
    const cenOffset = buffer.readUInt32LE(eocd + 16);
    const files = [];
    let cursor = cenOffset;
    for (let index = 0; index < count; index += 1) {
        if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CEN_SIG) {
            break;
        }
        const method = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
        cursor += 46 + nameLength + extraLength + commentLength;
        if (name.endsWith('/')) {
            continue;
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(dataStart, dataStart + compressedSize);
        let data;
        if (method === 0) {
            data = Buffer.from(raw);
        }
        else if (method === 8) {
            data = inflateRawSync(raw);
        }
        else {
            throw badRequest(`这个 zip 用了不支持的压缩方式（${method}）`);
        }
        files.push({ name, data });
    }
    return files;
}

/** 解出来的路径必须在目标目录里（挡掉绝对路径和 ..）。 */
function safeRelative(name) {
    const normalized = posix.normalize(String(name).replace(/\\/g, '/'));
    if (!normalized || normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('\0')) {
        throw badRequest(`zip 里有不安全的路径：${name}`);
    }
    return normalized;
}

/** 把 zip 解开到 dir；返回写进去的相对路径。 */
export async function extractTo(buffer, dir) {
    const files = unzip(buffer);
    if (files.length === 0) {
        throw badRequest('这个 zip 是空的');
    }
    const written = [];
    for (const file of files) {
        const relative = safeRelative(file.name);
        const target = join(dir, relative);
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, file.data);
        written.push(relative);
    }
    return written;
}

/** SKILL.md 的 frontmatter：只认顶层的 `key: value`（够读 name / description）。 */
export function parseFrontmatter(text) {
    const raw = String(text ?? '');
    if (!raw.startsWith('---')) return {};
    const end = raw.indexOf('\n---', 3);
    if (end < 0) return {};
    const body = raw.slice(3, end).split(/\r?\n/);
    const out = {};
    let lastKey = '';
    for (const line of body) {
        if (!line.trim()) continue;
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (match) {
            lastKey = match[1];
            out[lastKey] = match[2].trim().replace(/^['"]|['"]$/g, '');
            continue;
        }
        // 缩进续行（description: > 这种多行写法）
        if (lastKey && /^\s+\S/.test(line)) {
            out[lastKey] = `${out[lastKey]} ${line.trim()}`.trim();
        }
    }
    return out;
}

/**
 * 装一个技能：下 zip → 解开到 `<技能根目录>/<slug>/`。
 *
 * 技能根目录必须是宿主真正会去读的那种目录（见 dsh-skill-filesystem 的 `roots()`）：
 *   · 用户级 `$DSH_HOME/skills`
 *   · 项目级 `<projectRoot>/.dsh/skills`
 * 传 `home` 时按 `$DSH_HOME/skills` 算；传 `skillsRoot` 时直接用那个目录。
 *
 * @param {{ home?: string, skillsRoot?: string, slug: string, overwrite?: boolean, version?: string }} options
 */
/**
 * 宿主只认 kebab-case 的技能名（`dsh-skill` 里的 `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`），
 * 市场里很多技能把 `name:` 写成展示名（`Word / DOCX`、`Poetry Daily Art`），
 * 这种会被宿主静默丢掉（`skill file ... ignored: invalid skill name`）——页面上就是「装了但不显示」。
 * 所以装完先把它揉成合法名字。
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function kebabName(input) {
    const text = String(input ?? '').trim().toLowerCase();
    const out = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return out || '';
}

/**
 * 把 SKILL.md 的 frontmatter 揉成宿主认的样子。
 * 返回 `{ text, changed, from }`：`changed` 为 true 时 `from` 是原来的 name。
 */
export function normalizeSkillName(text, fallback) {
    const source = String(text ?? '');
    const target = kebabName(fallback) || 'skill';
    const lines = source.split('\n');
    if (lines[0]?.trim() !== '---') {
        return {
            text: `---\nname: ${target}\n---\n\n${source}`.replace(/\n{3,}$/, '\n'),
            changed: true,
            from: '',
        };
    }
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end < 0) {
        return {
            text: `---\nname: ${target}\n---\n\n${source}`.replace(/\n{3,}$/, '\n'),
            changed: true,
            from: '',
        };
    }
    const head = lines.slice(1, end);
    const body = lines.slice(end);
    const nameIndex = head.findIndex((line) => /^name\s*:/.test(line));
    let from = '';
    let next;
    if (nameIndex < 0) {
        next = [`name: ${target}`, ...head];
        from = '';
    }
    else {
        const raw = head[nameIndex].replace(/^name\s*:\s*/, '').trim().replace(/^["']|["']$/g, '');
        from = raw;
        if (SKILL_NAME_RE.test(raw)) {
            return { text: source, changed: false, from: raw };
        }
        next = head.map((line, index) => (index === nameIndex ? `name: ${target}` : line));
    }
    // 展示名别丢：没 title: 的话补一条，方便人看
    if (!next.some((line) => /^title\s*:/.test(line)) && from) {
        const at = next.findIndex((line) => /^name\s*:/.test(line));
        next = [...next.slice(0, at + 1), `title: ${JSON.stringify(from)}`, ...next.slice(at + 1)];
    }
    return { text: ['---', ...next, ...body].join('\n'), changed: true, from };
}

export async function installSkill(options) {
    const explicitRoot = String(options?.skillsRoot ?? '').trim();
    const home = String(options?.home ?? '').trim();
    const skillsRoot = explicitRoot || (home ? join(home, 'skills') : '');
    if (!skillsRoot) {
        throw badRequest('不知道装到哪个技能目录，装不了');
    }
    const slug = safeSlug(options?.slug);
    const dir = join(skillsRoot, slug);
    if (existsSync(dir) && options?.overwrite !== true) {
        throw badRequest(`已经装过一个叫「${slug}」的技能了（目录 ${dir}）。要覆盖就勾上覆盖。`);
    }

    const params = new URLSearchParams();
    params.set('slug', slug);
    if (options?.version) params.set('version', String(options.version));
    const response = await fetch(`${MARKET_BASE}/api/v1/download?${params.toString()}`, {
        headers: { accept: '*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
        throw new Error(`下载失败：HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error('下载下来是空的');
    }

    await mkdir(dir, { recursive: true });
    let written;
    try {
        written = await extractTo(buffer, dir);
    }
    catch (e) {
        // 解到一半失败：把半成品清掉，别留一个坏技能在那儿。
        await rm(dir, { recursive: true, force: true });
        throw e;
    }

    let meta = {};
    const metaPath = join(dir, '_meta.json');
    if (existsSync(metaPath)) {
        try {
            meta = JSON.parse(await readFile(metaPath, 'utf8'));
        }
        catch {
            meta = {};
        }
    }
    // 真正的名字/描述写在这个技能的 SKILL.md frontmatter 里，_meta.json 只有版本信息。
    const skillMd = written.find((name) => name === 'SKILL.md' || name.endsWith('/SKILL.md'));
    let front = {};
    if (skillMd) {
        try {
            front = parseFrontmatter(await readFile(join(dir, skillMd), 'utf8'));
        }
        catch {
            front = {};
        }
    }
    const hasSkillMd = skillMd !== undefined;
    let renamedFrom = '';
    if (skillMd) {
        const filePath = join(dir, skillMd);
        try {
            const original = await readFile(filePath, 'utf8');
            const fixed = normalizeSkillName(original, slug);
            if (fixed.changed) {
                renamedFrom = fixed.from;
                await writeFile(filePath, fixed.text, 'utf8');
                front = parseFrontmatter(fixed.text);
            }
        }
        catch {
            // 改不动就算了，下面照旧返回，宿主那边自己会忽略并留日志
        }
    }
    const entries = await readdir(dir).catch(() => []);
    return {
        slug,
        name: String(front.name ?? meta?.name ?? slug),
        skillsRoot,
        description: String(front.description ?? ''),
        version: String(meta?.version ?? ''),
        dir,
        files: written,
        entries,
        hasSkillMd,
        renamedFrom,
    };
}
