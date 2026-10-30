// 插件自己报出来的工具清单。
//
// 为什么需要这一层：静态扫源码认不全。
// 有些插件把工具定义放在**运行时 manifest** 里 —— 名字不是写在源码中的常量，
// 而是插件起服务后通过 HTTP 端点公布的。billion-context 就是这样：
//   - 源码里能看到的只有 `forwardTool(base, sid, "acp_cache", …)` 这种调用，
//     那是「把工具转发到宿主侧执行」，不是「定义这个工具」；
//   - 真正的定义（name / description / input_schema）在
//     `GET /__bili/plugin/manifest` 的响应里。
// 扫源码永远认不出 `acp_cache`，只能问插件自己。
//
// 通道怎么找：manifest 端点是插件自己挂的，路径不统一。这里不猜路径，
// 而是从**已装插件包的源码里找它自己声明的 manifest 路径** ——
// 插件一定会把路径写成常量（不然它自己也不知道挂哪），
// 那个常量就是索引。找不到声明的包就跳过，绝不瞎试路径。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 从一份源码里找「插件自己声明的 manifest 端点路径」。
 *
 * 认这两种写法：
 *   - `MANIFEST_PATH = "/__bili/plugin/manifest"`
 *   - `manifestPath: "/__bili/plugin/manifest"`
 * 路径必须以 `/` 开头、以 `/` 结尾或以 `.json`/manifest 之类结尾 ——
 * 太宽松会把 `"/"` `"/api"` 这类通用路径也当成 manifest 通道，
 * 拿回来的是 HTML 页面，浪费一次请求还可能误判。
 */
export function manifestPathInSource(text) {
    if (!text) {
        return undefined;
    }
    const re = /['"](\/[A-Za-z0-9_\-./]{4,120}(?:manifest|manifest\.json)[A-Za-z0-9_\-./]*)['"]/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const p = m[1];
        if (!p.startsWith('/') || p.includes('..')) {
            continue;
        }
        return p;
    }
    return undefined;
}

/** 把 manifest 响应里的工具名抠出来 —— 只认数组或对象里的 `name` 字段。 */
export function toolNamesFromManifest(payload) {
    const names = new Set();
    const visit = (node, depth) => {
        if (!node || depth > 4) {
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                visit(item, depth + 1);
            }
            return;
        }
        if (typeof node !== 'object') {
            return;
        }
        // 形状一：{ name: "x", description, input_schema }
        if (typeof node.name === 'string' && /^[A-Za-z][A-Za-z0-9_.\-]{1,48}$/.test(node.name)) {
            names.add(node.name);
            return;
        }
        // 形状二：{ toolNames: ["x", …] }
        if (Array.isArray(node.toolNames)) {
            for (const t of node.toolNames) {
                if (typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_.\-]{1,48}$/.test(t)) {
                    names.add(t);
                }
            }
            return;
        }
        for (const v of Object.values(node)) {
            visit(v, depth + 1);
        }
    };
    visit(payload, 0);
    return [...names];
}

/**
 * 问已装的插件要它自己的工具清单。
 *
 * @param {string[]} pluginDirs 第三方插件包目录
 * @param {{baseUrls?: string[], timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<Map<string,string>>} 工具名 → 包名
 */
export async function fetchPluginManifests(pluginDirs, options = {}) {
    const out = new Map();
    const baseUrls = options.baseUrls ?? defaultBaseUrls();
    const timeoutMs = options.timeoutMs ?? 2500;
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function' || baseUrls.length === 0) {
        return out;
    }
    // 端点路径 → 提供它的包（同一个路径可能被多个包声明）
    const routes = new Map();
    for (const dir of pluginDirs) {
        const pkgName = dir.split('/').pop();
        const path = await findManifestPathInDir(dir);
        if (!path) {
            continue;
        }
        let list = routes.get(path);
        if (!list) {
            list = [];
            routes.set(path, list);
        }
        list.push(pkgName);
    }
    for (const [path, owners] of routes) {
        const payload = await tryFetchManifest(doFetch, baseUrls, path, timeoutMs);
        if (!payload) {
            continue;
        }
        const names = toolNamesFromManifest(payload);
        for (const name of names) {
            if (!out.has(name)) {
                // 同一个名字被多个包的 manifest 声称 = 认不出来，不猜。
                if (owners.length === 1) {
                    out.set(name, owners[0]);
                }
            }
        }
    }
    return out;
}

/** 在包里找 manifest 端点声明 —— 只看入口文件与它同目录的兄弟文件。 */
async function findManifestPathInDir(dir) {
    const files = [];
    try {
        const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        const rel = raw.main ?? (typeof raw.exports === 'string' ? raw.exports : undefined);
        if (typeof rel === 'string') {
            files.push(join(dir, rel.split('#')[0].replace(/^\.\//, '')));
        }
    }
    catch {
        // package.json 读不到就放弃这个包
    }
    for (const file of files) {
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        const p = manifestPathInSource(text);
        if (p) {
            return p;
        }
    }
    return undefined;
}

/** 宿主 GUI 可能的地址 —— manifest 挂在宿主 HTTP 服务上。 */
function defaultBaseUrls() {
    const urls = [];
    const port = process.env.DSH_WEB_PORT ?? process.env.PORT;
    const host = process.env.DSH_WEB_HOST ?? '127.0.0.1';
    if (port) {
        urls.push(`http://${host}:${port}`);
    }
    // GUI 默认端口 3079
    urls.push('http://127.0.0.1:3079');
    return [...new Set(urls)];
}

/** 依次试各个 base url + 端点路径，拿到第一个能解析出工具名的响应。 */
async function tryFetchManifest(doFetch, baseUrls, path, timeoutMs) {
    for (const base of baseUrls) {
        const url = `${base.replace(/\/$/, '')}${path}`;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            const resp = await doFetch(url, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!resp || !resp.ok) {
                continue;
            }
            const text = await resp.text();
            let payload;
            try {
                payload = JSON.parse(text);
            }
            catch {
                continue;
            }
            if (toolNamesFromManifest(payload).length > 0) {
                return payload;
            }
        }
        catch {
            // 网络不通就换下一个地址，绝不抛
        }
    }
    return undefined;
}
