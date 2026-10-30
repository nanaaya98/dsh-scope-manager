// 常开白名单：人设那几段提示词永远注入，不许被预设/场景的名单关掉。
//
// 背景：角色卡选「系统提示词覆盖」时，是把 harness:identity 与
// deployment:persona-prefix 这两段的**原文整段换掉**。如果某个预设把
// system-prompt 这个包的段落停用了，装配时这段会被摘掉，角色卡写好的
// 人设就跟着一起没了 —— 面板上看着「角色卡注入」，模型那边一句都读不到。
//
// 所以这里单独立一份名单：
//   · 预设编辑器里不单独列出 system-prompt 这张卡（它没有可调的东西，
//     只有这几段常开提示词）；
//   · 场景/预设的段落名单（sectionFilter）摘不掉这几段；
//   · 全局逐段开关仍然算数 —— 那是人明确点的名，比白名单重。
//
// 单独放一个文件是为了服务端（装配瀑布、HTTP 接口）与界面（徽章）共用同一份
// 名单，写两份迟早会对不上。客户端模块是浏览器里跑的静态文件，import 不到
// 服务端模块，那边要单独写一遍。

/** @type {readonly string[]} 永远注入的段落名。 */
export const ALWAYS_ON_SECTIONS = Object.freeze([
    'harness:identity',
    'deployment:persona-prefix',
    'deployment:persona-suffix',
]);

/** 这一段是不是常开的。 */
export function isAlwaysOnSection(name) {
    return ALWAYS_ON_SECTIONS.includes(String(name ?? ''));
}
