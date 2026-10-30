// 分层管家的落盘位置。
//
// 为什么不放在插件自己的目录里：npm 安装下插件目录会被 `dsh plugin update` 整体替换，
// 账本放那儿等于升级即丢。所以侧车统一搬到 `$DSH_HOME/<插件名>/` 下 ——
// `$DSH_HOME` 是宿主自己的约定（dsh-home-paths 也这么读）。
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 宿主家目录：优先 $DSH_HOME，缺省 ~/.dsh。 */
export function resolveDshHome() {
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
        return fromEnv;
    }
    return join(homedir(), '.dsh');
}

/** 本插件在 $DSH_HOME 下的目录名。 */
const HUB_DIR = 'scope-manager';

/** 插件的落盘根目录。 */
function hubRoot() {
    return join(resolveDshHome(), HUB_DIR);
}

/** 落盘根目录下的某个路径（不创建目录）。 */
export function hubPath(...parts) {
    return join(hubRoot(), ...parts);
}
