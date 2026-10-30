/**
 * `@技能名` 的手势改写：本插件在 `agent/pre-step` 里把它翻成宿主的 `/技能名`。
 *
 * 为什么不让宿主自己认 `@`：技能手势是 dsh-tool-skill 的私有正则
 * （`(^|\s)\/(name)(?=\s|$)`），只有 `/` 会触发它注入技能正文。我们不去改别人的
 * 插件，而是在 pre-step 最前面把这一轮的文本改写掉 —— 效果与用户手打 `/名` 完全一致，
 * 而且原始输入不会被存成别的样子（改写只发生在这次请求的 messages 上）。
 */

/** 与 SKILL_GESTURE 同构：`@` 前面必须是行首或空白，后面必须是行尾或空白。 */
const AT_SKILL = /(^|\s)@([a-z0-9][a-z0-9-]*)(?=\s|$)/g;

/**
 * 把文本里能对上技能名的 `@名` 换成 `/名`。
 * @param {string} text - 一条用户消息的文本块。
 * @param {Iterable<string>} names - 本轮可用的技能名（大小写敏感，与技能注册表一致）。
 * @returns {string | null} 改写后的文本；没有命中返回 null。
 */
export function rewriteAtSkillGestures(text, names) {
    const known = names instanceof Set ? names : new Set(names || []);
    if (!known.size) {
        return null;
    }
    let hit = false;
    const out = String(text ?? '').replace(AT_SKILL, (whole, lead, name) => {
        if (!known.has(name)) {
            return whole;
        }
        hit = true;
        return `${lead}/${name}`;
    });
    return hit ? out : null;
}

/** 一条消息里所有文本块改写后的新 content；没有命中返回 null。 */
export function rewriteAtSkillContent(content, names) {
    let changed = false;
    const next = (Array.isArray(content) ? content : []).map((block) => {
        if (block?.type !== 'text' || typeof block.text !== 'string') {
            return block;
        }
        const text = rewriteAtSkillGestures(block.text, names);
        if (text === null) {
            return block;
        }
        changed = true;
        return { ...block, text };
    });
    return changed ? next : null;
}
