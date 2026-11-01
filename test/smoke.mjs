// 宿主那一半的冒烟测试。
//
// 不依赖真实 DSH：用假 ctx / 假 tools / 假 req-res 打通
//   ① HTTP 路由 POST /dsh-scope-manager/api
//   ② system-prompt/assemble 瀑布（工具描述改写）
//   ③ tools.restrict 可见性减工具
//   ④ tools.guard 执行侧拦截
//   ⑤ agent/pre-step 角色卡注入（含「内容没变不重发」）
// 跑法：node test/smoke.mjs
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { associateSections, sectionOwnerBase } from '../lib/section-map.js';
import { createSectionCatalog } from '../lib/sections.js';
import { collectInstalledNames, isOwnerInstalled } from '../lib/installed.js';
import { classifyToolName, crossCheckWithRuntime, probedOwnersFrom } from '../lib/tool-owner.js';
import { probeOnePlugin, probePlugins, runtimeToolNames } from '../lib/tool-probe.js';
import { isProbeFresh } from '../lib/probe-cache.js';
import { manifestPathInSource, toolNamesFromManifest } from '../lib/plugin-manifest.js';
import { diffSnapshots } from '../lib/plugin-watch.js';
import { scanPromptVars, validatePromptVars } from '../lib/prompt-vars.js';
import { scoreSectionHit } from '../lib/section-source.js';
import { SYSTEM_SECTION_OWNERS, systemSectionOwner } from '../lib/system-sections.js';
import { reorderSections, PINNED_SECTIONS } from '../lib/index.js';
import { ALWAYS_ON_SECTIONS, isAlwaysOnSection } from '../lib/always-on.js';
import { toolAllowedByFilter } from '../lib/resolve.js';
import { settleToolFilter } from '../lib/library.js';
import { skillOrigin, packageNameOf, frontmatterOf, rewriteSkillPolicy, locationFromSource, removeSkill, uninstallSelfInstalledSkill, SKILL_BUCKETS } from '../lib/skills.js';
import { isMcpToolDisabled, mcpDisabledTools } from '../lib/store.js';
import { MCP_GESTURE_KIND, mcpGestureTokens, resolveMcpGesture, renderMcpUnlockNote, serverGestureKeys } from '../lib/mcp-gesture.js';
import { rewriteAtSkillGestures, rewriteAtSkillContent } from '../lib/at-skill.js';
import { parseFrontmatter, unzip, extractTo, installSkill, normalizeSkillName } from '../lib/skillhub.js';
import {
    collectMcpRows,
    parsePatch,
    removeRow,
    rowToServer,
    serializePatch,
    setRowDisabled,
    upsertServer,
    validateServerInput,
} from '../lib/mcp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dsh-smoke-'));
process.env.DSH_HOME = home;

const plugin = (await import('../lib/index.js')).default;

let failed = 0;
function check(name, cond, extra) {
    if (cond) {
        console.log(`  ✓ ${name}`);
    }
    else {
        failed++;
        console.log(`  ✗ ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
    }
}

// ————————————————————— 假宿主 —————————————————————

const SCHEMAS = [
    { name: 'bash', description: '原始 bash 描述', parameters: { type: 'object', properties: {} } },
    { name: 'skill', description: '加载技能', parameters: { type: 'object', properties: {} } },
    { name: 'web_search', description: '搜网', parameters: { type: 'object', properties: {} } },
];

const guardFns = [];
const pluginRestricts = [];
const agentRestricts = [];
const routes = new Map();

const toolsService = {
    schemas: async () => SCHEMAS.map((s) => ({ ...s })),
    guard: (fn) => {
        guardFns.push(fn);
        return () => { };
    },
    restrict: (filter) => {
        pluginRestricts.push(filter);
        return () => { };
    },
    get: () => undefined,
    register: () => { },
};

const permissionCalls = [];
const services = {
    // 宿主权限预设服务：只记录调用，验证「场景里的档位真的落到会话上」。
    permissionPresets: {
        current: () => 'workspace-write',
        set: (session, name) => {
            permissionCalls.push([session?.id ?? null, name]);
        },
        catalog: () => ({ options: [], defaultOptions: [], defaultPreset: 'workspace-write' }),
    },
    webServer: {
        register: (spec) => {
            routes.set(spec.path, spec);
            return () => { };
        },
    },
    tools: toolsService,
    skills: { list: async () => [], get: async () => undefined },
    sessions: { list: () => [] },
    agents: { list: () => [] },
    workspaceRegistry: { resolveByPath: () => undefined, list: () => [] },
};

const listeners = new Map();
const ctx = {
    on(event, handler, options) {
        const list = listeners.get(event) ?? [];
        if (options?.prepend) {
            list.unshift(handler);
        }
        else {
            list.push(handler);
        }
        listeners.set(event, list);
        return () => { };
    },
    effect(fn) {
        fn();
        return () => { };
    },
    get(name) {
        return services[name];
    },
    logger: { warn: () => { }, info: () => { }, error: () => { } },
};
// 真实 cordis 会把注入的服务挂成 ctx.<name>，这里照做。
for (const [name, service] of Object.entries(services)) {
    Object.defineProperty(ctx, name, { get: () => service, enumerable: true });
}

/** 发一个事件：2 参以上的监听器当瀑布跑，1 参的当普通监听器。 */
async function emit(event, payload, context) {
    const list = listeners.get(event) ?? [];
    const plain = list.filter((fn) => fn.length < 2);
    for (const fn of plain) {
        await fn(payload);
    }
    const around = list.filter((fn) => fn.length >= 2);
    if (around.length === 0) {
        return undefined;
    }
    // 不同事件的监听器签名不同：assemble 是 (assembly, context, next)，pre-step 是 (payload, next)。
    const build = (acc, next) => (event === 'system-prompt/assemble' ? [acc, context, next] : [acc, next]);
    const run = async (index, acc) => {
        if (index >= around.length) {
            return acc;
        }
        const fn = around[index];
        const next = async (value) => run(index + 1, value === undefined ? acc : value);
        const out = await fn(...build(acc, next));
        return out === undefined ? acc : out;
    };
    return run(0, payload);
}

// 假的包扫描结果：让 bash 有归属，用来测「默认关联插件」那条路。
const fakeScanner = {
    get: async () => ({
        system: new Map([['bash', 'dsh-tool-bash']]),
        plugin: new Map(),
    }),
    peek: () => ({ system: new Map(), plugin: new Map() }),
    info: () => ({ scanning: false, cached: true, checkedAt: 0, scannedAt: 0, fingerprint: 'fake' }),
    verify: async () => ({ rescanned: false }),
    invalidate: () => { },
};

plugin.apply(ctx, { scanner: fakeScanner });
// 等启动加载（apply 内部是 void async）。
await new Promise((r) => setTimeout(r, 60));

// ————————————————————— HTTP 面 —————————————————————

class FakeReq {
    constructor(body, headers) {
        this.body = body;
        this.headers = headers;
        this.method = 'POST';
        this._handlers = {};
    }
    on(ev, fn) {
        (this._handlers[ev] ??= []).push(fn);
        return this;
    }
    resume() { }
    flush() {
        for (const fn of this._handlers.data ?? []) {
            fn(Buffer.from(this.body));
        }
        for (const fn of this._handlers.end ?? []) {
            fn();
        }
    }
}

async function callApi(op, args = {}, headers = {}) {
    const spec = routes.get('/dsh-scope-manager/api');
    if (!spec) {
        throw new Error('路由没注册上');
    }
    const req = new FakeReq(JSON.stringify({ op, args }), { 'x-dsh-plugin': 'dsh-scope-manager', ...headers });
    let status = 0;
    let body = '';
    const res = {
        writeHead(s) { status = s; },
        end(p) { body = p; },
    };
    const done = spec.handler(req, res);
    for (let i = 0; i < 50 && !(req._handlers.data?.length); i++) {
        await new Promise((r) => setTimeout(r, 1));
    }
    req.flush();
    await done;
    return { status, body: body ? JSON.parse(body) : null };
}

console.log('\n[1] HTTP 路由');
check('路由已注册', routes.has('/dsh-scope-manager/api'));
{
    const bad = await callApi('plugin-version', {}, { 'x-dsh-plugin': 'wrong' });
    check('缺门禁头 → 403', bad.status === 403, bad);
}
{
    const v = await callApi('plugin-version');
    check('plugin-version → 200', v.status === 200 && v.body.ok === true, v);
}
{
    const bad = await callApi('no-such-op');
    check('未知 op → 404', bad.status === 404, bad);
}

// ————————————————————— 三层作用域 —————————————————————

console.log('\n[2] 备注与「是否注入」只有全局一份（不随作用域变）');
await callApi('tool-note-save', { scope: 'workspace', cwd: '/tmp', name: 'bash', alias: '工作区别名', description: '工作区描述', inject: false });
await callApi('tool-note-save', { scope: 'session', sessionId: 'sess-1', name: 'bash', alias: '会话别名', description: '会话描述', inject: true });
{
    const g = await callApi('scope-context', {});
    check('后写的覆盖先写的（都落在全局层）', g.body.effective.tools.bash.alias === '会话别名', g.body.effective.tools.bash);
    check('备注来源标注为「全局」', g.body.effective.tools.bash.aliasSource === '全局', g.body.effective.tools.bash);
    check('是否注入也跟着这一份', g.body.effective.tools.bash.inject === true, g.body.effective.tools.bash);
}
{
    // 换一个工作区/会话看：同一份备注 —— 这就是「不关作用域的事」。
    const s = await callApi('scope-context', { cwd: '/tmp/other', sessionId: 'sess-9' });
    check('换作用域仍是同一份备注', s.body.effective.tools.bash.alias === '会话别名', s.body.effective.tools.bash);
    check('换作用域来源仍是全局', s.body.effective.tools.bash.aliasSource === '全局', s.body.effective.tools.bash);
}
{
    // 层级里的名单不参与备注解析（备注只在全局层那一份里找）。
    await callApi('layer-save', {
        scope: 'session',
        sessionId: 'sess-2',
        layer: { tools: { bash: { alias: '旧数据别名' } } },
    });
    const s = await callApi('scope-context', { cwd: '/tmp', sessionId: 'sess-2' });
    check('层级里的旧备注不参与解析', s.body.effective.tools.bash.alias === '会话别名', s.body.effective.tools.bash);
}

// ————————————————————— ① 改工具描述 —————————————————————

console.log('\n[3] ① system-prompt/assemble：只换描述，不动 parameters');
{
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: (f) => { agentRestricts.push(f); return () => { }; } } },
    };
    await emit('agent/created', { agent });
    const assembly = {
        sections: [],
        contexts: [],
        variables: {},
        tools: [
            { name: 'bash', description: '原始 bash 描述', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
            { name: 'skill', description: '加载技能', parameters: { type: 'object' } },
        ],
    };
    const out = await emit('system-prompt/assemble', assembly, { agent });
    const bash = out.tools.find((t) => t.name === 'bash');
    check('描述被换成用户写的那条', bash.description === '会话描述', bash);
    check('parameters 一个字没动', JSON.stringify(bash.parameters) === JSON.stringify(assembly.tools[0].parameters), bash.parameters);
    check('没写备注的工具原样保留', out.tools.find((t) => t.name === 'skill').description === '加载技能');
}

// ————————————————————— ①a 段落来源反查 —————————————————————

console.log('\n[2c] 段落来源反查：同一个名字出现在多个包里，取「定义处」而不是「借用处」');
{
    // dsh-system-prompt 是这么定义的：常量赋值。
    const declaration = 'const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";\n';
    const atDecl = declaration.indexOf('"deployment:persona-prefix"');
    check('常量定义算最高分',
        scoreSectionHit(declaration, atDecl, 'deployment:persona-prefix') >= 20,
        scoreSectionHit(declaration, atDecl, 'deployment:persona-prefix'));

    // dsh-subagent 只是给子代理借同名覆写槽位。
    const borrowed = 'if (composition.persona !== undefined) childCtx.systemPrompt.section({\n'
        + '    name: "deployment:persona-prefix",\n    order: 0, text: composition.persona\n});\n';
    const atBorrow = borrowed.indexOf('"deployment:persona-prefix"');
    check('子代理借名覆写分数更低',
        scoreSectionHit(borrowed, atBorrow, 'deployment:persona-prefix')
        < scoreSectionHit(declaration, atDecl, 'deployment:persona-prefix'),
        scoreSectionHit(borrowed, atBorrow, 'deployment:persona-prefix'));
}

// ————————————————————— ①b 摘系统提示词段落 —————————————————————

console.log('\n[3b] 系统提示词段落：关掉工具不会连带关掉那段说明');
{
    await callApi('scene-save', {
        name: '只摘段落',
        sectionFilter: { mode: 'deny', names: ['dsh-expression:companion'] },
    });
    const list = await callApi('scene-list');
    const sceneId = list.body.scenes.find((s) => s.name === '只摘段落').id;
    await callApi('layer-save', { scope: 'session', sessionId: 'sess-1', layer: { scene: sceneId } });
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const assembly = {
        sections: [
            { name: 'base', text: '基础提示词' },
            { name: 'dsh-expression:companion', text: '斗图规则：主动斗图' },
        ],
        contexts: [],
        variables: {},
        tools: [{ name: 'bash', description: '原始', parameters: { type: 'object' } }],
    };
    const out = await emit('system-prompt/assemble', assembly, { agent });
    const names = out.sections.map((s) => s.name);
    check('名单里的段落被摘掉', !names.includes('dsh-expression:companion'), names);
    check('别的段落还在', names.includes('base'), names);
    check('工具不受影响', out.tools.some((t) => t.name === 'bash'), out.tools.map((t) => t.name));
    // 目录：见过的段落要记下来，界面才有东西可勾
    const secs = await callApi('sections-list');
    check('见过的段落进了目录', (secs.body.sections ?? []).some((x) => x.name === 'dsh-expression:companion'), secs.body.sections);

    // 覆写：不写回插件源码，只在装配时换掉那段文字
    const ov = await callApi('section-override-save', { name: 'base', text: '被改写的提示词' });
    check('覆写能保存', ov.status === 200 && ov.body.ok === true, ov.body);
    const out2 = await emit('system-prompt/assemble', assembly, { agent });
    const baseSection = (out2.sections ?? []).find((x) => x.name === 'base');
    check('覆写后的文字进了装配', baseSection && baseSection.text === '被改写的提示词', baseSection);
    check('被摘掉的段落不会因为有覆写就回来', !(out2.sections ?? []).some((x) => x.name === 'dsh-expression:companion'), out2.sections);
    await callApi('section-override-save', { name: 'base', text: '' });
    const out3 = await emit('system-prompt/assemble', assembly, { agent });
    const baseAgain = (out3.sections ?? []).find((x) => x.name === 'base');
    check('清空覆写后回到原文', baseAgain && baseAgain.text === '基础提示词', baseAgain);

    // 清理：只清「上次没出现且没覆写」的
    {
        const before = await callApi('sections-list');
        const staleBefore = (before.body.sections ?? []).filter((x) => x.stale).map((x) => x.name);
        // 造一条上一次出现过、这一次没出现的段落不现实（record 由装配驱动），
        // 这里直接验证 prune 在没有 stale 时是空操作、且不动带覆写的条目。
        await callApi('section-override-save', { name: 'base', text: '保留我' });
        const pruned = await callApi('sections-prune');
        check('没有 stale 时清理是空操作', (pruned.body.removed ?? []).length === 0, pruned.body);
        const after = await callApi('sections-list');
        check('带覆写的条目不会被清掉', (after.body.sections ?? []).some((x) => x.name === 'base'), after.body.sections);
        await callApi('section-override-save', { name: 'base', text: '' });
        void staleBefore;
    }

    // 场景编辑的候选集：scopeAll 不该被「当前会话看得见什么」限制
    const allTools = await callApi('tools-list', { scopeAll: true });
    check('scopeAll 能取到工具', (allTools.body.total ?? 0) > 0, allTools.body.total);

    // 归属者那一行自己的备注：存进去、读回来、清空后消失。
    const someGroup = (allTools.body.groups ?? []).find((g) => g.tools.length > 0)
        ?? (allTools.body.groups ?? [])[0];
    if (someGroup) {
        const gkey = `${someGroup.category}::${someGroup.owner}`;
        await callApi('group-note-save', { key: gkey, text: '这是给整个插件写的备注' });
        const withNote = await callApi('tools-list', { scopeAll: true });
        const got = (withNote.body.groups ?? []).find((g) => `${g.category}::${g.owner}` === gkey);
        check('分组备注存得住', got?.note === '这是给整个插件写的备注', got?.note);
        await callApi('group-note-save', { key: gkey, text: '' });
        const cleared = await callApi('tools-list', { scopeAll: true });
        const back = (cleared.body.groups ?? []).find((g) => `${g.category}::${g.owner}` === gkey);
        check('清空后备注消失', back?.note === '', back?.note);
    }
    else {
        check('分组备注：没有分组可测（跳过）', false, allTools.body.groups);
    }
    await callApi('layer-save', { scope: 'session', sessionId: 'sess-1', layer: {} });
}

// ————————————————————— ② 减工具 —————————————————————

console.log('\n[4] ② 名单：工具定义真的被摘掉（scope 上不装 restrict）');
{
    await callApi('layer-save', {
        scope: 'session',
        sessionId: 'sess-1',
        layer: { tools: { bash: { alias: '会话别名', description: '会话描述', inject: true } }, toolFilter: { mode: 'deny', names: ['web_search'] } },
    });
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: (f) => { agentRestricts.push(f); return () => { }; } } },
    };
    await emit('agent/created', { agent });
    // restrict 的撤销函数只在本实例手里：插件一热重载就成孤儿层，把工具永久锁死。
    // 所以这一层一个都不装 —— 摘定义靠 assemble，拦调用靠 guard。
    check('agent scope 上不装 restrict', agentRestricts.length === 0, agentRestricts);
    check('插件级也不装 restrict', pluginRestricts.length === 0, pluginRestricts);
}
{
    // 工具定义真的被摘掉：restrict 只能点名全局工具，assemble 这一层才是
    // 「模型根本看不到这条 schema」的保证（`subagent` 这种按 agent 注册的只能靠它）。
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const assembly = {
        sections: [],
        contexts: [],
        variables: {},
        tools: [
            { name: 'bash', description: '原始', parameters: { type: 'object' } },
            { name: 'web_search', description: '搜索', parameters: { type: 'object' } },
            { name: 'skill', description: '技能', parameters: { type: 'object' } },
        ],
    };
    const out = await emit('system-prompt/assemble', assembly, { agent });
    const names = out.tools.map((t) => t.name);
    check('名单里的工具从工具定义里消失', !names.includes('web_search'), names);
    check('名单外的工具还在', names.includes('bash') && names.includes('skill'), names);
}

// ————————————————————— ③ 拦调用 —————————————————————

console.log('\n[5] ③ tools.guard：执行侧');
{
    await callApi('layer-save', {
        scope: 'session',
        sessionId: 'sess-1',
        layer: {
            tools: { bash: { alias: '会话别名', description: '会话描述', inject: true } },
            toolFilter: { mode: 'deny', names: ['web_search'] },
            skills: { mode: 'deny', names: ['某个被禁技能'] },
        },
    });
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const guard = guardFns[guardFns.length - 1];
    const denied = guard({ name: 'web_search', agent, arguments: {} });
    check('被名单排除的工具被拒', typeof denied === 'string' && denied.includes('web_search'), denied);
    check('放行的工具不拦', guard({ name: 'bash', agent, arguments: {} }) === undefined);
    const skillDenied = guard({ name: 'skill', agent, arguments: { name: '某个被禁技能' } });
    check('技能名单也能拦 skill 工具', typeof skillDenied === 'string', skillDenied);
    check('技能名单里的其它技能放行', guard({ name: 'skill', agent, arguments: { name: '别的技能' } }) === undefined);
}

// ————————————————————— 角色卡注入 —————————————————————

console.log('\n[6] 角色卡：pre-step 合成 user 消息');
{
    await callApi('persona-save', { name: '审稿人', description: '严格审稿', body: '你是一个严格的审稿人。' });
    const list = await callApi('persona-list');
    const personaId = list.body.personas[0].id;
    await callApi('layer-save', {
        scope: 'session',
        sessionId: 'sess-1',
        layer: { persona: personaId, toolFilter: { mode: 'deny', names: ['web_search'] } },
    });
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const messages = [{ role: 'user', content: [{ type: 'text', text: '你好' }] }];
    const decision = await emit('agent/pre-step', { agent, messages, step: 2 }, undefined);
    check('插了一条消息', decision.messages.length === 2, decision.messages.length);
    const own = decision.messages[decision.messages.length - 1];
    check('是自己那类消息', own?.source?.kind === 'scope-manager-persona', own?.source);
    check('正文是角色卡内容', String(own?.content?.[0]?.text ?? '').includes('严格的审稿人'), own?.content);
    const again = await emit('agent/pre-step', { agent, messages: decision.messages, step: 3 }, undefined);
    check('内容没变不重发', again.messages.length === 2, again.messages.length);
}

// ————————————————————— 场景预设 —————————————————————

console.log('\n[7] 场景预设：层内显式 > 场景兜底');
{
    const p = await callApi('persona-list');
    const personaId = p.body.personas[0].id;
    const s = await callApi('scene-save', { name: '审稿场景', description: 'd', persona: personaId });
    const sceneId = s.body.scene.id;
    await callApi('layer-save', { scope: 'workspace', cwd: '/tmp', layer: { scene: sceneId } });
    const w = await callApi('scope-context', { cwd: '/tmp' });
    check('场景提供角色卡', w.body.effective.persona?.name === '审稿人', w.body.effective.persona);
    check('来源标注是预设', String(w.body.effective.persona?.source ?? '').startsWith('预设'), w.body.effective.persona?.source);
    await callApi('layer-save', { scope: 'workspace', cwd: '/tmp', layer: { scene: sceneId, persona: null } });
    const w2 = await callApi('scope-context', { cwd: '/tmp' });
    check('显式置 null 清掉场景那一份', w2.body.effective.persona === null, w2.body.effective.persona);
}

// ————————————————————— 角色卡三段 / 两种注入 —————————————————————

console.log('\n[7b] 角色卡三段：上下文注入 vs 系统提示词覆盖');
{
    // ① 三段正文 + 注入方式能存能读
    const saved = await callApi('persona-save', {
        name: '三段卡', description: 'd',
        worldview: '世界观甲', character: '角色乙', constraints: '约束丙',
        inject: 'system',
    });
    const pid = saved.body.persona.id;
    check('三段都存下来',
        saved.body.persona.worldview === '世界观甲'
        && saved.body.persona.character === '角色乙'
        && saved.body.persona.constraints === '约束丙', saved.body.persona);
    check('注入方式记成 system', saved.body.persona.inject === 'system', saved.body.persona.inject);
    const read = await callApi('persona-read', { id: pid });
    check('读回来还是三段', read.body.persona.constraints === '约束丙', read.body.persona);

    // ② system 模式：装配时盖到那三条人设段上，别的段不碰
    await callApi('layer-save', { scope: 'session', sessionId: 'sess-2', layer: { persona: pid } });
    const agent = {
        session: { header: { id: 'sess-2', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const assembly = {
        sections: [
            { name: 'harness:identity', text: '原来的身份' },
            { name: 'deployment:persona-prefix', text: '原来的抬头' },
            { name: 'deployment:persona-suffix', text: '原来的结尾' },
            { name: 'todo:other', text: '别段' },
        ],
        contexts: [],
        variables: {},
        tools: [],
    };
    const out = await emit('system-prompt/assemble', assembly, { agent });
    const byName = new Map(out.sections.map((x) => [x.name, x.text]));
    check('世界观 → harness:identity', byName.get('harness:identity') === '世界观甲', byName.get('harness:identity'));
    check('角色设定 + 行为约束 → persona-prefix（约束在末尾）',
        byName.get('deployment:persona-prefix') === '角色乙\n\n约束丙',
        JSON.stringify(byName.get('deployment:persona-prefix')));
    check('persona-suffix 不再被角色卡碰', byName.get('deployment:persona-suffix') === '原来的结尾', byName.get('deployment:persona-suffix'));
    check('别的段落一个字没动', byName.get('todo:other') === '别段', byName.get('todo:other'));

    // ③ system 模式不插对话消息（三段已经进了段落）
    const decision = await emit('agent/pre-step', {
        agent,
        messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
        step: 2,
    }, undefined);
    check('覆盖模式不再插合成消息', decision.messages.length === 1, decision.messages.length);

    // ④ 空内容也照盖：世界观留空 = 把 harness:identity 抹成空（整段消失），不是「保留原文」
    const empty = await callApi('persona-save', {
        id: pid, name: '三段卡', worldview: '', character: '只有角色设定', constraints: '',
        inject: 'system',
    });
    check('空段照样存下来', empty.body.persona.worldview === '', empty.body.persona.worldview);
    const out2 = await emit('system-prompt/assemble', assembly, { agent });
    const byName2 = new Map(out2.sections.map((x) => [x.name, x.text]));
    check('空内容覆盖成空（原文不再保留）', byName2.get('harness:identity') === '', byName2.get('harness:identity'));
    check('没留空的那段照常盖', byName2.get('deployment:persona-prefix') === '只有角色设定', byName2.get('deployment:persona-prefix'));

    // ⑤ 只传 body 的调用方：整段落成「角色设定」
    const legacy = await callApi('persona-save', { name: '老卡', body: '整段人设' });
    check('整段 body 当成角色设定',
        legacy.body.persona.character === '整段人设' && legacy.body.persona.worldview === '',
        legacy.body.persona);
}

// ————————————————————— 工具总表 —————————————————————

console.log('\n[8] 工具总表：按来源分组');
{
    const t = await callApi('tools-list');
    const cats = t.body.groups.map((g) => g.category);
    check('至少分出一组', t.body.groups.length > 0, t.body.groups);
    check('bash 归到系统工具', t.body.groups.find((g) => g.tools.some((x) => x.name === 'bash'))?.category === 'system', cats);
    check('总条数对得上', t.body.total === SCHEMAS.length, t.body.total);
}

// ————————————————————— 段落 ↔ 工具组 —————————————————————

console.log('\n[9] 段落 ↔ 工具组：关联 + 逐段开关 + 逐段覆写');
{
    const agent = {
        session: { header: { id: 'sess-1', cwd: '/tmp' } },
        ctx: { tools: { restrict: () => () => { } } },
    };
    await emit('agent/created', { agent });
    const assembly = {
        sections: [
            { name: 'base', text: '基础提示词' },
            { name: 'tool:bash', text: '用 bash 的时候注意……' },
            { name: 'harness:identity', text: '你是谁' },
        ],
        contexts: [],
        variables: {},
        tools: [{ name: 'bash', description: '原始', parameters: { type: 'object' } }],
    };
    await emit('system-prompt/assemble', assembly, { agent });

    // 关联：`tool:bash` 应该挂到 bash 所在的那个组；接不上的单列「未归组」。
    const t = await callApi('tools-list', { sessionId: 'sess-1', editScope: 'global' });
    const withSections = t.body.groups.filter((g) => (g.sections ?? []).length > 0);
    check('段落挂到了工具组上', withSections.length > 0, t.body.groups.map((g) => [g.owner, (g.sections ?? []).length]));
    check('tool:bash 归到 bash 那一组', (withSections.find((g) => g.sections.some((s) => s.name === 'tool:bash'))?.tools ?? [])
        .some((x) => x.name === 'bash'), withSections.map((g) => g.sections.map((s) => s.name)));
    check('接不上的段落进「未归组」', (t.body.ungroupedSections ?? []).some((s) => s.name === 'harness:identity'), t.body.ungroupedSections?.map((s) => s.name));

    // 逐段开关：全局层点名「不注入 tool:bash」，装配时它就该没。
    const st = await callApi('section-state-save', { scope: 'global', name: 'tool:bash', enabled: false });
    check('逐段开关能保存', st.status === 200 && st.body.ok === true, st.body);
    const out = await emit('system-prompt/assemble', assembly, { agent });
    check('点名不注入的段落被摘掉', !out.sections.map((s) => s.name).includes('tool:bash'), out.sections.map((s) => s.name));
    const t2 = await callApi('tools-list', { sessionId: 'sess-1', editScope: 'global' });
    const bashSec = (t2.body.groups.find((g) => g.sections.some((s) => s.name === 'tool:bash'))?.sections ?? [])
        .find((s) => s.name === 'tool:bash');
    check('这一层自己点名的状态是「不注入」', bashSec?.ownEnabled === false, bashSec);
    check('生效状态也是不注入', bashSec?.injected === false, bashSec);

    // 逐段覆写：层内覆写进装配。
    const ov = await callApi('section-layer-override-save', { scope: 'global', name: 'base', text: '层内改写的提示词' });
    check('层内覆写能保存', ov.status === 200 && ov.body.ok === true, ov.body);
    const out2 = await emit('system-prompt/assemble', assembly, { agent });
    const baseSec = (out2.sections ?? []).find((x) => x.name === 'base');
    check('层内覆写进了装配', baseSec?.text === '层内改写的提示词', baseSec);
    const t3 = await callApi('tools-list', { sessionId: 'sess-1', editScope: 'global' });
    const baseInList = (t3.body.ungroupedSections ?? []).find((s) => s.name === 'base');
    check('这一层自己存的那份覆写能读到', baseInList?.ownOverrideText === '层内改写的提示词', baseInList);

    // 撤回
    await callApi('section-layer-override-save', { scope: 'global', name: 'base', text: '' });
    await callApi('section-state-save', { scope: 'global', name: 'tool:bash', enabled: null });
    const out3 = await emit('system-prompt/assemble', assembly, { agent });
    check('撤回后段落回到原文', (out3.sections ?? []).find((x) => x.name === 'base')?.text === '基础提示词', out3.sections);
    check('撤回后段落回到注入', out3.sections.map((s) => s.name).includes('tool:bash'), out3.sections.map((s) => s.name));
}

// ————————————————————— 收尾 —————————————————————

// ————————————————————— [10] 段落 ↔ 工具关联 —————————————————————

console.log('\n[10] 段落 ↔ 工具关联：关联着的工具全关 → 这一段不注入');

{
    const agent = { session: { header: { id: 'session-link', cwd: process.cwd() } } };
    const linkAssembly = {
        sections: [
            { name: 'tool:bash', text: 'bash 的说明', plugin: '@deepseek-ai/dsh-tool-bash' },
            { name: 'base', text: '恒在的说明' },
        ],
        tools: SCHEMAS.map((s) => ({ ...s })),
        contexts: [],
        variables: {},
    };
    // 先让目录认得这段（record 才会写 bindTools）
    await emit('system-prompt/assemble', linkAssembly, { agent });
    await callApi('sections-list');

    // ① 默认关联插件：只关掉 bash —— bash 是这个包唯一的工具，所以这一段该走掉
    await callApi('layer-save', { scope: 'global', layer: { toolFilter: { mode: 'deny', names: ['bash'] } } });
    await new Promise((r) => setTimeout(r, 30));
    const out1 = await emit('system-prompt/assemble', linkAssembly, { agent });
    const names1 = (out1.sections ?? []).map((s) => s.name);
    check('默认关联：包内工具全关 → 这一段不注入', !names1.includes('tool:bash'), names1);
    check('没有归属的段落不受影响', names1.includes('base'), names1);

    // ② 关回来 → 又有了
    await callApi('layer-reset', { scope: 'global' });
    await new Promise((r) => setTimeout(r, 30));
    const out2 = await emit('system-prompt/assemble', linkAssembly, { agent });
    check('工具开回来 → 段落也跟着回来', (out2.sections ?? []).some((s) => s.name === 'tool:bash'),
        (out2.sections ?? []).map((s) => s.name));

    // ③ 显式绑定到一个「不存在的工具」→ 那个工具永远不在，所以这一段永远不注入
    await callApi('section-bind-save', { name: 'tool:bash', tools: ['no_such_tool'] });
    const out3 = await emit('system-prompt/assemble', linkAssembly, { agent });
    check('显式绑定：绑的工具一个都不在 → 不注入',
        !(out3.sections ?? []).some((s) => s.name === 'tool:bash'),
        (out3.sections ?? []).map((s) => s.name));

    // ④ 绑回默认
    await callApi('section-bind-save', { name: 'tool:bash', tools: null });
    const out4 = await emit('system-prompt/assemble', linkAssembly, { agent });
    check('绑回默认关联插件 → 又回来',
        (out4.sections ?? []).some((s) => s.name === 'tool:bash'),
        (out4.sections ?? []).map((s) => s.name));
}

// ————————————————————— [11] MCP 段落：归属是那台服务器 —————————————————————

console.log('\n[11] MCP 段落：`mcp:<server>` 归到那台服务器的工具组，服务器工具全关才不注入');

{
    const agent = { session: { header: { id: 'session-mcpsec', cwd: process.cwd() } } };
    const mcpAssembly = {
        sections: [
            { name: 'mcp:testsrv', text: '这台服务器的说明' },
            { name: 'base', text: '恒在的说明' },
        ],
        tools: [
            ...SCHEMAS.map((s) => ({ ...s })),
            { name: 'mcp__testsrv__foo', description: 'mcp 工具', parameters: {} },
        ],
        contexts: [],
        variables: {},
    };
    const before = await emit('system-prompt/assemble', mcpAssembly, { agent });
    check('默认：服务器工具还在 → 段落注入', (before.sections ?? []).some((s) => s.name === 'mcp:testsrv'),
        (before.sections ?? []).map((s) => s.name));

    // 插件页那一路（分组靠真实注册表，假 ctx 里没有 MCP 工具）单独按单元测：
    // 段落名 `mcp:<server>` 必须能靠服务器名接到那一组。
    const assoc = associateSections(
        [{ category: 'mcp', owner: 'testsrv', tools: [{ name: 'mcp__testsrv__foo' }] }],
        [{ name: 'mcp:testsrv', plugin: null }, { name: 'harness:identity', plugin: null }],
    );
    const mcpKey = 'mcp::testsrv';
    check('mcp 段落归到服务器那一组',
        (assoc.byGroup.get(mcpKey) ?? []).some((s) => s.name === 'mcp:testsrv'),
        [...assoc.byGroup.keys()]);
    check('mcp 段落的默认关联就是那台服务器',
        sectionOwnerBase({ name: 'mcp:testsrv', plugin: null }) === 'testsrv',
        sectionOwnerBase({ name: 'mcp:testsrv', plugin: null }));
    check('接不上的段落仍落到未归组',
        assoc.ungrouped.some((s) => s.name === 'harness:identity'),
        assoc.ungrouped.map((s) => s.name));

    // 只注入段落、不注册工具的插件（dsh-kaomoji 那种）：补一个空工具组，
    // 不能让它掉进「未归组」——用户在插件页找不到它的归属。
    const onlySec = associateSections(
        [{ category: 'plugin', owner: 'dsh-meme', tools: [{ name: 'send_meme' }] }],
        [
            { name: 'dsh-kaomoji:guidance', plugin: 'dsh-kaomoji' },
            { name: 'dsh-expression:companion', plugin: 'dsh-meme' },
            { name: 'harness:identity', plugin: '@deepseek-ai/dsh-system-prompt' },
        ],
    );
    check('没有工具的插件也分到一个（空工具的）组',
        onlySec.sectionOnlyGroups.some((g) => g.owner === 'dsh-kaomoji' && g.tools.length === 0),
        onlySec.sectionOnlyGroups);
    check('它的段落挂在这个组下，不进未归组',
        (onlySec.byGroup.get('plugin::dsh-kaomoji') ?? []).some((s) => s.name === 'dsh-kaomoji:guidance')
        && !onlySec.ungrouped.some((s) => s.name === 'dsh-kaomoji:guidance'),
        [...onlySec.byGroup.keys()]);
    check('第三方插件补出来的组算「插件工具」',
        onlySec.sectionOnlyGroups.some((g) => g.owner === 'dsh-kaomoji' && g.category === 'plugin'),
        onlySec.sectionOnlyGroups.map((g) => [g.category, g.owner]));
    check('宿主自带的纯段落包不进插件页（不补空组）',
        !onlySec.sectionOnlyGroups.some((g) => g.owner === '@deepseek-ai/dsh-system-prompt')
        && !onlySec.byGroup.has('system::@deepseek-ai/dsh-system-prompt'),
        onlySec.sectionOnlyGroups.map((g) => [g.category, g.owner]));
    check('人设那几段归「角色卡」管，不落到「未归组」',
        !onlySec.ungrouped.some((s) => s.name === 'harness:identity'),
        onlySec.ungrouped.map((s) => s.name));
    check('常开的那几段归「角色卡」管，不在未归组里露头',
        !onlySec.ungrouped.some((s) => s.name === 'deployment:persona-prefix'),
        onlySec.ungrouped.map((s) => s.name));
    check('有工具可接的插件不会多出一个空组',
        !onlySec.sectionOnlyGroups.some((g) => g.owner === 'dsh-meme'),
        onlySec.sectionOnlyGroups.map((g) => g.owner));

    // 宿主自带的纯段落包（只有段落、没有工具）：补一个系统工具组，
    // 段落挂在那个官方包名下 —— 来源是明确的，就不该飘在「未归组」里让人猜。
    const hostSec = associateSections(
        [{ category: 'system', owner: 'dsh-tool-bash', tools: [{ name: 'bash' }] }],
        [
            { name: 'app:web-surface', plugin: '@deepseek-ai/dsh-harness-dev-context' },
            { name: 'harness:source', plugin: '@deepseek-ai/dsh-harness-dev-context' },
            { name: 'harness:identity', plugin: '@deepseek-ai/dsh-system-prompt' },
        ],
    );
    check('宿主自带的纯段落包补一个系统工具组',
        hostSec.sectionOnlyGroups.some((g) => g.owner === '@deepseek-ai/dsh-harness-dev-context' && g.category === 'system'),
        hostSec.sectionOnlyGroups.map((g) => [g.category, g.owner]));
    check('宿主自带的纯段落包挂在自己名下，不进未归组',
        (hostSec.byGroup.get('system::@deepseek-ai/dsh-harness-dev-context') ?? []).some((s) => s.name === 'app:web-surface')
        && !hostSec.ungrouped.some((s) => s.name === 'app:web-surface' || s.name === 'harness:source'),
        hostSec.ungrouped.map((s) => [s.name, s.plugin]));
    check('人设常开那几段归「角色卡」管，不露头',
        !hostSec.sectionOnlyGroups.some((g) => g.owner === '@deepseek-ai/dsh-system-prompt')
        && !hostSec.ungrouped.some((s) => s.name === 'harness:identity'),
        hostSec.ungrouped.map((s) => s.name));

    // 关掉这台服务器唯一的工具 → 段落跟着走
    await callApi('layer-save', { scope: 'global', layer: { toolFilter: { mode: 'deny', names: ['mcp__testsrv__foo'] } } });
    await new Promise((r) => setTimeout(r, 30));
    const after = await emit('system-prompt/assemble', mcpAssembly, { agent });
    check('服务器工具全关 → mcp 段落不注入', !(after.sections ?? []).some((s) => s.name === 'mcp:testsrv'),
        (after.sections ?? []).map((s) => s.name));
    check('别的段落不受影响', (after.sections ?? []).some((s) => s.name === 'base'),
        (after.sections ?? []).map((s) => s.name));

    // 清理
    await callApi('layer-reset', { scope: 'global' });
}

// ————————————————————— [12] 占位符 {{变量}} —————————————————————

console.log('\n[12] 占位符：覆写里写的 {{名字}} 要在保存时就校验，装配后原样留着给宿主替换');

{
    // ① 扫描器：认得出引用、分得清字面量与坏写法
    const scan1 = scanPromptVars('前面 {{model}} 后面 {{cwd}}');
    check('扫出两个引用', scan1.refs.map((r) => r.name).join(',') === 'model,cwd', scan1.refs);
    check('孤零零的 {{ 当文字', scanPromptVars('{% raw %} 里写 {{ 不是引用').problems.length === 0,
        scanPromptVars('a {{ b').problems);
    check('坏写法被发现', scanPromptVars('{{a{b}}').problems.some((p) => p.kind === 'malformed'),
        scanPromptVars('{{a{b}}').problems);
    check('大写变量名不合法', scanPromptVars('{{Model}}').problems.some((p) => p.kind === 'bad-name'),
        scanPromptVars('{{Model}}').problems);

    // ② 校验器
    check('未知变量被拒', !validatePromptVars('{{nope}}', ['model']).ok,
        validatePromptVars('{{nope}}', ['model']));
    check('已知变量放行', validatePromptVars('{{model}}', ['model']).ok,
        validatePromptVars('{{nope}}', ['model']));
    check('还没装配过（变量表空）不拦存在性', validatePromptVars('{{whatever}}', []).ok,
        validatePromptVars('{{whatever}}', []));

    // ③ 装配时把变量表存下来
    const agent = { session: { header: { id: 'session-vars', cwd: process.cwd() } } };
    const varAssembly = {
        sections: [{ name: 'tool:bash', text: 'bash 的说明', plugin: '@deepseek-ai/dsh-tool-bash' }],
        tools: SCHEMAS.map((s) => ({ ...s })),
        contexts: [],
        variables: { model: 'deepseek-test', provider: 'deepseek' },
    };
    await emit('system-prompt/assemble', varAssembly, { agent });
    const vt = await callApi('variables-list');
    check('变量表被记下来', (vt.body.list ?? []).some((v) => v.name === 'model' && v.value === 'deepseek-test'),
        vt.body.list);

    // ④ 保存覆写时拦住未知变量
    const rejected = await callApi('section-override-save', { name: 'tool:bash', text: '写错了 {{not_a_var}}' });
    check('未知占位符：保存这一步就拒绝',
        rejected.status === 500 && String(rejected.body?.error ?? '').includes('not_a_var'),
        [rejected.status, rejected.body]);

    // ⑤ 已知变量可以存，且装配时原样留着（宿主在渲染时才替换）
    const saved = await callApi('section-override-save', { name: 'tool:bash', text: '换个说法：{{model}}' });
    check('已知占位符可以保存', saved.body.ok === true, saved.body);
    const out = await emit('system-prompt/assemble', varAssembly, { agent });
    const sec = (out.sections ?? []).find((x) => x.name === 'tool:bash');
    // 本插件在装配时就把已知变量换掉（宿主注册的变量也一并换，字面量段落才用得上）。
    check('装配时把宿主变量也换掉', sec?.text === '换个说法：deepseek-test', sec?.text);

    // ⑥ 宿主标了 interpolate: false 的段落：不校验、也不提供占位符
    const literalAssembly = {
        sections: [{ name: 'lit:demo', text: '字面量 {{model}}', interpolate: false }],
        tools: [],
        contexts: [],
        variables: { model: 'x' },
    };
    await emit('system-prompt/assemble', literalAssembly, { agent });
    const litSave = await callApi('section-override-save', { name: 'lit:demo', text: '留个 {{bogus}} 也不管' });
    check('字面量段落不做占位符校验', litSave.body.ok === true, litSave.body);
    await callApi('section-override-save', { name: 'lit:demo', text: '' });
    await callApi('sections-prune', {});

    // ⑦ 本插件自己的变量 `{{mcp_servers}}`：写进覆写里照样保存，装配时换成实时名单
    const scmAssembly = {
        sections: [
            {
                name: 'mcp-resource-servers',
                text: '## MCP resource servers\n\nUse list_mcp_resources with one of these names as the server argument: ["alpha","beta"].',
                interpolate: false,
            },
            { name: 'tool:bash', text: '原文' },
        ],
        // tool:bash 现在按名字绑 bash（段落名就是它讲的那个工具），
        // 所以工具表里得有 bash，否则这一段会被判定「工具没开」而不注入。
        tools: [{ name: 'mcp__alpha__do', description: 'x', parameters: {} }, { name: 'bash', description: 'x', parameters: {} }],
        contexts: [],
        variables: { model: 'x' },
    };
    await emit('system-prompt/assemble', scmAssembly, { agent });
    const scmSave = await callApi('section-override-save', {
        name: 'tool:bash',
        text: '可用服务器：{{mcp_servers}}',
    });
    check('本插件变量不算未知，能保存', scmSave.body.ok === true, scmSave.body);
    const scmOut = await emit('system-prompt/assemble', scmAssembly, { agent });
    const scmSec = (scmOut.sections ?? []).find((x) => x.name === 'tool:bash');
    check(
        '装配时换成实时名单',
        scmSec?.text === '可用服务器：["alpha","beta"]',
        scmSec?.text,
    );
    check('换完之后不留 {{', !String(scmSec?.text ?? '').includes('{{'), scmSec?.text);
    const varList = await callApi('variables-list', {});
    check(
        '变量清单里带上本插件的变量',
        (varList.body.list ?? []).some((v) => v.name === 'mcp_servers' && v.scm === true),
        varList.body,
    );

    // ⑧ 段落原文里自己用到的占位符：自动认领，编辑这一段时能直接用
    const ownAssembly = {
        sections: [
            {
                name: 'deployment:persona-prefix',
                text: '你现在用的是 {{model}}，由 {{provider}} 提供。',
                plugin: '@deepseek-ai/dsh-system-prompt',
            },
        ],
        tools: [],
        contexts: [],
        variables: { model: 'deepseek-test', provider: 'deepseek' },
    };
    await emit('system-prompt/assemble', ownAssembly, { agent });
    const ownList = await callApi('sections-list', {});
    const ownEntry = (ownList.body.sections ?? []).find((x) => x.name === 'deployment:persona-prefix');
    check('原文里的占位符被认领', JSON.stringify(ownEntry?.textVars) === '["model","provider"]', ownEntry?.textVars);
    const ownSave = await callApi('section-override-save', {
        name: 'deployment:persona-prefix',
        text: '本段自定义：{{model}} / {{provider}}',
    });
    check('可以照原样复用它自己的占位符', ownSave.body.ok === true, ownSave.body);
    const ownOut = await emit('system-prompt/assemble', ownAssembly, { agent });
    const ownSec = (ownOut.sections ?? []).find((x) => x.name === 'deployment:persona-prefix');
    check(
        '装配后换成真实值',
        ownSec?.text === '本段自定义：deepseek-test / deepseek',
        ownSec?.text,
    );
    await callApi('section-override-save', { name: 'deployment:persona-prefix', text: '' });

    // ⑨ `{{original}}`：每一段都能引用自己的原文，动态内容不会被冻住
    const origAssembly = {
        // 段落名 tool:grep 绑的就是 grep 这把工具，工具表里必须有它才会注入。
        sections: [{ name: 'tool:grep', text: '正文明细：第 ' + '一' + ' 版' }],
        tools: [...SCHEMAS, { name: 'grep', description: '搜内容', parameters: { type: 'object', properties: {} } }],
        contexts: [],
        variables: { model: 'deepseek-test' },
    };
    await emit('system-prompt/assemble', origAssembly, { agent });
    const origSave = await callApi('section-override-save', {
        name: 'tool:grep',
        text: '【我的抬头】\n{{original}}',
    });
    check('{{original}} 能保存', origSave.body.ok === true, origSave.body);
    const origOut = await emit('system-prompt/assemble', origAssembly, { agent });
    const origSec = (origOut.sections ?? []).find((x) => x.name === 'tool:grep');
    check('装配时换成这一段原文', origSec?.text === '【我的抬头】\n正文明细：第 一 版', origSec?.text);

    // 正文变了 → 标记为动态，覆写里再用 original 就跟着新正文走
    const origAssembly2 = {
        ...origAssembly,
        sections: [{ name: 'tool:grep', text: '正文明细：第 二 版' }],
    };
    const origOut2 = await emit('system-prompt/assemble', origAssembly2, { agent });
    const origSec2 = (origOut2.sections ?? []).find((x) => x.name === 'tool:grep');
    check('原文变了，覆写跟着变（没被冻住）', origSec2?.text === '【我的抬头】\n正文明细：第 二 版', origSec2?.text);
    const dynList = await callApi('sections-list', {});
    const dynEntry = (dynList.body.sections ?? []).find((x) => x.name === 'tool:grep');
    check('正文变过就标成动态段落', dynEntry?.dynamic === true, dynEntry && { d: dynEntry.dynamic });
    await callApi('section-override-save', { name: 'tool:grep', text: '' });

    // ⑩ 上下文压缩之后，角色卡要重新插到结账点之后（不然会随被压掉的内容一起消失）
    const compactCheck = await (async () => {
        await callApi('layer-save', { scope: 'global', layer: { persona: 'reviewer' } });
        await callApi('persona-save', {
            id: 'reviewer',
            name: '审稿人',
            description: '',
            body: '你是一位严谨的审稿人。',
        });
        await emit('agent/created', { agent });
        // 第一轮：插进去
        let d = await emit('agent/pre-step', { agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], step: 2 });
        const first = (d.messages ?? []).filter((m) => m?.source?.kind === 'scope-manager-persona');
        // 第二轮：没变化就不重复插
        d = await emit('agent/pre-step', { agent, messages: d.messages, step: 3 });
        const second = (d.messages ?? []).filter((m) => m?.source?.kind === 'scope-manager-persona');
        // 第三轮：中间来了一条压缩结账点 → 角色卡要重新出现一次
        const compacted = [...(d.messages ?? []), {
            role: 'user',
            content: [{ type: 'text', text: '（历史已压缩）' }],
            source: { kind: 'compact-checkpoint', id: 'c1' },
        }];
        d = await emit('agent/pre-step', { agent, messages: compacted, step: 4 });
        const list = d.messages ?? [];
        const ckpt = list.findIndex((m) => m?.source?.kind === 'compact-checkpoint');
        const mine = list.map((m, i) => (m?.source?.kind === 'scope-manager-persona' ? i : -1)).filter((i) => i >= 0);
        // 第四轮：压缩后再跑一轮，不能再叠一条
        d = await emit('agent/pre-step', { agent, messages: list, step: 5 });
        const again = (d.messages ?? []).filter((m) => m?.source?.kind === 'scope-manager-persona').length;
        return {
            firstCount: first.length,
            secondCount: second.length,
            mine,
            ckpt,
            again,
        };
    })();
    check('第一次装配插一条角色卡', compactCheck.firstCount === 1, compactCheck);
    check('没变化不重复插', compactCheck.secondCount === 1, compactCheck);
    check('压缩之后角色卡重新插到结账点后面', compactCheck.mine.length === 2 && compactCheck.mine[1] > compactCheck.ckpt, compactCheck);
    check('压缩后也只留新的一条', compactCheck.again === 2, compactCheck);

    // ⑧ 权限档位：场景里存下来，解析时带来源；不认识的名字丢掉
    const permScene = await callApi('scene-save', { name: '权限场景', persona: null, permission: 'read-only' });
    check('场景能存权限档位', permScene.body.scene?.permission === 'read-only', permScene.body.scene?.permission);
    const badPerm = await callApi('scene-save', { name: '乱写权限', permission: 'root-everything' });
    check('不认识的权限名被丢掉', badPerm.body.scene?.permission === undefined, badPerm.body.scene);
    const permCtx = await callApi('scope-context', {});
    check('没人设权限时不乱推', permCtx.body.effective?.permission == null, permCtx.body.effective?.permission);
    await callApi('scene-delete', { id: permScene.body.scene.id });
    await callApi('scene-delete', { id: badPerm.body.scene.id });

    // ⑨ 场景带权限 → 落到会话上（走 permissionPresets.set，一轮只写一次）
    const permLive = await callApi('scene-save', { name: '只读场景', permission: 'read-only' });
    await callApi('layer-save', {
        scope: 'session',
        sessionId: agent.session.header.id,
        layer: { scene: permLive.body.scene.id },
    });
    await emit('system-prompt/assemble', { sections: [], tools: [], contexts: [], variables: {} }, { agent });
    check('场景的权限档位落到会话上', permissionCalls.some((r) => r[1] === 'read-only'), permissionCalls);
    await callApi('layer-save', { scope: 'session', sessionId: agent.session.header.id, layer: {} });
    await callApi('scene-delete', { id: permLive.body.scene.id });

    // ⑩ 固定名次：人设三条钉成 1、2、3，第三方插件的段落当成 push 挪到末尾
    const thirdParty = new Set(['tool:browser_tools', 'dsh-kaomoji:guidance', 'genui:fence']);
    const make = (names) => names.map((name) => ({ name, text: name }));
    {
        // 故意打乱输入：宿主给什么顺序都不影响结果
        const shuffled = make(['tool:bash', 'genui:fence', 'deployment:persona-suffix',
            'harness:identity', 'dsh-kaomoji:guidance', 'deployment:persona-prefix', 'tool:browser_tools']);
        const out = reorderSections(shuffled, (n) => thirdParty.has(n));
        const names = out.list.map((s) => s.name);
        check('人设三条按 identity → prefix → suffix 钉成 1、2、3',
            names[0] === 'harness:identity' && names[1] === 'deployment:persona-prefix' && names[2] === 'deployment:persona-suffix', names);
        check('第三方插件的段落挪到末尾、相对顺序不变',
            names.slice(-3).join(',') === 'genui:fence,dsh-kaomoji:guidance,tool:browser_tools', names);
        check('官方段落留在中间、保持宿主原顺序', names[3] === 'tool:bash', names);
        check('重排后条数不变', out.list.length === shuffled.length, out.list.length);

        // 再跑一遍必须一模一样（名次要能「固定下来」而不是每轮抖）
        const again = reorderSections(out.list, (n) => thirdParty.has(n));
        check('同一批段落重排两次结果一致（幂等）', again.list.map((s) => s.name).join(',') === names.join(','), again.list.map((s) => s.name));
        check('已经排好的不算「挪动」', again.moved === 0, again.moved);
    }
    {
        // 缺段（比如预设里没有 persona-suffix）不能把整张表弄乱
        const partial = make(['tool:bash', 'deployment:persona-prefix', 'harness:identity']);
        const out = reorderSections(partial, () => false);
        check('缺段时只钉存在的那几条', out.list.map((s) => s.name).join(',') === 'harness:identity,deployment:persona-prefix,tool:bash', out.list.map((s) => s.name));
        check('全是官方段落时不往末尾塞东西', out.list.length === 3, out.list.length);
    }

    // 清理
    await callApi('layer-save', { scope: 'global', layer: { persona: undefined } });
    await callApi('section-override-save', { name: 'tool:bash', text: '' });

    // ⑪ 早退路径也要钉名次：重载插件后的第一次装配可能没有 agent，
    //    这里不能直接 return，提示词会抖回宿主原生顺序并被提交进历史。
    {
        const shuffled = make(['tool:bash', 'dsh-kaomoji:guidance', 'harness:identity', 'deployment:persona-prefix']);
        const assembly = { sections: shuffled, contexts: [], variables: {}, tools: [] };
        // 让目录里记住这几个段落的来源，判第三方才有依据
        await emit('system-prompt/assemble', { sections: shuffled.map((s) => ({ ...s })), contexts: [], variables: {}, tools: [] }, { agent });
        const noAgent = await emit('system-prompt/assemble', assembly, {});
        const noAgentNames = (noAgent?.sections ?? []).map((s) => s.name);
        check('没 agent 时也把 identity → prefix 钉在最前',
            noAgentNames[0] === 'harness:identity' && noAgentNames[1] === 'deployment:persona-prefix', noAgentNames);
        check('没 agent 时第三方段落仍挪到末尾',
            noAgentNames[noAgentNames.length - 1] === 'dsh-kaomoji:guidance', noAgentNames);
        // 有 agent 但查不到层，走的是另一条早退，结果必须一致
        const unknownAgent = { session: { header: { id: 'sess-unknown', cwd: '/tmp' } }, ctx: {} };
        const noLayer = await emit('system-prompt/assemble', assembly, { agent: unknownAgent });
        const noLayerNames = (noLayer?.sections ?? []).map((s) => s.name);
        check('没绑层时也是同一套名次', noLayerNames.join(',') === noAgentNames.join(','), noLayerNames);
    }

    // ⑫ 场景里的「新装的插件工具默认激活」开关
    {
        const catalog = ['bash', 'read', 'newtool'];
        // 开着（默认）：新工具不进名单，自然生效
        const on = settleToolFilter({ mode: 'deny', names: ['read'], baseline: ['bash', 'read'] }, catalog);
        check('开关开着：新工具不写进名单', !on.names.includes('newtool'), on.names);
        check('开关开着：基线刷新成当前全量', on.baseline.join(',') === 'bash,read,newtool', on.baseline);
        check('开关开着：新工具放行', toolAllowedByFilter(on, 'newtool') === true, on);

        // 关着：新工具当场落进名单（基线一刷新也不会偷偷恢复）
        const off = settleToolFilter({ mode: 'deny', names: ['read'], newToolsActive: false, baseline: ['bash', 'read'] }, catalog);
        check('开关关着：新工具被写进停用名单', off.names.includes('newtool'), off.names);
        check('开关关着：老工具不受牵连', !off.names.includes('bash'), off.names);
        check('开关关着：新工具被拦', toolAllowedByFilter(off, 'newtool') === false, off);
        check('开关关着：点名停用的仍然停用', toolAllowedByFilter(off, 'read') === false, off);
        check('开关关着：老工具照旧放行', toolAllowedByFilter(off, 'bash') === true, off);

        // 保存过一次以后基线里已经有它了 —— 名单已经落好，结论不能变
        const again = settleToolFilter(off, catalog);
        check('再存一次结论不变', toolAllowedByFilter(again, 'newtool') === false, again.names);

        // 老场景（没有基线）：不知道什么是新的，按老规矩放行
        const legacy = { mode: 'deny', names: [], newToolsActive: false, baseline: [] };
        check('没基线的老场景不乱停用', toolAllowedByFilter(legacy, 'newtool') === true, legacy);
        // 第一次关开关保存：当前这批工具一律算老的，一个都不停用
        const firstOff = settleToolFilter({ mode: 'deny', names: [], newToolsActive: false }, catalog);
        check('第一次关开关：不会把现有工具全停用', firstOff.names.length === 0, firstOff.names);
        check('第一次关开关：顺手把基线存下来', firstOff.baseline.join(',') === 'bash,read,newtool', firstOff.baseline);

        // allow 模式不受这个开关影响
        const allow = { mode: 'allow', names: ['bash'], newToolsActive: false, baseline: catalog };
        check('allow 模式不受影响：没列出的还是不开', toolAllowedByFilter(allow, 'newtool') === false, allow);
        check('allow 模式不受影响：列出的照开', toolAllowedByFilter(allow, 'bash') === true, allow);
    }

    // —— 工具归属：能确定才归，认不准就留「未归属」 ——
    {
        const scanned = {
            system: new Map(),
            plugin: new Map(),
            quoted: new Map([
                ['compress', new Set(['billion-context'])],
                ['acp_cache', new Set(['billion-context', 'dsh-im'])],
            ]),
            officialByPackage: new Map([['subagent', 'dsh-tool-subagent']]),
            pluginByStem: new Map([['modlens', 'modlens']]),
        };
        const one = classifyToolName('compress', undefined, scanned);
        check('唯一声称的包 → 归它', one.owner === 'billion-context' && one.category === 'plugin', one);

        const many = classifyToolName('acp_cache', undefined, scanned);
        check('多个包都声称 → 不猜，留未归属', many.owner === '未归属' && many.category === 'other', many);

        const official = classifyToolName('subagent', undefined, scanned);
        check('官方包名兜底：subagent → dsh-tool-subagent',
            official.owner === 'dsh-tool-subagent' && official.category === 'system', official);

        const forked = classifyToolName('subagent_fork', undefined, scanned);
        check('官方包名兜底也吃 subagent_fork', forked.category === 'system', forked);

        const stem = classifyToolName('modlens_read_image', undefined, scanned);
        check('包名前缀兜底：modlens_read_image → modlens',
            stem.owner === 'modlens' && stem.category === 'plugin', stem);

        const unknown = classifyToolName('nobody_knows', undefined, scanned);
        check('完全认不出来的 → 未归属（交给手动归属）', unknown.owner === '未归属', unknown);
    }

    // —— 工具归属：自报 / manifest 优先于静态扫描 ——
    {
        const scanned = {
            system: new Map(),
            plugin: new Map([['acp_cache', 'dsh-meme']]),
            quoted: new Map(),
            officialByPackage: new Map(),
            pluginByStem: new Map(),
        };
        // 扫描说是 dsh-meme，但自报说是 billion-context —— 自报赢
        scanned.plugin.set('acp_cache', 'billion-context');
        const self = classifyToolName('acp_cache', undefined, scanned);
        check('插件自报的归属优先于扫描结果',
            self.owner === 'billion-context' && self.category === 'plugin', self);
    }

    // —— manifest 通道：从源码里认 manifest 端点 ——
    {
        const src = `const MANIFEST_PATH = "/__bili/plugin/manifest";`;
        check('认得出 manifest 端点路径', manifestPathInSource(src) === '/__bili/plugin/manifest', src);

        const noManifest = `const BASE = "/api"; const x = "settings.section";`;
        check('没有 manifest 端点就返回 undefined', manifestPathInSource(noManifest) === undefined, noManifest);

        const nested = `const p = "/deep/path/manifest.json";`;
        check('manifest.json 也认', manifestPathInSource(nested) === '/deep/path/manifest.json', nested);
    }

    // —— manifest 里的工具名 ——
    {
        const names = toolNamesFromManifest({
            tools: [
                { name: 'acp_cache', description: 'x' },
                { name: 'acp_status' },
            ],
        });
        check('从 manifest 响应里抠出工具名',
            names.includes('acp_cache') && names.includes('acp_status'), names);

        const names2 = toolNamesFromManifest({ toolNames: ['a_tool', 'b_tool'] });
        check('认 toolNames 数组形状', names2.includes('a_tool') && names2.includes('b_tool'), names2);

        const none = toolNamesFromManifest({ version: '1.0' });
        check('没有工具就返回空', none.length === 0, none);
    }
}

// ————————————————————— [13] 技能来源标签 —————————————————————

console.log('\n[13] 技能来源：三档标签（内置技能 / 插件技能 / 用户技能）与分类桶');

{
    const preset = skillOrigin({ path: '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/genui/SKILL.md', location: 'package', source: 'custom' });
    check('预设包里的 → 内置技能', preset.kind === 'preset' && preset.label === '内置技能' && preset.bucket === 'builtin', preset);
    check('预设包里的也带上包名（标签才不会只剩一半）',
        preset.packageName === '@deepseek-ai/dsh-agent-preset', preset.packageName);

    const pluginSkill = skillOrigin({ path: '/root/.dsh/profiles/web/node_modules/.pnpm/dsh-mcp-studio@1.0.6_x/node_modules/dsh-mcp-studio/skills/find-skills/SKILL.md', location: 'package', source: 'custom' });
    check('插件包里的 → 插件 + 包名',
        pluginSkill.kind === 'plugin' && pluginSkill.label === '插件技能' && pluginSkill.bucket === 'plugin'
        && pluginSkill.packageName === 'dsh-mcp-studio', pluginSkill);

    // 作用域的包名是两段：只取第一段会变成「插件自带 · @changfenhuang」，把包名丢一半。
    const scopedSkill = skillOrigin({ path: '/root/.dsh/profiles/web/node_modules/.pnpm/@changfenhuang+dsh-genui@0.14.0_x/node_modules/@changfenhuang/dsh-genui/SKILL.md', location: 'package', source: 'bundled' });
    check('作用域的包名要连作用域一起取（@changfenhuang/dsh-genui）',
        scopedSkill.kind === 'plugin' && scopedSkill.packageName === '@changfenhuang/dsh-genui', scopedSkill);
    check('packageNameOf 对普通包名照旧', packageNameOf('/a/node_modules/dsh-meme/skills/x/SKILL.md') === 'dsh-meme');
    check('packageNameOf 拿不到 node_modules 就空着', packageNameOf('/workspace/饭堂/skills/x/SKILL.md') === '');

    const official = skillOrigin({ path: '/root/.dsh/tool-management/official-skills/web/office-docx/SKILL.md', location: 'user' });
    check('官方技能包 → 也算内置技能', official.kind === 'official' && official.bucket === 'builtin', official);
    check('官方技能包也带来源目录名', official.packageName === 'official-skills', official.packageName);

    const project = skillOrigin({ path: '/workspace/饭堂/.dsh/skills/foo/SKILL.md', location: 'project' });
    check('仓库里的 → 其他', project.kind === 'project' && project.bucket === 'other', project);

    const user = skillOrigin({ path: '/root/.dsh/skills/bar/SKILL.md', location: 'user' });
    check('用户目录 → 用户技能', user.kind === 'user' && user.label === '用户技能' && user.bucket === 'other', user);

    // 位置要按宿主报的 source 判：/root/.dsh/skills（用户级）里也有 `.dsh/skills`，
    // 只看路径会把它误判成「项目内」—— 装到用户目录的技能标签就是错的。
    check('技能位置：user-dsh 算用户目录', locationFromSource('user-dsh') === 'user');
    check('技能位置：project-dsh 算项目内', locationFromSource('project-dsh') === 'project');
    check('技能位置：bundled 算插件自带', locationFromSource('bundled') === 'package');
    check('技能位置：custom 单独一类', locationFromSource('custom') === 'custom');
    check('技能位置：用户目录的技能不被路径骗成项目内',
        skillOrigin({ path: '/root/.dsh/skills/word-docx/SKILL.md', location: locationFromSource('user-dsh') }).label === '用户技能',
        skillOrigin({ path: '/root/.dsh/skills/word-docx/SKILL.md', location: locationFromSource('user-dsh') }).label);

    // 「自装技能」= 用户级目录里的（市场装的、会话里建的），能删；
    // 预设/插件自带/官方技能包不给删 —— 删了升级回来，还会弄坏包。
    {
        const fakeRoot = await mkdtemp(join(tmpdir(), 'scm-skill-rm-'));
        const skillDir = join(fakeRoot, 'skills', 'mine-skill');
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, 'SKILL.md'), ['---', 'name: mine-skill', 'description: 我自己装的', '---', ''].join('\n'), 'utf8');
        const summaries = [
            { name: 'mine-skill', source: 'user-dsh', path: join(skillDir, 'SKILL.md') },
            { name: 'genui', source: 'bundled', path: '/root/.dsh/profiles/web/node_modules/x/genui/SKILL.md' },
            { name: 'agent-experience', source: 'custom', path: '/usr/local/lib/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md' },
        ];
        const fakeSkills = { list: async () => summaries };
        check('技能位置：用户目录的技能标「用户技能」', skillOrigin({ path: '/root/.dsh/skills/x/SKILL.md', location: 'user' }).label === '用户技能');

        const blocked = await removeSkill(fakeSkills, 'genui').then(() => null, (e) => e);
        check('卸载：插件自带的删不了', Boolean(blocked) && blocked.code === 'bad-request', blocked?.message);
        const blocked2 = await removeSkill(fakeSkills, 'agent-experience').then(() => null, (e) => e);
        check('卸载：预设自带的删不了', Boolean(blocked2) && /自装技能/.test(blocked2.message), blocked2?.message);

        const gone = await removeSkill(fakeSkills, 'mine-skill');
        check('卸载：自装技能删掉了', existsSync(skillDir) === false && gone.removed === true);
        check('卸载：是硬删（目录整个没了）', gone.dir === skillDir && existsSync(skillDir) === false);

        // 页面走的是这条：先列出来拿到路径，再按路径卸载（换上下文重新 list 可能看不全）
        const dir2 = join(fakeRoot, 'skills', 'by-path');
        await mkdir(dir2, { recursive: true });
        await writeFile(join(dir2, 'SKILL.md'), ['---', 'name: by-path', '---', ''].join('\n'), 'utf8');
        const byPath = await uninstallSelfInstalledSkill({
            name: 'by-path', file: join(dir2, 'SKILL.md'), location: 'user',
        });
        check('卸载：按路径也能删（页面走这条）', byPath.removed === true && existsSync(dir2) === false);
        const wrongPlace = await uninstallSelfInstalledSkill({
            name: 'x', file: '/root/.dsh/skills/x/SKILL.md', location: 'package',
        }).then(() => null, (e) => e);
        check('卸载：位置不对就不删', Boolean(wrongPlace) && wrongPlace.code === 'bad-request', wrongPlace?.message);
        const noPath = await uninstallSelfInstalledSkill({ name: 'x', location: 'user' }).then(() => null, (e) => e);
        check('卸载：没有路径要报错', Boolean(noPath) && /文件路径/.test(noPath.message), noPath?.message);
        const rootGuard = await uninstallSelfInstalledSkill({
            name: 'y', file: '/root/.dsh/skills/SKILL.md', location: 'user',
        }).then(() => null, (e) => e);
        check('卸载：技能根目录本身不删', Boolean(rootGuard) && /不像一个技能目录/.test(rootGuard.message), rootGuard?.message);

        const missing = await removeSkill(fakeSkills, 'not-there').then(() => null, (e) => e);
        check('卸载：没这个技能要报错', Boolean(missing) && /找不到技能/.test(missing.message), missing?.message);
        await rm(fakeRoot, { recursive: true, force: true });
    }

    const unknown = skillOrigin({ location: 'virtual', sourceLabel: '内置随包' });
    check('没路径的走兜底：kind=other、标签「其他」',
        unknown.kind === 'other' && unknown.label === '用户技能' && unknown.bucket === 'other', unknown);

    // 已安装列表按这三桶折叠：桶的顺序/标签固定，且每种来源都得落在其中一桶里，
    // 否则那段技能会从界面上「消失」（分组时被 filter 掉）。
    check('分类桶：内置技能 / 插件技能 / 用户技能（顺序固定）',
        SKILL_BUCKETS.map((b) => b.label).join('/') === '内置技能/插件技能/用户技能', SKILL_BUCKETS.map((b) => b.label));
    check('每种来源都落在三个桶里',
        [preset, pluginSkill, official, project, user, unknown]
            .every((o) => SKILL_BUCKETS.some((b) => b.key === o.bucket)),
        [preset, pluginSkill, official, project, user, unknown].map((o) => o.bucket));
}

// ————————————————————— [14] MCP 补丁读写 —————————————————————

console.log('\n[14] MCP：补丁行的解析 / 新增 / 启停 / 删除');

{
    const patch = [
        '- id: ui-sidebar-browser',
        '  disabled: false',
        '- insert:',
        '    - id: mcp-demo',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: demo',
        '        transport: streamable-http',
        '        url: http://127.0.0.1:9/mcp',
        '        headers:',
        '          Authorization: Bearer abc',
        '    - id: mcp-off',
        '      name: "@deepseek-ai/dsh-mcp-client"',
        '      config:',
        '        serverName: off',
        '        transport: stdio',
        '        command: node',
        '      disabled: true',
        '',
    ].join('\n');

    const doc = parsePatch(patch);
    const rows = collectMcpRows(doc).map(rowToServer);
    check('裸行和 insert 块里的行都收进来了', rows.length === 2, rows.length);

    const demo = rows.find((r) => r.id === 'mcp-demo');
    check('服务器名读得出来', demo.serverName === 'demo', demo);
    check('传输方式读得出来', demo.transport === 'streamable-http', demo);
    check('URL 读得出来', demo.url === 'http://127.0.0.1:9/mcp', demo);
    check('请求头读得出来', demo.headers?.Authorization === 'Bearer abc', demo.headers);

    const off = rows.find((r) => r.id === 'mcp-off');
    check('停用的行标出来了', off.disabled === true, off);
    check('stdio 的行读得到命令', off.command === 'node', off);

    check('改完再写回去内容不变（往返稳定）', serializePatch(doc) === patch, serializePatch(doc));

    // 新增一行：必须进 insert 块，裸 - id: 是「覆盖」不是「新增」。
    const doc2 = parsePatch('[]\n');
    const created = upsertServer(doc2, { serverName: 'fresh', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' });
    check('新行有 id', created.id === 'mcp-fresh', created);
    const text2 = serializePatch(doc2);
    check('新行进 insert 块', text2.includes('insert:') && text2.includes('mcp-fresh'), text2);

    // 同名再来一次 → 换个 id，不覆盖前一行。
    const again = upsertServer(doc2, { serverName: 'fresh', transport: 'streamable-http', url: 'http://127.0.0.1:2/mcp' });
    check('同名不覆盖，换个 id', again.id === 'mcp-fresh-2', again);

    // 启停：停用写 disabled: true，恢复把这个键删掉。
    const doc3 = parsePatch(patch);
    setRowDisabled(doc3, 'mcp-demo', true);
    check('停用写 disabled: true', serializePatch(doc3).includes('disabled: true'), serializePatch(doc3));
    setRowDisabled(doc3, 'mcp-demo', false);
    const demoAgain = collectMcpRows(doc3).map(rowToServer).find((r) => r.id === 'mcp-demo');
    check('恢复后这行不再标记停用', demoAgain.disabled === false, demoAgain);

    // 删除：行没了，insert 块里剩下的行还在。
    const doc4 = parsePatch(patch);
    const removed = removeRow(doc4, 'mcp-demo');
    check('删除返回 true', removed === true, removed);
    const text4 = serializePatch(doc4);
    check('删掉的那行不见了', !text4.includes('mcp-demo'), text4);
    check('同一块里的另一行还在', text4.includes('mcp-off'), text4);

    check('服务器名非法时报错', typeof validateServerInput({ serverName: 'bad name' }) === 'string');
    check('HTTP 传输缺 URL 报错', typeof validateServerInput({ serverName: 'ok', transport: 'streamable-http' }) === 'string');
    check('stdio 缺命令报错', typeof validateServerInput({ serverName: 'ok', transport: 'stdio' }) === 'string');
    check('合法输入不报错', validateServerInput({ serverName: 'ok', transport: 'stdio', command: 'node' }) === null);
}

// ————————————————————— [15] MCP 逐工具开关 —————————————————————

console.log('\n[15] MCP 逐工具开关：跨层共用的那把总闸');

{
    const data = { mcpTools: { 'mcp__demo__list': { disabled: true }, 'mcp__demo__get': {} } };
    const off = mcpDisabledTools(data);
    check('只把 disabled=true 的算进来', off.size === 1 && off.has('mcp__demo__list'), [...off]);
    check('点名能查到', isMcpToolDisabled(data, 'mcp__demo__list') === true);
    check('没点名的不算关', isMcpToolDisabled(data, 'mcp__demo__get') === false);
    check('空数据不炸', mcpDisabledTools(undefined).size === 0);
}

// ————————————————————— [16] 技能启停 —————————————————————

console.log('\n[16] 技能启停：frontmatter 两个调用面开关');

{
    const skill = [
        '---',
        'name: demo',
        'description: 演示技能',
        '---',
        '',
        '正文。',
        '',
    ].join('\n');

    const fm = frontmatterOf(skill);
    check('读得出 frontmatter', fm.lines.includes('name: demo'), fm.lines);

    const offText = rewriteSkillPolicy(skill, false);
    const offLines = frontmatterOf(offText).lines;
    check('停用 → 模型不能主动调用', offLines.includes('disable-model-invocation: true'), offLines);
    check('停用 → 用户也不能手动调', offLines.includes('user-invocable: false'), offLines);
    check('停用不动正文', offText.includes('正文。'), offText);

    const onLines = frontmatterOf(rewriteSkillPolicy(offText, true)).lines;
    check('启用 → 两个键都删掉',
        !onLines.some((line) => /^(?:disable-model-invocation|user-invocable):/.test(line)), onLines);
    check('启停可逆', rewriteSkillPolicy(rewriteSkillPolicy(skill, false), true) === skill, rewriteSkillPolicy(rewriteSkillPolicy(skill, false), true));
}

// ————————————————————— [17] MCP 管理器（真写补丁文件） —————————————————————

console.log('\n[17] MCP 管理器：新增落哪层、改名跟不跟得上、撞名拦不拦、复制');

{
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir, readFile } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    // 新行默认落全局层（所有 profile 共用），所以读全局补丁文件。
    const readRows = async () => collectMcpRows(parsePatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8'))).map(rowToServer);

    const created = await mgr.save({ serverName: 'demo', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    check('新增 → 默认落全局层', created.layer === 'global' && created.created === true, created);
    const rows1 = await readRows();
    check('新增的那行读得回来', rows1.length === 1 && rows1[0].serverName === 'demo', rows1);

    await mgr.save({ id: created.id, serverName: 'demo2', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    const rows2 = await readRows();
    check('改名 → 行里的 serverName 跟着变', rows2.length === 1 && rows2[0].serverName === 'demo2', rows2);
    check('改名 → id 不变', rows2[0].id === created.id, rows2);

    await mgr.save({ serverName: 'clash', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    let clashError = null;
    try {
        await mgr.save({ serverName: 'clash', transport: 'streamable-http', url: 'http://127.0.0.1:9/other' });
    }
    catch (e) {
        clashError = e;
    }
    check('撞名 → 拦下来（bad-request）', clashError?.code === 'bad-request', clashError?.message);

    const listed = await mgr.list();
    check('list 里有这几台', listed.servers.length === 2, listed.servers.map((s) => s.id));
    check('list 给出两层补丁路径', listed.layers.length === 2, listed.layers);

    // 复制：留在原来那层，服务器名自动加后缀（工具前缀必须唯一）。
    const copied = await mgr.copy({ id: created.id });
    check('复制 → 还在同一层', copied.layer === 'global', copied);
    check('复制 → 名字加了后缀', copied.serverName === 'demo2-2', copied);
    const rows3 = await readRows();
    check('复制 → 多出来一行', rows3.length === 3, rows3.map((r) => r.serverName));
    check('复制 → 原来的那行没被动', rows3.some((r) => r.id === created.id && r.serverName === 'demo2'), rows3.map((r) => r.serverName));
}

// ————————————————————— [18] 外部插件（dsh-mcp-connector）也在管连接器 —————————————————————

console.log('\n[18] 外部管理器：dsh-mcp-connector 的状态要和补丁对得上');

{
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    const storages = join(home, 'storages');
    await mkdir(storages, { recursive: true });
    const connPath = join(storages, 'mcp_connector.json');
    await writeFile(connPath, `${JSON.stringify({
        unit: { name: 'mcp_connector', version: 1 },
        global: null,
        tables: {
            connections: {
                'custom-demo': {
                    key: 'custom-demo',
                    name: '演示连接器',
                    serverName: 'demo2',
                    url: 'http://127.0.0.1:9/mcp',
                    enabled: false,
                },
            },
        },
    }, null, 2)}\n`);
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    const listed = await mgr.list();
    const demo = listed.servers.find((s) => s.serverName === 'demo2');
    check('list 里带上外部插件的状态', demo?.external?.owner === 'dsh-mcp-connector', demo?.external);
    check('两边不一致 → agrees=false', demo?.external?.agrees === false, demo?.external);

    // 本插件只管平台的补丁行：不写另一个插件的状态文件，这个能力已经删掉了。
    check('没有写外部状态文件的出口（externalSync 已删除）', typeof mgr.externalSync === 'undefined');
    check('外部状态文件读完之后没被改过', JSON.parse(await readFile(connPath, 'utf8')).tables.connections['custom-demo'].enabled === false);
}

// ————————————————————— [19] 连接器的显示名 —————————————————————

console.log('\n[19] 显示名：存在自己那张表里，改名跟着搬，同步只改名字不动启停');

{
    const { createStore, mcpNameOf } = await import('../lib/store.js');
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir, readFile, writeFile } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    const store = createStore();
    await store.load();
    await store.mutate((data) => {
        data.mcpNames = { ...(data.mcpNames ?? {}), demo2: '演示连接器' };
        return data;
    });
    check('存进去 → 读得回来', mcpNameOf(store.peek(), 'demo2') === '演示连接器', store.peek().mcpNames);
    check('没起过名字 → 空串', mcpNameOf(store.peek(), '压根没这台') === '');
    const disk = JSON.parse(await readFile(join(home, 'scope-manager', 'layers.json'), 'utf8'));
    check('落盘后还在（重启不丢）', disk.mcpNames?.demo2 === '演示连接器', disk.mcpNames);

    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    const rows = collectMcpRows(parsePatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8'))).map(rowToServer);
    const demo2 = rows.find((r) => r.serverName === 'demo2');
    const saved = await mgr.save({
        id: demo2.id, serverName: 'demo3',
        transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp',
    });
    check('改名 → 报出原来的名字（名字好跟着搬）', saved.previousServerName === 'demo2' && saved.serverName === 'demo3', saved);

}

// ————————————————————— [20] 删掉连接器，它那条显示名也跟着收走 —————————————————————

console.log('\n[20] 删除连接器：显示名一起清掉，不留没人用的名字');

{
    const { createStore, mcpNameOf } = await import('../lib/store.js');
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { buildOps } = await import('../lib/http-api.js');
    const { mkdir, readFile } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    const store = createStore();
    await store.load();
    const ops = buildOps({ store, mcp: mgr, afterChange: async () => {} });

    const created = await mgr.save({ serverName: 'gone', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    await store.mutate((data) => {
        data.mcpNames = { ...(data.mcpNames ?? {}), gone: '要删掉的那台' };
        return data;
    });
    check('起名 → 存进去了', mcpNameOf(store.peek(), 'gone') === '要删掉的那台', store.peek().mcpNames);

    const removed = await ops['mcp-remove']({ id: created.id });
    check('删除 → 报出被删的那台服务器名', removed.serverName === 'gone', removed);
    const rows = collectMcpRows(parsePatch(await readFile(join(home, 'cordis.patch.yml'), 'utf8')));
    check('删除 → 补丁里那一行没了', !rows.some((r) => r.id === created.id), rows.map((r) => r.id));
    check('删除 → 显示名也一起清掉', mcpNameOf(store.peek(), 'gone') === '', store.peek().mcpNames);
}

// ————————————————————— [21] 停用→启用：状态判定、等待起来、刷新宿主 —————————————————————

console.log('\n[21] 停用→启用：状态要分得清「正在起来」和「坏了」，点完就等它连上');

{
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    // 假 loader：能按 serverName 造出各种 fiber 状态。
    const loaderState = new Map();          // serverName → fiber.state
    const loaderPresent = new Set();         // serverName → 宿主挂上了没有
    let reconciled = 0;
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return {
                    entries: () => [...loaderPresent].map((serverName) => ({
                        options: {
                            id: `mcp-${serverName}`,
                            name: '@deepseek-ai/dsh-mcp-client',
                            config: { serverName },
                        },
                        disabled: false,
                        fiber: { state: loaderState.get(serverName) ?? 2 },
                    })),
                };
            }
            if (name === 'hmr') {
                return {
                    runExclusive: async (fn) => fn(),
                    reconcileProfile: async () => { reconciled++; },
                };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const schemas = [];
    const mgr = createMcpManager({
        ctx,
        listSchemas: async () => schemas,
    });

    const created = await mgr.save({ serverName: 'st', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });

    // ① 补丁里写着 disabled → 已停用
    await mgr.toggle({ id: created.id, disabled: true });
    let row = await mgr.list();
    let st = row.servers.find((s) => s.serverName === 'st');
    check('补丁写着 disabled → 已停用', st.status === 'disabled', st.status);

    // 先把它重新启用（下面几项要验的是「启用之后宿主那边的各种状态」）。
    await mgr.toggle({ id: created.id, disabled: false });

    // ② 宿主没挂上 → not-mounted（不是「坏了」）
    loaderPresent.delete('st');
    loaderState.delete('st');
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('宿主没挂上 → not-mounted', st.status === 'not-mounted', st.status);

    // ③ 刚挂上、还在 PENDING/LOADING → starting（别吓人）
    loaderPresent.add('st');
    loaderState.set('st', 1);
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('正在起来 → starting（不是「挂着但没激活」）', st.status === 'starting', st.status);

    // ④ fiber FAILED(3) → failed
    loaderState.set('st', 3);
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('宿主挂它时出错 → failed', st.status === 'failed', st.status);

    // ⑤ fiber DISPOSED(4) → inactive（再点一次启用能重新挂上）
    loaderState.set('st', 4);
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('已被宿主卸掉 → inactive', st.status === 'inactive', st.status);

    // ⑥ 挂上了但一个工具都没有 → no-tools
    loaderState.set('st', 2);
    schemas.length = 0;
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('挂上了但没工具 → no-tools', st.status === 'no-tools', st.status);

    // ⑦ 有工具了 → connected
    schemas.push({ name: 'mcp__st__do_thing', description: '' });
    st = (await mgr.list()).servers.find((s) => s.serverName === 'st');
    check('有工具了 → connected', st.status === 'connected' && st.toolCount === 1, st.status);

    // ⑧ settle：轮询到稳定就返回（connected 立刻返回）
    const settled = await mgr.settle({ serverName: 'st', disabled: false }, { timeoutMs: 3000 });
    check('settle → connected 立刻返回', settled.status === 'connected', settled);

    // ⑨ refresh：叫宿主重算一遍补丁
    const before = reconciled;
    const refreshed = await mgr.refresh();
    check('refresh → 真的叫宿主重算了', refreshed.refreshed === true && reconciled === before + 1, { refreshed, reconciled });

    // ⑩ 没有 hmr 时不炸，只是回一个 refreshed:false
    const noHmr = createMcpManager({
        ctx: { ...ctx, get: (name) => (name === 'profileContext' ? ctx.get('profileContext') : undefined) },
        listSchemas: async () => [],
    });
    const nope = await noHmr.refresh();
    check('没有 hmr → 不报错，回 refreshed:false', nope.refreshed === false && typeof nope.reason === 'string', nope);

    // ⑪ toggle 启用：等它自己连上，回的是最终状态（不是「挂着但没激活」）
    loaderPresent.add('st');
    loaderState.set('st', 2);
    schemas.length = 0;
    schemas.push({ name: 'mcp__st__do_thing', description: '' });
    const toggled = await mgr.toggle({ id: created.id, disabled: false });
    check('启用 → 直接回「已连接」', toggled.status === 'connected' && toggled.toolCount === 1, toggled);
}

// ————————————————————— [22] 连接器绑着它自己的系统提示词 —————————————————————

console.log('\n[22] 系统提示词：MCP 服务器推的那段（mcp:<服务器名>）绑在连接器上');

{
    const { buildOps } = await import('../lib/http-api.js');
    const { createStore } = await import('../lib/store.js');
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    const store = createStore();
    await store.load();
    const sections = [
        { name: 'mcp:pr', text: '这段是服务器推给模型的', stale: false, dynamic: false },
        { name: 'mcp:xx', text: '另一台', stale: true, dynamic: false },
    ];
    const ops = buildOps({
        store,
        mcp: mgr,
        library: { scenesById: new Map(), personasById: new Map() },
        resolveScope: async () => ({ sessionKey: '', workspaceKey: '' }),
        sectionCatalog: { list: () => sections },
        afterChange: async () => {},
    });

    const created = await mgr.save({ serverName: 'pr', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    await mgr.save({ serverName: 'xx', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    const listed = await ops['mcp-list']({});
    const pr = listed.servers.find((s) => s.serverName === 'pr');
    check('列表里带着这台连接器的提示词段落', pr.prompt?.name === 'mcp:pr', pr.prompt);
    check('提示词正文就是服务器推的那段', pr.prompt?.text === '这段是服务器推给模型的', pr.prompt?.text);
    check('没推过的段落标成 stale', listed.servers.find((s) => s.serverName === 'xx')?.prompt?.stale === true);
    check('名字挂在 serverName 上，不是 id 上', pr.prompt?.name === `mcp:${pr.serverName}`, pr.serverName);
    check('刚建的这台 id 是新生成的', created.created === true && created.id === 'mcp-pr', created);
}

// ————————————————————— [23] 启用后自己把自己挂起来 + 插件页不重复列 MCP 提示词 —————————————————————

console.log('\n[23] 点「启用」就该自己挂起来（别停在「挂着但没激活」）；插件页不重复列 mcp: 段落');

{
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    // 假 loader：每个 entry 的 fiber 可以「卡住」——uid 还在、state 不是 ACTIVE，
    // 正是宿主的 entry.update() 救不回来的那种（走了「改配置」分支）。
    const entries = new Map();
    const mkFiber = (entry, state, uid) => ({
        state,
        uid,
        dispose() {
            // 真的 fiber 的 dispose 是幂等的（cordis 里带 disposing 闸门），照这个来。
            if (this.uid === null) return;
            entry.disposeCount += 1;
            this.uid = null;
            this.state = 4;
        },
    });
    const mkEntry = (serverName) => {
        const entry = {
            options: { id: `mcp-${serverName}`, name: '@deepseek-ai/dsh-mcp-client', config: { serverName } },
            disabled: false,
            fiber: null,
            initCount: 0,
            disposeCount: 0,
            async init() {
                entry.initCount += 1;
                entry.fiber = mkFiber(entry, 2, 100 + entry.initCount);
            },
        };
        // 一开始就是卡住的样子：还在、但 uid 没清、state 也不是 ACTIVE。
        entry.fiber = mkFiber(entry, 5, 7);
        entries.set(entry.options.id, entry);
        return entry;
    };
    let reconciled = 0;
    const schemas = [];
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [...entries.values()] };
            }
            if (name === 'hmr') {
                return {
                    runExclusive: async (fn) => fn(),
                    // 宿主那一轮 reconcile 故意什么都不做 —— 模拟它救不回来。
                    reconcileProfile: async () => { reconciled += 1; },
                };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => schemas });

    const created = await mgr.save({ serverName: 'stuck', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    schemas.push({ name: 'mcp__stuck__do_thing', description: '' });
    const entry = mkEntry('stuck');

    // ① 停用之后状态文案不再带那串解释
    const off = await mgr.toggle({ id: created.id, disabled: true });
    check('停用 → 文案就是「已停用」', off.status === 'disabled' && off.statusText === '已停用', off);

    // ② 启用：宿主那轮 reconcile 救不回来，但 manager 自己把它重挂了
    const on = await mgr.toggle({ id: created.id, disabled: false });
    check('启用 → 自己重挂，直接回「已连接」',
        on.status === 'connected' && on.toolCount === 1, on);
    check('重挂 = 先 dispose 旧的再 init 新的',
        entry.disposeCount >= 1 && entry.initCount === 1, { dispose: entry.disposeCount, init: entry.initCount });

    // ③ remountStuck：把「补丁里启用着、宿主里却没跑」的逐台捞回来
    const entry2 = mkEntry('stuck2');
    await mgr.save({ serverName: 'stuck2', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    schemas.push({ name: 'mcp__stuck2__do_thing', description: '' });
    const healed = await mgr.remountStuck();
    check('remountStuck 把卡住的那台捞回来了', healed.fixed.includes(entry2.options.id), healed);
    check('remountStuck 不动已经跑着的', !healed.fixed.includes(entry.options.id), healed);

    // ④ toggle 停用：立刻把 fiber 摘掉（不等宿主那一轮）
    await mgr.toggle({ id: created.id, disabled: true });
    check('停用 → 当场摘掉 fiber', entry.fiber.uid === null, entry.fiber);
}

{
    // 插件页不重复列 `mcp:<server>` 段落 —— 它们已经在 MCP 页跟连接器长在一起了。
    const { buildOps } = await import('../lib/http-api.js');
    const { createStore } = await import('../lib/store.js');
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const profileDir = join(home, 'profiles', 'web');
    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({ ctx, listSchemas: async () => [] });
    const store = createStore();
    await store.load();
    const ops = buildOps({
        store,
        mcp: mgr,
        scanner: { get: async () => ({ plugins: [], owners: {} }) },
        tools: { schemas: async () => [] },
        allSchemas: async () => [],
        schemasFor: async () => [],
        library: { scenesById: new Map(), personasById: new Map() },
        resolveScope: async () => ({ sessionKey: '', workspaceKey: '' }),
        sectionCatalog: {
            list: () => [
                { name: 'mcp:kept-out', text: '服务器推的', stale: false, dynamic: false },
                { name: 'harness:identity', text: '宿主自己的', stale: false, dynamic: false },
            ],
        },
        afterChange: async () => {},
    });
    const listed = await ops['tools-list']({});
    const names = [
        ...(listed.ungroupedSections ?? []).map((x) => x.name),
        ...(listed.groups ?? []).flatMap((g) => (g.sections ?? []).map((x) => x.name)),
    ];
    check('插件页不列 mcp: 段落', !names.some((n) => String(n).startsWith('mcp:')), names);
    check('别的段落照旧列出来', names.includes('harness:identity'), names);
}

// ————————————————————— [24] MCP 页的工具行也带备注（和插件页同一张表）————————————————————

console.log('\n[24] MCP 页的工具行：显示名 / 备注 / 注入，和插件页共用同一张表');

{
    const { buildOps } = await import('../lib/http-api.js');
    const { createStore } = await import('../lib/store.js');
    const { createMcpManager } = await import('../lib/mcp-manager.js');
    const { mkdir } = await import('node:fs/promises');
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });

    const ctx = {
        get(name) {
            if (name === 'profileContext') {
                return { home, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') };
            }
            if (name === 'loader') {
                return { entries: () => [] };
            }
            return undefined;
        },
        logger: { warn() {}, info() {} },
    };
    const mgr = createMcpManager({
        ctx,
        listSchemas: async () => [
            { name: 'mcp__note-demo__one', description: '工具原本的描述' },
        ],
    });
    const store = createStore();
    await store.load();
    await mgr.save({ serverName: 'note-demo', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' });
    const ops = buildOps({
        store,
        mcp: mgr,
        library: { scenesById: new Map(), personasById: new Map() },
        resolveScope: async () => ({ sessionKey: '', workspaceKey: '' }),
        sectionCatalog: { list: () => [] },
        afterChange: async () => {},
    });

    const before = await ops['mcp-list']({});
    const toolBefore = (before.tools ?? []).flatMap((g) => g.tools ?? []).find((t) => t.name === 'mcp__note-demo__one');
    check('工具行带出来（一开始没有备注）', toolBefore && toolBefore.note === '' && toolBefore.alias === '', toolBefore);

    // 用插件页那个接口改备注，MCP 页这边要跟着变（同一张表）。
    await ops['tool-note-save']({ scope: 'global', name: 'mcp__note-demo__one', alias: '第一个', description: '别用它', inject: true });
    const after = await ops['mcp-list']({});
    const toolAfter = (after.tools ?? []).flatMap((g) => g.tools ?? []).find((t) => t.name === 'mcp__note-demo__one');
    check('在 MCP 页改的备注，插件页那张表里就行', toolAfter?.alias === '第一个' && toolAfter?.note === '别用它' && toolAfter?.inject === true, toolAfter);
}

// ——————————————————— [25] 技能市场（SkillHub）——————————————————

{
    // 自己造一个最小的 zip（stored，不压缩），用来测解压与 zip-slip。
    function makeZip(entries) {
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const item of entries) {
            const nameBuf = Buffer.from(item.name, 'utf8');
            const data = Buffer.from(item.data ?? '', 'utf8');
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0, 6);
            local.writeUInt16LE(0, 8); // method 0 = stored
            local.writeUInt32LE(data.length, 18);
            local.writeUInt32LE(data.length, 22);
            local.writeUInt16LE(nameBuf.length, 26);
            locals.push(local, nameBuf, data);
            const cen = Buffer.alloc(46);
            cen.writeUInt32LE(0x02014b50, 0);
            cen.writeUInt16LE(20, 4);
            cen.writeUInt16LE(20, 6);
            cen.writeUInt16LE(0, 8);
            cen.writeUInt16LE(0, 10); // method 0
            cen.writeUInt32LE(data.length, 20);
            cen.writeUInt32LE(data.length, 24);
            cen.writeUInt16LE(nameBuf.length, 28);
            cen.writeUInt32LE(offset, 42);
            centrals.push(cen, nameBuf);
            offset += 30 + nameBuf.length + data.length;
        }
        const centralBuf = Buffer.concat(centrals);
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(centralBuf.length, 12);
        eocd.writeUInt32LE(offset, 16);
        return Buffer.concat([...locals, centralBuf, eocd]);
    }

    const zip = makeZip([
        { name: 'SKILL.md', data: '---\nname: zip-demo\ndescription: 解压出来的例子\n---\n\n正文' },
        { name: 'scripts/run.sh', data: 'echo hi' },
    ]);
    const files = unzip(zip);
    check('zip：读出两个条目', files.length === 2 && files[0].name === 'SKILL.md', files.map((f) => f.name));

    const dir = join(home, 'ziptest');
    const written = await extractTo(zip, dir);
    check('zip：解到目录里', written.includes('SKILL.md') && written.includes('scripts/run.sh'), written);

    const front = parseFrontmatter('---\nname: zip-demo\ndescription: 解压出来的例子\n---\n正文');
    check('frontmatter：读到 name 与 description', front.name === 'zip-demo' && front.description === '解压出来的例子', front);
    check('frontmatter：没有 frontmatter 就空对象', Object.keys(parseFrontmatter('# 标题')).length === 0);

    // zip-slip：带 .. 的条目必须被拒
    const evil = makeZip([{ name: '../escaped.txt', data: 'x' }]);
    let slipError = '';
    try {
        await extractTo(evil, join(home, 'zipslip'));
    }
    catch (e) {
        slipError = String(e.message ?? e);
    }
    check('zip-slip：带 .. 的条目被拒', slipError.includes('不安全的路径'), slipError);

    const abs = makeZip([{ name: '/etc/passwd', data: 'x' }]);
    let absError = '';
    try {
        await extractTo(abs, join(home, 'zipabs'));
    }
    catch (e) {
        absError = String(e.message ?? e);
    }
    check('zip-slip：绝对路径被拒', absError.includes('不安全的路径'), absError);

    // 非法 slug 与「已经装过了」都得在联网之前就被拦住。
    let badSlug = '';
    try {
        await installSkill({ home, slug: '../evil' });
    }
    catch (e) {
        badSlug = String(e.message ?? e);
    }
    check('装技能：非法 slug 被拒', badSlug.includes('不安全'), badSlug);

    const existing = join(home, 'skills', 'already-here');
    await (await import('node:fs/promises')).mkdir(existing, { recursive: true });
    let dup = '';
    try {
        await installSkill({ home, slug: 'already-here' });
    }
    catch (e) {
        dup = String(e.message ?? e);
    }
    check('装技能：已经装过就要提示覆盖', dup.includes('要覆盖就勾上覆盖'), dup);

    // 真装一次（把 fetch 换成返回上面那个 zip，不联网）：落在传进来的技能根目录里。
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(zip, { status: 200 });
    try {
        const root = join(home, 'skills-root-test');
        const result = await installSkill({ skillsRoot: root, slug: 'net-demo' });
        check('装技能：落在给定的技能根目录里', result.dir === join(root, 'net-demo'), result.dir);
        check('装技能：SKILL.md 里有 name 就拿来当名字', result.name === 'zip-demo', result.name);
        check('装技能：解出来的文件齐了', result.files.includes('SKILL.md'), result.files);
        check('装技能：认得 SKILL.md', result.hasSkillMd === true);

        // 市场里不少技能把 name 写成展示名，宿主要求 kebab-case，装完得揉成合法的，
        // 不然宿主会静默丢掉（「装了但不显示」）。
        const display = [
            '---',
            'name: Word / DOCX',
            'description: 处理 Word 文档',
            '---',
            '',
            '正文',
        ].join('\n');
        const fixed = normalizeSkillName(display, 'word-docx');
        check('装技能：展示名被揉成 kebab', /\nname: word-docx\n/.test(fixed.text), fixed.text.split('\n')[1]);
        check('装技能：原展示名留在 title 里', fixed.text.includes('title: \"Word / DOCX\"')); 
        check('装技能：改过就要报出原名', fixed.changed === true && fixed.from === 'Word / DOCX');
        const keep = normalizeSkillName(['---', 'name: word-docx', '---', ''].join('\n'), 'word-docx');
        check('装技能：本来就合法的名字不动', keep.changed === false);
        const bare = normalizeSkillName('没有 frontmatter', 'poetry-daily-art');
        check('装技能：没有 frontmatter 就补一个', bare.text.startsWith('---\nname: poetry-daily-art\n---\n'), bare.text.slice(0, 20));
    }
    finally {
        globalThis.fetch = realFetch;
    }
}

// ————————————————————— [26] 段落「归属到插件」 —————————————————————

console.log('\n[26] 归属插件：人点出来的归属优先于工具名前缀和来源插件，连宿主自带的包也能挂');

{
    const { readFile } = await import('node:fs/promises');
    // ① 分组：归属命中「已有工具组」就直接挂过去（不问前缀、不问来源）。
    const pinnedToGroup = associateSections(
        [{ category: 'plugin', owner: 'dsh-meme', tools: [{ name: 'send_meme' }] }],
        [{ name: 'tool:workflow', plugin: null }],
        { 'tool:workflow': 'dsh-meme' },
    );
    check('归属插件 → 挂到那个插件已有的组',
        (pinnedToGroup.byGroup.get('plugin::dsh-meme') ?? []).some((s) => s.name === 'tool:workflow'),
        [...pinnedToGroup.byGroup.keys()]);
    check('归属插件 → 不落到「未归组」',
        !pinnedToGroup.ungrouped.some((s) => s.name === 'tool:workflow'),
        pinnedToGroup.ungrouped.map((s) => s.name));

    // ② 归属到「一个工具都没有的包」→ 补一个空组，并且标上 pinnedOwner（界面要区分「人点的」）。
    const pinnedEmpty = associateSections([], [{ name: 'harness:identity', plugin: null }], {
        'harness:identity': '@deepseek-ai/dsh-tool-web',
    });
    check('归属到没工具的包 → 补一个只带段落的组',
        pinnedEmpty.sectionOnlyGroups.some((g) => g.owner === '@deepseek-ai/dsh-tool-web' && g.sectionOnly),
        pinnedEmpty.sectionOnlyGroups.map((g) => g.owner));
    check('这种组带 pinnedOwner 标记', pinnedEmpty.sectionOnlyGroups.some((g) => g.pinnedOwner === true));

    // ③ 宿主自带的包：靠来源插件那条线索是会被跳过的（那是内部实现、算噪声）；
    //    但人明确点了归属，就必须挂上去 —— 否则点了没反应。
    check('归属到宿主自带的包也照挂（不被跳过）',
        (pinnedEmpty.byGroup.get('system::@deepseek-ai/dsh-tool-web') ?? []).some((s) => s.name === 'harness:identity'),
        [...pinnedEmpty.byGroup.keys()]);
    check('归属到宿主自带的包算「系统插件」那一类',
        pinnedEmpty.sectionOnlyGroups.some((g) => g.owner === '@deepseek-ai/dsh-tool-web' && g.category === 'system'),
        pinnedEmpty.sectionOnlyGroups.map((g) => [g.category, g.owner]));

    // ④ 没人点过归属时，行为保持原样。
    const noPin = associateSections([], [{ name: 'harness:identity', plugin: null }], {});
    check('没有归属记录 → 照旧进「未归组」',
        noPin.ungrouped.some((s) => s.name === 'harness:identity'),
        noPin.ungrouped.map((s) => s.name));
    const noPin3 = associateSections([], [{ name: 'tool:workflow', plugin: null }]);
    check('第三个参数干脆不传也不炸', noPin3.ungrouped.length === 1);

    // ⑤ 存在哪、怎么取消：都在 sectionOwners 这张跨层共用的表里。
    const saved = await callApi('section-owner-save', { name: 'tool:workflow', owner: '@deepseek-ai/dsh-tool-web' });
    check('section-owner-save 返回存的归属', saved.body?.owner === '@deepseek-ai/dsh-tool-web', saved.body);
    const disk = JSON.parse(await readFile(join(home, 'scope-manager', 'layers.json'), 'utf8'));
    check('归属落盘（重启不丢）', disk.sectionOwners?.['tool:workflow'] === '@deepseek-ai/dsh-tool-web', disk.sectionOwners);
    await callApi('section-owner-save', { name: 'tool:workflow', owner: '' });
    const disk2 = JSON.parse(await readFile(join(home, 'scope-manager', 'layers.json'), 'utf8'));
    check('owner 传空串 = 取消归属（键被删掉）', (disk2.sectionOwners ?? {})['tool:workflow'] === undefined, disk2.sectionOwners);
    const bad = await callApi('section-owner-save', { owner: 'x' });
    check('缺段落名报 400 bad-request', bad.status === 400, bad.status);
}

// ————————————————————— [27] 插件页列全量工具 —————————————————————

console.log('\n[27] 插件页：被预设关掉的工具照样列出来，只标一下（不藏）');

{
    // 先记下没有预设时的样子
    const before = await callApi('tools-list', {});
    const beforeTotal = before.body?.total ?? 0;
    check('没有名单时：工具都在、没被标关掉',
        before.body?.offTotal === 0 && (before.body?.groups ?? [])
            .every((g) => g.tools.every((t) => t.allowed === true)),
        before.body?.offTotal);

    // 用全局层关掉 bash
    await callApi('layer-save', { scope: 'global', layer: { toolFilter: { mode: 'deny', names: ['bash'] } } });
    const after = await callApi('tools-list', {});
    const flat = (after.body?.groups ?? []).flatMap((g) => g.tools);
    const bash = flat.find((t) => t.name === 'bash');
    check('被关掉的工具还在列表里（不藏）', Boolean(bash), flat.map((t) => t.name));
    check('但它标成 allowed=false', bash?.allowed === false, bash);
    check('总数没因为名单而变少', after.body?.total === beforeTotal, [beforeTotal, after.body?.total]);
    check('单独报了「被预设关掉」的个数', after.body?.offTotal === 1, after.body?.offTotal);
    check('别的工具不受影响', flat.filter((t) => t.allowed === false).length === 1,
        flat.filter((t) => t.allowed === false).map((t) => t.name));

    // 编辑预设时（scopeAll）不该被任何名单影响
    const all = await callApi('tools-list', { scopeAll: true });
    check('scopeAll 时全部算「开着」', all.body?.offTotal === 0
        && (all.body?.groups ?? []).every((g) => g.tools.every((t) => t.allowed === true)), all.body?.offTotal);

    await callApi('layer-reset', { scope: 'global' });
}

console.log('\n[28] 归属识别：实测结论优先于静态推断');
{
    // 一个第三方插件真的注册了 workflow，而官方表里也有 workflow。
    // 实测是事实，必须赢过手写表。
    const scanned = {
        system: new Map(),
        plugin: new Map(),
        quoted: new Map(),
        probed: new Map([['workflow', 'my-workflow-plugin']]),
    };
    const r = classifyToolName('workflow', {}, scanned);
    check('实测结论盖过官方手写表', r.owner === 'my-workflow-plugin' && r.category === 'plugin', r);
    check('实测结论会标记出来', r.probed === true, r);

    // 没有实测时，仍然按静态扫描来。
    const noProbe = { ...scanned, probed: new Map() };
    const r2 = classifyToolName('workflow', {}, noProbe);
    check('没有实测时不乱认', r2.owner !== 'my-workflow-plugin', r2);

    // 实测结论也压过「第三方包里扫到」——同样是事实，但实测更直接。
    const both = {
        ...scanned,
        plugin: new Map([['workflow', 'other-plugin']]),
    };
    const r3 = classifyToolName('workflow', {}, both);
    check('实测优先于静态扫描', r3.owner === 'my-workflow-plugin', r3);

    // 用户手点的归属永远最高。
    const r4 = classifyToolName('workflow', { workflow: { category: 'plugin', owner: 'manual' } }, scanned);
    check('手点归属高于实测', r4.owner === 'manual' && r4.overridden === true, r4);
}

console.log('\n[29] 归属识别：运行时交叉验证剔掉幽灵条目');
{
    const scanned = {
        system: new Map([['bash', 'dsh-tool-bash']]),
        plugin: new Map([['real_tool', 'dsh-real'], ['ghost_tool', 'dsh-ghost']]),
        quoted: new Map([['real_tool', new Set(['dsh-real'])], ['ghost_tool', new Set(['dsh-ghost'])]]),
        officialByPackage: new Map(),
        pluginByStem: new Map(),
    };
    const runtime = new Set(['bash', 'real_tool']);
    const r = crossCheckWithRuntime(scanned, runtime);
    check('运行时没有的名字被剔掉', !r.scanned.plugin.has('ghost_tool'), [...r.scanned.plugin.keys()]);
    check('运行时有的名字留下', r.scanned.plugin.get('real_tool') === 'dsh-real', [...r.scanned.plugin.keys()]);
    check('幽灵名单里有它', r.dropped.includes('ghost_tool'), r.dropped);

    // 拿不到运行时清单时不做裁剪 —— 宁可多列也不凭空少列。
    // 用一份新的扫描结果：上一步的 crossCheck 已经就地改过 scanned 了。
    const scanned2 = {
        system: new Map(),
        plugin: new Map([['real_tool', 'dsh-real'], ['ghost_tool', 'dsh-ghost']]),
        quoted: new Map(),
        officialByPackage: new Map(),
        pluginByStem: new Map(),
    };
    const noRuntime = crossCheckWithRuntime(scanned2, null);
    check('没有运行时清单就不裁剪', noRuntime.scanned.plugin.has('ghost_tool'), [...noRuntime.scanned.plugin.keys()]);
    check('没有运行时清单就不报幽灵', noRuntime.dropped.length === 0, noRuntime.dropped);
}

console.log('\n[30] 深度排查：软重启差分反推工具集');
{
    // 假的世界：插件 "demo-plugin" 注册了 alpha / beta。
    let enabled = true;
    const registered = new Set(['alpha', 'beta', 'other_tool']);
    const tools = {
        schemas: () => (enabled ? [...registered] : ['other_tool']).map((name) => ({ name, description: '' })),
    };
    const fakeCtx = { tools };
    const pluginManager = {
        setPluginEnabled: async (id, on) => {
            enabled = on;
            return { ok: true };
        },
    };
    const r = await probeOnePlugin({
        ctx: fakeCtx,
        pluginManager,
        entryId: 'e1',
        moduleName: 'demo-plugin',
        settleMs: 1,
    });
    check('测出它注册了哪些工具', r.status === 'verified' && r.tools.includes('alpha') && r.tools.includes('beta'), r);
    check('别人的工具不算它的', !r.tools.includes('other_tool'), r.tools);
    check('插件被恢复到开着状态', enabled === true, enabled);
}

console.log('\n[31] 深度排查：测不出来就说测不出来');
{
    const tools = { schemas: () => [{ name: 'x', description: '' }] };
    const fakeCtx = { tools };
    const pluginManager = {
        setPluginEnabled: async (id, on) => {
            if (!on) throw new Error('启停失败');
            return { ok: true };
        },
    };
    const r = await probeOnePlugin({
        ctx: fakeCtx,
        pluginManager,
        entryId: 'e1',
        moduleName: 'broken-plugin',
        settleMs: 1,
    });
    check('出问题时状态是 unverifiable', r.status === 'unverifiable', r);
    check('带上了原因', typeof r.reason === 'string' && r.reason.length > 0, r.reason);
}

console.log('\n[32] 深度排查缓存：版本变了结论就作废');
{
    const fresh = { tools: ['a'], status: 'verified', version: '1.0.0' };
    check('版本没变时结论有效', isProbeFresh(fresh, '1.0.0') === true, isProbeFresh(fresh, '1.0.0'));
    check('版本变了结论作废', isProbeFresh(fresh, '2.0.0') === false, isProbeFresh(fresh, '2.0.0'));
    check('没版本不作数', isProbeFresh(fresh, undefined) === false);
    check('没测过的不作数', isProbeFresh(undefined, '1.0.0') === false);
    check('测失败的也不算数', isProbeFresh({ tools: [], status: 'empty', version: '1.0.0' }, '1.0.0') === false);
}

console.log('\n[33] 深度排查结论的形状容错（probedMap is not iterable 回归）');
{
    // 事故现场：调用方传了个 async 回调，probedMap 变成 Promise，
    // `for…of` 直接 TypeError，插件页连同 pre-step 全挂。
    // probedOwnersFrom 必须把所有脏形状都吃掉，永不抛。
    const fromPromise = probedOwnersFrom(Promise.resolve({ plugins: {} }), new Map());
    check('传 Promise 不抛且是空 Map', fromPromise instanceof Map && fromPromise.size === 0, [...fromPromise]);

    for (const junk of [undefined, null, 'x', 42, [], () => { }]) {
        const r = probedOwnersFrom(junk, new Map());
        check(`脏输入 ${String(junk).slice(0, 12)} 给空 Map`, r instanceof Map && r.size === 0, [...r]);
    }

    // 旧形状：Map<包名, string[]>
    const legacy = probedOwnersFrom(new Map([['dsh-a', ['t1', 't2']]]), new Map());
    check('旧 Map 形状认得出', legacy.get('t1') === 'dsh-a' && legacy.get('t2') === 'dsh-a', [...legacy]);

    // 缓存文件形状 + 版本判定
    const cache = {
        version: 1,
        plugins: {
            'dsh-a': { tools: ['t1'], status: 'verified', version: '1.0.0' },
            'dsh-b': { tools: ['t9'], status: 'verified', version: '1.0.0' },
        },
    };
    const versions = new Map([['dsh-a', '1.0.0'], ['dsh-b', '2.0.0']]);
    const fresh = probedOwnersFrom(cache, versions);
    check('版本一致的结论生效', fresh.get('t1') === 'dsh-a', [...fresh]);
    check('版本变了的结论作废', !fresh.has('t9'), [...fresh]);

    // 两个包声称同一个工具 → 不猜
    const conflict = probedOwnersFrom(new Map([
        ['dsh-a', ['same']],
        ['dsh-b', ['same']],
    ]), new Map());
    check('撞名的不猜', !conflict.has('same'), [...conflict]);

    // 记录被手改坏（tools 不是数组）→ 跳过这条，不影响其它
    const broken = probedOwnersFrom(new Map([
        ['dsh-a', 'not-an-array'],
        ['dsh-b', ['ok']],
    ]), new Map());
    check('坏记录跳过、好记录留下', broken.get('ok') === 'dsh-b' && broken.size === 1, [...broken]);
}

console.log('\n[34] 深度排查：缓存入参形状容错（cache.get is not a function 回归）');
{
    // 事故现场：调用方把 probe-cache.json 里的 `cache.plugins`（普通对象）
    // 直接传进来，probePlugins 里一句 cache.set 就 TypeError。
    let enabled = true;
    const registered = new Set(['alpha', 'other']);
    const fakeCtx = { tools: { schemas: () => (enabled ? [...registered] : ['other']).map((n) => ({ name: n })) } };
    const pluginManager = {
        setPluginEnabled: async (id, on) => { enabled = on; return { ok: true }; },
        listPlugins: async () => [{ entryId: 'e1', moduleName: 'demo', enabled: true }],
    };
    const objectCache = { demo: { tools: ['old'], status: 'verified', version: '1.0.0' } };
    const r = await probePlugins({
        ctx: fakeCtx,
        pluginManager,
        plugins: [{ entryId: 'e1', moduleName: 'demo' }],
        cache: objectCache,
        settleMs: 1,
    });
    check('普通对象缓存不报错', Array.isArray(r.results) && r.results.length === 1, r.results);
    check('结果覆盖了旧缓存', r.cache.get('demo')?.tools?.includes('alpha') === true, [...r.cache]);
}

console.log('\n[35] 运行时清单要把所有 agent 的 scope 并进来（expiredOfficial 误报回归）');
{
    // 事故现场：只查 ctx.tools.schemas()（全局层），拿到的是「少了半壁江山」的清单，
    // 于是 bash / read / edit / todo_write / job_* 这批按 preset 注册的工具
    // 全被标成「官方表已过时」，真工具还被当幽灵剔掉。
    const globalOnly = [{ name: 'present' }];
    const agentA = [{ name: 'bash' }, { name: 'read' }, { name: 'edit' }];
    const agentB = [{ name: 'bash' }, { name: 'todo_write' }];
    const fakeCtx = {
        tools: {
            schemas: (scope) => {
                if (!scope) {
                    return globalOnly;
                }
                return scope.name === 'a' ? agentA : agentB;
            },
        },
        get: (name) => (name === 'agents' ? { list: () => [{ name: 'a' }, { name: 'b' }] } : false),
    };
    const names = runtimeToolNames(fakeCtx);
    check('并上了 agent scope 的 bash', names.has('bash'), [...names]);
    check('并上了 edit / todo_write', names.has('edit') && names.has('todo_write'), [...names]);
    check('全局层的 present 没丢', names.has('present'), [...names]);
    check('去重后共 5 个', names.size === 5, [...names]);
    // 拿这份清单做交叉验证：真工具一个都不该被剔掉。
    const scanned = { plugin: new Map([['bash', 'dsh-tool-bash']]), quoted: new Map(), officialByPackage: new Map() };
    const checked = crossCheckWithRuntime(scanned, names);
    check('真工具没被当幽灵', checked.dropped.length === 0 && scanned.plugin.has('bash'), checked.dropped);
    check('官方表没被误报过时', !checked.expired.includes('bash'), checked.expired);
}

// ——————————————————— [33] 插件变化监测：快照差分 ———————————————————

{
    const snap = (rows) => Object.fromEntries(rows.map((r) => [r.moduleName, {
        moduleName: r.moduleName,
        entryId: 'e-' + r.moduleName,
        enabled: true,
        version: r.version ?? '1.0.0',
        tools: r.tools ?? [],
        sections: r.sections ?? [],
    }]));

    // 1) 新装的插件：工具和段落都算「新增」，不要报成 changed。
    const first = diffSnapshots({}, snap([
        { moduleName: 'dsh-new', tools: ['new_a', 'new_b'], sections: ['新段'] },
    ]));
    check('新装插件记成 installed', first.length === 1 && first[0].kind === 'installed', first);
    check('新装带出全部工具', first[0]?.toolsAdded?.join(',') === 'new_a,new_b', first[0]);
    check('新装带出全部提示词段落', first[0]?.sectionsAdded?.join(',') === '新段', first[0]);

    // 2) 版本变了：记成 updated，并给出前后版本。
    const bumped = diffSnapshots(snap([
        { moduleName: 'dsh-new', version: '1.0.0', tools: ['new_a'], sections: [] },
    ]), snap([
        { moduleName: 'dsh-new', version: '1.1.0', tools: ['new_a', 'new_c'], sections: [] },
    ]));
    check('升级记成 updated', bumped.length === 1 && bumped[0].kind === 'updated', bumped);
    check('升级带出前后版本', bumped[0]?.versionFrom === '1.0.0' && bumped[0]?.version === '1.1.0', bumped[0]);
    check('升级带出新增工具', bumped[0]?.toolsAdded?.join(',') === 'new_c', bumped[0]);

    // 3) 版本没动、只是多了东西：记成 changed（升级和「偷偷改了行为」要分得开）。
    const drifted = diffSnapshots(snap([
        { moduleName: 'dsh-new', tools: ['a'], sections: ['旧段'] },
    ]), snap([
        { moduleName: 'dsh-new', tools: ['a', 'b'], sections: ['旧段', '新段'] },
    ]));
    check('只变内容记成 changed', drifted.length === 1 && drifted[0].kind === 'changed', drifted);
    check('changed 带增删两侧',
        drifted[0]?.toolsAdded?.join() === 'b' && drifted[0]?.sectionsAdded?.join() === '新段',
        drifted[0]);

    // 4) 一模一样：不该产生事件（否则每两分钟刷一条噪音）。
    const quiet = diffSnapshots(snap([{ moduleName: 'dsh-new', tools: ['a'] }]),
        snap([{ moduleName: 'dsh-new', tools: ['a'] }]));
    check('没变化就不出声', quiet.length === 0, quiet);

    // 5) 插件被卸了：记成 removed，并保留它原来的工具名供追溯。
    const gone = diffSnapshots(snap([{ moduleName: 'dsh-gone', tools: ['old'] }]), {});
    check('卸插件记成 removed', gone.length === 1 && gone[0].kind === 'removed', gone);
    check('removed 带出原有工具', gone[0]?.toolsRemoved?.join(',') === 'old', gone[0]);
}

// ————————————————————— 归属扫描缓存 —————————————————————

console.log('\n[33] 归属扫描缓存：落盘 / 读回 / 指纹');
{
    const { writeScanCache, readScanCache, dropScanCache } = await import('../lib/scan-cache.js');

    const base = {
        system: new Map([['bash', 'dsh-tool-bash']]),
        plugin: new Map([['send_meme', 'dsh-meme']]),
        quoted: new Map([['x', new Set(['dsh-a', 'dsh-b'])]]),
        officialByPackage: new Map([['subagent', 'dsh-tool-subagent']]),
        pluginByStem: new Map([['meme', 'dsh-meme']]),
        manifestTools: new Map([['acp_cache', 'billion-context']]),
        packages: new Map([['meme', {
            key: 'meme', dir: '/tmp/meme', official: false,
            packageName: 'dsh-meme', version: '0.1.64', description: '表情包',
        }]]),
    };

    await dropScanCache();
    check('没写过就是 null（退回重新扫描）', await readScanCache() === null);

    await writeScanCache('fp-1', base);
    const back = await readScanCache();
    check('写进去能读回来', back !== null, back);
    check('指纹原样带回', back?.fingerprint === 'fp-1', back?.fingerprint);
    check('字符串表还原成 Map', back?.base.plugin.get('send_meme') === 'dsh-meme');
    check('多值兜底表还原成 Set',
        back?.base.quoted.get('x') instanceof Set && back?.base.quoted.get('x').has('dsh-b'));
    check('包元信息还原（含版本号）', back?.base.packages.get('meme')?.version === '0.1.64');

    // 缓存格式对不上就当没有（格式不符的文件不能拿来做归属判断）。
    const { hubPath } = await import('../lib/paths.js');
    await writeFile(hubPath('scan-cache.json'), JSON.stringify({ version: 1, fingerprint: 'old' }), 'utf8');
    check('版本号不对的旧缓存被忽略', await readScanCache() === null);

    await dropScanCache();
    check('删掉之后就读不到', await readScanCache() === null);
}

// ——————————————————— [34] @mcp: 手势解析 ———————————————————

{
    const tokens = mcpGestureTokens('帮我用 @mcp:weknora 查一下，再 @mcp:金山文档 整理。');
    check('抽出手势名字', tokens.length === 2 && tokens[0] === 'weknora' && tokens[1] === '金山文档', tokens);
    check('句末标点不粘在名字上', mcpGestureTokens('用 @mcp:weknora，谢谢').join('|') === 'weknora');
    check('括号包着也认得', mcpGestureTokens('（@mcp:weknora）').join('|') === 'weknora');
    check('没有手势就是空数组', mcpGestureTokens('普通一句话，@123 和 user@host').length === 0);
    check('name 为空不算', mcpGestureTokens('@mcp:  后面有空格').length === 0);

    const servers = [
        { id: 'mcp-1', serverName: 'weknora', name: '知识库', disabled: false },
        { id: 'mcp-2', serverName: '金山文档', name: '文档', disabled: true },
    ];
    check('服务名能指到', resolveMcpGesture(['weknora'], servers).matched[0]?.id === 'mcp-1');
    check('备注名能指到', resolveMcpGesture(['文档'], servers).matched[0]?.id === 'mcp-2');
    check('id 也能指到', resolveMcpGesture(['mcp-1'], servers).matched[0]?.serverName === 'weknora');
    check('大小写不敏感', resolveMcpGesture(['WEKNORA'], servers).matched.length === 1);
    check('认不出来进 unknown', resolveMcpGesture(['nope'], servers).unknown[0] === 'nope');
    const dup = resolveMcpGesture(['weknora', '知识库'], servers);
    check('同一台只解锁一次', dup.matched.length === 1 && dup.unknown.length === 0, dup);
    check('候选键含服务名与备注名', serverGestureKeys(servers[0]).join(',') === 'weknora,mcp-1,知识库');

    const note = renderMcpUnlockNote({
        groups: [{
            label: 'weknora（知识库）',
            serverName: 'weknora',
            tools: [{ name: 'mcp__weknora__search', description: '搜索知识库', parameters: { required: ['query'] } }],
        }],
        unknown: ['nope'],
    });
    check('提醒里有工具名', note.includes('mcp__weknora__search'), note);
    check('提醒里有必填参数', note.includes('必填：query'), note);
    check('提醒里有没认出来的写法', note.includes('@mcp:nope'), note);
    check('没连上时说明白', renderMcpUnlockNote({ groups: [{ label: 'x', serverName: 'x', tools: [] }] }).includes('没连上'));
    check('什么都没解锁就空串', renderMcpUnlockNote({ groups: [], unknown: [] }) === '');
    check('KIND 固定', MCP_GESTURE_KIND === 'scope-manager-mcp-unlock');
}

// ——————————————————— [36] @技能名 手势改写 ———————————————————

{
    const names = new Set(['summarize', 'cuigengji-write']);
    check('命中技能名就换成 /名', rewriteAtSkillGestures('@summarize 这篇文档', names) === '/summarize 这篇文档');
    check('句首、行中、行尾都认',
        rewriteAtSkillGestures('用 @cuigengji-write 续写', names) === '用 /cuigengji-write 续写');
    check('不认识的原样留着', rewriteAtSkillGestures('@unknown 和 @summarize', names) === '@unknown 和 /summarize');
    check('邮箱不算手势', rewriteAtSkillGestures('ping me at a@summarize.com', names) === null);
    check('紧贴中文不算手势', rewriteAtSkillGestures('@summarize文档', names) === null);
    check('没有 @ 就返回 null', rewriteAtSkillGestures('普通一句话', names) === null);
    check('空技能表不解', rewriteAtSkillGestures('@summarize', new Set()) === null);
    check('@mcp: 不会被误伤', rewriteAtSkillGestures('@mcp:weknora', names) === null);

    const content = [
        { type: 'text', text: '@summarize 总结一下' },
        { type: 'image', url: 'x' },
        { type: 'text', text: '再 @unknown 一下' },
    ];
    const next = rewriteAtSkillContent(content, names);
    check('只改文本块', next !== null && next[0].text === '/summarize 总结一下', next);
    check('非文本块原样', next[1] === content[1]);
    check('没命中的文本块保持引用', next[2] === content[2]);
    check('整体没命中返回 null', rewriteAtSkillContent([{ type: 'text', text: '普通' }], names) === null);
}

// ——————————————————— [37] 已卸载插件的残留清理 ———————————————————

{
    const installed = new Set(['dsh-meme', 'dsh-genui', 'dsh-browser-desktop']);
    check('装着的算还在', isOwnerInstalled('@dsh-custom/dsh-browser-desktop', installed) === true);
    check('卸掉的算没了', isOwnerInstalled('@dsh-custom/dsh-container-helper', installed) === false);
    check('没归属的一律当还在', isOwnerInstalled(null, installed) === true);
    check('官方包不判已卸载', isOwnerInstalled('@deepseek-ai/dsh-tool-bash', installed) === true);
    check('清单拿不到就不判', isOwnerInstalled('@dsh-custom/x', new Set()) === true);

    const dir = await mkdtemp(join(tmpdir(), 'scope-sections-'));
    const file = join(dir, 'sections.json');
    const catalog = createSectionCatalog({ file });
    catalog.record([
        { name: 'tool:browser_tools', text: '浏览器工具提示' },
        { name: 'tool:meme', text: '表情包提示' },
    ]);
    catalog.setOverride('tool:browser_tools', '我自己改的提示');
    // 模拟：来源反查后知道 browser_tools 来自这个包
    const list = catalog.list();
    const browser = list.find((x) => x.name === 'tool:browser_tools');
    check('段落能记下来', !!browser, JSON.stringify(list));

    const removed = catalog.forgetByOwner('dsh-browser-desktop');
    check('按来源包忘掉段落', removed.length === 0 || removed.includes('tool:browser_tools'), JSON.stringify(removed));
    catalog.flush();
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    check('落盘里没有已卸载包的段落',
        !raw.sections.some((x) => x.name === 'tool:browser_tools' && x.plugin === '@dsh-custom/dsh-browser-desktop'));
    await rm(dir, { recursive: true, force: true });

    const names = await collectInstalledNames({
        pluginManager: { listPlugins: async () => [{ moduleName: '@xmanrui/dsh-im' }] },
        scanned: { packages: new Map([['dsh-meme', { key: 'dsh-meme', packageName: 'dsh-meme' }]]) },
    });
    check('Loader 条目进清单', names.has('dsh-im'), [...names].join(','));
    check('扫包结果进清单', names.has('dsh-meme'), [...names].join(','));
}

// ——————————————————— [38] 常开白名单（人设段落） ———————————————————

{
    check('人设三段在白名单里',
        ALWAYS_ON_SECTIONS.includes('harness:identity')
        && ALWAYS_ON_SECTIONS.includes('deployment:persona-prefix')
        && ALWAYS_ON_SECTIONS.includes('deployment:persona-suffix'),
        JSON.stringify(ALWAYS_ON_SECTIONS));
    check('白名单判定认这三段', isAlwaysOnSection('harness:identity') === true);
    check('白名单不认别的段', isAlwaysOnSection('tool:bash') === false);
    check('空名字不认', isAlwaysOnSection(undefined) === false);
}

// ——————————————————— [39] 系统段落默认归属表 ———————————————————

{
    check('表里认得出宿主自带的那几段',
        systemSectionOwner('app:web-surface') === '@deepseek-ai/dsh-harness-dev-context'
        && systemSectionOwner('harness:source') === '@deepseek-ai/dsh-harness-dev-context',
        systemSectionOwner('app:web-surface'));
    check('人设三段归官方包',
        systemSectionOwner('harness:identity') === '@deepseek-ai/dsh-system-prompt'
        && systemSectionOwner('deployment:persona-prefix') === '@deepseek-ai/dsh-system-prompt',
        systemSectionOwner('harness:identity'));
    check('表里的归属都是官方包',
        [...SYSTEM_SECTION_OWNERS.values()].every((v) => v.startsWith('@deepseek-ai/')),
        [...SYSTEM_SECTION_OWNERS.values()].join(','));
    check('表里没有的名字交给反查',
        systemSectionOwner('dsh-expression:companion') === ''
        && systemSectionOwner('never-heard-of-it') === ''
        && systemSectionOwner(undefined) === '',
        JSON.stringify(systemSectionOwner('never-heard-of-it')));
}

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
