// 「现在到底还装着哪些插件」——一个只认事实的清单。
//
// 为什么需要这一层：
// 插件页的卡片有两个来源 —— 宿主注册的工具组，以及「只注入提示词、不注册工具」的
// 段落归属（section-map.js 会给这种插件补一个空组）。后者的归属写死在落盘的
// 段落目录里：插件被卸载后，那条记录**还在**，于是页面照样显示一张卡片，
// 而包其实早就不在了。
//
// 所以要有一份「当前还装着哪些包」的清单，用来判断那些残留记录是不是已经作废。
//
// 清单从两处取（互为补充）：
//   ① 宿主的 Loader 条目（pluginManager.listPlugins）—— 装了就有一条，
//      包名就是 moduleName，最权威。
//   ② 扫包得到的 packages（scanned.packages）—— 用户装的包一个不落全收，
//      包括「一个工具都没注册」的包（Loader 条目里可能压根没有它）。
//
// 名单按**包名基名**比较（`@scope/foo` → `foo`）：三边的键形态不一致
// （目录名 / 包名 / Loader 的 moduleName），归一后才比得动。
import { packageBaseName } from './section-map.js';

/**
 * 收集当前已安装插件的名字集合。
 *
 * @param {object} [options]
 * @param {{listPlugins?: () => Promise<Array<object>>}} [options.pluginManager] 宿主插件管理服务
 * @param {{packages?: Map<string, object>}} [options.scanned] 扫包结果
 * @returns {Promise<Set<string>>} 包名基名集合
 */
export async function collectInstalledNames({ pluginManager, scanned } = {}) {
    const names = new Set();
    const add = (raw) => {
        const base = packageBaseName(raw);
        if (base) {
            names.add(base);
        }
    };
    // ① Loader 条目
    try {
        const plugins = pluginManager?.listPlugins ? await pluginManager.listPlugins() : [];
        for (const entry of plugins ?? []) {
            add(entry?.moduleName);
        }
    }
    catch {
        /* 拿不到就只用 ② */
    }
    // ② 扫包
    // 扫包结果的每条是 `{ key, dir, official, packageName, version }`，
    // 两种写法都认一下（有的地方包在 meta 里）。
    for (const entry of scanned?.packages?.values?.() ?? []) {
        add(entry?.packageName);
        add(entry?.key);
        add(entry?.meta?.packageName);
        add(entry?.meta?.key);
    }
    return names;
}

/**
 * 这个段落所属的包还在不在。
 *
 * - 没有归属（`plugin` 为空）→ 不知道来源，一律当「还在」：
 *   很多段落宿主不给归属，猜错了就把别人的段落弄丢了。
 * - 官方包（`@deepseek-ai/*`）→ 一律当「还在」：官方包三百多个，
 *   清单未必收全，误判会把宿主自己的段落判成已卸载。
 *
 * @param {string|undefined|null} plugin 段落的来源包名
 * @param {Set<string>} installed 已装包名基名集合
 * @returns {boolean}
 */
export function isOwnerInstalled(plugin, installed) {
    const raw = String(plugin ?? '').trim();
    if (!raw) {
        return true;
    }
    if (/^@deepseek-ai\//.test(raw)) {
        return true;
    }
    if (!installed || installed.size === 0) {
        // 清单拿不到（宿主没插件管理服务 / 扫包失败）→ 不做判断，别误删。
        return true;
    }
    return installed.has(packageBaseName(raw));
}
