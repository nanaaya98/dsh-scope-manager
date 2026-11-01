// 把「系统提示词段落」和「工具组」对上号。
//
// 为什么需要：宿主给 `assembly.sections` 的每条只有 `{name, text}`，没有归属；
// 工具那边反而是有归属的（扫包认出来的 owner）。用户要的是「在工具的分组旁边
// 看到这一组自己的系统提示词段落」——所以要靠下面两条线索把两边接上：
//
//   ① 段落名带工具前缀：`tool:bash` → 工具 `bash` → 它所在的那个组。
//      这是最准的一条：名字是插件自己起的，跟工具名一字不差。
//   ② 段落的来源插件（扫源码反查出来的 `plugin` 字段）：`@deepseek-ai/dsh-tool-bash`
//      → 包名 `dsh-tool-bash` → 工具组 owner 也是它。
//      名字不是工具前缀的段落靠这条接上（表情包的 `dsh-expression:companion`
//      归 `dsh-meme`，genui 的 `genui:fence` 归 `dsh-genui`）。
//
//   ③ 只有段落、没有工具的插件：`dsh-kaomoji` 一个工具都不注册，却往提示词里
//      注入 `dsh-kaomoji:guidance`。它天生就不会出现在工具分组里，① ② 也就都接不上。
//      这种「来源插件认得、工具组没有」的段落直接给它的插件包**补一个空工具组** ——
//      否则它只能掉进「未归组」，用户找不到它的归属。
//      补出来的组按包判大类：宿主自带的（`@deepseek-ai/*`）算**系统工具**，
//      第三方的（dsh-kaomoji、@changfenhuang/dsh-genui…）才算**插件工具**。
//
//      宿主自带的纯段落包同样补组，算**系统工具**：它们的段落（Web GUI 的使用语义、
//      文件引用策略…）有明确的来源包，就挂到那个包名下、界面上标着来自哪个官方包，
//      而不是丢进「未归组」让人猜。人设那三段（世界观 / 角色设定 / 收尾口径）
//      归「角色卡」管、永远注入，插件页不重复列。
//
// 三条都接不上（比如 `tool:subagent` 这种没扫到来源、名字又对不上工具的段落）才落到「未归组」，
// 由界面单独列出来 —— 不能因为接不上就让人找不到它。

import { CATEGORY_PLUGIN, CATEGORY_SYSTEM, CATEGORY_LABELS, isOfficialPlugin } from './tool-owner.js';
import { isAlwaysOnSection } from './always-on.js';

/** `@deepseek-ai/dsh-tool-bash` → `dsh-tool-bash`；`dsh-meme` → `dsh-meme`。 */
export function packageBaseName(plugin) {
    const raw = String(plugin ?? '').trim();
    if (!raw) {
        return '';
    }
    const idx = raw.lastIndexOf('/');
    return idx >= 0 ? raw.slice(idx + 1) : raw;
}

/**
 * 这段提示词默认归谁（= 默认关联的「插件」基名）。
 *
 * 三种来源：
 *   ① 反查到的来源插件包名（最准）；
 *   ② `mcp:<server>` —— MCP 服务器自己推的目录段，归属就是那台服务器；
 *   ③ `tool:<工具名>` —— 归属看工具本身，这里给空串（由工具名那条线索接）。
 */
export function sectionOwnerBase(section) {
    const base = packageBaseName(section?.plugin);
    if (base) {
        return base;
    }
    const name = String(section?.name ?? '');
    if (name.startsWith('mcp:')) {
        return name.slice('mcp:'.length).trim();
    }
    return '';
}

/** 组的 owner 也可能是带作用域的（`@dsh-custom/dsh-browser-desktop`），比的是包名。 */
function ownerBaseName(owner) {
    return packageBaseName(owner);
}

/**
 * @param {Array<{category:string, owner:string, tools:Array<{name:string}>}>} groups 工具分组
 * @param {Array<{name:string, owner?:string, plugin?:string|null}>} sections 段落清单
 * @returns {{ byGroup: Map<string, Array<object>>, ungrouped: Array<object>, sectionOnlyGroups: Array<object> }}
 *   `sectionOnlyGroups` 是「只注入段落、不注册工具」的插件补出来的空工具组，
 *   调用方要把它们并进分组列表（否则这些段落只挂在 byGroup 的 key 上、界面看不到组）。
 *   宿主自带（`@deepseek-ai/*`）的纯段落包同样补组，算**系统工具**：
 *   它们的来源包是明确的，就挂在那个包名下；人设那三段归「角色卡」管，不进这里。
 *   只有既认不出来源、又接不上工具的段落才落进 `ungrouped`。
 */
export function associateSections(groups, sections, owners) {
    /**
     * 人点出来的归属（`sectionOwners`）：段落名 → 归属包名。
     * 有它的段落**优先**按它归组 —— 宿主不给归属，反查源码又猜不出来的时候，
     * 这是唯一能把「未归组」的段落挂到某个插件名下的办法。
     */
    const pinned = owners instanceof Map ? owners : new Map(Object.entries(owners ?? {}));
    /** 工具名 → 组 key。 */
    const byToolName = new Map();
    /** 包名 → 组 key。 */
    const byPackage = new Map();
    for (const group of groups ?? []) {
        const key = `${group.category}::${group.owner}`;
        for (const tool of group.tools ?? []) {
            const name = String(tool?.name ?? '');
            if (name && !byToolName.has(name)) {
                byToolName.set(name, key);
            }
        }
        const base = ownerBaseName(group.owner);
        if (base && !byPackage.has(base)) {
            byPackage.set(base, key);
        }
    }

    const byGroup = new Map();
    const ungrouped = [];
    // 只注入段落、不注册工具的插件：给它补一个空工具组（tools: []）。
    const sectionOnly = new Map();
    for (const section of sections ?? []) {
        const name = String(section?.name ?? '');
        if (!name) {
            continue;
        }
        let key = '';
        // ⓪ 人点过的归属优先：哪怕是宿主自带的包、哪怕它一个工具都没注册，也照点照归。
        const pinnedOwner = String(pinned.get(name) ?? '').trim();
        if (pinnedOwner) {
            const base = packageBaseName(pinnedOwner);
            key = byPackage.get(base) ?? '';
            if (!key) {
                const category = isOfficialPlugin(pinnedOwner) ? CATEGORY_SYSTEM : CATEGORY_PLUGIN;
                key = `${category}::${pinnedOwner}`;
                if (!sectionOnly.has(key)) {
                    sectionOnly.set(key, {
                        category,
                        categoryLabel: CATEGORY_LABELS[category] ?? category,
                        owner: pinnedOwner,
                        overridden: false,
                        sectionOnly: true,
                        pinnedOwner: true,
                        tools: [],
                    });
                }
            }
        }
        // ① 工具名前缀：`tool:bash` → 工具 `bash`
        if (!key && name.startsWith('tool:')) {
            const toolName = name.slice('tool:'.length).trim();
            key = byToolName.get(toolName) ?? '';
        }
        // ② 来源插件包名（`mcp:<server>` 这种没有插件的，按服务器名接 MCP 组）
        if (!key) {
            const base = sectionOwnerBase(section);
            if (base) {
                key = byPackage.get(base) ?? '';
            }
        }
        // ③ 认得来源插件，但那个包没有任何工具（如 dsh-kaomoji）→ 补一个只带段落的组。
        //    宿主自带的纯段落包（Web GUI 的使用语义、文件引用策略…）也补组，
        //    算**系统工具**：它们的来源包是明确的，就挂在那个包名下，界面上标出来源。
        //    人设那几段（世界观 / 角色设定 / 收尾口径）归「角色卡」管、永远注入，不重复露头。
        if (!key) {
            const owner = String(section?.plugin ?? '').trim();
            if (owner) {
                if (isOfficialPlugin(owner) && isAlwaysOnSection(name)) {
                    continue;
                }
                const category = isOfficialPlugin(owner) ? CATEGORY_SYSTEM : CATEGORY_PLUGIN;
                key = `${category}::${owner}`;
                if (!sectionOnly.has(key)) {
                    sectionOnly.set(key, {
                        category,
                        categoryLabel: CATEGORY_LABELS[category] ?? category,
                        owner,
                        overridden: false,
                        // 界面靠这个标记显示「仅提示词」，不显示成 0 个工具的空组
                        sectionOnly: true,
                        tools: [],
                    });
                }
            }
        }
        if (!key) {
            ungrouped.push(section);
            continue;
        }
        const list = byGroup.get(key) ?? [];
        list.push(section);
        byGroup.set(key, list);
    }
    return { byGroup, ungrouped, sectionOnlyGroups: [...sectionOnly.values()] };
}
