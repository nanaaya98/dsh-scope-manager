// 三层作用域的解析：把「全局 / 工作区 / 会话」三层叠成一份**生效配置**。
//
// 优先级：**会话 > 工作区 > 全局**。同一层里，**显式设置 > 该层选中的场景预设**。
//
// 每层只写自己改过的那几格，合并是纯函数，来源（provenance）能一路报给界面。
// 不用「给每个会话冻一份创建时的全量基线」那套叠加：侧车会随会话数线性膨胀，
// 而且基线是**快照**，全局改了以后老会话还拿着旧基线，
// 「全局改了但这个会话没跟上」很难解释。
import { GLOBAL_KEY, layerOf } from './store.js';

const LAYER_ORDER = Object.freeze([GLOBAL_KEY, 'workspace', 'session']);

/** 宿主权限预设的三档（`dsh-permission-presets` 的 sandbox 三态）。 */
export const PERMISSION_MODES = Object.freeze(new Set(['read-only', 'workspace-write', 'danger-full-access']));

const PERMISSION_LABELS = Object.freeze({
    'read-only': '仅可查看',
    'workspace-write': '工作区内修改',
    'danger-full-access': '完全权限',
});

/** 三个键的来源标签。 */
const LAYER_LABELS = Object.freeze({
    [GLOBAL_KEY]: '全局',
    workspace: '工作区',
    session: '会话',
});

/**
 * 把三层叠成一条从低到高的槽位链。
 * 每个槽位是「一层里的一份来源」：显式设置，或该层选中的场景预设。
 *
 * **同一层里场景槽排在显式槽之前** —— 链是从尾部往前读的，所以后放的先被读到：
 * 显式设置先被读到 = 显式设置赢。层与层之间仍然是全局 < 工作区 < 会话。
 */
function buildChain(layers, scenesById) {
    const chain = [];
    for (const key of LAYER_ORDER) {
        const layer = layers[key];
        // 这一层**明确选了「默认场景」**（scene: null）＝ 从这里往下全部放开。
        // 只把 scene 本身置空是不够的：低层那份场景槽位还在链上，角色卡、名单、
        // 备注会继续从下面漏上来 —— 实测里「会话选了默认场景，bash 仍然被工作区
        // 的场景排除」。所以要把已经攒下的低层槽位整段丢掉。
        if (layer && typeof layer === 'object'
            && Object.prototype.hasOwnProperty.call(layer, 'scene') && !layer.scene) {
            chain.length = 0;
        }
        const sceneId = layer?.scene;
        if (typeof sceneId === 'string' && sceneId) {
            const scene = scenesById?.[sceneId];
            if (scene) {
                chain.push({ kind: 'scene', scope: key, label: LAYER_LABELS[key], sceneId, data: scene });
            }
        }
        if (layer && typeof layer === 'object') {
            chain.push({ kind: 'explicit', scope: key, label: LAYER_LABELS[key], data: layer });
        }
    }
    return chain;
}

/** 这一层有没有**显式**写这个键？（区分「没写」与「写了 null」） */
function hasKey(obj, key) {
    return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 一层里显式给的值优先于该层的场景预设 —— 场景是「兜底包」，不是「覆盖层」。
 *
 * 三态：
 *   undefined = 这一层不管这个域 → 继续往低层找
 *   null      = 这一层**明确置空** → 停止往低层找
 *               （「会话覆盖工作区」也包括「会话明确说不要」）
 *   其它       = 有值
 */
function pickDomain(chain, read) {
    for (let i = chain.length - 1; i >= 0; i--) {
        const slot = chain[i];
        const raw = read(slot.data);
        if (raw === undefined) {
            continue;
        }
        return {
            value: raw,
            cleared: raw === null,
            source: slot.kind === 'scene' ? `预设「${slot.data.name ?? slot.sceneId}」` : slot.label,
            sourceScope: slot.scope,
            sourceKind: slot.kind,
        };
    }
    return null;
}

/**
 * 解析一份生效配置。
 *
 * @param {object} data 存储里的整份数据
 * @param {object} scenesById 场景预设表
 * @param {object} personasById 角色卡表
 * @param {{workspaceKey?: string, sessionKey?: string}} scope 当前作用域的键
 */
export function resolveEffective(data, scenesById, personasById, scope) {
    const wsKey = scope?.workspaceKey ?? '';
    const sKey = scope?.sessionKey ?? '';
    const layers = {
        [GLOBAL_KEY]: layerOf(data, GLOBAL_KEY),
        workspace: wsKey ? layerOf(data, wsKey) : {},
        session: sKey ? layerOf(data, sKey) : {},
    };
    const chain = buildChain(layers, scenesById);

    // —— 场景 ——
    const scenePick = pickDomain(chain, (d) => (hasKey(d, 'scene')
        ? (typeof d.scene === 'string' && d.scene ? d.scene : null)
        : undefined));
    const sceneId = scenePick && !scenePick.cleared ? scenePick.value : null;
    const scene = sceneId ? (scenesById?.[sceneId] ?? null) : null;

    // —— 角色卡 ——
    const personaPick = pickDomain(chain, (d) => (hasKey(d, 'persona')
        ? (typeof d.persona === 'string' && d.persona ? d.persona : null)
        : undefined));
    const personaId = personaPick && !personaPick.cleared ? personaPick.value : null;
    const personaRecord = personaId ? (personasById?.[personaId] ?? null) : null;

    // —— 权限档位 ——
    // 宿主的三档就是 sandbox/approval 的组合：read-only / workspace-write /
    // danger-full-access。三态同角色卡：没写 = 这一层不管，null = 明确「不设」。
    // 只认这三个名字：别的名字宿主 `permissionPresets.set()` 会直接抛。
    const permissionPick = pickDomain(chain, (d) => (hasKey(d, 'permission')
        ? (typeof d.permission === 'string' && PERMISSION_MODES.has(d.permission) ? d.permission : null)
        : undefined));
    const permissionName = permissionPick && !permissionPick.cleared ? permissionPick.value : null;

    // —— 工具名单（整体取值：allow/deny 二选一）——
    // 这里没有「明确置空」的第三态：名单的「空」就是「不管」，
    // 想取消上层名单用 allow 模式列全量，不用 null。
    const filterPick = pickDomain(chain, (d) => (d.toolFilter && typeof d.toolFilter === 'object' ? d.toolFilter : undefined));
    const skillsPick = pickDomain(chain, (d) => (d.skills && typeof d.skills === 'object' ? d.skills : undefined));
    // 系统提示词段落：插件往 `system-prompt/assemble` 里 push 的整段文字（比如表情包
    // 插件的「斗图规则」）。它们和工具是两套东西，关掉工具不会让这段消失。
    const sectionsPick = pickDomain(chain, (d) => (d.sectionFilter && typeof d.sectionFilter === 'object' ? d.sectionFilter : undefined));

    // —— 工具备注 / 段落逐段开关 / 段落覆写：**全局一份，不分作用域** ——
    // 这三样是「改了就生效」的开关：工具显示名与描述、描述是否作为注入描述、
    // 这一段注不注入、这一段文字换成什么。用户明确要求它们不随会话/工作区变化，
    // 所以只读全局层这一份 —— 层级与场景预设都不参与。
    // 这样不会出现「我在插件页改了，但当前会话里没生效」这种对不上号的情况。
    const globalLayer = layers[GLOBAL_KEY] ?? {};

    const toolNotes = {};
    {
        const map = globalLayer.tools;
        if (map && typeof map === 'object') {
            for (const [name, note] of Object.entries(map)) {
                if (!note || typeof note !== 'object') {
                    continue;
                }
                const target = toolNotes[name] ?? (toolNotes[name] = { name });
                for (const field of ['alias', 'description', 'inject']) {
                    if (!Object.prototype.hasOwnProperty.call(note, field)) {
                        continue;
                    }
                    target[field] = note[field];
                    target[`${field}Source`] = '全局';
                }
            }
        }
    }

    //   true  = 强制注入
    //   false = 强制不注入
    //   缺席  = 听 sectionFilter 的（没名单就默认注入）
    const sectionStates = {};
    {
        const map = globalLayer.sectionStates;
        if (map && typeof map === 'object') {
            for (const [name, value] of Object.entries(map)) {
                if (typeof value !== 'boolean') {
                    continue;
                }
                sectionStates[name] = { enabled: value, source: '全局', sourceScope: GLOBAL_KEY };
            }
        }
    }

    // 段落逐段文字覆写：同样只认全局这一份（目录里的全局覆写是另一条线，两者都由
    // 装配钩子按「全局覆写 > 原文」取，作用域不参与）。
    const sectionOverrides = {};
    {
        const map = globalLayer.sectionOverrides;
        if (map && typeof map === 'object') {
            for (const [name, text] of Object.entries(map)) {
                if (typeof text !== 'string') {
                    continue;
                }
                sectionOverrides[name] = { text, source: '全局', sourceScope: GLOBAL_KEY };
            }
        }
    }

    return {
        layers: {
            global: layers[GLOBAL_KEY],
            workspace: layers.workspace,
            session: layers.session,
        },
        scene: scene ? { id: scene.id, name: scene.name, source: scenePick?.source ?? null } : null,
        persona: personaRecord
            ? {
                id: personaRecord.id,
                name: personaRecord.name,
                description: personaRecord.description ?? '',
                body: personaRecord.body ?? '',
                // 三段正文 + 注入方式：装配时要按它们决定「写进段落」还是「合成消息」。
                inject: personaRecord.inject === 'system' ? 'system' : 'context',
                worldview: personaRecord.worldview ?? '',
                character: personaRecord.character ?? '',
                constraints: personaRecord.constraints ?? '',
                source: personaPick?.source ?? null,
            }
            : null,
        permission: permissionName
            ? {
                name: permissionName,
                label: PERMISSION_LABELS[permissionName] ?? permissionName,
                source: permissionPick?.source ?? null,
            }
            : null,
        tools: toolNotes,
        toolFilter: filterPick
            ? {
                mode: filterPick.value.mode === 'allow' ? 'allow' : 'deny',
                names: Array.isArray(filterPick.value.names) ? filterPick.value.names : [],
                // 「以后新装的插件工具默认激活吗」+ 保存时的工具基线。
                // 两个字段跟着名单一起透出：判「这是不是新工具」需要它们。
                newToolsActive: filterPick.value.newToolsActive !== false,
                baseline: Array.isArray(filterPick.value.baseline) ? filterPick.value.baseline : [],
                source: filterPick.source,
            }
            : null,
        skills: skillsPick
            ? {
                mode: skillsPick.value.mode === 'allow' ? 'allow' : 'deny',
                names: Array.isArray(skillsPick.value.names) ? skillsPick.value.names : [],
                source: skillsPick.source,
            }
            : null,
        sectionFilter: sectionsPick
            ? {
                mode: sectionsPick.value.mode === 'allow' ? 'allow' : 'deny',
                names: Array.isArray(sectionsPick.value.names) ? sectionsPick.value.names : [],
                source: sectionsPick.source,
            }
            : null,
        sectionStates,
        sectionOverrides,
    };
}

/** 某工具在生效配置里最终被允许吗？（toolFilter 为空 = 全放行。） */
export function toolAllowedByFilter(filter, name) {
    if (!filter) {
        return true;
    }
    const hit = filter.names.includes(name);
    if (filter.mode === 'allow') {
        return hit;
    }
    // deny 模式：「没被点名 = 放行」，例外是这套场景设了「新装的工具默认不激活」。
    // 判「新」靠保存时留下的基线：基线为空 = 老场景，不知道什么是新的，按老规矩放行。
    if (!hit && filter.newToolsActive === false) {
        const baseline = Array.isArray(filter.baseline) ? filter.baseline : [];
        if (baseline.length > 0 && !baseline.includes(name)) {
            return false;
        }
    }
    return !hit;
}

/** 某段系统提示词文字在生效配置里最终要保留吗？（sectionFilter 为空 = 全保留。） */
export function sectionAllowedByFilter(filter, name) {
    if (!filter) {
        return true;
    }
    const hit = filter.names.includes(name);
    return filter.mode === 'allow' ? hit : !hit;
}

/** 某技能在生效配置里最终被允许吗？ */
export function skillAllowedByFilter(filter, name) {
    if (!filter) {
        return true;
    }
    const hit = filter.names.includes(name);
    return filter.mode === 'allow' ? hit : !hit;
}
