// 固定名次：这三段在装配时被钉到 1、2、3，中间是宿主原本的顺序，
// 末尾是第三方插件注入的段落（等价于 push 型）。
//
// 单独放一个文件是为了让**服务端**（装配瀑布、HTTP 接口）和**界面**
// （标「固定」徽章）共用同一份名单 —— 写两份迟早会对不上。

/** @type {readonly string[]} 数组顺序 = 名次。 */
export const PINNED_SECTIONS = Object.freeze([
    'harness:identity',
    'deployment:persona-prefix',
    'deployment:persona-suffix',
]);

/** 这一段是不是被钉住名次的。 */
export function isPinnedSection(name) {
    return PINNED_SECTIONS.includes(String(name ?? ''));
}
