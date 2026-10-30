// 角色卡三段 → 系统提示词段落的对应关系。
//
//   世界观        → harness:identity（最开场那句身份/世界设定）
//   角色设定      → deployment:persona-prefix
//   行为约束      → 追加在 deployment:persona-prefix 末尾（与角色设定同一段）
//
// 行为约束为什么不单独占 `deployment:persona-suffix`：suffix 排在整份提示词的
// 最末尾（order 10200，工具说明、场景、技能目录全在它前面），是「收尾口径」而不是
// 人设的一部分；把行为约束丢到那儿，它跟角色设定之间会隔着一大堆工具手册，
// 读起来是断的。两段本来就是一体的，所以拼在一段里，约束在下。
//
// 这里只放纯函数：宿主装配（lib/index.js）和面板展示（lib/http-api.js）共用同一份映射，
// 免得两边各写一份、改了这边忘了那边。

/** 三段的键与标题，顺序即界面顺序。 */
export const PERSONA_LABELS = [
    ['worldview', '世界观'],
    ['character', '角色设定'],
    ['constraints', '行为约束'],
];

/**
 * 角色卡在「系统提示词覆盖」模式下要盖上去的文字：段落名 → 文本。
 *
 * **空内容也照盖**：这三格是「整段替换」，清空就等于把那一段抹掉（宿主
 * `renderPrompt` 会丢掉空段落，模型那边就看不到这句话了）。想保留原文就别选
 * 覆盖模式，或者把原文抄进去再改。
 * @param {object|null|undefined} persona 生效的角色卡（resolve.js 投影过的那份）
 * @returns {Map<string, string>}
 */
export function personaSectionTexts(persona) {
    const out = new Map();
    if (!persona || persona.inject !== 'system') {
        return out;
    }
    out.set('harness:identity', String(persona.worldview ?? '').trim());
    const character = String(persona.character ?? '').trim();
    const constraints = String(persona.constraints ?? '').trim();
    // 行为约束接在角色设定末尾，中间空一行 —— 同一段，不是两段。
    out.set('deployment:persona-prefix', [character, constraints].filter(Boolean).join('\n\n'));
    return out;
}
