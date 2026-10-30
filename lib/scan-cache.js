/**
 * 工具归属扫描结果的**落盘缓存**。
 *
 * 为什么要它：扫一遍要读 294 个官方包的 JS（实测 15.9 秒）。
 * 只放在内存里的话，宿主一重启、或者用户手点「快速刷新」，
 * 就得重新付这 15 秒，点开「插件」页的人盯着转圈。
 *
 * 口径：
 *   - 扫描结果落盘，页面随时打开都读缓存（毫秒级）；
 *   - 只有当**插件集合变了**（新装 / 卸载 / 升级 / 本地改包）才重扫 ——
 *     判据是指纹（指纹怎么算见 tool-owner.js 的 computeFingerprint）；
 *   - 指纹不匹配时**不阻塞**页面：先把旧结果给出去，后台重扫，
 *     扫完再换上新结果。宁可显示一秒旧的，也不要让页面白屏 15 秒。
 *
 * 存哪儿：`$DSH_HOME/scope-manager/scan-cache.json`，跟账本、排查缓存放一起，
 * 不进插件目录（那儿升级即丢）。
 */
import { readFile, rename, rm } from 'node:fs/promises';

import { hubPath } from './paths.js';
import { writeAtomic } from './atomic.js';

const CACHE_FILE = 'scan-cache.json';
/** 缓存格式版本。改了序列化形状就把这个数 +1，旧文件自动作废。 */
const CACHE_VERSION = 2;

/** Map<string,string> → 普通对象。 */
function strMapToJson(map) {
    const out = {};
    for (const [k, v] of map ?? []) {
        if (typeof k === 'string' && typeof v === 'string') {
            out[k] = v;
        }
    }
    return out;
}

/** 普通对象 → Map<string,string>。 */
function jsonToStrMap(obj) {
    const out = new Map();
    if (!obj || typeof obj !== 'object') {
        return out;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
            out.set(k, v);
        }
    }
    return out;
}

/** Map<string,string> 的**多值**版本（quoted：一个名字可能被好几个包声称）。 */
function setMapToJson(map) {
    const out = {};
    for (const [k, v] of map ?? []) {
        if (typeof k === 'string' && v instanceof Set) {
            out[k] = [...v].filter((x) => typeof x === 'string');
        }
    }
    return out;
}

function jsonToSetMap(obj) {
    const out = new Map();
    if (!obj || typeof obj !== 'object') {
        return out;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v)) {
            out.set(k, new Set(v.filter((x) => typeof x === 'string')));
        }
    }
    return out;
}

/**
 * 扫描结果 → 可落盘的 JSON。
 *
 * **不含 `probed`**：实测结论有自己的缓存（probe-cache.json）和版本判据，
 * 混进来会让「插件升级了」这件事被扫描缓存掩盖。
 * **不含运行时交叉验证的产物**（runtimeNames / droppedGhosts / expiredOfficial）：
 * 那些取决于当前运行时，几分钟就变，不属于「包扫出来的事实」。
 */
function encodeScanBase(base) {
    return {
        system: strMapToJson(base?.system),
        plugin: strMapToJson(base?.plugin),
        quoted: setMapToJson(base?.quoted),
        officialByPackage: strMapToJson(base?.officialByPackage),
        pluginByStem: strMapToJson(base?.pluginByStem),
        manifestTools: strMapToJson(base?.manifestTools),
        packages: [...(base?.packages ?? [])].map(([key, pkg]) => [key, {
            key: pkg?.key ?? key,
            dir: pkg?.dir ?? '',
            official: pkg?.official === true,
            packageName: pkg?.packageName ?? key,
            version: pkg?.version ?? '',
            description: pkg?.description ?? '',
        }]),
    };
}

/** 落盘 JSON → 扫描结果（形状跟 scanNow 返回的一致）。 */
function decodeScanBase(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const packages = new Map();
    for (const row of Array.isArray(raw.packages) ? raw.packages : []) {
        if (!Array.isArray(row) || row.length !== 2) {
            continue;
        }
        const [key, pkg] = row;
        if (typeof key === 'string' && pkg && typeof pkg === 'object') {
            packages.set(key, pkg);
        }
    }
    return {
        system: jsonToStrMap(raw.system),
        plugin: jsonToStrMap(raw.plugin),
        quoted: jsonToSetMap(raw.quoted),
        officialByPackage: jsonToStrMap(raw.officialByPackage),
        pluginByStem: jsonToStrMap(raw.pluginByStem),
        manifestTools: jsonToStrMap(raw.manifestTools),
        packages,
    };
}

/**
 * 读缓存。文件不在 / 坏了 / 版本不对 → null（调用方退回重新扫描）。
 *
 * @returns {Promise<{fingerprint: string, savedAt: number, base: object}|null>}
 */
export async function readScanCache() {
    try {
        const text = await readFile(hubPath(CACHE_FILE), 'utf8');
        const raw = JSON.parse(text);
        if (!raw || typeof raw !== 'object' || raw.version !== CACHE_VERSION) {
            return null;
        }
        if (typeof raw.fingerprint !== 'string' || raw.fingerprint === '') {
            return null;
        }
        const base = decodeScanBase(raw.scan);
        if (!base) {
            return null;
        }
        return {
            fingerprint: raw.fingerprint,
            savedAt: Number(raw.savedAt) || 0,
            base,
        };
    }
    catch {
        return null;
    }
}

/** 原子写（同目录临时文件 → rename），避免半截文件被读到。 */

/**
 * 写缓存。失败不抛（缓存是优化，不是必需品）。
 *
 * @param {string} fingerprint - 这份结果对应哪一版插件集合
 * @param {object} base - scanNow 的产物
 */
export async function writeScanCache(fingerprint, base) {
    try {
        const payload = {
            version: CACHE_VERSION,
            fingerprint: String(fingerprint ?? ''),
            savedAt: Date.now(),
            scan: encodeScanBase(base),
        };
        await writeAtomic(hubPath(CACHE_FILE), JSON.stringify(payload));
        return true;
    }
    catch {
        return false;
    }
}

/** 删缓存文件（插件集合变了、或用户手点重建时用）。 */
export async function dropScanCache() {
    try {
        await rm(hubPath(CACHE_FILE), { force: true });
    }
    catch {
        /* 删不掉也不影响：指纹对不上照样会重扫 */
    }
}
