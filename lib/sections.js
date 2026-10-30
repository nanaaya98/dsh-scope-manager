// 系统提示词段落的「目录」。
//
// 为什么需要它：`assembly.sections` 里的每一条只有 `{ name, text }`，**没有归属信息**
// —— 宿主不告诉你是谁 push 进来的。所以只能「看到一次就记下来」，攒出一份清单，
// 让用户按名字勾选。名字是唯一的稳定标识（插件自己起的，比如表情包用
// `dsh-expression:companion`）。
//
// 目录落盘是为了「还没发生过装配时界面也有东西可列」——冷启动、刚装插件的场景。
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { hubPath } from './paths.js';
import { tokensInText } from './prompt-vars.js';
import { packageBaseName } from './section-map.js';

// 来源反查算法的版本号（与 lib/section-source.js 的 SOURCE_SCAN_VERSION 对应）。
// 改了打分规则就 +1：老条目会被当成「没查过」，重扫一遍纠正归属。
const SOURCE_SCAN_VERSION = 2;

const MAX_SNIPPET = 160;
// 原文整段留着：编辑时要看到全文，不能只有开头。上限防止个别插件塞超大文本把目录撑爆。
const MAX_TEXT = 32 * 1024;

/** `dsh-expression:companion` → `dsh-expression`；没有冒号就用整个名字。 */
function ownerHintOf(name) {
    const raw = String(name ?? '');
    const idx = raw.indexOf(':');
    return idx > 0 ? raw.slice(0, idx) : raw;
}

function normalize(entry) {
    const override = typeof entry?.override === 'string' && entry.override !== '' ? entry.override : null;
    return {
        name: String(entry?.name ?? ''),
        owner: String(entry?.owner ?? '') || ownerHintOf(entry?.name),
        snippet: String(entry?.snippet ?? '').slice(0, MAX_SNIPPET),
        text: typeof entry?.text === 'string' ? entry.text.slice(0, MAX_TEXT) : '',
        lastSeen: Number(entry?.lastSeen) || null,
        seenAt: Number(entry?.seenAt) || null,
        // 来源：扫源码反查出来的（插件名 / 文件 / 行号）。查不到就是 null。
        plugin: typeof entry?.plugin === 'string' && entry.plugin ? entry.plugin : null,
        file: typeof entry?.file === 'string' && entry.file ? entry.file : null,
        line: Number(entry?.line) || null,
        source: typeof entry?.source === 'string' && entry.source ? entry.source : null,
        // 覆写：不写回插件文件，装配时把这段文字换掉。
        override,
        // 覆写要不要真的注入：false = 改写留着但不生效（装配时用原文）。
        // 这是「这种改写是否应用」的开关，全局一份，与作用域无关。
        overrideInjected: entry?.overrideInjected !== false,
        // 这一段跟哪些工具绑定：null = 默认关联「来源插件」（那个包下的所有工具都算了）。
        // 非空数组 = 只认这几个工具；它们一个都没启用（比如场景里关掉了）→ 这一段不注入。
        bindTools: Array.isArray(entry?.bindTools)
            ? entry.bindTools.filter((n) => typeof n === 'string' && n !== '')
            : null,
        // 宿主给这一段标了 `interpolate: false`：里面的 `{{...}}` 是字面量，不会被替换。
        literal: entry?.literal === true,
        // 上一次装配时的正文：跟这次不一样就说明这一段是**动态**的，
        // 界面会提醒「覆写会把它冻住，要用 {{original}} 才保得住」。
        prevText: typeof entry?.prevText === 'string' ? entry.prevText.slice(0, MAX_TEXT) : null,
        // 来源查过没有（查不到也算查过，避免每次装配都重扫一遍源码）。
        sourceChecked: entry?.sourceChecked === true,
        // 这份来源是用哪一版反查算法算出来的（null = 从没查过）。
        sourceVersion: Number(entry?.sourceVersion) || null,
        // 这一段在**上一轮装配里排第几**（从 1 开始，0 = 还没装配过）。
        // 宿主交出来的 assembly.sections 已经是排好序的：注册式段落按 order 排，
        // 瀑布里 `sections.push()` 的排在最后。所以这个数字就是「它在整份提示词里的位置」。
        position: Number(entry?.position) > 0 ? Number(entry.position) : null,
    };
}

export function createSectionCatalog(options = {}) {
    const file = options.file ?? hubPath('sections.json');
    /** @type {Map<string, {name: string, owner: string, snippet: string, lastSeen: number|null}>} */
    const byName = new Map();
    /** 最近一次 recordSections 的时间戳；跟着目录一起落盘，重启后仍能判断「上次装配里有没有」。 */
    let lastRunAt = 0;
    let lastPersistedRunAt = 0;
    /** 最近一次装配里宿主认识的提示词变量：{ list: {name: value}, capturedAt }。 */
    let variableSnapshot = { list: {}, capturedAt: 0 };
    /**
     * 插件卸载时从目录里删掉的段落，用户的覆写文字先存这儿。
     * 插件装回来时（`record()` 再见到同名段落）自动还回去 —— 免得「卸载一次，
     * 我改的那段提示词就白改了」。
     * @type {Record<string, string>}
     */
    const removedOverrides = {};

    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        lastRunAt = Number(raw?.lastRunAt) || 0;
        lastPersistedRunAt = lastRunAt;
        const vars = raw?.variables;
        if (vars && typeof vars.list === 'object' && vars.list !== null) {
            variableSnapshot = { list: { ...vars.list }, capturedAt: Number(vars.capturedAt) || 0 };
        }
        const lost = raw?.removedOverrides;
        if (lost && typeof lost === 'object') {
            for (const [name, text] of Object.entries(lost)) {
                if (typeof text === 'string' && text !== '') {
                    removedOverrides[name] = text;
                }
            }
        }
        const list = Array.isArray(raw?.sections) ? raw.sections : [];
        for (const entry of list) {
            const item = normalize(entry);
            if (item.name) {
                byName.set(item.name, item);
            }
        }
    }
    catch {
        /* 没有目录文件 / 文件坏了都从空开始：它只是缓存，不是真相。 */
    }

    let saveTimer = null;

    function save() {
        saveTimer = null;
        const payload = {
            version: 1,
            lastRunAt,
            variables: variableSnapshot,
            sections: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
            removedOverrides,
        };
        try {
            mkdirSync(dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
            writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            renameSync(tmp, file);
        }
        catch {
            try {
                unlinkSync(`${file}.${process.pid}.tmp`);
            }
            catch {
                /* 忽略 */
            }
        }
    }

    function scheduleSave() {
        if (saveTimer) {
            return;
        }
        saveTimer = setTimeout(save, 500);
        if (typeof saveTimer.unref === 'function') {
            saveTimer.unref();
        }
    }

    /** 装配时把看到的段落记下来（过滤之前的样子，用户才能知道漏了什么）。 */
    function record(list) {
        if (!Array.isArray(list)) {
            return;
        }
        let changed = false;
        const now = Date.now();
        // 本轮装配的时间戳：list() 拿它判断「这一段这次还在不在」。
        // 只放内存，不落盘 —— 重启后第一次装配之前，所有段落都算「未知」。
        lastRunAt = now;
        // lastRunAt 要落盘（重启后才知道「上次装配里有哪些」），但不必每轮都写：
        // 五分钟内已经写过就只在内存里推进。
        if (now - lastPersistedRunAt > 5 * 60 * 1000) {
            lastPersistedRunAt = now;
            changed = true;
        }
        for (const [index, section] of list.entries()) {
            const name = String(section?.name ?? '');
            if (!name) {
                continue;
            }
            // 宿主交出来的数组已经是最终顺序，下标 + 1 就是「第几段」。
            const position = index + 1;
            const text = typeof section?.text === 'string' ? section.text : '';
            const snippet = text.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
            const prev = byName.get(name);
            if (!prev) {
                // 插件装回来时，把卸载前存下来的覆写文字还回去。
                const restored = removedOverrides[name];
                if (typeof restored === 'string' && restored !== '') {
                    delete removedOverrides[name];
                }
                byName.set(name, {
                    name, owner: ownerHintOf(name), snippet, lastSeen: now, seenAt: now,
                    text: text.slice(0, MAX_TEXT),
                    plugin: null, file: null, line: null, source: null,
                    override: typeof restored === 'string' && restored !== '' ? restored : null,
                    literal: section?.interpolate === false,
                    sourceChecked: false, sourceVersion: null,
                    position,
                });
                changed = true;
            }
            else {
                // 正文可能变（插件更新、模板渲染变量），跟着更新；
                // snippet 只是列表里的摘要，正文才是编辑时看到的那份。
                // lastSeen / seenAt 每次都刷：前者是「多久没见过」，后者给 list() 判断
                // 「上一次装配里还在不在」。它们变了不算需要落盘的变化。
                prev.lastSeen = now;
                prev.seenAt = now;
                if (prev.position !== position) {
                    // 顺序变了（插件装卸、别的插件改了 order），界面要跟着报新位置。
                    prev.position = position;
                    changed = true;
                }
                const full = text.slice(0, MAX_TEXT);
                if (prev.text !== full) {
                    // 留一份旧正文：两次不一样就说明这一段的内容是现算的。
                    prev.prevText = prev.text;
                    prev.text = full;
                    changed = true;
                }
                if (prev.snippet !== snippet) {
                    prev.snippet = snippet;
                    changed = true;
                }
                const literal = section?.interpolate === false;
                if (prev.literal !== literal) {
                    prev.literal = literal;
                    changed = true;
                }
            }
        }
        if (changed) {
            scheduleSave();
        }
    }

    /**
     * 清掉「上一次装配里没出现、也没有覆写」的条目。
     *
     * 保守在这里：带覆写的宁可留着 —— 条目删了覆写就成了孤儿，插件装回来时
     * 用户改过的文字就白白丢了。而按需注入的段落被清掉也没关系，下次它出现
     * 会被重新记进来。
     */
    function prune() {
        if (lastRunAt <= 0) {
            return { removed: [], kept: [...byName.keys()], reason: 'no-run' };
        }
        const removed = [];
        const kept = [];
        for (const [name, entry] of byName) {
            const staleNow = entry.seenAt !== lastRunAt;
            if (staleNow && !(typeof entry.override === 'string' && entry.override !== '')) {
                removed.push(name);
            }
            else {
                kept.push(name);
            }
        }
        if (removed.length > 0) {
            for (const name of removed) {
                byName.delete(name);
            }
            save();
        }
        return { removed, kept };
    }

    function list() {
        return [...byName.values()]
            .map((entry) => ({
                ...entry,
                // 这一段原文里自己用到哪些占位符：编辑它时直接列出来，用户照抄就能用。
                textVars: tokensInText(entry.text),
                // 正文会变 = 动态段落。真到装配时用 `{{original}}` 引用它，别整段覆写。
                dynamic: typeof entry.prevText === 'string' && entry.prevText !== entry.text,
                // 上一次装配里没出现：可能是按需注入（工具没开、条件不满足），
                // 也可能是插件卸载了。界面上标出来，但不禁用 —— 下次装配可能又回来。
                stale: lastRunAt > 0 && entry.seenAt !== lastRunAt,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** 还没查过来源的名字（新见到的段落）。 */
    function unresolved() {
        return [...byName.values()]
            .filter((e) => e.sourceChecked !== true || e.sourceVersion !== SOURCE_SCAN_VERSION)
            .map((e) => e.name);
    }

    /** 把反查结果写回去。查不到的也标记一次，避免每轮重复扫。 */
    function applySources(map) {
        let changed = false;
        const now = Date.now();
        for (const entry of byName.values()) {
            const hit = map.get(entry.name);
            if (hit) {
                if (entry.plugin !== hit.plugin || entry.file !== hit.file || entry.line !== hit.line) {
                    entry.plugin = hit.plugin ?? null;
                    entry.file = hit.file ?? null;
                    entry.line = hit.line ?? null;
                    entry.source = hit.source ?? null;
                    changed = true;
                }
            }
            if (entry.sourceVersion !== SOURCE_SCAN_VERSION) {
                entry.sourceVersion = SOURCE_SCAN_VERSION;
                changed = true;
            }
            entry.sourceChecked = true;
            void now;
        }
        if (changed) {
            scheduleSave();
        }
        return changed;
    }

    /** 设置/清除覆写。text 为空 → 清除。 */
    /** 覆写内容要不要注入（false = 留着改写但仍用原文）。 */
    function setOverrideInject(name, value) {
        const entry = byName.get(String(name ?? ''));
        if (!entry) {
            return false;
        }
        const next = value !== false;
        if (entry.overrideInjected === next) {
            return true;
        }
        entry.overrideInjected = next;
        save();
        return true;
    }

    function setOverride(name, text) {
        const entry = byName.get(String(name ?? ''));
        if (!entry) {
            return false;
        }
        const next = typeof text === 'string' && text !== '' ? text : null;
        if (entry.override === next) {
            return true;
        }
        entry.override = next;
        save();
        return true;
    }

    /** 装配时用：`Map<name, overrideText>`，只含真有覆写的。 */
    function overrides() {
        const map = new Map();
        for (const entry of byName.values()) {
            if (typeof entry.override === 'string' && entry.override !== ''
                && entry.overrideInjected !== false) {
                map.set(entry.name, entry.override);
            }
        }
        return map;
    }

    /** 设置段落跟哪些工具绑定。null / 空数组 → 回到「默认关联来源插件」。 */
    function setBind(name, tools) {
        const entry = byName.get(String(name ?? ''));
        if (!entry) {
            return false;
        }
        const next = Array.isArray(tools) && tools.length > 0
            ? [...new Set(tools.filter((n) => typeof n === 'string' && n !== ''))]
            : null;
        const prev = Array.isArray(entry.bindTools) ? entry.bindTools : null;
        const same = (prev === null && next === null)
            || (prev && next && prev.length === next.length && prev.every((x, i) => x === next[i]));
        if (same) {
            return true;
        }
        entry.bindTools = next;
        save();
        return true;
    }

    /** 装配时用：`Map<name, string[]>`，只含**显式**设过工具绑定的段落。 */
    function bindings() {
        const map = new Map();
        for (const entry of byName.values()) {
            if (Array.isArray(entry.bindTools) && entry.bindTools.length > 0) {
                map.set(entry.name, entry.bindTools);
            }
        }
        return map;
    }

    /**
     * 记一份「这次装配里宿主认识的变量」（名字 + 当时的取值）。
     *
     * 只能这样拿：宿主没有「列出已注册变量」的服务，`assembly.variables` 是
     * 唯一能看见它们的地方；而它只在装配时才有值。界面上给人看的提示、以及
     * 保存覆写时的校验，都以这份快照为准。
     */
    function noteVariables(vars) {
        if (!vars || typeof vars !== 'object') {
            return;
        }
        const next = {};
        for (const [name, value] of Object.entries(vars)) {
            if (typeof name !== 'string' || !name) {
                continue;
            }
            const text = value === undefined || value === null ? '' : String(value);
            next[name] = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        }
        const before = JSON.stringify(variableSnapshot.list);
        if (before === JSON.stringify(next)) {
            return;
        }
        variableSnapshot = { list: next, capturedAt: Date.now() };
        scheduleSave();
    }

    function variables() {
        return {
            list: Object.entries(variableSnapshot.list).map(([name, value]) => ({ name, value })),
            capturedAt: variableSnapshot.capturedAt,
        };
    }

    function forget(name) {
        if (byName.delete(String(name ?? ''))) {
            scheduleSave();
            return true;
        }
        return false;
    }

    /**
     * 忘掉某个包带来的所有段落（插件被卸载时用）。
     *
     * 为什么要有这一条：段落目录只增不减 —— `record()` 只更新本轮出现的，
     * 消失的段落要靠 `prune()` 清，而 prune 只在手动调用时才跑。
     * 插件卸载后，它注入过的段落就永远留在目录里；界面上「只注入段落、
     * 不注册工具」的插件会因此凭空多出一张空卡片（用户看到的幽灵插件）。
     *
     * 用户的覆写文字不丢：删条目时把 override 挪进 `removedOverrides`，
     * 插件装回来时 `record()` 会自动把它还回去。
     *
     * @param {string} ownerBase 包名基名（`dsh-browser-desktop`）
     * @returns {string[]} 被删掉的段落名
     */
    function forgetByOwner(ownerBase) {
        const base = packageBaseName(ownerBase);
        if (!base) {
            return [];
        }
        const removed = [];
        for (const [name, entry] of byName) {
            const owner = packageBaseName(entry?.plugin) || packageBaseName(entry?.owner);
            if (owner !== base) {
                continue;
            }
            if (typeof entry?.override === 'string' && entry.override !== '') {
                removedOverrides[name] = entry.override;
            }
            byName.delete(name);
            removed.push(name);
        }
        if (removed.length > 0) {
            scheduleSave();
        }
        return removed;
    }

    return {
        file, record, list, forget, forgetByOwner, prune, flush: save, unresolved, applySources,
        setOverride, setOverrideInject, setBind, bindings, overrides,
        noteVariables, variables,
    };
}
