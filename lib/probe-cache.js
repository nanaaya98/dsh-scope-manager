/**
 * 深度排查结果的本地缓存。
 *
 * 存在哪儿：`$DSH_HOME/scope-manager/probe-cache.json` —— 跟账本放一起，
 * 不进插件目录（插件升级会被整体替换，那儿的东西会丢）。
 *
 * 缓存的是什么：某��包「实测注册了哪些工具」。
 *
 * 什么时候失效：
 *   - 插件升级/重装了 → 版本对不上 → 结论作废，重新测。
 *   - 插件被卸载 → 条目没意义。
 * 所以每条记录都带版本号和版本指纹，对不上就当没测过。
 */
import { readFile, rename } from 'node:fs/promises';

import { hubPath } from './paths.js';
import { writeAtomic } from './atomic.js';

const CACHE_FILE = 'probe-cache.json';
const CACHE_VERSION = 1;

/**
 * 读缓存。读不出来就当没有 —— 缓存是优化，不是必需品。
 *
 * @returns {Promise<{version: number, plugins: Record<string, object>}>}
 */
export async function readProbeCache() {
    try {
        const text = await readFile(hubPath(CACHE_FILE), 'utf8');
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION) {
            return emptyCache();
        }
        const plugins = {};
        if (raw.plugins && typeof raw.plugins === 'object') {
            for (const [key, value] of Object.entries(raw.plugins)) {
                if (value && typeof value === 'object') {
                    plugins[key] = value;
                }
            }
        }
        return { version: CACHE_VERSION, plugins };
    }
    catch {
        return emptyCache();
    }
}

function emptyCache() {
    return { version: CACHE_VERSION, plugins: {} };
}

/** 原子写（同目录临时文件 → rename）。 */

/**
 * 写缓存。
 *
 * @param {Record<string, object>} plugins - 包名 → 记录
 */
export async function writeProbeCache(plugins) {
    const payload = { version: CACHE_VERSION, plugins: plugins ?? {} };
    await writeAtomic(hubPath(CACHE_FILE), JSON.stringify(payload, null, 2));
}

/**
 * 缓存里的结论对某个包是否还有效。
 *
 * 判据：版本号一致，且记录的包版本与当前一致。
 * 插件升过级 → 之前测的工具集可能已经变了 → 不作数。
 *
 * @param {object|undefined} record - 缓存记录
 * @param {string|undefined} currentVersion - 当前包的版本
 * @returns {boolean}
 */
export function isProbeFresh(record, currentVersion) {
    if (!record || !Array.isArray(record.tools)) {
        return false;
    }
    if (record.status !== 'verified') {
        return false;
    }
    if (typeof record.version !== 'string' || record.version === '') {
        return false;
    }
    if (typeof currentVersion !== 'string' || currentVersion === '') {
        return false;
    }
    return record.version === currentVersion;
}

/**
 * 把缓存整理成「包名 → 工具名数组」，只含仍然新鲜的结论。
 *
 * @param {object} cache - readProbeCache 的结果
 * @param {Map<string, string>} versions - 包名 → 当前版本
 * @returns {Map<string, string[]>}
 */
export function freshProbeTools(cache, versions) {
    const out = new Map();
    for (const [name, record] of Object.entries(cache?.plugins ?? {})) {
        if (isProbeFresh(record, versions.get(name))) {
            out.set(name, record.tools.filter((t) => typeof t === 'string'));
        }
    }
    return out;
}
