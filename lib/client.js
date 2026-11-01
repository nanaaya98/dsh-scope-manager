// 功能管理和预设 · 浏览器那一半（插件包名 dsh-scope-manager）。
//
// 形态：**静态 client 模块**（ModuleLoader CJS 格式）。它没有 host.call
// （`host.call` 只属动态插件 —— dsh-cordis-client-runner/lib/client.js:178），
// 也没有 ctx.http，所以数据面全部走同源的 exact 路由 POST /dsh-scope-manager/api。
//
// 侧边栏占**两个槽**，而且 id 必须一样：
//   · sidebar.panellist —— 左栏那一行图标（list 槽）
//   · main              —— 中间那一页（keyed 槽，key = 同一个 id）
// 只注册 'sidebar' 槽本身会**整体替换左栏**（那是被别的包占着的 single 槽），别碰。
window.__ModuleLoader__.load({
    id: 'dsh-scope-manager',
    factory: (require) => {
        var module = { exports: {} }
        var exports = module.exports
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
        const React = require('react')
        const { useState, useEffect, useMemo, useCallback, useRef } = React

        const PLUGIN_ID = 'dsh-scope-manager'
        const PANEL_ID = 'dsm-scope-manager'
        const NS = 'dsh-scope-manager'
        /** 宿主权限预设的三档（`dsh-permission-presets` 的 sandbox 组合）。 */
        const PERMISSION_CHOICES = [
            { value: 'read-only', label: '仅可查看' },
            { value: 'workspace-write', label: '工作区内修改' },
            { value: 'danger-full-access', label: '完全权限' },
        ]
        /** 角色卡的两种注入方式（详情页顶部的模式选择器用）。 */
        const MODE_CHOICES = [
            { value: 'context', label: '角色卡上下文', hint: '拼一条合成 user 消息，不占系统提示词' },
            { value: 'system', label: '系统提示词覆盖', hint: '直接盖掉那两段提示词文字' },
        ]

        /**
         * 技能页「已安装」的三个分类桶（顺序就是界面顺序）。
         * 与服务端 lib/skills.js 的 SKILL_BUCKETS 一一对应 —— 客户端模块是
         * 浏览器里跑的静态文件，import 不到服务端模块，所以这份要单独写一遍。
         */
        const SKILL_BUCKETS = [
            { key: 'builtin', label: '内置技能', hint: '跟着宿主 / agent 预设一起带的' },
            { key: 'plugin', label: '插件技能', hint: '插件包里带的，改了升级会被覆盖' },
            { key: 'other', label: '用户技能', hint: '自己装的、项目里的、额外加的目录' },
        ]

        const API_PATH = '/dsh-scope-manager/api'
        // ——————————————————— 取词 ———————————————————
        // 客户端 locale 服务给的是「注册期」取值；页面里用不到细粒度文案，
        // 全部中文写死，免得两套字典对不上。
        const t = (key) => key

        // ——————————————————— 样式 ———————————————————
        const C = {
            bg: 'var(--dsw-alias-bg-base, #fff)',
            panel: 'var(--dsw-alias-bg-layer-1, #f7f7f8)',
            panel2: 'var(--dsw-alias-bg-layer-2, #eeeef1)',
            border: 'var(--dsw-alias-border-l1, #e3e3e6)',
            border2: 'var(--dsw-alias-border-l2, #d0d0d5)',
            text: 'var(--dsw-alias-label-primary, #16181d)',
            text2: 'var(--dsw-alias-label-secondary, #4a4f58)',
            // 正文里那些「次要但必须读得清」的字用 secondary：dimmed 在浅色主题下
            // 对比度太低，工具描述几乎看不见（截图验证过）。
            dim: 'var(--dsw-alias-label-secondary, #4a4f58)',
            caption: 'var(--dsw-alias-label-dimmed, #868b94)',
            accent: 'var(--dsw-alias-brand-primary, #2f6bff)',
            accentText: 'var(--dsw-alias-brand-text, #fff)',
            hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))',
            error: 'var(--dsw-alias-state-error-primary, #d13c3c)',
            warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
            success: 'var(--dsw-alias-state-success-primary, #1f8a4c)',
        }
        const S = {
            page: { padding: 18, color: C.text, fontSize: 13, lineHeight: 1.6, minHeight: '100%', boxSizing: 'border-box' },
            row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
            tabs: { display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, padding: '0 18px', background: C.panel },
            tab: (on) => ({
                padding: '9px 13px', cursor: 'pointer', fontSize: 13, userSelect: 'none',
                color: on ? C.text : C.dim, fontWeight: on ? 600 : 400,
                borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
            }),
            card: { border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, background: C.panel, marginBottom: 10 },
            label: { fontSize: 12, color: C.text2, marginBottom: 4, display: 'block' },
            input: {
                width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 13,
                color: C.text, background: C.bg, border: `1px solid ${C.border2}`, borderRadius: 6,
                fontFamily: 'inherit',
            },
            textarea: {
                width: '100%', boxSizing: 'border-box', padding: '8px 9px', fontSize: 12.5,
                color: C.text, background: C.bg, border: `1px solid ${C.border2}`, borderRadius: 6,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minHeight: 220, resize: 'vertical',
            },
            btn: (primary) => ({
                padding: '5px 12px', fontSize: 12.5, borderRadius: 6, cursor: 'pointer',
                border: `1px solid ${primary ? C.accent : C.border2}`,
                background: primary ? C.accent : C.bg, color: primary ? C.accentText : C.text,
            }),
            chip: (tone) => ({
                display: 'inline-block', fontSize: 11, padding: '1px 7px', borderRadius: 10,
                border: `1px solid ${tone === 'session' ? C.accent : tone === 'workspace' ? C.success : C.border2}`,
                color: tone === 'session' ? C.accent : tone === 'workspace' ? C.success : C.dim,
                whiteSpace: 'nowrap',
            }),
            muted: { color: C.dim, fontSize: 12 },
            h2: { fontSize: 14, fontWeight: 600, margin: '0 0 8px' },
            h3: { fontSize: 12.5, fontWeight: 600, color: C.text2, margin: '14px 0 6px' },
        }
        /**
         * 页签的「光学对齐」小补丁。
         * 中文方块字的墨迹高度约 13~14px（13px 字号），纯拉丁大写缩写（MCP）只有 ~11px，
         * 盒子一样高、行盒也一样，但看起来会显得小一号、位置偏上。这里给纯拉丁标签
         * 字号加 0.5px、整体下移 0.5px，让它的视觉中心和中文标签齐平。
         */
        function opticalTab(label) {
            return /^[\x20-\x7e]+$/.test(String(label ?? ''))
                ? { fontSize: 13.5, letterSpacing: '0.2px', transform: 'translateY(0.5px)' }
                : null
        }

        /**
         * 往 textarea 的光标处插一段文字（占位符按钮用）。
         * 不是 hook，只是闭包 —— 两处编辑器共用同一套插入行为。
         */
        function makeInserter(text, setText, taRef) {
            return (token) => {
                const el = taRef ? taRef.current : null
                if (!el) {
                    setText(`${text}${token}`)
                    return
                }
                const start = el.selectionStart ?? text.length
                const end = el.selectionEnd ?? start
                setText(text.slice(0, start) + token + text.slice(end))
                const caret = start + token.length
                requestAnimationFrame(() => {
                    try {
                        el.focus()
                        el.setSelectionRange(caret, caret)
                    }
                    catch { /* 忽略：元素可能已经卸载 */ }
                })
            }
        }

        /** 一排「可用占位符」按钮：宿主唯一的插值写法就是 `{{名字}}`。 */
        function VarChips({ vars, onPick }) {
            const list = Array.isArray(vars) ? vars : []
            if (list.length === 0) {
                return null
            }
            return React.createElement('div', { style: { ...S.row, marginTop: 6, gap: 4 } },
                React.createElement('span', { style: { ...S.muted, fontSize: 11.5, marginRight: 2 } }, '可用占位符：'),
                list.map((v) => React.createElement('button', {
                    key: v.name,
                    type: 'button',
                    title: `插入 {{${v.name}}}${v.scm === true
                        ? '\n本插件提供：装配时按当前值替换（宿主不认识它，所以不会报错）'
                        : (v.self === true
                            ? '\n这一段此刻的原文：写它就能「加自己的排版、但不冻住动态内容」'
                            : (v.value ? `\n当前值：${v.value}` : ''))}`,
                    onClick: () => onPick(`{{${v.name}}}`),
                    style: { ...S.btn(false), padding: '1px 6px', fontSize: 11, color: C.accent },
                }, v.scm === true
                    ? `{{${v.name}}}·本插件`
                    : (v.self === true
                        ? `{{${v.name}}}·本段原文`
                        : (v.own === true ? `{{${v.name}}}·原文` : `{{${v.name}}}`)))))
        }

        const btn = (label, onClick, primary, disabled) => React.createElement('button', {
            style: disabled ? { ...S.btn(primary === true), opacity: 0.55, cursor: 'progress' } : S.btn(primary === true),
            onClick: disabled ? undefined : onClick,
            disabled: disabled === true,
            type: 'button',
        }, label)

        // ——————————————————— API ———————————————————
        async function apiCall(op, args) {
            const res = await fetch(new URL(API_PATH, document.baseURI), {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-dsh-plugin': PLUGIN_ID },
                body: JSON.stringify({ op, args: args || {} }),
            })
            let data = null
            try { data = await res.json() } catch { data = null }
            if (!res.ok || !data || data.ok !== true) {
                throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
            }
            return data
        }

        // ——————————————————— 作用域上下文 ———————————————————
        /** 读宿主会话清单：当前会话 = retainedBy.mainView > 0 的那一行。 */
        function readSessionContext(ctx) {
            try {
                const snap = ctx.sessions?.list?.getSnapshot?.()
                const byId = snap?.byId ?? {}
                const rows = Object.values(byId).map((row) => ({
                    id: String(row.id ?? ''),
                    title: String(row.displayTitle || row.title || row.id || ''),
                    cwd: String(row.cwd ?? ''),
                    current: Number(row.retainedBy?.mainView ?? 0) > 0,
                    origin: row.origin === 'subagent' ? 'subagent' : '',
                }))
                const current = rows.find((r) => r.current) ?? null
                const cwds = []
                for (const r of rows) {
                    if (r.cwd && !cwds.includes(r.cwd)) cwds.push(r.cwd)
                }
                // 工作区：宿主登记过的（有标题、有 path、有归属会话）；
                // 没登记但会话用过的目录也补进来，否则那些目录没法设工作区层。
                let workspaceRows = []
                try {
                    const snapW = ctx.workspaces?.list?.getSnapshot?.()
                    workspaceRows = (snapW?.items ?? []).map((w) => ({
                        id: String(w.workspaceId ?? ''),
                        path: String(w.path ?? ''),
                        title: String(w.title || w.path || ''),
                        sessionCount: (w.sessionIds ?? []).length,
                    }))
                }
                catch { workspaceRows = [] }
                for (const c of cwds) {
                    if (!workspaceRows.some((w) => w.path === c)) {
                        workspaceRows.push({ id: '', path: c, title: c, sessionCount: 0, unregistered: true })
                    }
                }
                return { rows, current, cwds, workspaceRows }
            }
            catch {
                return { rows: [], current: null, cwds: [], workspaceRows: [] }
            }
        }

        // ——————————————————— 通用小组件 ———————————————————
        function Field({ label, children, hint }) {
            return React.createElement('div', { style: { marginBottom: 10 } },
                React.createElement('span', { style: S.label }, label),
                children,
                hint ? React.createElement('div', { style: { ...S.muted, marginTop: 3 } }, hint) : null)
        }

        function TextInput({ value, onChange, placeholder, disabled }) {
            return React.createElement('input', {
                style: S.input, value: value ?? '', disabled: disabled === true,
                placeholder: placeholder ?? '', onChange: (e) => onChange(e.target.value),
            })
        }

        function TextArea({ value, onChange, rows, disabled, mono, style }) {
            return React.createElement('textarea', {
                style: {
                    ...S.textarea,
                    ...(mono === false ? { fontFamily: 'inherit', fontSize: 13, minHeight: rows ? rows * 20 : 120 } : {}),
                    ...(style ?? {}),
                },
                value: value ?? '', disabled: disabled === true, rows: rows,
                onChange: (e) => onChange(e.target.value),
            })
        }

        function Checkbox({ checked, onChange, label, disabled }) {
            return React.createElement('label', { style: { ...S.row, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 } },
                React.createElement('input', {
                    type: 'checkbox', checked: checked === true, disabled: disabled === true,
                    onChange: (e) => onChange(e.target.checked),
                }),
                React.createElement('span', { style: { fontSize: 12.5 } }, label))
        }

        function ErrorBar({ error }) {
            if (!error) return null
            return React.createElement('div', {
                style: {
                    padding: '8px 10px', marginBottom: 12, borderRadius: 8,
                    background: 'rgba(209,60,60,.08)', border: `1px solid ${C.error}`,
                    color: C.error, fontSize: 12.5, wordBreak: 'break-word',
                },
            }, String(error))
        }

        function Loading() {
            return React.createElement('div', { style: { ...S.muted, padding: '24px 0' } }, '加载中…')
        }

        // ————————————— 工具 / 插件选择（卡片式） —————————————
        //
        // 用户的心里单位是**插件**，不是一串工具名。所以这里分两级：
        //   ① 模式卡 = 宿主那几套 Agent 预设。点一下，按「这套预设挂哪些插件」
        //      把工具预勾好 —— 插件在，它的工具就勾着；插件不在，就停用。
        //   ② 插件卡 = 真正可选的东西。点卡片才展开它自己的工具，逐个别调。
        //
        // 模式是**算出来的，不是存下来的**：当前勾选恰好等于某套预设的推算结果，
        // 就显示成那套；差一个就落回「自定义」。这样存量预设打开也对得上，
        // 也不会出现「标着极简、实际开着全量」的假标签。
        const AGENT_PRESET_LABEL = {
            // `custom` 不是宿主返回的预设，是「对不上任何一套」时的兜底标签。
            custom: '自定义模式',
            minimal: '极简模式',
            standard: '标准模式',
            ptc: 'PTC 模式',
            cordis: '创造模式',
        }
        /** `@deepseek-ai/dsh-tool-fs` → `dsh-tool-fs`：归属表里存的是包名尾段。 */
        const ownerKey = (s) => String(s || '')
            .split(/[\\/]/)
            .pop()
            .replace(/\.(js|mjs|cjs|ts|tsx)$/, '')

        /**
         * 同一个工具，预设里挂的包名和面板上这张卡的名字可能不是一个。
         *
         * 最典型的是 bash：四套预设里写的是 `dsh-tool-bash-persistent` / `dsh-terminal-bash`
         * （常驻会话那套），而这个 profile 里真正注册 `bash` 工具的是 `dsh-tool-bash`。
         * 不并成一家，切「极简」就会把 bash 一起关掉 —— 极简本来是要留 shell 的。
         *
         * 只并「同一个工具的不同实现」，不按前缀乱并：否则 `dsh-tool-fs` 会把
         * `dsh-tool-fs-search` 也带成开着，那才是错的。
         */
        const PACKAGE_ALIAS = {
            'dsh-terminal': 'dsh-tool-bash',
            'dsh-terminal-bash': 'dsh-tool-bash',
            'dsh-tool-bash-persistent': 'dsh-tool-bash',
            'dsh-tool-pwsh-persistent': 'dsh-tool-bash',
            // fork 委派工具在运行时记的归属者是 `dsh-subagent`，
            // 而预设清单里写的是 `@deepseek-ai/dsh-tool-subagent`（entry id
            // tool-subagent-fork，config.toolName: subagent_fork）——
            // 同一个能力的两个名字。不并成一家，fork 就会被算成「宿主自带」，
            // 切模式时该关的没关。
            'dsh-subagent': 'dsh-tool-subagent',
        }
        /**
         * 常开白名单：人设那几段永远注入，预设/场景的停用名单摘不掉它们。
         *
         * 角色卡要拿这几段做系统提示词替换（世界观→harness:identity，
         * 角色设定/行为约束→deployment:persona-prefix），一旦被预设切走，
         * 人设就跟着没了。所以：既不在「宿主自带」里列出来让人乱关，
         * 也不能进停用账。
         */
        const ALWAYS_ON_SECTIONS = ['harness:identity', 'deployment:persona-prefix', 'deployment:persona-suffix']
        const isAlwaysOnSection = (name) => ALWAYS_ON_SECTIONS.includes(String(name || ''))

        /** 包名 → 卡片键：先按别名归一，再取尾段。 */
        const pkgKey = (s) => {
            const k = ownerKey(s)
            return PACKAGE_ALIAS[k] || k
        }

        /** 这套预设挂了哪些插件（`off` 的行不挂；`conditional` 求不出条件，算挂）。 */
        const presetPackages = (preset) => new Set(
            (preset && preset.plugins ? preset.plugins : [])
                .filter((x) => x.enabled !== 'off')
                // `@deepseek-ai/dsh-plugin-manager/tools` 这种是挂工具的入口，不是插件包本身；
                // 不剔掉，预设的包集合里会多出一个叫 `tools` 的假包。
                .filter((x) => !/\/tools?$/i.test(String(x.moduleName || '')))
                .map((x) => pkgKey(x.moduleName)),
        )

        /**
         * 几套预设一共管到哪些插件 —— 也就是「系统工具」那一圈的边界。
         *
         * 不在这个圈里的（用户自己装的 ego-browser、cuigengji、meme…）不归预设管：
         * 它们在 profile 里挂着，跟选哪套 Agent 预设定无关。切模式时**原样保留**，
         * 否则选个「极简」会顺手把写小说用的插件也关掉。
         */
        const presetUniverse = (presets) => {
            const all = new Set()
            for (const p of presets) {
                for (const k of presetPackages(p)) all.add(k)
            }
            return all
        }
        const sameSet = (a, b) => {
            const x = new Set(a)
            const y = new Set(b)
            if (x.size !== y.size) return false
            for (const v of x) if (!y.has(v)) return false
            return true
        }

        /**
         * 模式匹配引擎：一套「停用名单」对得上哪套 Agent 预设。
         *
         * 编辑器里的模式卡和预设列表卡上的模式标签共用这一份 —— 两处各算一套的话，
         * 迟早出现「编辑器说极简、列表卡说自定义」。
         *
         * 只比**预设圈里**的条目：自己装的插件、MCP 连接不归模式管，它们在停用名单里
         * 有名字也不影响判定。
         */
        function buildModeIndex({ toolOptions, groups, sections, presets }) {
            const list = Array.isArray(presets) ? presets : []
            const univPkgs = presetUniverse(list)
            const managedOwner = (owner) => univPkgs.has(pkgKey(owner))

            const managedTools = (toolOptions || [])
                .filter((o) => o.category !== 'mcp' && managedOwner(o.group))
            const toolNames = new Set(managedTools.map((o) => o.value))

            // 段落归属：先听装配钩子的「挂在哪组工具下」，其次 mcp:<连接名>，最后看它自报的包。
            const ownerByGroup = new Map()
            for (const g of groups || []) {
                for (const x of g.sections || []) {
                    const name = typeof x === 'string' ? x : x?.name
                    if (name) ownerByGroup.set(name, { owner: ownerKey(g.owner), category: g.category })
                }
            }
            const managedSections = []
            for (const sec of sections || []) {
                // 绑了工具的段落跟着工具走，不算独立一笔账。
                if ((sec.bindTools ?? []).length > 0) continue
                const fromGroup = ownerByGroup.get(sec.name)
                const mcpServer = String(sec.name || '').startsWith('mcp:') ? String(sec.name).slice(4) : ''
                const owner = (fromGroup && fromGroup.owner)
                    || mcpServer
                    || ownerKey(sec.plugin)
                const cat = (fromGroup && fromGroup.category)
                    || (mcpServer ? 'mcp' : (String(sec.plugin || '').startsWith('@deepseek-ai/') ? 'system' : 'plugin'))
                if (cat === 'mcp' || !managedOwner(owner)) continue
                managedSections.push({ pkg: owner, value: sec.name })
            }
            const sectionNames = new Set(managedSections.map((x) => x.value))

            const impliedOff = (p) => {
                const pkgs = presetPackages(p)
                return managedTools.filter((o) => !pkgs.has(pkgKey(o.group))).map((o) => o.value)
            }
            const impliedSectionsOff = (p) => {
                const pkgs = presetPackages(p)
                return managedSections.filter((x) => !pkgs.has(pkgKey(x.pkg))).map((x) => x.value)
            }

            return {
                /** 宿主的预设花名册拿到了没 —— 没拿到时「对得上哪套」无从谈起，别乱贴标签。 */
                hasPresets: list.length > 0,
                univPkgs,
                managedTools,
                managedSections,
                isManagedTool: (n) => toolNames.has(n),
                isManagedSection: (n) => sectionNames.has(n),
                impliedOff,
                impliedSectionsOff,
                /** 对得上哪套预设 → 预设 id；对不上 → `custom`。 */
                modeOf: ({ toolOff, sectionsOff } = {}) => {
                    const a = (toolOff || []).filter((n) => toolNames.has(n))
                    const b = (sectionsOff || []).filter((n) => sectionNames.has(n))
                    for (const p of list) {
                        if (sameSet(a, impliedOff(p)) && sameSet(b, impliedSectionsOff(p))) return p.id
                    }
                    return 'custom'
                },
            }
        }

        function PluginToolPicker({
            toolOptions, groups, sections, skills, presets, toolOff, sectionsOff, skillsOff, onChange,
        }) {
            const [q, setQ] = useState('')
            const [open, setOpen] = useState({})
            const [docId, setDocId] = useState('')
            const [docs, setDocs] = useState({})

            const needle = q.trim().toLowerCase()
            const hit = (...texts) => !needle || texts.some((t) => String(t || '').toLowerCase().includes(needle))

            // —— 三本停用账，各管一摊：工具 / 提示词段落 / 技能。
            const tOff = Array.isArray(toolOff) ? toolOff : []
            // 常开白名单里的段落不进停用账：它们永远注入，账里留着名字只会让人以为能关。
            const pOff = (Array.isArray(sectionsOff) ? sectionsOff : [])
                .filter((n) => !isAlwaysOnSection(n))
            const kOff = Array.isArray(skillsOff) ? skillsOff : []
            const lib = {
                tools: { off: tOff, key: 'toolOff' },
                sections: { off: pOff, key: 'sectionsOff' },
                skills: { off: kOff, key: 'skillsOff' },
            }
            const emit = (kind, values, on) => {
                const cur = new Set(lib[kind].off)
                for (const v of values) {
                    if (on) cur.delete(v)
                    else cur.add(v)
                }
                onChange({ toolOff: tOff, sectionsOff: pOff, skillsOff: kOff, [lib[kind].key]: [...cur] })
            }
            const emitAll = (rows, on) => {
                // 卡片总开关：工具、段落、技能一起切。
                const next = { toolOff: tOff, sectionsOff: pOff, skillsOff: kOff }
                for (const kind of ['tools', 'sections', 'skills']) {
                    const cur = new Set(lib[kind].off)
                    for (const it of rows[kind]) {
                        if (on) cur.delete(it.value)
                        else cur.add(it.value)
                    }
                    next[lib[kind].key] = [...cur]
                }
                onChange(next)
            }

            // —— 卡片 = 一个插件。三样东西都挂它底下：提示词段落、工具、技能。
            const cards = new Map()
            const cardOf = (pkg, seed) => {
                const key = ownerKey(pkg) || '未归属'
                let c = cards.get(key)
                if (!c) {
                    c = {
                        key,
                        label: (seed && seed.label) || key,
                        // 有工具就听工具的（那是实测归属）；没有就按包名前缀猜，
                        // 猜错只影响摆在哪一栏，不影响开关。
                        category: (seed && seed.category)
                            || (String(pkg || '').startsWith('@deepseek-ai/') ? 'system' : 'plugin'),
                        tools: [],
                        sections: [],
                        skills: [],
                    }
                    cards.set(key, c)
                }
                else if (seed && seed.category && !c.category) {
                    c.category = seed.category
                }
                if (seed && seed.label) c.label = seed.label
                return c
            }

            for (const o of toolOptions) {
                const c = cardOf(o.group, { label: o.groupLabel, category: o.category })
                c.tools.push({ value: o.value, label: o.label, sub: o.value })
            }
            // 段落归属：优先听装配钩子自己记的「这段挂在哪组工具下」（tools-list 的 group.sections），
            // 那是运行时真认的；其次 mcp:<server> 这种运行时生成的段落，按连接名归；
            // 再看段落自报的所属包（sections[].plugin）；都没有才进「未归属」。
            const ownerByGroup = new Map()
            for (const g of groups || []) {
                for (const x of g.sections || []) {
                    const name = typeof x === 'string' ? x : x?.name
                    if (name) ownerByGroup.set(name, { owner: ownerKey(g.owner), category: g.category })
                }
            }
            for (const sec of sections) {
                // 只列「不由工具带动」的段落：绑了工具的跟着工具走，不单列一份真相。
                if ((sec.bindTools ?? []).length > 0) continue
                // 常开白名单里的段落不参与卡片分组：它们不归预设管，也不给开关
                // （角色卡要拿它们做提示词替换，不能让人在这里关掉）。
                if (isAlwaysOnSection(sec.name)) continue
                const fromGroup = ownerByGroup.get(sec.name)
                const mcpServer = String(sec.name || '').startsWith('mcp:') ? String(sec.name).slice(4) : ''
                const owner = (fromGroup && fromGroup.owner)
                    || mcpServer
                    || ownerKey(sec.plugin)
                // 没有工具段落的包（比如只注入提示词的 dsh-harness-dev-context）也得分对栏：
                // 按它自报的包名判系统/用户，别用归一后的尾段去猜。
                const pkg = String(sec.plugin || '')
                const category = (fromGroup && fromGroup.category)
                    || (mcpServer ? 'mcp' : (pkg.startsWith('@deepseek-ai/') ? 'system' : 'plugin'))
                cardOf(owner, { category })
                    .sections.push({
                        pkg: owner,
                        cat: category,
                        value: sec.name,
                        label: sec.name,
                        sub: sec.plugin ? ownerKey(sec.plugin) : (mcpServer ? `MCP ${mcpServer}` : '运行时注入'),
                    })
            }
            for (const sk of skills) {
                const bucket = sk.origin?.bucket ?? 'other'
                if (bucket !== 'plugin') continue   // 内置的跟预设、用户技能的走下面单独一栏
                cardOf(sk.origin?.packageName, { category: undefined }).skills.push({
                    value: sk.name, label: sk.name, sub: sk.origin?.label || '',
                })
            }

            // 搜索：按卡片名或它底下的东西筛；筛空了整张卡不出现。
            const filtered = []
            for (const c of cards.values()) {
                const keep = {
                    tools: c.tools.filter((t) => hit(t.value, c.label)),
                    sections: c.sections.filter((x) => hit(x.value, c.label)),
                    skills: c.skills.filter((x) => hit(x.value, c.label)),
                }
                if (!hit(c.label) && keep.tools.length + keep.sections.length + keep.skills.length === 0) continue
                filtered.push({ ...c, shown: keep })
            }

            // 工具/段落名 → 卡。算「这套模式会关掉几个插件」时用。
            const nameCard = new Map()
            for (const c of cards.values()) {
                for (const t of c.tools) nameCard.set(t.value, c.key)
                for (const x of c.sections) nameCard.set(x.value, c.key)
            }
            // —— 模式。模式 = 一组插件开关；插件一旦被关，它带的工具和它注入的提示词段落
            // 都得跟着停（技能由插件自己注册，插件关了就没有，不用记）。
            // 规则在 buildModeIndex 里，预设列表卡上的模式标签用的是同一份。
            const modeIdx = buildModeIndex({ toolOptions, groups, sections, presets })
            const univPkgs = modeIdx.univPkgs
            const managedTools = modeIdx.managedTools
            const managedSections = modeIdx.managedSections
            const isManagedTool = modeIdx.isManagedTool
            const isManagedSection = modeIdx.isManagedSection
            const impliedOff = modeIdx.impliedOff
            const impliedSectionsOff = modeIdx.impliedSectionsOff
            /** 本页能看到的、归预设圈管的卡片（用户在这页数得着的那一层）。 */
            const managedCards = filtered.filter((c) => univPkgs.has(pkgKey(c.key)))
            /** 这套模式真会关掉的那几个插件 —— 按卡片算，跟用户在页面上看到的对得上。 */
            const affectedPkgs = (p) => {
                const set = new Set()
                for (const n of [...impliedOff(p), ...impliedSectionsOff(p)]) {
                    const k = nameCard.get(n)
                    if (k) set.add(k)
                }
                return set
            }
            const currentMode = modeIdx.modeOf({ toolOff: tOff, sectionsOff: pOff })
            const applyMode = (p) => {
                const keep = tOff.filter((n) => !isManagedTool(n))
                const keepSec = pOff.filter((n) => !isManagedSection(n))
                onChange({
                    toolOff: [...new Set([...impliedOff(p), ...keep])],
                    sectionsOff: [...new Set([...impliedSectionsOff(p), ...keepSec])],
                    skillsOff: kOff,
                })
            }

            function toggleDoc(id) {
                if (docId === id) {
                    setDocId('')
                    return
                }
                setDocId(id)
                if (docs[id]) return
                apiCall('preset-document', { id })
                    .then((doc) => setDocs((m) => ({ ...m, [id]: doc })))
                    .catch((err) => setDocs((m) => ({ ...m, [id]: { error: String((err && err.message) || err) } })))
            }

            const modeCards = presets.map((p) => {
                const on = currentMode === p.id
                const offTools = impliedOff(p).length
                const offSecs = impliedSectionsOff(p).length
                const aff = affectedPkgs(p).size
                const sum = aff === 0 && offTools === 0 && offSecs === 0
                    ? '不关任何东西'
                    : `关 ${aff} 个插件 · ${offTools} 个工具 · ${offSecs} 段提示词`
                return React.createElement('div', {
                    key: `m:${p.id}`,
                    onClick: () => applyMode(p),
                    style: {
                        cursor: 'pointer', padding: '8px 10px', borderRadius: 8, minWidth: 120,
                        border: `1px solid ${on ? C.accent : C.border}`,
                        background: on ? 'rgba(47,107,255,.06)' : C.bg,
                        userSelect: 'none',
                    },
                },
                    React.createElement('div', {
                        style: { fontWeight: 600, fontSize: 12.5, color: on ? C.accent : C.text },
                    }, AGENT_PRESET_LABEL[p.id] || (p.name || p.id)),
                    React.createElement('div', {
                        style: { ...S.muted, fontSize: 11 },
                    }, sum),
                    React.createElement('div', {
                        onClick: (e) => { e.stopPropagation(); toggleDoc(p.id) },
                        style: { fontSize: 11, color: C.accent, cursor: 'pointer', marginTop: 2 },
                    }, docId === p.id ? '收起 YAML' : '看 YAML'))
            })
            modeCards.push(React.createElement('div', {
                key: 'm:custom',
                style: {
                    padding: '8px 10px', borderRadius: 8, minWidth: 120,
                    border: `1px ${currentMode === 'custom' ? 'solid' : 'dashed'} ${currentMode === 'custom' ? C.accent : C.border}`,
                    background: currentMode === 'custom' ? 'rgba(47,107,255,.06)' : 'transparent',
                },
            },
                React.createElement('div', {
                    style: { fontWeight: 600, fontSize: 12.5, color: currentMode === 'custom' ? C.accent : C.dim },
                }, '自定义模式'),
                React.createElement('div', { style: { ...S.muted, fontSize: 11 } }, '改过任何一项就到这里')))

            const doc = docId ? (docs[docId] || null) : null

            const cardEl = (c) => {
                const expanded = open[c.key] === true
                const rows = {
                    tools: c.shown.tools,
                    sections: c.shown.sections,
                    skills: c.shown.skills,
                }
                const total = rows.tools.length + rows.sections.length + rows.skills.length
                const onCount = [
                    ...rows.tools.map((t) => ({ k: 'tools', v: t.value })),
                    ...rows.sections.map((x) => ({ k: 'sections', v: x.value })),
                    ...rows.skills.map((x) => ({ k: 'skills', v: x.value })),
                ].filter((x) => !lib[x.k].off.includes(x.v)).length
                const bits = []
                if (rows.tools.length) bits.push(`${rows.tools.length} 工具`)
                if (rows.sections.length) bits.push(`${rows.sections.length} 提示词`)
                if (rows.skills.length) bits.push(`${rows.skills.length} 技能`)
                // 一次算完三本账再提交：分三次 emit 会各自基于本轮渲染的旧值起算，
                // 后一次把前一次的结果盖掉，看起来就是「关了卡头、底下的没跟着关」。
                const toggleAll = (on) => emitAll(rows, on)
                const groupRow = (kind, title) => {
                    const items = rows[kind]
                    if (!items.length) return null
                    const mine = items.map((x) => x.value)
                    const on = mine.filter((v) => !lib[kind].off.includes(v)).length
                    const full = on === mine.length
                    return React.createElement('div', { key: `g:${kind}`, style: { marginTop: 6 } },
                        React.createElement('div', {
                            style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 },
                        },
                            React.createElement('input', {
                                type: 'checkbox',
                                checked: full,
                                ref: (el) => { if (el) el.indeterminate = on > 0 && !full },
                                // 半开着点一下 = 全关（「把这个插件关掉」），全关时点一下 = 全开。
                            onChange: () => emit(kind, mine, on === 0),
                            }),
                            React.createElement('span', {
                                style: { fontSize: 11, color: C.dim, fontWeight: 500 },
                            }, `${title} ${on}/${mine.length}`)),
                        ...items.map((it) => React.createElement('label', {
                            key: `${kind}:${it.value}`,
                            style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '1px 0 1px 18px', cursor: 'pointer' },
                        },
                            React.createElement('input', {
                                type: 'checkbox', checked: !lib[kind].off.includes(it.value),
                                onChange: () => emit(kind, [it.value], lib[kind].off.includes(it.value)),
                                style: { marginTop: 3 },
                            }),
                            React.createElement('span', {
                                style: { minWidth: 0, flex: 1, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' },
                            },
                                React.createElement('span', { style: { fontSize: 12 } }, it.label || it.value),
                                (it.label && it.label !== it.value)
                                    ? React.createElement('span', { style: { ...S.muted, fontSize: 10.5 } }, it.value)
                                    : null))))
                }
                return React.createElement('div', {
                    key: `b:${c.key}`,
                    style: {
                        width: 240, boxSizing: 'border-box', padding: 8, borderRadius: 8,
                        border: `1px solid ${total && onCount === 0 ? C.border : C.border2}`,
                        background: C.bg, opacity: total ? 1 : 0.75,
                    },
                },
                    React.createElement('div', {
                        onClick: () => setOpen((o) => ({ ...o, [c.key]: !o[c.key] })),
                        style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' },
                    },
                        React.createElement('input', {
                            type: 'checkbox',
                            checked: total > 0 && onCount === total,
                            ref: (el) => { if (el) el.indeterminate = onCount > 0 && onCount < total },
                            onClick: (e) => e.stopPropagation(),
                            // 同上：只要还有开着的东西，点一下就是全关；已经全关了点一下才全开。
                            onChange: () => toggleAll(total === 0 ? true : onCount === 0),
                        }),
                        React.createElement('span', {
                            title: c.key,
                            style: {
                                flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            },
                        }, c.label),
                        React.createElement('span', { style: { ...S.muted, fontSize: 10.5, whiteSpace: 'nowrap' } },
                            bits.join(' · ')),
                        React.createElement('span', {
                            style: { color: C.caption, fontSize: 10, width: 8, textAlign: 'center' },
                        }, expanded ? '▾' : '▸')),
                    expanded
                        ? React.createElement('div', {
                            style: { marginTop: 6, paddingTop: 6, borderTop: `1px solid ${C.border}`, maxHeight: 320, overflow: 'auto' },
                        },
                            groupRow('sections', '提示词'),
                            groupRow('tools', '工具'),
                            groupRow('skills', '技能'),
                            total === 0 ? React.createElement('div', { style: { ...S.muted, fontSize: 11.5 } }, '这个插件没声明可调的东西。') : null)
                        : null)
            }

            const zone = (title, hint, list) => (list.length === 0 ? null : React.createElement('div', { style: { marginTop: 10 } },
                React.createElement('div', {
                    style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 },
                },
                    React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: C.text2 } }, title),
                    hint ? React.createElement('span', { style: { ...S.muted, fontSize: 11 } }, hint) : null),
                React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                    ...list.map(cardEl))))

            // 系统插件分两栏：预设圈里的（切模式会跟着变）和宿主基础装配的
            // （任何预设都带着，模式不碰）。这两类混在一起，切极简时就会
            // 数不清「到底还剩几个开着」。
            const sysPreset = filtered.filter((c) => c.category === 'system' && univPkgs.has(pkgKey(c.key)))
            const sysHost = filtered.filter((c) => c.category === 'system' && !univPkgs.has(pkgKey(c.key)))
            const usr = filtered.filter((c) => c.category !== 'system' && c.category !== 'mcp')
            const mcp = filtered.filter((c) => c.category === 'mcp')
            // 用户技能（自己加的、项目里的、额外目录）：也给卡片，跟插件一样点一下开关。
            // 插件技能和内置技能挂在各自插件卡里，这里不重复列。
            const userSkills = (skills || [])
                .filter((sk) => (sk.origin?.bucket ?? 'other') === 'other')
                .map((sk) => ({ value: sk.name, label: sk.name, desc: sk.description || '' }))
            const knownSkill = new Set(userSkills.map((x) => x.value))
            // 老预设里可能存着内置技能名（那时还没接管这一层），它们没有卡片可点，
            // 但保存后会照样生效，所以要列出来并且给一个出口。
            const straySkills = kOff.filter((n) => !knownSkill.has(n))

            return React.createElement('div', { style: { marginTop: 6 } },
                React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 6 } },
                    `选一套模式 = 按它的插件清单来开关；插件在清单里就勾着，不在就把它带来的工具和提示词一起停用，改任何一项会自动变成「自定义模式」。`
                    + `只动预设圈这一层（本页可调的 ${managedCards.length} 个插件，=${managedTools.length} 个工具 + ${managedSections.length} 段提示词）；`
                    + '用户插件和 MCP 连接也不归预设管。'),
                React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, ...modeCards),
                docId
                    ? React.createElement('pre', {
                        style: {
                            margin: '8px 0 0', padding: 10, borderRadius: 8, maxHeight: 240,
                            overflow: 'auto', background: C.panel, border: `1px solid ${C.border}`,
                            fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        },
                    }, doc ? (doc.error || doc.content || '（这套预设没有声明任何插件）') : '读取中…')
                    : null,
                React.createElement('div', { style: { ...S.row, margin: '10px 0 6px', flexWrap: 'nowrap' } },
                    React.createElement('input', {
                        style: { ...S.input, flex: 1, minWidth: 100, margin: 0 },
                        value: q, placeholder: '按插件名或它底下的工具/提示词/技能筛选',
                        onChange: (e) => setQ(e.target.value),
                    }),
                    React.createElement('span', { style: { ...S.muted, whiteSpace: 'nowrap' } },
                        `停用 ${tOff.length} 工具 / ${pOff.length} 提示词 / ${kOff.length} 技能`),
                    btn('全部恢复', () => onChange({ toolOff: [], sectionsOff: [], skillsOff: [] }))),
                zone('系统插件', 'Agent 预设管的，切模式会跟着变', sysPreset),
                zone('宿主自带', '', sysHost),
                zone('用户插件', '', usr),
                zone('MCP', '按连接分，不归预设管', mcp),
                userSkills.length === 0 ? null : React.createElement('div', { style: { marginTop: 10 } },
                    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
                        React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: C.text2 } }, '用户技能'),
                        React.createElement('span', { style: { ...S.muted, fontSize: 11 } }, '插件技能和内置技能在上面各自的插件卡里')),
                    React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
                        ...userSkills.map((sk) => {
                            const off = kOff.includes(sk.value)
                            return React.createElement('div', {
                                key: `sk:${sk.value}`,
                                onClick: () => emit('skills', [sk.value], off),
                                title: sk.desc || sk.value,
                                style: {
                                    width: 210, padding: 8, borderRadius: 8, cursor: 'pointer', userSelect: 'none',
                                    border: `1px solid ${off ? C.border : C.border2}`,
                                    background: C.bg, opacity: off ? 0.72 : 1,
                                },
                            },
                                React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                                    React.createElement('input', {
                                        type: 'checkbox', checked: !off, readOnly: true,
                                        style: { marginTop: 2, pointerEvents: 'none' },
                                    }),
                                    React.createElement('div', { style: { minWidth: 0 } },
                                        React.createElement('div', {
                                            style: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                                        }, sk.label),
                                        sk.desc
                                            ? React.createElement('div', {
                                                style: {
                                                    ...S.muted, fontSize: 10.5, marginTop: 2, lineHeight: 1.4,
                                                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                                },
                                            }, sk.desc)
                                            : null)))
                        })),
                    straySkills.length === 0 ? null : React.createElement('div', {
                        style: { ...S.muted, fontSize: 11, marginTop: 6, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' },
                    },
                        React.createElement('span', null,
                            `另有 ${straySkills.length} 个旧条目不在当前技能列表里（${straySkills.slice(0, 4).join('、')}${straySkills.length > 4 ? '…' : ''}），保存后仍会停用：`),
                        React.createElement('span', {
                            onClick: () => onChange({ toolOff: tOff, sectionsOff: pOff, skillsOff: kOff.filter((n) => knownSkill.has(n)) }),
                            style: { color: C.accent, cursor: 'pointer' },
                        }, '清掉'))))
        }

        // 盘上的名单 -> 停用名单。盘上可能是 mode:'allow'（只放行）形态，
        // 用当前候选集反推成停用名单，语义不变。
        function denyOf(filter, options) {
            if (!filter) return []
            if (filter.mode === 'allow') {
                const all = (options || []).map((o) => o.value)
                return all.filter((n) => !(filter.names || []).includes(n))
            }
            return [...(filter.names || [])]
        }

        // 单个页签崩了不能把整个面板从槽里整块拆掉（那会只剩一个空白主区，用户
        // 完全没线索、点别的页签也回不来）。用错误边界把异常收敛成一条可读文案。
        class PageBoundary extends React.Component {
            constructor(props) {
                super(props)
                this.state = { error: null }
            }
            static getDerivedStateFromError(error) {
                return { error: String(error?.message ?? error) }
            }
            componentDidCatch(error) {
                console.error('[scope-manager] page crashed', error)
            }
            render() {
                if (this.state.error) {
                    return React.createElement('div', { style: S.card },
                        React.createElement('div', { style: { color: C.error, fontWeight: 600 } }, '这个页签渲染失败'),
                        React.createElement('div', { style: { ...S.muted, marginTop: 8 } }, `错误信息：${this.state.error}`))
                }
                return this.props.children
            }
        }

        // ——————————————————— 作用域页：一棵层级树 ———————————————————
        //
        // 全局 → 工作区 → 会话，每个节点只绑一个**预设**（存储里仍叫 scene）。三态：
        //   继承上级（不写这个键）/ 默认预设（写 null）/ 指定某个预设（写 id）
        //
        // 「默认预设」= 全部工具与技能都启用 —— 它不是一个固定的白名单，而是
        // **没有名单**，所以以后新装的工具、新写的技能天然就在里面。

        const SCENE_INHERIT = ''
        const SCENE_DEFAULT = '__default__'

        function ScopePage({ sessionCtx, reloadToken }) {
            // 整棵树由宿主算好：工作区、会话（活的 + 落盘的）、标题、归档/置顶标记、
            // 每个节点绑了哪个预设。客户端只负责渲染与筛选。
            const [data, setData] = useState(null)
            const [collapsed, setCollapsed] = useState({})
            const [showArchived, setShowArchived] = useState(false)
            const [showSubagents, setShowSubagents] = useState(false)
            const [error, setError] = useState('')
            const [busy, setBusy] = useState(false)
            const [tick, setTick] = useState(0)
            // 本会话当前的权限档位（宿主 `permissions` 投影的 currentValue）。
            const [permNow, setPermNow] = useState('')

            const load = useCallback(async () => {
                setError('')
                try {
                    setData(await apiCall('tree'))
                }
                catch (e) { setError(String(e.message ?? e)) }
                try {
                    const sid = sessionCtx?.current?.id ?? ''
                    const res = await apiCall('permission-catalog', sid ? { sessionId: sid } : {})
                    setPermNow(sid ? (res.current ?? res.currentOf?.[sid] ?? '') : '')
                }
                catch { setPermNow('') }
            }, [sessionCtx])

            useEffect(() => { void load() }, [load, reloadToken, tick])

            const allRows = useMemo(() => {
                const out = []
                for (const g of data?.workspaces ?? []) { out.push(...(g.sessions ?? [])) }
                return out
            }, [data])
            const archived = useMemo(() => new Set(allRows.filter((r) => r.archived).map((r) => r.id)), [allRows])
            const pinned = useMemo(() => new Set(allRows.filter((r) => r.pinned).map((r) => r.id)), [allRows])

            const bind = async (scope, scene, extra) => {
                setBusy(true); setError('')
                try {
                    await apiCall('scene-bind', { scope, scene, ...extra })
                    await load()
                    setTick((n) => n + 1)
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /**
             * 删会话：不可恢复，所以问两次。
             * 第一次确认目标；如果宿主说「它还在跑」，第二次问要不要停掉再删。
             */
            const removeSession = async (row) => {
                const name = row.title || row.id
                if (!window.confirm(`删除这个会话？\n${name}\n\n会话文件会一起删掉，不可恢复。子代理会话也会一起删。`)) {
                    return
                }
                setBusy(true); setError('')
                try {
                    await apiCall('session-delete', { id: row.id })
                }
                catch (e) {
                    const message = String(e.message ?? e)
                    if (/仍在运行|还在运行/.test(message)) {
                        if (window.confirm(`这个会话还在运行。\n\n先停掉它再删？`)) {
                            try {
                                await apiCall('session-delete', { id: row.id, force: true })
                            }
                            catch (e2) {
                                setError(String(e2.message ?? e2))
                            }
                        }
                    }
                    else {
                        setError(message)
                    }
                }
                finally {
                    await load()
                    setTick((n) => n + 1)
                    setBusy(false)
                }
            }

            const manage = async (op, args, question) => {
                if (question && !window.confirm(question)) { return }
                setBusy(true); setError('')
                try {
                    await apiCall(op, args)
                    await load()
                    setTick((n) => n + 1)
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /** 一个节点自己绑的是什么。 */
            const ownOf = (scope, key) => {
                let raw
                if (scope === 'global') {
                    raw = data?.global
                }
                else if (scope === 'workspace') {
                    raw = (data?.workspaces ?? []).find((g) => g.path === key)?.scene
                }
                else {
                    raw = allRows.find((r) => r.id === key)?.scene
                }
                if (raw === undefined) { return SCENE_INHERIT }
                if (raw === null) { return SCENE_DEFAULT }
                return raw
            }

            const scenes = data?.scenes ?? []
            /** 从这一节往上找：会话 → 工作区 → 全局；都没有就是默认预设。 */
            /** 节点上的预设下拉。 */
            const sceneSelect = (scope, key, extra) => {
                const own = ownOf(scope, key)
                const options = []
                if (scope !== 'global') {
                    options.push({ v: SCENE_INHERIT, t: '继承上级' })
                    options.push({ v: SCENE_DEFAULT, t: '默认预设（全部启用）' })
                }
                else {
                    options.push({ v: SCENE_INHERIT, t: '默认预设（全部启用）' })
                }
                for (const s of scenes) { options.push({ v: s.id, t: `${s.name}${s.description ? ' — ' + s.description : ''}` }) }
                return React.createElement('select', {
                    style: { ...S.btn(false), padding: '3px 6px', fontSize: 12, width: 208, flex: '0 0 auto' },
                    value: own,
                    disabled: busy,
                    onChange: (e) => { void bind(scope, e.target.value, extra) },
                }, options.map((o) => React.createElement('option', { key: o.v, value: o.v }, o.t)))
            }

            const currentId = sessionCtx?.current?.id ?? ''

            /** 这一列里该显示哪些会话。子代理默认藏起来：它们继承父会话的作用域。 */
            const visible = useCallback((list) => (list ?? []).filter((r) => {
                if (r.archived && !showArchived) { return false }
                if (r.origin === 'subagent' && !showSubagents) { return false }
                return true
            }), [showArchived, showSubagents])

            const groups = useMemo(() => (data?.workspaces ?? []).filter((g) => g.path !== ''), [data])
            const loose = useMemo(() => {
                const g = (data?.workspaces ?? []).find((x) => x.path === '')
                return visible(g?.sessions ?? [])
            }, [data, visible])

            const archivedCount = allRows.filter((r) => r.archived).length
            const subagentCount = allRows.filter((r) => r.origin === 'subagent').length

            // 操作按钮统一宽度，右侧那一列才对得齐。
            const act = (label, onClick, danger, title) => React.createElement('button', {
                type: 'button',
                title,
                disabled: busy,
                style: { ...S.btn(false), minWidth: 62, flex: '0 0 auto', ...(danger ? { color: C.error, borderColor: C.error } : {}) },
                onClick,
            }, label)

            const sessionRow = (r) => {
                const isArchived = r.archived === true
                const isPinned = r.pinned === true
                return React.createElement('div', {
                    key: r.id,
                    style: {
                        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                        padding: '4px 0 4px 26px', opacity: isArchived ? 0.55 : 1,
                    },
                },
                    React.createElement('span', { style: { width: 6 } }),
                    React.createElement('span', {
                        style: { flex: '0 1 auto', maxWidth: 420, minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        title: r.id,
                    }, `${currentId === r.id ? '● ' : ''}${r.title || '（未命名会话）'}`,
                        // 没标题 / 标题只是目录名时整列看起来一模一样，补一小截 id 才分得清。
                        !r.title || r.title === (r.cwd.split('/').filter(Boolean).pop() ?? '')
                            ? React.createElement('span', { style: { ...S.muted, marginLeft: 6, fontSize: 11 } },
                                `#${r.id.slice(-6)}`)
                            : null,
                        r.origin === 'subagent'
                            ? React.createElement('span', { style: { ...S.chip(), marginLeft: 6 } }, '子代理')
                            : null,
                        isArchived
                            ? React.createElement('span', { style: { ...S.chip(), marginLeft: 6 } }, '已归档')
                            : null),
                    // 弹性留白：把「预设 → 删除」这一串统一推到右边，标题长短不影响对齐。
                    React.createElement('span', { style: { flex: '1 1 12px', minWidth: 8 } }),
                    React.createElement('span', null,
                        sceneSelect('session', r.id, { sessionId: r.id, cwd: r.cwd })),
                    isArchived
                        ? act('取消归档', () => void manage('session-unarchive', { id: r.id }))
                        : act('归档', () => void manage('session-archive', { id: r.id }, `归档这个会话？\n${r.title}`)),
                    act(isPinned ? '取消置顶' : '置顶', () => void manage('session-pin', { id: r.id, pin: !isPinned })),
                    act('删除', () => void removeSession(r), true, '删除会话文件（不可恢复）'))
            }

            const workspaceRow = (w) => {
                const isOpen = collapsed[w.path] !== true
                const kids = visible(w.sessions)
                return React.createElement('div', { key: w.path, style: { marginBottom: 4 } },
                    React.createElement('div', {
                        style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '5px 0' },
                    },
                        React.createElement('span', {
                            style: { cursor: 'pointer', width: 14, color: C.dim, userSelect: 'none' },
                            onClick: () => setCollapsed({ ...collapsed, [w.path]: isOpen }),
                        }, isOpen ? '▾' : '▸'),
                        React.createElement('span', { style: { fontWeight: 600 } },
                            w.title || w.path,
                            w.registered
                                ? null
                                : React.createElement('span', { style: { ...S.chip(), marginLeft: 6 } }, '未登记为工作区')),
                        React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } }, w.path),
                        React.createElement('span', { style: { flex: '1 1 12px', minWidth: 8 } }),
                        sceneSelect('workspace', w.path, { cwd: w.path }),
                        React.createElement('span', { style: { ...S.muted, fontSize: 11.5, minWidth: 56, textAlign: 'right' } },
                            `${kids.length} 个会话`),
                        w.registered
                            ? act('重命名', () => {
                                const title = window.prompt('工作区标题', w.title || '')
                                if (title !== null) { void manage('workspace-rename', { id: w.workspaceId, title }) }
                            })
                            : null,
                        w.registered
                            ? act('移除', () => void manage('workspace-remove', { id: w.workspaceId },
                                `移除工作区登记？\n${w.path}\n\n目录和会话日志都会保留。`))
                            : null),
                    isOpen ? kids.map(sessionRow) : null,
                    isOpen && kids.length === 0
                        ? React.createElement('div', { style: { ...S.muted, paddingLeft: 26, fontSize: 11.5 } }, '这个工作区还没有会话')
                        : null)
            }

            return React.createElement('div', { style: S.page },
                React.createElement(ErrorBar, { error }),
                React.createElement('div', { style: { ...S.card } },
                    React.createElement('div', { style: S.h2 }, '层级作用域'),
                    React.createElement('div', { style: S.muted },
                        '只给每一层绑一个预设。没绑就继承上级：会话 → 工作区 → 全局。'),
                    React.createElement('div', { style: { ...S.muted, marginTop: 4 } },
                        `「默认预设」= 全部工具与技能都启用（以后新增的也自动启用）；全局不绑也是这个意思。`),
                    // 这一行是给预设「权限档位」用的：预设设了权限，切进来那一下就会把
                    // 会话的权限切过去；这里显示它当前实际落在哪一档，省得去输入框看。
                    React.createElement('div', { style: { ...S.muted, marginTop: 6, fontSize: 11.5 } },
                        `本会话当前：权限 ${permNow
                            ? `${PERMISSION_CHOICES.find((p) => p.value === permNow)?.label ?? permNow}`
                            : '未知'}`)),

                // —— 全局 ——
                React.createElement('div', { style: { ...S.card, borderLeft: `3px solid ${C.accent}` } },
                    React.createElement('div', { style: S.row },
                        React.createElement('span', { style: { fontWeight: 700 } }, '全局'),
                        React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } }, '所有工作区与会话的根'),
                        React.createElement('span', { style: { flex: '1 1 12px', minWidth: 8 } }),
                        sceneSelect('global', '', {}),
                        busy ? React.createElement('span', { style: S.muted }, '处理中…') : null)),

                // —— 工作区 ——
                React.createElement('div', { style: S.card },
                    React.createElement('div', { style: S.row },
                        React.createElement('span', { style: S.h2 }, '工作区'),
                        React.createElement('span', { style: { ...S.muted, fontSize: 11.5, marginLeft: 'auto' } },
                            `${groups.length} 个工作区 · ${allRows.length} 个会话`),
                        React.createElement('label', { style: { ...S.muted, fontSize: 11.5, cursor: 'pointer' } },
                            React.createElement('input', {
                                type: 'checkbox', checked: showSubagents,
                                onChange: (e) => setShowSubagents(e.target.checked),
                                style: { marginRight: 4, verticalAlign: 'middle' },
                            }),
                            `显示子代理会话（${subagentCount}）`),
                        // 和「显示子代理会话」并排：两个都是「这一列里默认藏了什么」的开关。
                        // 归档数为 0 也照常显示，勾上才看得见这个开关存在过。
                        React.createElement('label', { style: { ...S.muted, fontSize: 11.5, cursor: 'pointer' } },
                            React.createElement('input', {
                                type: 'checkbox', checked: showArchived,
                                onChange: (e) => setShowArchived(e.target.checked),
                                style: { marginRight: 4, verticalAlign: 'middle' },
                            }),
                            `显示归档会话（${archivedCount}）`)),
                    groups.length === 0
                        ? React.createElement('div', { style: { ...S.muted, marginTop: 8 } }, '宿主还没有登记任何工作区。')
                        : React.createElement('div', { style: { marginTop: 8 } }, groups.map(workspaceRow)),
                    loose.length
                        ? React.createElement('div', { style: { marginTop: 10 } },
                            React.createElement('div', { style: { ...S.muted, fontSize: 12, marginBottom: 4 } }, '未归入工作区的会话'),
                            loose.map(sessionRow))
                        : null),

                data === null
                    ? React.createElement(Loading, null)
                    : null)
        }
        // ——————————————————— 角色卡页 ———————————————————
        function PersonaPage({ reloadToken, onChanged }) {
            const [list, setList] = useState(null)
            const [current, setCurrent] = useState(null)
            const [error, setError] = useState('')
            const [busy, setBusy] = useState(false)
            const [form, setForm] = useState(null)
            // 系统提示词那边的现状：覆盖模式下要显示「原提示词」，还要列可用占位符。
            const [sectionsByName, setSectionsByName] = useState({})
            const [promptVars, setPromptVars] = useState([])

            const load = useCallback(async () => {
                setError('')
                try {
                    const [data, sec, vars] = await Promise.all([
                        apiCall('persona-list', {}),
                        apiCall('sections-list', {}).catch(() => ({ sections: [] })),
                        apiCall('variables-list', {}).catch(() => ({ list: [] })),
                    ])
                    setList(data.personas ?? [])
                    const byName = {}
                    for (const item of sec.sections ?? []) {
                        byName[item.name] = item
                    }
                    setSectionsByName(byName)
                    setPromptVars(vars.list ?? [])
                }
                catch (e) { setError(String(e.message ?? e)) }
            }, [])

            useEffect(() => { load() }, [load, reloadToken])

            // 三段正文分别对应系统提示词里的哪一条（新卡默认把当前原文装进来）。
            // [键, 标题, 目标段落（只在覆盖模式显示）, 要预填的段落名（null = 没有自己的段落）]
            //
            // 行为约束**不单独占一段**：它接在角色设定末尾、同属 `deployment:persona-prefix`。
            // 所以它没有可预填的段落，也不该在面板里被当成独立的一段去盖。
            const PART_FIELDS = [
                ['worldview', '世界观', 'harness:identity', 'harness:identity'],
                ['character', '角色设定', 'deployment:persona-prefix', 'deployment:persona-prefix'],
                ['constraints', '行为约束', 'deployment:persona-prefix 末尾', null],
            ]

            const blankForm = () => ({
                id: '', name: '', description: '',
                worldview: '', character: '', constraints: '',
                inject: 'context',
            })

            /** 新建时把当前那三条人设段的原文装进三个框 —— 编辑的就是模型此刻真正看到的文字。 */
            const prefillFromSections = async (form0) => {
                try {
                    const data = await apiCall('sections-list', {})
                    const byName = new Map((data.sections ?? []).map((x) => [x.name, x]))
                    for (const [key, , , sectionName] of PART_FIELDS) {
                        if (sectionName) {
                            form0[key] = String(byName.get(sectionName)?.text ?? '')
                        }
                    }
                }
                catch { /* 拿不到就留空，不影响手写 */ }
                return form0
            }

            const open = async (id) => {
                setError('')
                try {
                    if (!id) {
                        setCurrent(null)
                        setForm(await prefillFromSections(blankForm()))
                        return
                    }
                    const data = await apiCall('persona-read', { id })
                    setCurrent(data.persona)
                    // 老卡（或从 body 存下来的卡）可能只有 parts / body，没有三段字段；
                    // 先把能拿到的正文填进三个框 —— 否则切模式时会看到三个空框，像是字丢了。
                    const loaded = { ...blankForm(), ...data.persona }
                    const parts = data.persona?.parts ?? {}
                    for (const [key] of PART_FIELDS) {
                        if (!String(loaded[key] ?? '').trim() && String(parts[key] ?? '').trim()) {
                            loaded[key] = parts[key]
                        }
                    }
                    if (!String(loaded.worldview ?? '').trim() && !String(loaded.character ?? '').trim()
                        && !String(loaded.constraints ?? '').trim() && String(data.persona?.body ?? '').trim()) {
                        loaded.character = data.persona.body
                    }
                    setForm(loaded)
                }
                catch (e) { setError(String(e.message ?? e)) }
            }

            const save = async () => {
                setBusy(true); setError('')
                try {
                    const data = await apiCall('persona-save', {
                        id: form.id || undefined,
                        name: form.name,
                        description: form.description,
                        worldview: form.worldview,
                        character: form.character,
                        constraints: form.constraints,
                        inject: form.inject,
                    })
                    setCurrent(data.persona)
                    setForm({ ...blankForm(), ...data.persona })
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const del = async () => {
                if (!current) return
                setBusy(true); setError('')
                try {
                    await apiCall('persona-delete', { id: current.id })
                    setCurrent(null); setForm(blankForm())
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            if (!list) return React.createElement('div', { style: S.page }, React.createElement(Loading, null))

            // 只摆对「写角色卡」真有意义的变量。
            // provider（供应商 id）和本插件自己的 mcp_servers 都跟人设无关，
            // 摆出来只会诱人去写 `{{provider}}`，索性不列。
            const HIDDEN_VARS = new Set(['provider', 'mcp_servers']);
            const visibleVars = promptVars.filter((v) => v.scm !== true && !HIDDEN_VARS.has(v.name))

            /** 三段各写了多少字 —— 卡片上用来一眼看出这张卡是不是空的。 */
            const partSizes = (p) => {
                const parts = p.parts ?? { worldview: p.worldview, character: p.character, constraints: p.constraints }
                const n = (v) => String(v ?? '').trim().length
                return { worldview: n(parts.worldview), character: n(parts.character), constraints: n(parts.constraints) }
            }

            /** 一张角色卡（和插件页 / MCP 页 / 技能页同一套卡片）。 */
            const card = (p) => {
                const size = partSizes(p)
                const system = p.inject === 'system'
                const summary = String(p.description ?? '').trim()
                    || String(p.character ?? p.parts?.character ?? '').trim()
                    || '（这张卡还没写正文）'
                return EntityCard({
                    key: p.id,
                    avatar: React.createElement(SkillAvatar, { name: p.name || p.id, size: 26 }),
                    title: p.name || p.id,
                    titleAttr: summary,
                    badge: miniChip(system ? '覆盖系统提示词' : '角色卡上下文', system ? C.warn : C.accent),
                    desc: summary,
                    descMinHeight: 42,
                    foot: `世界观 ${size.worldview} 字 · 角色 ${size.character} 字 · 约束 ${size.constraints} 字`,
                    onClick: () => open(p.id),
                    extra: React.createElement('div', {
                        style: { ...S.row, gap: 4, flexWrap: 'nowrap', marginTop: 2 },
                    },
                        btn('编辑', (e) => { e?.stopPropagation?.(); open(p.id) }),
                        btn('删除', (e) => {
                            e?.stopPropagation?.()
                            if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                                && !window.confirm(`删掉角色卡「${p.name || p.id}」？`)) return
                            apiCall('persona-delete', { id: p.id })
                                .then(() => load())
                                .then(() => onChanged?.())
                                .catch((err) => setError(String(err.message ?? err)))
                        })),
                })
            }

            return React.createElement('div', { style: S.page },
                React.createElement(ErrorBar, { error }),
                // 编辑态把「新建」那颗收起来，版式和其它页的详情一致。
                form ? null : React.createElement('div', { style: { ...S.row, marginBottom: 10 } },
                    btn('新建角色卡', () => open(''), true),
                    React.createElement('span', { style: S.muted },
                        `共 ${list.length} 张 · 角色卡 = 一段人设正文，供预设与会话层引用`)),
                form ? null : React.createElement(React.Fragment, null,
                    list.length === 0
                        ? React.createElement('div', { style: S.muted }, '还没有角色卡。点「新建角色卡」写一张。')
                        : React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
                            list.map((p) => card(p)))),
                form ? React.createElement(React.Fragment, null,
                    React.createElement(BackBar, { label: '全部角色卡', onClick: () => { setForm(null); setCurrent(null) } }),
                    current
                        ? React.createElement('div', { style: { ...S.card, padding: 14, marginBottom: 12 } },
                            React.createElement('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
                                React.createElement(SkillAvatar, { name: current.name || current.id, size: 32 }),
                                React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } },
                                    current.name || current.id),
                                miniChip(current.inject === 'system' ? '覆盖系统提示词' : '角色卡上下文',
                                    current.inject === 'system' ? C.warn : C.accent),
                                React.createElement('span', { style: { flex: 1 } }),
                                current.updatedAt
                                    ? React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } },
                                        `改于 ${String(current.updatedAt).slice(0, 16).replace('T', ' ')}`)
                                    : null),
                            React.createElement('div', { style: { ...S.muted, fontSize: 12, marginTop: 6, wordBreak: 'break-all' } },
                                `id=${current.id}`),
                            current.description
                                ? React.createElement('div', { style: { fontSize: 12.5, color: C.text2, marginTop: 6 } },
                                    current.description)
                                : null)
                        : null,
                    React.createElement('div', { style: S.card },
                    React.createElement(Field, { label: 'id（留空自动生成；生成后不可改）' },
                        React.createElement('input', {
                            style: S.input, value: form.id ?? '', disabled: Boolean(current),
                            onChange: (e) => setForm({ ...form, id: e.target.value }),
                        })),
                    React.createElement(Field, { label: '名称' },
                        React.createElement('input', {
                            style: S.input, value: form.name ?? '',
                            onChange: (e) => setForm({ ...form, name: e.target.value }),
                        })),
                    React.createElement(Field, { label: '一句话说明' },
                        React.createElement('input', {
                            style: S.input, value: form.description ?? '',
                            onChange: (e) => setForm({ ...form, description: e.target.value }),
                        })),
                    // 模式选择器：两档，切换**只改注入方式**，下面三个框里的字一个字都不动。
                    // 两个选项并排看着像两个各自独立的动作，容易让人以为点一下会重填正文。
                    React.createElement(Field, { label: '模式（切哪个都不会动下面三个框里的字，保存后才生效）' },
                        React.createElement('div', { style: { ...S.row, gap: 0, alignItems: 'stretch' } },
                            ...MODE_CHOICES.map(({ value, label, hint }, i) => {
                                const on = (form.inject === 'system') === (value === 'system')
                                return React.createElement('button', {
                                    key: value,
                                    type: 'button',
                                    title: hint,
                                    onClick: () => setForm({ ...form, inject: value }),
                                    style: {
                                        flex: '1 1 0',
                                        minWidth: 0,
                                        padding: '8px 10px',
                                        fontSize: 12.5,
                                        fontWeight: on ? 600 : 400,
                                        cursor: 'pointer',
                                        color: on ? C.text : C.dim,
                                        background: on ? C.accentSoft ?? 'rgba(160,60,160,.10)' : 'transparent',
                                        border: `1px solid ${on ? C.accent : C.border ?? 'rgba(0,0,0,.12)'}`,
                                        borderRadius: i === 0 ? '7px 0 0 7px' : '0 7px 7px 0',
                                        marginLeft: i === 0 ? 0 : -1,
                                        textAlign: 'left',
                                    },
                                },
                                    React.createElement('div', null,
                                        on ? '● ' : '○ ', label),
                                    React.createElement('div', {
                                        style: { fontSize: 10.5, lineHeight: 1.4, marginTop: 2, fontWeight: 400, opacity: 0.8 },
                                    }, hint))
                            })),
                        React.createElement('div', {
                            style: { ...S.muted, fontSize: 11.5, marginTop: 6, whiteSpace: 'pre-wrap' },
                        }, form.inject === 'system'
                            ? '系统提示词覆盖：正文直接盖到系统提示词的那两段上。某一格留空也会盖 —— 等于把那一段抹掉。'
                            : '角色卡上下文：三段拼成一条合成 user 消息插到对话里，不占系统提示词，也不受预设 complete 影响。')),
                    // 覆盖模式：注意事项 1–3 + 第 4 条「可用占位符」全装进同一个框里。
                    form.inject === 'system'
                        ? React.createElement('div', {
                            style: { ...S.card, marginBottom: 10, padding: 10, ...S.muted, fontSize: 11.5 },
                        },
                            React.createElement('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.6 } },
                                [
                                    '1. 通过覆盖系统提示词方式注入。',
                                    '2. 遇到 complete:true 的预设，整份提示词只剩那一段，这里的覆盖会一起失效。',
                                    '3. 内容为空也直接覆盖原有提示词：某一格留空 = 那一段被抹掉、模型看不到那句话。',
                                ].join('\n')),
                            React.createElement('div', { style: { ...S.row, gap: 6, flexWrap: 'wrap', marginTop: 6 } },
                                React.createElement('span', null, '4. 可用占位符：'),
                                // 插件自己造的那些变量（`mcp_servers` 之类）不列：它们属于本插件的
                                // 覆写机制，角色卡这三段用不上，摆出来只会让人以为能用。
                                visibleVars.length === 0
                                    ? React.createElement('span', null, '（还没观测到可用变量）')
                                    : visibleVars.map((v) => React.createElement('span', {
                                        key: v.name,
                                        style: { ...S.chip(''), fontFamily: 'ui-monospace, Menlo, monospace' },
                                        title: v.value ? `当前值：${v.value}` : '当前值为空',
                                    }, `{{${v.name}}}`))))
                        : null,
                    ...PART_FIELDS.map(([key, label, target, sectionName]) => {
                        const system = form.inject === 'system'
                        // 「原提示词」= 这一段在系统提示词里的当前原文（覆盖前长什么样）。
                        const original = sectionName ? String(sectionsByName[sectionName]?.text ?? '') : ''
                        return React.createElement(Field, {
                            key,
                            // 上下文模式不指向任何段落：三段只是一条消息里的三段。
                            label: system ? `${label}（→ ${target}）` : label,
                        },
                            system
                                // 有自己段落的（世界观、角色设定）：这一行点一下就回填原文。
                                // 行为约束没有独立段落（接在 prefix 末尾），回填整段 prefix 会把
                                // 角色设定又抄一份，所以它只作展示、不给回填。
                                ? (sectionName
                                    ? React.createElement('div', {
                                        style: {
                                            ...S.muted, fontSize: 11.5, marginTop: 2, marginBottom: 4,
                                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                            maxHeight: 52, overflow: 'hidden',
                                            cursor: 'pointer', textDecoration: 'underline dotted',
                                        },
                                        title: '点一下把原文填进下面的文本框',
                                        onClick: () => setForm({ ...form, [key]: original }),
                                    }, `原提示词：${original.trim() ? original : '（空）'}`, original.trim()
                                        ? React.createElement('span', { style: { ...S.muted, fontSize: 10.5 } }, '　（点一下回填）')
                                        : null)
                                    : React.createElement('div', {
                                        style: {
                                            ...S.muted, fontSize: 11.5, marginTop: 2, marginBottom: 4,
                                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                            maxHeight: 52, overflow: 'hidden',
                                        },
                                    }, `原提示词：${original.trim() ? original : '（空）'}`, '　（接在角色设定末尾）'))
                                : null,
                            React.createElement('textarea', {
                                style: { ...S.textarea, minHeight: key === 'character' ? 160 : 100 },
                                value: form[key] ?? '',
                                onChange: (e) => setForm({ ...form, [key]: e.target.value }),
                            }))
                    }),
                    React.createElement('div', { style: S.row },
                        btn('保存', save, true),
                        current ? btn('删除', del) : null,
                        busy ? React.createElement('span', { style: S.muted }, '处理中…') : null)))
                    : null)
        }

        // ——————————————————— 插件页 ———————————————————
        // 界面上按「来源包」看：系统插件（宿主自带）和用户插件（自己装的）两个子页，
        // MCP 不在这里 —— 那批工具跟着连接器走，单独一页。
        const CATEGORY_ORDER = ['system', 'plugin', 'mcp', 'other']
        const CATEGORY_LABELS = {
            system: '系统插件', plugin: '用户插件', mcp: 'MCP', other: '其他',
        }

        /**
         * 一组工具对应的系统提示词段落。
         *
         * 三件事：看（这段话是谁 push 的、原文长什么样）、选（注入不注入）、
         * 改（把文字覆写掉）。覆写不写回插件源码，只在装配那一刻把这段文字换掉。
         *
         * 注入状态就是一个开关：注入 / 不注入（全局一份，与作用域无关）。
         * 勾上 = 这一段进模型，取消 = 不进。名单只在没被人点过名时才起作用。
         */
        function SectionPanel({
            sections, busy, onState, onToggle, onSave, onBind, editing, vars,
            bindCandidates, ownerCandidates, onBindOwner,
        }) {
            // 哪一段展开了「关联」面板（同一时刻只开一个）
            const [bindName, setBindName] = useState(null)
            if (!sections || sections.length === 0) {
                return React.createElement('div', { style: { ...S.muted, padding: '4px 0 4px 14px' } },
                    '这一组没有自己的系统提示词段落。')
            }
            return React.createElement('div', { style: { margin: '4px 0 8px 14px' } },
                sections.map((sec) => {
                    const open = editing?.name === sec.name
                    // 开关显示的是**实际生效**的注入状态：全局点过名就是点名值，
                    // 没点过名就是名单/默认算出来的值。点一下就写成全局的明确值。
                    const on = sec.injected === true
                    return React.createElement('div', { key: sec.name, style: { ...S.card, marginBottom: 6, padding: 10 } },
                        React.createElement('div', { style: { ...S.row } },
                            sec.position ? React.createElement('span', { style: { ...S.muted, fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace' } },
                                `${sec.position}.`) : null,
                            React.createElement('span', { style: { fontSize: 12.5, fontWeight: 600 } }, sec.name),
                            sec.pinned ? React.createElement('span', { style: S.chip('') }, '固定名次') : null,
                            sec.alwaysOn ? React.createElement('span', { style: S.chip('') }, '常开') : null,
                            sec.personaInjected
                                ? React.createElement('span', { style: S.chip('') }, '角色卡')
                                : null,
                            React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } },
                                sec.pinnedOwner && sec.plugin === sec.pinnedOwner
                                    // 这个归属是人点出来的，别写成「来源」——那是反查出来的才叫来源
                                    ? `　归属 ${sec.plugin}（手动指定）`
                                    : sec.plugin ? `　来源 ${sec.plugin}`
                                    : (sec.file ? `　${sec.file}${sec.line ? ':' + sec.line : ''}`
                                        // `mcp:<server>` 这类段落是服务器自己推的目录，
                                        // 没有插件也没有文件 —— 归属就是那台服务器。
                                        : (sec.sourceHint ? `　来源 ${sec.sourceHint}` : '　来源不明'))),
                            React.createElement('span', { style: { flex: 1 } }),
                            React.createElement('label', {
                                style: { ...S.row, cursor: 'pointer', gap: 5, fontSize: 12.5 },
                            },
                                React.createElement('input', {
                                    type: 'checkbox',
                                    checked: on,
                                    onChange: (e) => onState(sec, e.target.checked ? 'on' : 'off'),
                                }),
                                React.createElement('span', { style: { color: on ? C.text : C.dim } }, '注入')),
                            // 「归属」= 这段提示词跟着哪几把工具走：关联着的工具一个都没启用，它就不注入。
                            // 有来源插件的段落，候选就是那个包自己的工具；接不到任何插件的段落
                            // （harness:identity 这类）用外部传进来的全量工具当候选 —— 否则这颗按钮根本不会出现。
                            bindToolsOf(sec, bindCandidates).length > 0
                                ? btn(bindName === sec.name ? '收起' : '归属',
                                    () => setBindName(bindName === sec.name ? null : sec.name))
                                : null,
                            btn(open ? '收起' : '编辑', () => onToggle(open ? null : sec))),
                        React.createElement('div', {
                            style: {
                                ...S.muted, fontSize: 11.5, marginTop: 5, whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word', maxHeight: 96, overflow: 'hidden',
                            },
                        }, (sec.overrideText ?? sec.text ?? '').slice(0, 600)),
                        React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 3 } },
                            `实际：${sec.injected ? '注入' : '不注入'}`,
                            // 角色卡注入 ≠ 手改覆写：前者改卡片就会变，后者是本层的覆写。
                            sec.personaInjected
                                ? `　角色卡注入（${sec.overrideSource ?? '系统提示词覆盖'}）`
                                : (sec.overrideText
                                    ? (sec.overrideInjected === false ? '　已覆写（未注入）' : '　已覆写')
                                    : ''),
                            // 关联了什么，写在「实际」这一行的后面
                            sec.bindLabel
                                ? `　${sec.bindLabel}${sec.bindAllOff ? '（工具全关，所以没注入）' : ''}`
                                : ''),
                        bindName === sec.name
                            ? React.createElement(SectionBind, {
                                sec,
                                tools: bindToolsOf(sec, bindCandidates),
                                owners: ownerCandidates,
                                busy,
                                onSave: onBind,
                                onSaveOwner: onBindOwner,
                                onClose: () => setBindName(null),
                            })
                            : null,
                        open ? React.createElement(SectionEditor, { sec, busy, onSave, vars }) : null)
                }))
        }

        /**
         * 关联编辑器：这一段跟哪几把工具绑定。
         *
         * 默认 = 关联「来源插件」：那个包下的工具**全关**才不注入（只关一两把时提示词还留着）。
         * 手动 = 只认勾选的工具：它们一个都不在（预设里关了）就不注入。
         * 关联是全局一份，写进段落目录，与作用域无关。
         */
        /** 这一段能关联哪些工具：优先它自己来源包的工具，没有就用外部给的候选池。 */
        function bindToolsOf(sec, fallback) {
            const own = Array.isArray(sec?.ownerTools) ? sec.ownerTools : []
            if (own.length > 0) return own
            return Array.isArray(fallback) ? fallback : []
        }

        function SectionBind({ sec, tools: candidates, owners, busy, onSave, onSaveOwner, onClose }) {
            const tools = Array.isArray(candidates) ? candidates : []
            const own = Array.isArray(sec.ownerTools) ? sec.ownerTools : []
            // 归属到哪个插件（'' = 不归属任何插件）。候选是插件页里那些包。
            const ownerList = Array.isArray(owners) ? owners : []
            const [owner, setOwner] = useState(String(sec.plugin ?? ''))
            const [custom, setCustom] = useState(Array.isArray(sec.bindTools) && sec.bindTools.length > 0)
            const [picked, setPicked] = useState(() => (sec.bindTools ?? []).slice())
            if (tools.length === 0) {
                return React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 6 } },
                    '这一段接不到任何插件工具，归属对它不生效。')
            }
            const toggle = (name) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]))
            return React.createElement('div', { style: { ...S.card, marginTop: 8, padding: 10 } },
                // 上半截：这段到底算哪个插件的东西（决定它挂在哪张插件卡片里）。
                React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 4 } },
                    ownerList.length > 0
                        ? '归属插件决定这段提示词挂在哪张插件卡片里；选「不归属」就回到「未归组的提示词」。'
                        : '这段提示词挂在哪张插件卡片里。'),
                ownerList.length > 0
                    ? React.createElement('div', { style: { ...S.row, gap: 6, marginBottom: 8 } },
                        React.createElement('select', {
                            style: { ...S.input, flex: 1 },
                            value: owner,
                            onChange: (e) => setOwner(e.target.value),
                        },
                            React.createElement('option', { value: '' }, '（不归属 —— 留在「未归组的提示词」里）'),
                            ownerList.map((o) => React.createElement('option', {
                                key: o.value, value: o.value,
                            }, o.label))),
                        btn('保存归属', () => onSaveOwner?.(sec, owner), true))
                    : null,
                React.createElement('div', {
                    style: { ...S.muted, fontSize: 11.5, marginBottom: 6, marginTop: 4 },
                },
                    '下面这一半是「跟着哪几把工具走」：关联着的工具一个都没启用，它就不注入。'),
                React.createElement('label', { style: { ...S.row, cursor: 'pointer', fontSize: 12.5, marginBottom: 4 } },
                    React.createElement('input', {
                        type: 'radio', checked: !custom, onChange: () => setCustom(false),
                    }),
                    React.createElement('span', null,
                        own.length > 0
                            ? `默认关联插件 ${sec.plugin ?? ''}（包内工具全关才不注入）`
                            : '默认不关联（这段不受工具开关影响）')),
                React.createElement('label', { style: { ...S.row, cursor: 'pointer', fontSize: 12.5, marginBottom: 6 } },
                    React.createElement('input', {
                        type: 'radio', checked: custom, onChange: () => setCustom(true),
                    }),
                    React.createElement('span', null, '只认下面勾选的工具')),
                custom ? React.createElement('div', {
                    style: {
                        maxHeight: 150, overflow: 'auto', paddingLeft: 22, marginBottom: 6,
                        border: `1px solid ${C.border}`, borderRadius: 6, padding: 6,
                    },
                }, tools.map((t) => React.createElement('label', {
                    key: t, style: { ...S.row, cursor: 'pointer', fontSize: 12, padding: '1px 0' },
                },
                    React.createElement('input', {
                        type: 'checkbox', checked: picked.includes(t), onChange: () => toggle(t),
                    }),
                    React.createElement('span', { style: { fontFamily: 'ui-monospace, monospace' } }, t))))
                    : null,
                React.createElement('div', { style: { ...S.row, gap: 8 } },
                    btn('保存关联', () => onSave(sec, custom && picked.length > 0 ? picked : null), true),
                    btn('取消', onClose)))
        }

        /**
         * 段落编辑器：原文只读对照 + 改写输入 + 「注入改写后的内容」开关。
         *
         * 三个动作：
         *  · 保存覆写 —— 把改写存下来；下面的开关决定它要不要真的替换原文。
         *  · 取消覆写 —— 把改写删掉，回到插件原文。
         *  · 关闭     —— 什么都不改。
         */
        function SectionEditor({ sec, busy, onSave, vars }) {
            const [text, setText] = useState(sec.catalogOverride ?? sec.overrideText ?? '')
            const [inject, setInject] = useState(sec.overrideInjected !== false)
            const taRef = useRef(null)
            // 可用占位符**只列这一段原文里自己用到的**（+ 永远可用的 `{{original}}`）。
            // 别的段落用到的变量、宿主那一堆全局变量都不在这里列 —— 手写照样能生效，
            // 但列表只反映「这一段自己的约定」，免得每段都挂一串跟自己无关的按钮。
            const textVars = Array.isArray(sec.textVars) ? sec.textVars : []
            const list = [
                ...textVars
                    .filter((name) => name !== 'original')
                    .map((name) => ({ name, value: '', own: true })),
                { name: 'original', value: '', self: true },
            ]
            // 校验仍然用全集：手写宿主变量/本插件变量不该被误判成坏引用。
            const known = new Set([
                ...(Array.isArray(vars) ? vars : []).map((v) => v.name),
                ...textVars,
                'original',
            ])
            // 就地算一遍坏引用：宿主是在渲染时抛错的，那会儿这一轮已经废了。
            const bad = []
            {
                const re = /\{\{([^{}]*)\}\}/g
                let m = re.exec(text)
                while (m) {
                    const name = m[1]
                    if (!/^[a-z][a-z0-9_]*$/.test(name) || (known.size > 0 && !known.has(name))) {
                        if (!bad.includes(name)) bad.push(name)
                    }
                    m = re.exec(text)
                }
            }
            const insertVar = makeInserter(text, setText, taRef)
            return React.createElement('div', { style: { marginTop: 8 } },
                React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 4 } },
                    '上面是插件原文；下面写的就是装配时换上去的文字，不动插件源码。'),
                React.createElement('pre', {
                    style: {
                        margin: '0 0 6px', padding: 8, maxHeight: 150, overflow: 'auto',
                        background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6,
                        fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    },
                }, sec.text || '（这一段的原文是空的）'),
                React.createElement('textarea', {
                    ref: taRef,
                    style: { ...S.textarea, minHeight: 130 },
                    value: text,
                    placeholder: '在这里写改写后的文字…（占位符用 {{名字}}，点下面的按钮插入）',
                    onChange: (e) => setText(e.target.value),
                }),
                // 可用占位符：宿主唯一的插值写法就是 {{名字}}，且是在装配之后、
                // 渲染之前替换的 —— 所以覆写里写它照样生效。
                sec.literal === true
                    ? React.createElement('div', null,
                        React.createElement('div', { style: { ...S.muted, fontSize: 11.5, margin: '6px 0 0' } },
                            '这一段宿主不插值（interpolate: false）：原文里的 {{…}} 原样给模型。'
                            + '但在下面的覆写里写 {{名字}}，本插件会在装配时替换成当前值。'),
                        // 本插件自己的变量不受这个限制 —— 是我们在装配时替换的，早于宿主渲染。
                        React.createElement(VarChips, { vars: list, onPick: insertVar }))
                    : React.createElement(VarChips, { vars: list, onPick: insertVar }),
                bad.length > 0
                    ? React.createElement('div', {
                        style: { color: C.error, fontSize: 11.5, marginTop: 6 },
                    }, `这些占位符宿主不认识：${bad.map((n) => `{{${n}}}`).join('、')} —— 保存会被拒绝（渲染时它会让这一轮直接失败）`)
                    : null,
                React.createElement('label', {
                    style: { ...S.row, marginTop: 6, cursor: 'pointer', fontSize: 12.5 },
                },
                    React.createElement('input', {
                        type: 'checkbox',
                        checked: inject,
                        onChange: (e) => setInject(e.target.checked),
                    }),
                    React.createElement('span', null,
                        '注入改写后的内容（不勾 = 改写留着，但装配时仍用原文）')),
                React.createElement('div', { style: { ...S.row, marginTop: 6 } },
                    btn('保存覆写', () => onSave(sec, text, inject), true),
                    btn('取消覆写', () => onSave(sec, '', true)),
                    btn('关闭', () => onSave(sec, null)),
                    busy ? React.createElement('span', { style: S.muted }, '处理中…') : null))
        }

        /** 一条工具：左边名字/描述，右边两个按钮。点开后在下面出编辑区。 */
        function ToolRow(props) {
            const { tool, group, editing, ownerEdit, setEditing, setOwnerEdit, busy, onSaveNote, onSaveOwner } = props
            const editingThis = editing?.name === tool.name
            // 这一页是全量清单：插件注册了什么就列什么，跟当前会话绑的预设无关
            // （预设决定的是「最后给会话调用的那份」，不在这里体现）。
            return React.createElement('div', { style: { marginBottom: 6 } },
                React.createElement('div', {
                    style: { ...S.card, ...S.row, alignItems: 'flex-start' },
                },
                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                        React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } },
                            tool.alias ? `${tool.alias} ` : '',
                            React.createElement('span', {
                                style: { fontWeight: tool.alias ? 400 : 600, color: tool.alias ? C.dim : C.text },
                            }, tool.name)),
                        React.createElement('div', { style: { ...S.muted, marginTop: 2, wordBreak: 'break-word' } },
                            tool.note ? `备注：${tool.note}` : (tool.description || '（无描述）')),
                        tool.inject
                            ? React.createElement('div', {
                                style: { color: C.success, fontSize: 11.5, marginTop: 2 },
                            }, '已作为注入描述生效')
                            : null),
                    React.createElement('div', { style: { ...S.row, marginLeft: 10 } },
                        btn(editingThis ? '收起' : '备注', () => {
                            setEditing(editingThis ? null : {
                                name: tool.name,
                                alias: tool.alias ?? '',
                                description: tool.note ?? '',
                                inject: tool.inject === true,
                            })
                        }),
                        btn('归属', () => setOwnerEdit({
                            name: tool.name, category: group.category, owner: group.owner,
                        })))),
                editingThis ? React.createElement(NoteEditor, {
                    tool, editing, setEditing, busy, onSave: onSaveNote,
                }) : null,
                ownerEdit?.name === tool.name ? React.createElement(OwnerEditor, {
                    ownerEdit, setOwnerEdit, busy, onSave: onSaveOwner,
                }) : null)
        }

        /** 归属者那一行的备注：一句话说清「这个插件是干什么的」。 */
        function GroupNoteBox({ groupNote, setGroupNote, busy, onSave }) {
            const set = (patch) => setGroupNote({ ...groupNote, ...patch })
            return React.createElement('div', {
                style: { ...S.card, borderColor: C.accent, marginLeft: 14, marginTop: 6 },
            },
                React.createElement(Field, { label: `给「${groupNote.owner || '（未归属）'}」起一个备注名（列表里就用它当显示名，真名保留在括号里）` },
                    React.createElement('textarea', {
                        style: { ...S.input, minHeight: 58, resize: 'vertical' },
                        value: groupNote.text ?? '',
                        placeholder: '比如：刷 B 站',
                        onChange: (e) => set({ text: e.target.value }),
                    })),
                React.createElement('div', { style: { ...S.row, marginTop: 6 } },
                    btn('保存', () => onSave(groupNote.key, groupNote.text ?? ''), true),
                    btn('清空', () => onSave(groupNote.key, '')),
                    btn('取消', () => setGroupNote(null)),
                    busy ? React.createElement('span', { style: S.muted }, '处理中…') : null))
        }

        /** 备注编辑器：显示名 / 描述备注 / 是否作为注入描述。 */
        function NoteEditor({ tool, editing, setEditing, busy, onSave }) {
            const set = (patch) => setEditing({ ...editing, ...patch })
            return React.createElement('div', { style: { ...S.card, borderColor: C.accent } },
                React.createElement(Field, { label: '在本插件内的显示名（只改显示，不改工具真名）' },
                    React.createElement('input', {
                        style: S.input,
                        value: editing.alias,
                        placeholder: tool.name,
                        onChange: (e) => set({ alias: e.target.value }),
                    })),
                React.createElement(Field, {
                    label: '描述备注',
                    hint: '这一栏是备注本身。只有勾了下面那一条，它才会成为模型看到的工具描述。',
                }, React.createElement('textarea', {
                    style: { ...S.textarea, minHeight: 80 },
                    placeholder: tool.description || '（这个工具原本没有描述）',
                    value: editing.description,
                    onChange: (e) => set({ description: e.target.value }),
                })),
                React.createElement(Checkbox, {
                    checked: editing.inject,
                    label: '把这段描述作为工具定义注入（模型看到的描述换成它；工具原本的描述一个字不动，取消勾选立刻还原）',
                    onChange: (v) => set({ inject: v }),
                }),
                React.createElement('div', { style: { ...S.row, marginTop: 8 } },
                    btn('保存', onSave, true),
                    btn('取消', () => setEditing(null)),
                    busy ? React.createElement('span', { style: S.muted }, '处理中…') : null))
        }

        /** 归属编辑器：来源大类 + 归属者。 */
        function OwnerEditor({ ownerEdit, setOwnerEdit, busy, onSave }) {
            const set = (patch) => setOwnerEdit({ ...ownerEdit, ...patch })
            return React.createElement('div', { style: { ...S.card, borderColor: C.warn } },
                React.createElement('div', { style: S.h2 }, `改归属：${ownerEdit.name}`),
                React.createElement('div', { style: S.row },
                    React.createElement('select', {
                        style: { ...S.input, width: 160 },
                        value: ownerEdit.category,
                        onChange: (e) => set({ category: e.target.value }),
                    }, CATEGORY_ORDER.map((c) => React.createElement('option', { key: c, value: c }, CATEGORY_LABELS[c] ?? c))),
                    React.createElement('input', {
                        style: { ...S.input, flex: 1 },
                        value: ownerEdit.owner,
                        placeholder: '归属者（包名 / MCP 服务器名）',
                        onChange: (e) => set({ owner: e.target.value }),
                    })),
                React.createElement('div', { style: { ...S.muted, marginTop: 4 } },
                    '宿主没给出「工具 → 插件」的对照表，这一栏是扫包认出来的；认错了在这里改。'),
                React.createElement('div', { style: { ...S.row, marginTop: 8 } },
                    btn('保存', onSave, true),
                    btn('取消', () => setOwnerEdit(null)),
                    busy ? React.createElement('span', { style: S.muted }, '处理中…') : null))
        }

        /**
         * 通用实体卡片：插件 / MCP 连接器 / 技能都用这一个。
         *
         * 三行结构，卡片高度才能整齐：
         *   ① 图标 + 名字（长名字省略号）+ 右上角一枚小徽标（版本或状态）
         *   ② 一句简介，最多三行
         *   ③ 底行：左边一句计数，右边动作按钮（按钮自己 stopPropagation，
         *      点卡片其它地方是「进详情」）
         */
        function EntityCard({
            avatar, title, titleAttr, badge, desc, meta, foot, actions, extra, onClick, accent,
            descLines, descMinHeight,
        }) {
            const lines = descLines ?? 3
            return React.createElement('div', {
                style: {
                    ...S.card, width: 300, boxSizing: 'border-box', marginBottom: 0,
                    cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6,
                    borderColor: accent || C.border,
                },
                onClick,
                title: titleAttr ?? undefined,
            },
                React.createElement('div', {
                    style: { ...S.row, alignItems: 'center', gap: 8, flexWrap: 'nowrap' },
                },
                    avatar ?? null,
                    React.createElement('span', {
                        style: {
                            fontSize: 13.5, fontWeight: 600, minWidth: 0, flex: '1 1 auto',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                    }, title),
                    badge ?? null),
                React.createElement('div', {
                    style: {
                        ...S.muted, fontSize: 11.5, lineHeight: 1.45, whiteSpace: 'pre-wrap',
                        display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden', minHeight: descMinHeight ?? 42,
                    },
                }, desc || '（没有简介）'),
                // 「标签」行：放在简介下面、按钮上面；没有就不占位。
                meta ? React.createElement('div', {
                    style: { ...S.row, gap: 4, flexWrap: 'wrap', alignItems: 'center' },
                }, meta) : null,
                (foot || actions) ? React.createElement('div', {
                    style: { ...S.row, gap: 6, marginTop: 'auto', flexWrap: 'nowrap' },
                },
                    React.createElement('span', {
                        style: {
                            ...S.muted, fontSize: 11.5, minWidth: 0, overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        },
                    }, foot ?? ''),
                    React.createElement('span', { style: { flex: 1 } }),
                    actions ?? null) : null,
                extra ?? null)
        }

        /** 详情页顶部那颗「← 返回」。 */
        function BackBar({ label, onClick }) {
            return React.createElement('div', { style: { ...S.row, marginBottom: 8 } },
                btn(`← ${label}`, onClick),
                React.createElement('span', { style: { flex: 1 } }))
        }

        /**
         * 插件页：两个子页 —— 「系统插件」和「用户插件」。
         *
         * 系统插件 = 宿主自带的那批 @deepseek-ai/dsh-*（bash / read / web / subagent…），
         * 用户插件 = 自己装进 profile 的那些（ego / genui / meme / modlens…）。
         *
         * 每个插件一张卡片：名字 + 版本 + 一句简介 + 「几把工具 / 几段提示词」；
         * 点卡片进详情，能看到这个插件自己带的系统提示词段落和它注册的工具，
         * 备注、改写、注入开关、归属修正全在详情里改。
         *
         * 数据来自 `tools-list`：它已经把工具按「来源包」分好组，每组的 sections
         * 就是那个包推的系统提示词；包名 / 版本 / 简介是宿主没暴露的那部分，
         * 由宿主那半扫包时从各自 package.json 读出来，一起塞在 `plugins` 里。
         */
        const PLUGIN_CAT_SYSTEM = 'system'
        const PLUGIN_CAT_PLUGIN = 'plugin'
        const PLUGIN_CAT_MCP = 'mcp'

        function PluginPage({ reloadToken, onChanged, sessionCtx }) {
            const [data, setData] = useState(null)
            const [error, setError] = useState('')
            const [q, setQ] = useState('')
            // 'system' | 'host' | 'user'
            const [sub, setSub] = useState('system')
            // 打开详情的插件 key（= 归属者包名）；null = 卡片列表
            const [open, setOpen] = useState(null)
            const [editing, setEditing] = useState(null)
            const [busy, setBusy] = useState(false)
            const [note, setNote] = useState('')
            const [ownerEdit, setOwnerEdit] = useState(null)
            // 正在改文字的段落：{ name }
            const [sectionEdit, setSectionEdit] = useState(null)
            /** 归属候选：所有插件（包名 + 备注名/简介）—— 段落可以指到其中任何一个。 */
            const ownerCandidates = useMemo(() => {
                const out = []
                for (const g of (data?.groups ?? [])) {
                    const value = String(g.owner ?? '')
                    if (!value) continue
                    out.push({ value, label: g.note ? `${g.note}（${value}）` : value })
                }
                for (const pkg of (data?.plugins ?? [])) {
                    const value = String(pkg.packageName ?? pkg.key ?? '')
                    if (!value || out.some((o) => o.value === value)) continue
                    out.push({ value, label: value })
                }
                return out.sort((a, b) => a.value.localeCompare(b.value))
            }, [data])
            /** 全量工具名 —— 给「未归组的提示词」当归属候选池。 */
            const allToolNames = useMemo(() => {
                const out = []
                for (const g of (data?.groups ?? [])) {
                    for (const t of (g.tools ?? [])) out.push(t.name)
                }
                return [...new Set(out)].sort()
            }, [data])
            // 宿主认识的提示词变量（`{{名字}}`）：取自最近一次装配，供覆写时插入
            const [vars, setVars] = useState([])
            /** 正在编辑备注名的归属者：{ key, owner, text } | null */
            const [groupNote, setGroupNote] = useState(null)
            /** 详情里两块的展开状态（默认都展开 —— 点进来就是想看内容） */
            const [detailOpen, setDetailOpen] = useState({ prompts: true, tools: true })
            /** 插件变化监测的现状：{ available, autoProbe, baselineAt, lastRunAt, events } */
            const [watch, setWatch] = useState(null)
            const [watchBusy, setWatchBusy] = useState(false)
            /**
             * 预设圈里的包名（`dsh-tool-fs` 这种尾段形式）。
             *
             * 拿它把「系统插件」再切一刀：预设管得到的 vs 宿主基础装配带上的。
             * 拿不到（宿主没装 Agent 预设注册表）就留 null —— 那就退回「系统 / 用户」
             * 两栏，不硬猜某个官方包属于哪一边。
             */
            const [presetPkgs, setPresetPkgs] = useState(null)

            const currentSessionId = sessionCtx?.current?.id ?? ''

            // 备注、逐段开关、逐段改写都只有**全局一份**：改了就生效，与作用域无关。
            // listArgs 里的 sessionId 只是为了让宿主按当前会话的 agent 取工具表
            // （不传的话只能拿到插件级那一份）。
            const listArgs = useMemo(() => ({
                sessionId: currentSessionId,
                editScope: 'global',
            }), [currentSessionId])

            const load = useCallback(async () => {
                setError('')
                try {
                    const [tools, varTable, pcomp] = await Promise.all([
                        apiCall('tools-list', listArgs),
                        // 变量表只是提示与校验用，取不到不能连累插件表。
                        apiCall('variables-list', {}).catch(() => ({ list: [] })),
                        // 预设组成：用来把系统插件分成「预设管的」和「宿主自带」。
                        // 取不到就留 null，不影响插件表本身。
                        apiCall('preset-composition', {}).catch(() => null),
                    ])
                    setData(tools)
                    setVars(varTable?.list ?? varTable?.variables ?? [])
                    setPresetPkgs(pcomp && Array.isArray(pcomp.presets) && pcomp.presets.length
                        ? presetUniverse(pcomp.presets)
                        : null)
                }
                catch (e) { setError(String(e.message ?? e)) }
            }, [listArgs])

            useEffect(() => { load() }, [load, reloadToken])

            /**
             * 快速刷新：先核对「插件集合变没变」，变了才重扫。
             *
             * 归属表是落盘的，插件没装没卸没升级的时候重扫结果一模一样 ——
             * 所以这里先比指纹（十几毫秒）。没变化就直接回「没变化」，
             * 不让用户白等那 16 秒；真变了才重扫一遍（插件列表当场更新）。
             *
             * 不重启任何插件。
             */
            const quickRefresh = async () => {
                setBusy(true); setError('')
                try {
                    const r = await apiCall('tools-refresh', {})
                    // 顺手跑一轮变化检测：新装/升级的插件会在这里留下记录。
                    // 变化检测并进这一个按钮 —— 用户点一下就知道「变了什么」，
                    // 不用在两处之间对照。
                    let events = []
                    let first = false
                    if (watch?.available) {
                        try {
                            const w = await apiCall('plugins-watch-run', { probe: false })
                            if (w?.status) setWatch(w.status)
                            events = w?.events ?? []
                            first = w?.first === true
                        }
                        catch { /* 监测不可用不影响归属刷新 */ }
                    }
                    await load()
                    onChanged?.()
                    const parts = [r?.rescanned
                        ? `插件有变动，已重新识别归属：剔掉 ${r?.droppedGhosts?.length ?? 0} 个幽灵条目，`
                            + `${r?.expiredOfficial?.length ?? 0} 个官方表条目已失效。`
                        : '插件没有变动，归属表是最新的（没重扫，秒回）。']
                    if (first) parts.push('已建立变化基线。')
                    else if (events.length) {
                        const brief = events.slice(0, 3).map((ev) => {
                            const label = WATCH_KIND[ev.kind]?.label ?? '变化'
                            const delta = watchDeltaText(ev)
                            return `${ev.moduleName}（${label}${delta ? `：${delta}` : ''}）`
                        })
                        parts.push(`记录到 ${events.length} 处变化：${brief.join('；')}`
                            + `${events.length > 3 ? ` 等 ${events.length} 处` : ''}。`)
                        const more = events.slice(3).reduce((acc, ev) => {
                            const delta = watchDeltaText(ev)
                            if (delta) acc.push(`${ev.moduleName}：${delta}`)
                            return acc
                        }, [])
                        if (more.length) parts.push(`其余 —— ${more.join('；')}。`)
                    }
                    setNote(parts.join(' '))
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /**
             * 深度排查：逐一软重启没实测过的插件，用工具差分反推真实工具集。
             *
             * 会把插件关掉再打开 —— 插件会有短暂的不可用。跑之前要说清楚。
             */
            const deepProbe = async () => {
                if (busy) return
                const ok = window.confirm(
                    '深度排查会逐个把插件关掉再打开（软重启），期间该插件短暂不可用。\n'
                    + '结果只存在本地缓存里，不改插件本身。\n\n继续吗？')
                if (!ok) return
                setBusy(true); setError('')
                try {
                    const r = await apiCall('tools-probe', {})
                    await load()
                    onChanged?.()
                    const failed = (r?.results ?? []).filter((x) => x.status !== 'verified')
                    // 「逐个列出来」不能写「见下」—— 底下没有清单了，名字得就地写出来。
                    const names = failed.slice(0, 4).map((x) => x.moduleName)
                    setNote(`排查完成：${r?.probed ?? 0} 个插件实测出工具集`
                        + (failed.length
                            ? `；${failed.length} 个测不出来`
                                + (names.length
                                    ? `（${names.join('、')}${failed.length > names.length ? ' 等' : ''}）`
                                    : '')
                            : '')
                        + '。')
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /**
             * 插件变化监测：读现状。
             *
             * 宿主没有 pluginManager 时这条通道是空的（`available: false`），
             * 那就当没这个功能，不报错 —— 老宿主上页面其他部分照常用。
             */
            const loadWatch = useCallback(async () => {
                try {
                    setWatch(await apiCall('plugins-watch', {}))
                }
                catch { setWatch(null) }
            }, [])

            useEffect(() => { loadWatch() }, [loadWatch, reloadToken])

            const resetWatch = async () => {
                if (!window.confirm('把当前状态当作基线？事件流会被清空（插件本身不受影响）。')) return
                setWatchBusy(true)
                try {
                    await apiCall('plugins-watch-reset', {})
                    await loadWatch()
                    setNote('基线已重置。')
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setWatchBusy(false) }
            }

            const saveGroupNote = async (key, text) => {
                setBusy(true); setError('')
                try {
                    await apiCall('group-note-save', { key, text })
                    setGroupNote(null)
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const saveNote = async (name, note) => {
                setBusy(true); setError('')
                try {
                    await apiCall('tool-note-save', { scope: 'global', name, ...note })
                    setEditing(null)
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            // 逐段注入开关：'on' = 注入，'off' = 不注入。写的是全局那一份。
            const saveSectionState = async (sec, mode) => {
                const enabled = mode === 'on'
                setBusy(true); setError('')
                try {
                    await apiCall('section-state-save', { scope: 'global', name: sec.name, enabled })
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            // 段落 ↔ 工具关联：tools 为空 = 回到「默认关联来源插件」。
            // 归属到某个插件（'' = 取消归属，这段回到「未归组的提示词」）。
            const saveSectionOwner = async (sec, owner) => {
                setBusy(true); setError('')
                try {
                    await apiCall('section-owner-save', { name: sec.name, owner: owner ?? '' })
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const saveSectionBind = async (sec, tools) => {
                setBusy(true); setError('')
                try {
                    await apiCall('section-bind-save', { name: sec.name, tools: tools ?? null })
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            // 逐段文字覆写：text 为空 = 撤掉这一层的覆写（回到目录里的全局覆写或原文）。
            const saveSectionOverride = async (sec, text, inject) => {
                if (text === null) { setSectionEdit(null); return }
                setBusy(true); setError('')
                try {
                    await apiCall('section-layer-override-save', {
                        scope: 'global', name: sec.name, text: text ?? '',
                    })
                    if (typeof inject === 'boolean') {
                        await apiCall('section-override-inject', { name: sec.name, inject })
                    }
                    setSectionEdit(null)
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const saveOwner = async () => {
                if (!ownerEdit) return
                setBusy(true); setError('')
                try {
                    await apiCall('tool-owner-save', {
                        name: ownerEdit.name, category: ownerEdit.category, owner: ownerEdit.owner,
                    })
                    setOwnerEdit(null)
                    await load()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            // 包元信息索引。宿主扫包时用的 key 是包目录名（`dsh-browser-desktop`），
            // 而工具组的 owner 是包名（`@dsh-custom/dsh-browser-desktop`）——
            // 三个别名都指到同一份元信息，不然同一个插件会在列表里出现两次
            // （一次有工具、一次是空卡片）。
            const catalog = useMemo(() => {
                const map = new Map()
                const put = (k, meta) => {
                    if (k && !map.has(k)) {
                        map.set(k, meta)
                    }
                }
                for (const meta of data?.plugins ?? []) {
                    if (!meta) {
                        continue
                    }
                    put(meta.key, meta)
                    put(meta.packageName, meta)
                    put(String(meta.packageName ?? '').split('/').pop(), meta)
                }
                return map
            }, [data])

            /**
             * 把工具组翻成插件条目。
             *
             * 三件容易出错的事：
             *  - MCP 那批工具跟着连接器走（「MCP」页），这里不能列；
             *  - 只推提示词、不注册工具的插件（dsh-kaomoji 那种）也得有卡片；
             *  - 用户装进来但一个工具都没注册的插件（换肤、挂件）也该出现 ——
             *    不然「我装了什么」这件事在这一页看不全。
             */
            const items = useMemo(() => {
                const groups = data?.groups ?? []
                const byOwner = new Map()
                for (const g of groups) {
                    if (g.category === PLUGIN_CAT_MCP) {
                        continue
                    }
                    const meta = catalog.get(g.owner)
                        ?? catalog.get(String(g.owner).split('/').pop())
                        ?? null
                    byOwner.set(g.owner, {
                        key: g.owner,
                        owner: g.owner,
                        note: g.note ?? '',
                        group: g,
                        meta,
                        official: g.category === PLUGIN_CAT_SYSTEM || meta?.official === true,
                        tools: g.tools ?? [],
                        sections: g.sections ?? [],
                        category: g.category,
                    })
                }
                // 用户插件里那些「没注册工具也没有提示词」的：补一张空卡片。
                // 已经在 byOwner 里出现过的包（哪怕 key 长得不一样）不补，
                // 否则同一个插件会有两张卡。
                const seen = new Set()
                for (const it of byOwner.values()) {
                    if (it.meta?.key) {
                        seen.add(it.meta.key)
                    }
                }
                const extra = []
                const extraSeen = new Set()
                for (const meta of catalog.values()) {
                    if (meta.official === true || seen.has(meta.key) || extraSeen.has(meta.key)) {
                        continue
                    }
                    extraSeen.add(meta.key)
                    extra.push({
                        key: meta.key,
                        owner: meta.key,
                        note: '',
                        group: null,
                        meta,
                        official: false,
                        tools: [],
                        sections: [],
                        category: PLUGIN_CAT_PLUGIN,
                    })
                }
                const all = [...byOwner.values(), ...extra]
                const needle = q.trim().toLowerCase()
                const match = (it) => {
                    if (!needle) {
                        return true
                    }
                    const hay = [
                        it.key, it.owner, it.note, it.meta?.packageName, it.meta?.description,
                        ...it.tools.map((t) => `${t.name} ${t.alias ?? ''}`),
                        ...it.sections.map((s) => s.name),
                    ].join(' ').toLowerCase()
                    return hay.includes(needle)
                }
                const filtered = all.filter(match)
                // 官方包再看一眼：是不是某套 Agent 预设管着的。
                // 管着的归「系统插件」，剩下的归「宿主自带」—— 这两类混在一起，
                // 切模式的时候数不清「到底还剩几个开着」。
                const official = filtered
                    .filter((it) => it.official)
                    // 官方包只看这个会话里真正带东西的（另外几百个没启用的不该出现）。
                    .filter((it) => it.tools.length > 0 || it.sections.length > 0)
                // 拿不到预设清单（宿主没注册表）时不猜：官方包全算「系统插件」，
                // 「宿主自带」那一栏空着。
                const managed = presetPkgs
                    ? official.filter((it) => presetPkgs.has(pkgKey(it.key)))
                    : official
                const system = managed
                    .sort((a, b) => a.owner.localeCompare(b.owner))
                const host = (presetPkgs ? official.filter((it) => !presetPkgs.has(pkgKey(it.key))) : [])
                    .sort((a, b) => a.owner.localeCompare(b.owner))
                const user = filtered
                    .filter((it) => !it.official)
                    // 有工具的排前面，剩下的按包名。
                    .sort((a, b) => (b.tools.length + b.sections.length) - (a.tools.length + a.sections.length)
                        || a.owner.localeCompare(b.owner))
                // 给每张卡标一下它属于哪一栏，详情页的角标按这个显示。
                const tag = (list, zone) => list.map((it) => ({ ...it, zone }))
                return {
                    system: tag(system, 'system'),
                    host: tag(host, 'host'),
                    user: tag(user, 'user'),
                }
            }, [data, catalog, q, presetPkgs])

            const current = useMemo(() => {
                if (!open) {
                    return null
                }
                return [...items.system, ...items.host, ...items.user].find((it) => it.key === open) ?? null
            }, [items, open])

            if (error && !data) {
                return React.createElement('div', { style: S.page }, React.createElement(ErrorBar, { error }))
            }

            /** 一张插件卡片。 */
            const card = (it) => {
                const title = it.note !== '' ? it.note : (it.meta?.packageName || it.owner)
                const desc = it.meta?.description ?? ''
                return React.createElement('div', {
                    key: it.key,
                    style: {
                        ...S.card, width: 292, boxSizing: 'border-box', marginBottom: 0,
                        cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6,
                    },
                    onClick: () => { setOpen(it.key); setError('') },
                    title: '点开看它带的提示词和工具',
                },
                    React.createElement('div', {
                        // S.row 默认会换行，这里必须不换：长包名收到省略号，版本 chip 留在右边。
                        style: { ...S.row, alignItems: 'baseline', gap: 6, flexWrap: 'nowrap' },
                    },
                        // 包名常常很长（@deepseek-ai/dsh-tool-working-directory），
                        // 卡片宽度是固定的，就让它省略号收尾 —— 全名在详情里看。
                        React.createElement('span', {
                            style: {
                                fontSize: 13.5, fontWeight: 600, minWidth: 0, flex: '1 1 auto',
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            },
                            title: it.meta?.packageName || it.owner,
                        }, title),
                        it.meta?.version
                            ? React.createElement('span', {
                                style: { ...S.chip(''), flex: '0 0 auto' },
                            }, `v${it.meta.version}`)
                            : null),
                    React.createElement('div', {
                        style: {
                            ...S.muted, fontSize: 11.5, lineHeight: 1.45,
                            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden', minHeight: 42,
                        },
                    }, desc || '（这个包没写简介）'),
                    React.createElement('div', { style: { ...S.row, gap: 6, marginTop: 'auto' } },
                        React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } },
                            `${it.tools.length} 个工具 · ${it.sections.length} 段提示词`),
                        React.createElement('span', { style: { flex: 1 } }),
                        React.createElement('span', { style: { color: C.accent, fontSize: 11.5 } }, '查看 ›')))
            }

            /** 详情里的一块（提示词 / 工具）。 */
            const block = (key, label, count, children) => {
                const on = detailOpen[key] !== false
                return React.createElement('div', { key, style: { marginTop: 14 } },
                    React.createElement('div', {
                        style: { ...S.row, cursor: 'pointer', userSelect: 'none', padding: '4px 0' },
                        onClick: () => setDetailOpen((d) => ({ ...d, [key]: !on })),
                    },
                        React.createElement('span', { style: { color: C.text2, width: 14, flex: '0 0 14px' } },
                            on ? '▾' : '▸'),
                        React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, label),
                        React.createElement('span', { style: { ...S.muted, fontSize: 12 } }, `　${count}`)),
                    on ? children : null)
            }

            /** 插件详情：简介 + 它带的提示词 + 它注册的工具。 */
            const detail = (it) => {
                const gkey = it.group ? `${it.group.category}::${it.owner}` : ''
                const title = it.note !== '' ? it.note : (it.meta?.packageName || it.owner)
                return React.createElement('div', null,
                    React.createElement('div', { style: { ...S.row, marginBottom: 8 } },
                        btn('← 全部插件', () => { setOpen(null); setEditing(null); setOwnerEdit(null) }),
                        React.createElement('span', { style: { flex: 1 } })),
                    React.createElement('div', { style: { ...S.card, padding: 14 } },
                        React.createElement('div', { style: { ...S.row, alignItems: 'baseline', gap: 8 } },
                            React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } }, title),
                            it.note !== ''
                                ? React.createElement('span', { style: { ...S.muted, fontSize: 12 } }, it.owner)
                                : null,
                            it.meta?.version
                                ? React.createElement('span', { style: S.chip('') }, `v${it.meta.version}`)
                                : null,
                            React.createElement('span', { style: S.chip(it.official ? 'workspace' : 'session') },
                                it.zone === 'host' ? '宿主自带' : (it.official ? '系统插件' : '用户插件')),
                            it.group?.overridden
                                ? React.createElement('span', { style: S.chip('') }, '手工指定归属')
                                : null,
                            React.createElement('span', { style: { flex: 1 } }),
                            it.group
                                ? btn(groupNote?.key === gkey ? '收起' : '备注名',
                                    () => setGroupNote(groupNote?.key === gkey
                                        ? null
                                        : { key: gkey, owner: it.owner, text: it.note ?? '' }))
                                : null),
                        it.meta?.dir
                            ? React.createElement('div', {
                                style: {
                                    ...S.muted, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace',
                                    marginTop: 4, wordBreak: 'break-all',
                                },
                            }, it.meta.dir)
                            : null,
                        React.createElement('div', {
                            style: { fontSize: 12.5, color: C.text2, marginTop: 8, lineHeight: 1.55, whiteSpace: 'pre-wrap' },
                        }, it.meta?.description || '（这个包没写简介）'),
                        React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 6 } },
                            `${it.tools.length} 个工具 · ${it.sections.length} 段系统提示词`),
                        groupNote?.key === gkey
                            ? React.createElement(GroupNoteBox, {
                                groupNote, setGroupNote, busy,
                                onSave: (key, text) => saveGroupNote(key, text),
                            })
                            : null),
                    block('prompts', '系统提示词', `${it.sections.length} 段`,
                        it.sections.length === 0
                            ? React.createElement('div', { style: { ...S.muted, marginLeft: 14, padding: '4px 0' } },
                                '这个插件不往系统提示词里加东西。')
                            : React.createElement(SectionPanel, {
                                sections: it.sections,
                                busy,
                                vars,
                                editing: sectionEdit,
                                onState: (sec, mode) => saveSectionState(sec, mode),
                                onToggle: (sec) => setSectionEdit(sec),
                                onSave: (sec, text) => saveSectionOverride(sec, text),
                                onBind: (sec, tools) => saveSectionBind(sec, tools),
                                onBindOwner: (sec, owner) => saveSectionOwner(sec, owner),
                                ownerCandidates,
                            })),
                    block('tools', '工具', `${it.tools.length} 个`,
                        it.tools.length === 0
                            ? React.createElement('div', { style: { ...S.muted, marginLeft: 14, padding: '4px 0' } },
                                '这个插件没有注册工具（可能是只用它推的提示词，或者是界面类插件）。')
                            : React.createElement('div', { style: { marginLeft: 14 } },
                                it.tools.map((tool) => React.createElement(ToolRow, {
                                    key: tool.name,
                                    tool,
                                    group: it.group ?? { category: it.category, owner: it.owner },
                                    editing,
                                    ownerEdit,
                                    setEditing,
                                    setOwnerEdit,
                                    busy,
                                    onSaveNote: () => saveNote(editing.name, {
                                        alias: editing.alias,
                                        description: editing.description,
                                        inject: editing.inject,
                                    }),
                                    onSaveOwner: saveOwner,
                                })))))
            }

            const active = sub === 'system' ? items.system : (sub === 'host' ? items.host : items.user)
            // 未归组的段落（harness:identity 这类宿主自己的）：接不到任何插件，
            // 单独给一张卡片，别让它们在这一页消失。
            const ungrouped = data?.ungroupedSections ?? []

            return React.createElement('div', { style: S.page },
                React.createElement(ErrorBar, { error }),
                note
                    ? React.createElement('div', {
                        style: { ...S.muted, marginBottom: 8, fontSize: 12 },
                    }, note)
                    : null,
                current
                    ? detail(current)
                    : React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { ...S.row, marginBottom: 10, gap: 6 } },
                            btn(`系统插件${items.system.length ? `（${items.system.length}）` : ''}`,
                                () => setSub('system'), sub === 'system'),
                            items.host.length
                                ? btn(`宿主自带（${items.host.length}）`,
                                    () => setSub('host'), sub === 'host')
                                : null,
                            btn(`用户插件${items.user.length ? `（${items.user.length}）` : ''}`,
                                () => setSub('user'), sub === 'user'),
                            React.createElement('input', {
                                style: { ...S.input, width: 220, marginLeft: 6 },
                                placeholder: '搜插件名 / 简介 / 工具名',
                                value: q,
                                onChange: (e) => setQ(e.target.value),
                            }),
                            btn('检查变化', quickRefresh, false, busy),
                            btn('深度排查', deepProbe, false, busy),
                            watch?.available
                                ? btn('重建基线', resetWatch, false, watchBusy)
                                : null,
                            React.createElement('span', { style: { flex: 1 } }),
                            React.createElement('span', { style: S.muted },
                                sub === 'system'
                                    ? 'Agent 预设管着的那批：切模式会跟着变。'
                                    : (sub === 'host'
                                        ? '宿主基础装配带来的：任何预设都带着，模式不碰。'
                                        : '自己装进 profile 的插件；没注册工具的也算在内。'))),
                        data
                            ? React.createElement('div', { style: { ...S.muted, marginBottom: 10 } },
                                `宿主在这个会话里注册了 ${data.total} 个工具，来自 `
                                + `${items.system.length + items.host.length + items.user.length} 个插件`
                                + `（系统 ${items.system.length} / 宿主自带 ${items.host.length} / 用户 ${items.user.length}）。`
                                + '备注、提示词改写与「是否注入」都是全局一份：改了就生效。'
                                + (data.attribution?.scan?.cached
                                    ? `　归属结果读自本地缓存${data.attribution.scan.scannedAt
                                        ? `（${formatWhen(data.attribution.scan.scannedAt)} 扫的）` : ''}`
                                        + `${data.attribution.scan.scanning ? '，正在后台按新插件集合重扫…' : ''}。`
                                    : '')
                                + (watch?.available
                                    ? `　插件变化：${watch.baselineAt ? '已在监测' : '未建基线'}`
                                        + `${watch.lastRunAt ? `，上次检测 ${formatWhen(watch.lastRunAt)}` : ''}。`
                                    : ''))
                            : React.createElement(Loading, null),
                        active.length === 0
                            ? React.createElement('div', { style: S.muted },
                                q.trim() ? '没有匹配的插件。' : '这一栏还没有插件。')
                            : React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
                                active.map((it) => card(it))),
                        (sub === 'system' || sub === 'host') && ungrouped.length > 0
                            ? React.createElement('div', { style: { marginTop: 16 } },
                                React.createElement('div', { style: { ...S.row, padding: '4px 0' } },
                                    React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, '未归组的提示词'),
                                    React.createElement('span', { style: { ...S.muted, fontSize: 12 } },
                                        `　${ungrouped.length} 段`),
                                    React.createElement('span', { style: { flex: 1 } })),
                                React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 6 } },
                                    '认不出归属的那几段：既接不上任何工具分组，也查不出来自哪个包 —— 直接在这里开关和改写。'),
                                React.createElement(SectionPanel, {
                                    sections: ungrouped,
                                    busy,
                                    vars,
                                    // 这些段落接不到任何插件，所以候选池给全量工具名：
                                    // 「归属」= 这段跟着哪几把工具走，挑得到才叫得动。
                                    bindCandidates: allToolNames,
                                    editing: sectionEdit,
                                    onState: (sec, mode) => saveSectionState(sec, mode),
                                    onToggle: (sec) => setSectionEdit(sec),
                                    onSave: (sec, text) => saveSectionOverride(sec, text),
                                    onBind: (sec, tools) => saveSectionBind(sec, tools),
                                    onBindOwner: (sec, owner) => saveSectionOwner(sec, owner),
                                    ownerCandidates,
                                }))
                            : null))
        }

        // ——————————————————— 技能页 ———————————————————
        /**
         * 技能市场（技能页的第二个子页）。
         *
         * 数据不是我们自己的：直接读 SkillHub 的公开接口
         * （`https://api.skillhub.cn/api/skills`、`/api/v1/categories`），
         * 「安装」= 让宿主那半去 `https://api.skillhub.cn/api/v1/download?slug=` 下 zip，
         * 解开到 `$DSH_HOME/skills/<slug>/`，宿主自己广播 `skills/change`。
         *
         * 这里只做展示与触发，不缓存任何东西 —— 市场的库存天天在变，
         * 缓存下来只会让人看到过时的条目。
         */
        /**
         * 一条市场结果跟搜索词的贴合档位，数字越大越贴近用户真正在找的那个。
         *
         * 上游的 keyword 是全文召回：只要描述里出现过这个词就会被收进来，
         * 光看它给的顺序不够 —— 名字里带搜索词的排在只写在描述里的前面。
         *
         * 档位从高到低：
         * 3 = 整个搜索词落在名称、发布者标识或 slug 里；
         * 2 = 每个词都落在这几处里；
         * 1 = 有的词落在这几处里；
         * 0 = 搜索词出现在描述里；
         * -1 = 这些地方都没命中（上游是在别的字段上匹配的）。
         */
        function marketTier(item, keyword, tokens) {
            const strong = `${item.name ?? ''} ${item.canonicalName ?? ''} ${item.slug ?? ''}`.toLowerCase()
            const desc = `${item.description ?? ''} ${item.descriptionEn ?? ''}`.toLowerCase()
            const key = String(keyword ?? '').trim().toLowerCase()
            if (key && strong.includes(key)) return 3
            let strongHits = 0
            for (const token of tokens) if (strong.includes(token)) strongHits += 1
            if (tokens.length > 0 && strongHits === tokens.length) return 2
            if (strongHits > 0) return 1
            if (key && desc.includes(key)) return 0
            for (const token of tokens) if (desc.includes(token)) return 0
            return -1
        }

        /**
         * 搜索结果的分档排序：先看跟搜索词的贴合档位，档位相同再按用户选的指标排。
         * 指标取不到值时保持原来的先后（上游给的顺序本身就是按相关度排的）。
         */
        function rankByRelevance(list, keyword, sortKey) {
            const tokens = String(keyword ?? '').toLowerCase().split(/\s+/).filter(Boolean)
            return list
                .map((item, index) => ({ item, index, tier: marketTier(item, keyword, tokens) }))
                .sort((a, b) => {
                    if (a.tier !== b.tier) return b.tier - a.tier
                    const diff = (Number(b.item[sortKey] ?? 0) || 0) - (Number(a.item[sortKey] ?? 0) || 0)
                    if (diff !== 0) return diff
                    return a.index - b.index
                })
                .map((row) => row.item)
        }

        function SkillMarket({ onInstalled, cwd }) {
            const PAGE_SIZE = 20
            // 浏览时默认按「热门」（安装数）排：市场里绝大多数人先看的还是「别人都在用的」。
            // 一旦开始搜，就换成「相关度」——找东西的时候要的是找得着，不是热门。
            // 这里的 key 就是往上游传的 sortBy 字段名。
            const SORTS = [
                { key: 'score', label: '相关度' },
                { key: 'installs', label: '热门' },
                { key: 'downloads', label: '下载多' },
                { key: 'stars', label: '星标多' },
            ]

            const [items, setItems] = useState([])
            const [total, setTotal] = useState(0)
            const [cats, setCats] = useState([])
            const [home, setHome] = useState('https://skillhub.cn')
            const [q, setQ] = useState('')
            const [keyword, setKeyword] = useState('')
            const [cat, setCat] = useState('')
            const [sort, setSort] = useState('installs')
            const [page, setPage] = useState(1)
            const [loading, setLoading] = useState(false)
            const [more, setMore] = useState(true)
            const [error, setError] = useState('')
            const [note, setNote] = useState('')
            const [busySlug, setBusySlug] = useState('')
            const [detail, setDetail] = useState(null)
            const [detailError, setDetailError] = useState('')
            const [overwrite, setOverwrite] = useState(false)
            const sentinel = useRef(null)
            // 用 ref 存「当前查询条件」，翻页时才不会被闭包里的旧值带跑。
            const queryRef = useRef({ keyword: '', cat: '', sort: 'installs' })

            const fetchPage = useCallback(async (nextPage, append) => {
                setLoading(true); setError('')
                try {
                    const { keyword, cat, sort: sortKey } = queryRef.current
                    const res = await apiCall('skill-market-list', {
                        page: nextPage,
                        pageSize: PAGE_SIZE,
                        keyword,
                        category: cat,
                        // 有关键词时上游按相关度(score)出这一页：它的召回是全文匹配，
                        // 不先按相关度取，名字里带搜索词的条目会被挤到好几页之后。
                        // 没关键词时才按用户选的指标取。
                        sortBy: keyword ? 'score' : sortKey,
                        order: 'desc',
                    })
                    const list = res.skills ?? []
                    setTotal(res.total ?? 0)
                    setPage(nextPage)
                    setMore(list.length === PAGE_SIZE && nextPage * PAGE_SIZE < (res.total ?? 0))
                    // 有关键词时按贴合档位重排：名字里带搜索词的排在只写在描述里的前面。
                    // 只排这一页 —— 翻页时不动已经列出来的条目，滚动位置才不会跳。
                    const ranked = keyword ? rankByRelevance(list, keyword, sortKey) : list
                    setItems((prev) => (append ? [...prev, ...ranked] : ranked))
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setLoading(false) }
            }, [])

            const restart = useCallback((next) => {
                queryRef.current = {
                    keyword: next?.keyword === undefined ? queryRef.current.keyword : next.keyword,
                    cat: next?.cat === undefined ? queryRef.current.cat : next.cat,
                    sort: next?.sort === undefined ? queryRef.current.sort : next.sort,
                }
                setItems([]); setTotal(0); setPage(1); setMore(true); setNote('')
                fetchPage(1, false)
            }, [fetchPage])

            useEffect(() => {
                let alive = true
                apiCall('skill-market-categories', {})
                    .then((res) => {
                        if (!alive) return
                        setCats(res.categories ?? [])
                        if (res.home) setHome(res.home)
                    })
                    .catch(() => { /* 分类拿不到不影响搜 */ })
                return () => { alive = false }
            }, [])

            useEffect(() => { restart({ keyword: '', cat: '', sort: 'installs' }) }, [])

            /**
             * 瀑布流：底下那个哨兵一进视野就接着拉下一页，滚到底自动续。
             * 用 IntersectionObserver 而不是监听 scroll —— 面板的滚动容器
             * 不一定是谁，监听 window 会漏。
             */
            useEffect(() => {
                const node = sentinel.current
                if (!node || !more || loading) return undefined
                const observer = new IntersectionObserver((entries) => {
                    if (entries.some((entry) => entry.isIntersecting)) {
                        fetchPage(page + 1, true)
                    }
                }, { rootMargin: '240px' })
                observer.observe(node)
                return () => observer.disconnect()
            }, [more, loading, page, fetchPage])

            const openDetail = async (item) => {
                setDetailError('')
                setDetail({ ...item, loading: true })
                try {
                    const res = await apiCall('skill-market-detail', { slug: item.slug })
                    setDetail({ ...item, ...res, loading: false })
                }
                catch (e) {
                    setDetailError(String(e.message ?? e))
                    setDetail({ ...item, loading: false })
                }
            }

            const install = async (item) => {
                setBusySlug(item.slug); setError(''); setNote('')
                try {
                    // 一律装到用户级技能目录（$DSH_HOME/skills），不给人选。
                    const res = await apiCall('skill-market-install', {
                        slug: item.slug,
                        overwrite,
                    })
                    const fixed = res.renamedFrom
                        ? `　（市场里写的名字是「${res.renamedFrom}」，宿主只认 kebab-case，已改成「${res.name}」）`
                        : ''
                    setNote(`装好了：${res.name || item.slug}（${(res.files ?? []).length} 个文件）→ ${res.dir}${fixed}`)
                    if (typeof onInstalled === 'function') onInstalled()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusySlug('') }
            }

            return React.createElement('div', null,
                React.createElement(ErrorBar, { error }),
                note
                    ? React.createElement('div', {
                        style: { color: C.success, marginBottom: 8, fontSize: 12, wordBreak: 'break-all' },
                    }, note)
                    : null,

                // 第一行：搜 + 装到哪儿 + 外链
                React.createElement('div', { style: { ...S.row, marginBottom: 8 } },
                    React.createElement('input', {
                        style: { ...S.input, width: 240 },
                        placeholder: '搜技能名、用途（回车搜）',
                        value: q,
                        onChange: (e) => setQ(e.target.value),
                        onKeyDown: (e) => {
                            if (e.key === 'Enter') {
                                const text = q.trim()
                                setKeyword(text)
                                // 搜东西按相关度找：名字里带搜索词的先出现，同一档里再按所选指标排。
                                setSort(text ? 'score' : 'installs')
                                restart({ keyword: text, sort: text ? 'score' : 'installs' })
                            }
                        },
                    }),
                    btn('搜索', () => {
                        const text = q.trim()
                        setKeyword(text)
                        // 搜东西按相关度找：名字里带搜索词的先出现，同一档里再按所选指标排。
                        setSort(text ? 'score' : 'installs')
                        restart({ keyword: text, sort: text ? 'score' : 'installs' })
                    }, true),
                    keyword ? btn('清空', () => {
                        setQ('')
                        setKeyword('')
                        setSort('installs')
                        restart({ keyword: '', sort: 'installs' })
                    }) : null,
                    React.createElement('span', { style: { flex: 1 } }),
                    React.createElement('label', { style: { ...S.row, gap: 4, cursor: 'pointer', fontSize: 12 } },
                        React.createElement('input', {
                            type: 'checkbox',
                            checked: overwrite,
                            onChange: (e) => setOverwrite(e.target.checked),
                        }),
                        '覆盖已存在的'),
                    React.createElement('a', {
                        href: home,
                        target: '_blank',
                        rel: 'noreferrer',
                        style: { color: C.accent, fontSize: 12, textDecoration: 'none' },
                    }, '在 skillhub.cn 上看看 ↗')),

                // 第二行：排序
                React.createElement('div', { style: { ...S.row, marginBottom: 6, gap: 6 } },
                    React.createElement('span', { style: S.muted }, '排序'),
                    SORTS.map((item) => btn(
                        // 有搜索词时这一项是「相关度」，没有搜索词时是「评分」——
                        // 不带搜索词谈相关度没意义，那时排的就是上游给的综合评分。
                        item.key === 'score' ? (keyword ? '相关度' : '评分') : item.label,
                        () => {
                            setSort(item.key)
                            restart({ sort: item.key })
                        },
                        sort === item.key)),
                    keyword
                        ? React.createElement('span', { style: { ...S.muted, marginLeft: 4 } },
                            '· 搜索时先按相关度分档，同一档里再按这里选的指标排')
                        : null),

                // 第三行：分类
                React.createElement('div', { style: { ...S.row, marginBottom: 10, gap: 6 } },
                    btn('全部', () => { setCat(''); restart({ cat: '' }) }, cat === ''),
                    cats.map((c) => btn(c.name, () => {
                        const next = cat === c.key ? '' : c.key
                        setCat(next)
                        restart({ cat: next })
                    }, cat === c.key)),
                    React.createElement('span', { style: { flex: 1 } }),
                    React.createElement('span', { style: S.muted },
                        total ? `共 ${total.toLocaleString()} 个 · 已加载 ${items.length}` : '')),

                items.length === 0 && loading ? React.createElement(Loading, null) : null,
                items.length === 0 && !loading ? React.createElement('div', { style: S.muted }, '没搜到。换个词，或者点「全部」。') : null,

                items.map((item) => React.createElement('div', {
                    key: `${item.slug}:${item.canonicalName}`,
                    style: { ...S.card, display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' },
                    onClick: () => openDetail(item),
                    title: '点一下看详情',
                },
                    React.createElement(SkillAvatar, { name: item.name, icon: item.icon }),
                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                        React.createElement('div', { style: { ...S.row, gap: 6 } },
                            React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, item.name),
                            item.canonicalName
                                ? React.createElement('span', {
                                    style: {
                                        fontSize: 11, color: C.dim,
                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                    },
                                }, item.canonicalName)
                                : null),
                        React.createElement('div', {
                            style: {
                                ...S.muted, marginTop: 2,
                                // 市场里的描述有的是一大段英文，不限行会把一页撑成几千像素。
                                display: '-webkit-box', WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical', overflow: 'hidden',
                            },
                        }, item.description || '（无描述）'),
                        React.createElement('div', { style: { color: C.dim, fontSize: 11.5, marginTop: 3 } },
                            [
                                item.category ? `分类 ${item.category}` : '',
                                `下载 ${item.downloads}`,
                                item.installs ? `安装 ${item.installs}` : '',
                                item.owner ? `作者 ${item.owner}` : '',
                            ].filter(Boolean).join(' · '))),
                    React.createElement('div', { style: { marginLeft: 8 } },
                        btn(busySlug === item.slug ? '安装中…' : '安装',
                            (e) => { e?.stopPropagation?.(); install(item) }, true, busySlug !== '')))),

                // 哨兵：滚到这里就续下一页。
                React.createElement('div', { ref: sentinel, style: { height: 1 } }),
                loading && items.length > 0
                    ? React.createElement('div', { style: { ...S.muted, textAlign: 'center', padding: 10 } }, '加载中…')
                    : null,
                !more && items.length > 0
                    ? React.createElement('div', { style: { ...S.muted, textAlign: 'center', padding: 10 } },
                        `到底了 · 共 ${items.length} 个`)
                    : null,

                detail
                    ? React.createElement(Modal, {
                        title: '技能详情',
                        onClose: () => setDetail(null),
                        width: 660,
                    },
                        React.createElement(ErrorBar, { error: detailError }),
                        React.createElement('div', { style: { ...S.row, alignItems: 'flex-start', gap: 10 } },
                            React.createElement(SkillAvatar, {
                                name: detail.name, icon: detail.icon, size: 40,
                            }),
                            React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                                React.createElement('div', { style: { ...S.row, gap: 6 } },
                                    React.createElement('span', { style: { fontSize: 16, fontWeight: 600 } }, detail.name || detail.slug),
                                    detail.version
                                        ? React.createElement('span', { style: S.chip('') }, `v${detail.version}`)
                                        : null),
                                detail.canonicalName
                                    ? React.createElement('div', {
                                        style: {
                                            ...S.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                        },
                                    }, detail.canonicalName)
                                    : null,
                                React.createElement('div', { style: { ...S.muted, marginTop: 2 } },
                                    [
                                        detail.category ? `分类 ${detail.category}` : '',
                                        Array.isArray(detail.subCategories) && detail.subCategories.length
                                            ? detail.subCategories.join(' / ')
                                            : '',
                                        detail.owner ? `作者 ${detail.owner}` : '',
                                    ].filter(Boolean).join(' · ')))),

                        detail.loading
                            ? React.createElement('div', { style: { ...S.muted, marginTop: 12 } }, '读取详情…')
                            : React.createElement(React.Fragment, null,
                                React.createElement('div', {
                                    style: { ...S.row, marginTop: 12, gap: 14, ...S.muted },
                                },
                                    React.createElement('span', null, `下载 ${detail.downloads ?? 0}`),
                                    React.createElement('span', null, `安装 ${detail.installs ?? 0}`),
                                    React.createElement('span', null, `星标 ${detail.stars ?? 0}`),
                                    Array.isArray(detail.security) && detail.security.length
                                        ? React.createElement('span', {
                                            style: {
                                                color: detail.security.every((r) => r.status === 'benign')
                                                    ? C.success : C.warn,
                                            },
                                        }, detail.security.map((r) => r.statusText || r.status).join(' · '))
                                        : null),
                                detail.summary
                                    ? React.createElement('div', { style: { marginTop: 10, whiteSpace: 'pre-wrap' } }, detail.summary)
                                    : React.createElement('div', { style: { ...S.muted, marginTop: 10 } }, '（没有摘要）'),
                                detail.summaryEn && detail.summaryEn !== detail.summary
                                    ? React.createElement('div', {
                                        style: { ...S.muted, marginTop: 6, whiteSpace: 'pre-wrap' },
                                    }, detail.summaryEn)
                                    : null,
                                Object.keys(detail.labels ?? {}).length
                                    ? React.createElement('div', { style: { ...S.muted, marginTop: 8 } },
                                        `标签：${Object.entries(detail.labels).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
                                    : null,
                                detail.sourceUrl
                                    ? React.createElement('div', { style: { marginTop: 8 } },
                                        React.createElement('a', {
                                            href: detail.sourceUrl, target: '_blank', rel: 'noreferrer',
                                            style: { color: C.accent, fontSize: 12, textDecoration: 'none' },
                                        }, detail.sourceUrl))
                                    : null,
                                React.createElement('div', { style: { ...S.row, marginTop: 14 } },
                                    btn(busySlug === detail.slug ? '安装中…' : '安装到本机',
                                        () => install(detail), true, busySlug !== ''),
                                    btn('在 skillhub.cn 打开', () => {
                                        window.open(`${home}/skills/${detail.slug}`, '_blank', 'noreferrer')
                                    }),
                                    React.createElement('span', { style: { flex: 1 } }),
                                    btn('关闭', () => setDetail(null)))))
                    : null)
        }

        /**
         * 技能页：两个子页 —— 「已安装」和「技能市场」。
         */
        function SkillPage({ cwd, sessionId, reloadToken }) {
            const [sub, setSub] = useState('installed')
            const [installed, setInstalled] = useState(null)
            // 装了新的要立刻反映到「已安装」那一页，所以让子页把 load 挂出来。
            const [reloadKey, setReloadKey] = useState(0)
            const bump = useCallback(() => setReloadKey((n) => n + 1), [])
            return React.createElement('div', { style: S.page },
                React.createElement('div', { style: { ...S.row, marginBottom: 12, gap: 6 } },
                    btn(`已安装${installed === null ? '' : `（${installed}）`}`, () => setSub('installed'), sub === 'installed'),
                    btn('技能市场', () => setSub('market'), sub === 'market'),
                    React.createElement('span', { style: { flex: 1 } }),
                    React.createElement('span', { style: S.muted },
                        sub === 'installed'
                            ? '内置与第三方技能都能读；改之前会自动留一份 .bak 备份。'
                            : '这些是 skillhub.cn 上的技能，点「安装」直接装进本机。')),
                sub === 'installed'
                    ? React.createElement(SkillInstalled, {
                        cwd, sessionId, reloadToken, onCount: setInstalled,
                        key: `installed:${reloadKey}`,
                    })
                    : React.createElement(SkillMarket, {
                        key: 'market',
                        onInstalled: () => { bump(); setSub('installed') },
                    }))
        }

        /**
         * 已安装的技能（技能页的第一个子页）。
         *
         * 除了列出来，还能读 SKILL.md 改它、按 frontmatter 的调用面开关停用/启用。
         * 宿主 chokidar 监视技能目录，写完约 200ms 广播 skills/change。
         */
        function SkillInstalled({ cwd, sessionId, reloadToken, onCount }) {
            const [data, setData] = useState(null)
            const [error, setError] = useState('')
            const [q, setQ] = useState('')
            const [open, setOpen] = useState(null)
            const [content, setContent] = useState('')
            const [busy, setBusy] = useState(false)
            // 已安装列表按「内置 / 插件 / 其他」分三组折叠；默认全展开，点标题收起来。
            const [folded, setFolded] = useState(() => ({}))

            const load = useCallback(async () => {
                setError('')
                try {
                    const res = await apiCall('skill-list', { cwd, sessionId })
                    setData(res)
                    if (typeof onCount === 'function') onCount((res?.skills ?? []).length)
                }
                catch (e) { setError(String(e.message ?? e)) }
            }, [cwd, onCount])

            useEffect(() => { load() }, [load, reloadToken])

            const read = async (name) => {
                setError('')
                try {
                    const res = await apiCall('skill-read', { name, cwd, sessionId })
                    setOpen(res.skill)
                    setContent(res.skill.content ?? '')
                }
                catch (e) { setError(String(e.message ?? e)) }
            }

            const save = async () => {
                if (!open) return
                setBusy(true); setError('')
                try {
                    await apiCall('skill-write', { name: open.name, content, cwd, sessionId })
                    await load()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /**
             * 停用 / 启用一个技能。
             *
             * 宿主没有独立的开关表，语义落在 frontmatter 的两个调用面开关上
             * （disable-model-invocation / user-invocable），
             * 和 dsh-mcp-studio 的 rewriteSkillPolicy 同一个口径。
             */
            const setPolicy = async (name, enabled) => {
                setBusy(true); setError('')
                try {
                    await apiCall('skill-policy', { name, enabled, cwd, sessionId })
                    await load()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            /**
             * 卸载自装技能：整个技能目录直接删掉（硬删，没有回收站）。
             * 只给「自装技能」这类显示按钮 —— 预设/插件自带/官方技能包删了会坏。
             */
            const remove = async (name) => {
                if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                    && !window.confirm(`彻底删掉技能「${name}」？\n（它的整个目录会被直接删除，删了就没了，不能撤销）`)) {
                    return
                }
                setBusy(true); setError('')
                try {
                    const res = await apiCall('skill-remove', { name, cwd, sessionId })
                    if (typeof onCount === 'function') onCount((res?.skills ?? []).length)
                    if (open?.name === name) setOpen(null)
                    await load()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const skills = useMemo(() => {
                const all = data?.skills ?? []
                const needle = q.trim().toLowerCase()
                if (!needle) return all
                return all.filter((s) => s.name.toLowerCase().includes(needle)
                    || (s.description ?? '').toLowerCase().includes(needle))
            }, [data, q])

            const originOf = (s) => s.origin ?? {
                kind: 'other', label: s.sourceLabel ?? '技能', detail: '', packageName: '',
            }
            const originColor = (origin) => (origin.kind === 'preset' ? C.accent
                : origin.kind === 'plugin' ? C.success
                    : origin.kind === 'official' ? C.warn
                        : origin.kind === 'user' ? C.accent : C.dim)
            const originText = (origin) => (origin.packageName
                ? `${origin.label} · ${origin.packageName}`
                : origin.label)

            const stop = (fn) => (e) => { e?.stopPropagation?.(); fn() }

            /** 一张技能卡片（版式和插件页 / MCP 页一致）。 */
            const card = (s) => {
                const origin = originOf(s)
                const color = originColor(origin)
                return EntityCard({
                    key: `${s.source}:${s.name}`,
                    avatar: React.createElement(SkillAvatar, { name: s.name, size: 26 }),
                    title: s.name,
                    titleAttr: originText(origin),
                    badge: s.modelInvocable === false ? miniChip('已停用', C.warn) : null,
                    desc: s.description || '（无描述）',
                    descMinHeight: 42,
                    // 组标题上已经说了这一类是什么，卡片脚注只留「标签 · 包名」，免得被截断。
                    foot: originText(origin),
                    onClick: () => read(s.name),
                    extra: React.createElement('div', {
                        style: { ...S.row, gap: 4, flexWrap: 'nowrap', marginTop: 2 },
                    },
                        btn(s.modelInvocable === false ? '启用' : '停用',
                            stop(() => setPolicy(s.name, s.modelInvocable === false))),
                        btn('读取', stop(() => read(s.name))),
                        origin.kind === 'user' ? btn('删除', stop(() => remove(s.name))) : null),
                })
            }

            /** 技能详情：它的 SKILL.md，能直接改。 */
            const detail = () => {
                const origin = originOf(open)
                const color = originColor(origin)
                return React.createElement('div', null,
                    React.createElement(BackBar, {
                        label: '全部技能',
                        onClick: () => setOpen(null),
                    }),
                    React.createElement('div', { style: { ...S.card, padding: 14 } },
                        React.createElement('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
                            React.createElement(SkillAvatar, { name: open.name, size: 32 }),
                            React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } }, open.name),
                            miniChip(originText(origin), color),
                            open.modelInvocable === false ? miniChip('已停用', C.warn) : null,
                            React.createElement('span', { style: { flex: 1 } }),
                            btn(open.modelInvocable === false ? '启用' : '停用',
                                () => setPolicy(open.name, open.modelInvocable === false)),
                            origin.kind === 'user'
                                ? btn('删除', () => remove(open.name))
                                : null),
                        React.createElement('div', {
                            style: { ...S.muted, fontSize: 12, marginTop: 6, wordBreak: 'break-all' },
                        }, open.path || '（宿主没给路径）'),
                        React.createElement('div', {
                            style: {
                                fontSize: 12.5, color: C.text2, marginTop: 6,
                                lineHeight: 1.55, whiteSpace: 'pre-wrap',
                            },
                        }, open.description || '（这个技能没写简介）'),
                        origin.detail
                            ? React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 4 } },
                                origin.detail)
                            : null),
                    React.createElement('div', { style: { ...S.row, marginTop: 14, padding: '4px 0' } },
                        React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, 'SKILL.md'),
                        React.createElement('span', { style: { ...S.muted, fontSize: 12 } }, '　改完点保存，宿主会自己重新加载'),
                        React.createElement('span', { style: { flex: 1 } }),
                        busy ? React.createElement('span', { style: S.muted }, '处理中…') : null),
                    open.location === 'package'
                        ? React.createElement('div', { style: { ...S.muted, marginBottom: 6 } },
                            '这个文件在 node_modules 里：保存会先写一份 .bak-<时间戳>，'
                            + '但插件下次更新会把它覆盖回原样。')
                        : null,
                    React.createElement('textarea', {
                        style: { ...S.textarea, minHeight: 420 },
                        value: content,
                        disabled: open.editable === false,
                        onChange: (e) => setContent(e.target.value),
                    }),
                    React.createElement('div', { style: { ...S.row, marginTop: 8 } },
                        btn('保存', save, true),
                        btn('重新读取', () => read(open.name))))
            }

            return React.createElement('div', null,
                React.createElement(ErrorBar, { error }),
                open
                    ? detail()
                    : React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { ...S.row, marginBottom: 10 } },
                            React.createElement('input', {
                                style: { ...S.input, width: 260 },
                                placeholder: '搜技能',
                                value: q,
                                onChange: (e) => setQ(e.target.value),
                            }),
                            React.createElement('span', { style: { flex: 1 } })),
                        !data ? React.createElement(Loading, null) : null,
                        // 新会话还没有 agent 的时候，宿主只给得出全局注册的那几个技能。
                        // 不说清楚，看到「只有一个 genui」会以为插件只认内置的。
                        data && data.skills.length <= 1
                            ? React.createElement('div', { style: { ...S.muted, marginBottom: 10 } },
                                '只看到这么几个，通常是这个会话还没跑起来（没有活着的 agent）：'
                                + '宿主按 agent 那一层注册的技能要等对话开始后才拿得到。发一条消息再回来看就全了。')
                            : null,
                        skills.length === 0 && data
                            ? React.createElement('div', { style: S.muted },
                                q.trim() ? '没有匹配的技能。' : '还没有技能。')
                            : null,
                        React.createElement('div', null,
                            SKILL_BUCKETS.map((bucket) => {
                                const list = skills.filter((s) => (originOf(s).bucket ?? 'other') === bucket.key)
                                if (list.length === 0) return null
                                const isFolded = folded[bucket.key] === true
                                return React.createElement('div', { key: bucket.key, style: { marginBottom: 6 } },
                                    React.createElement('div', {
                                        style: {
                                            ...S.row, cursor: 'pointer', userSelect: 'none',
                                            padding: '5px 2px', gap: 6,
                                        },
                                        onClick: () => setFolded((f) => ({ ...f, [bucket.key]: !isFolded })),
                                    },
                                        React.createElement('span', {
                                            style: { fontSize: 9, color: C.dim, width: 10, flex: '0 0 auto' },
                                        }, isFolded ? '▶' : '▼'),
                                        React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } },
                                            bucket.label),
                                        React.createElement('span', { style: { ...S.muted, fontSize: 12 } },
                                            `${list.length} 个`),
                                        React.createElement('span', {
                                            style: { ...S.muted, fontSize: 11.5, flex: 1 },
                                        }, `　${bucket.hint}`)),
                                    isFolded
                                        ? null
                                        : React.createElement('div', {
                                            style: {
                                                display: 'flex', flexWrap: 'wrap', gap: 10,
                                                marginTop: 8, marginBottom: 12,
                                            },
                                        }, list.map((s) => card(s))))
                            }))))
        }

        /** 一枚小徽标（状态 / 已停用之类）。 */
        function miniChip(text, color) {
            return React.createElement('span', {
                style: {
                    fontSize: 10.5, lineHeight: '15px', padding: '0 6px', borderRadius: 9,
                    border: `1px solid ${color}`, color, whiteSpace: 'nowrap', flex: '0 0 auto',
                },
            }, text)
        }

        // ——————————————————— 时间与变化文案 ———————————————————

        /** 「3 分钟前 / 昨天 14:05」——比绝对时间好读，问的是「刚发生吗」。 */
        function formatWhen(ts) {
            const t = Number(ts) || 0
            if (!t) return '—'
            const delta = Date.now() - t
            if (delta < 0) return '刚刚'
            if (delta < 60e3) return '刚刚'
            if (delta < 3600e3) return `${Math.floor(delta / 60e3)} 分钟前`
            if (delta < 86400e3) return `${Math.floor(delta / 3600e3)} 小时前`
            const d = new Date(t)
            const pad = (n) => String(n).padStart(2, '0')
            return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        }

        const WATCH_KIND = {
            installed: { label: '新装', color: () => C.success },
            updated: { label: '升级', color: () => C.accent },
            changed: { label: '变化', color: () => C.warn },
            removed: { label: '移除', color: () => C.error },
        }

        /** 把「+3 个工具、-1 段提示词」压成一行字（列表太长就折起来）。 */
        function watchDeltaText(ev) {
            const parts = []
            const list = (arr, sign) => {
                if (!arr || arr.length === 0) return null
                const head = arr.slice(0, 4).join('、')
                return `${sign}${arr.length === 1 ? head : `${head} 等 ${arr.length} 个`}`
            }
            const toolsAdd = list(ev.toolsAdded, '工具 +')
            const toolsDel = list(ev.toolsRemoved, '工具 −')
            const secAdd = list(ev.sectionsAdded, '提示词 +')
            const secDel = list(ev.sectionsRemoved, '提示词 −')
            for (const p of [toolsAdd, toolsDel, secAdd, secDel]) {
                if (p) parts.push(p)
            }
            if (ev.kind === 'updated' && ev.versionFrom) {
                parts.unshift(`${ev.versionFrom || '?'} → ${ev.version || '?'}`)
            }
            return parts.join('；')
        }

        /**
         * 一台 MCP 连接器的卡片。
         *
         * 版式和插件页那张卡一模一样（名字 + 一句简介 + 底行），
         * 只是底行下面多一排动作按钮 —— 用户要求「启用关闭之类的按钮直接在框内最下一行」。
         * 点卡片正文（不是按钮）进详情，详情里才是提示词和工具清单。
         */
        function McpCard({
            s, toolsCount, probeResult, busy, onOpen, onToggle, onEdit, onCheck, onCopy, onRemove,
        }) {
            const stop = (fn) => (e) => { e?.stopPropagation?.(); fn() }
            const color = mcpStatusColor(s.status)
            const addr = s.transport === 'stdio'
                ? (`${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() || '（没填命令）')
                : (s.url || '（没填 URL）')
            const busyThis = typeof busy === 'string' && busy.endsWith(`:${s.id}`)
            return EntityCard({
                title: s.name || s.serverName || s.id,
                titleAttr: `${s.serverName ?? ''}\n${addr}`,
                badge: miniChip(s.statusText, color),
                desc: `${s.transport === 'stdio' ? 'stdio' : 'HTTP'} · ${addr}`
                    + (probeResult ? `\n探测：${probeResult.detail ?? (probeResult.ok ? '通' : '不通')}` : ''),
                foot: `${toolsCount} 个工具${busyThis ? ' · 处理中…' : ''}`,
                descLines: 2,
                descMinHeight: 32,
                onClick: onOpen,
                extra: React.createElement('div', {
                    style: { ...S.row, gap: 4, flexWrap: 'nowrap', marginTop: 2 },
                },
                    btn(s.disabled === true ? '启用' : '停用', stop(onToggle)),
                    btn('编辑', stop(onEdit)),
                    btn('探测', stop(onCheck)),
                    btn('复制', stop(onCopy)),
                    btn('删除', stop(onRemove))),
            })
        }

        /**
         * 一台 MCP 连接器的详情。
         *
         * 和插件详情同一个骨架：返回条 → 头部卡片（名字 / 状态 / 地址 / id）→
         * 这块「系统提示词」→ 这块「工具」。
         */
        function McpDetail({
            s, group, needle, toolStates, onToggleTool,
            promptOpen, setPromptOpen, promptEdit, setPromptEdit, onTogglePrompt, onSavePrompt,
            probeResult, busy, editing, setEditing, onSaveNote, onBack, onEdit, onCheck,
        }) {
            const cardKey = `${s.layer}:${s.id}`
            const allTools = group?.tools ?? []
            const shownTools = needle
                ? allTools.filter((t) => t.name.toLowerCase().includes(needle)
                    || String(t.description ?? '').toLowerCase().includes(needle))
                : allTools
            const promptOpenState = promptOpen[cardKey] === true
            const color = mcpStatusColor(s.status)
            const addr = s.transport === 'stdio'
                ? (`${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() || '（没填命令）')
                : (s.url || '（没填 URL）')
            const stop = (fn) => (e) => { e?.stopPropagation?.(); fn() }

            const block = (key, label, count, node) => {
                const on = promptOpen[`b:${cardKey}:${key}`] !== false
                return React.createElement('div', { key, style: { marginTop: 14 } },
                    React.createElement('div', {
                        style: { ...S.row, cursor: 'pointer', userSelect: 'none', padding: '4px 0' },
                        onClick: () => setPromptOpen((p) => ({
                            ...p, [`b:${cardKey}:${key}`]: !on,
                        })),
                    },
                        React.createElement('span', { style: { color: C.text2, width: 14, flex: '0 0 14px' } },
                            on ? '▾' : '▸'),
                        React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, label),
                        React.createElement('span', { style: { ...S.muted, fontSize: 12 } }, `　${count}`)),
                    on ? node : null)
            }

            return React.createElement('div', null,
                React.createElement(BackBar, { label: '全部连接器', onClick: onBack }),
                React.createElement('div', { style: { ...S.card, padding: 14 } },
                    React.createElement('div', { style: { ...S.row, alignItems: 'baseline', gap: 8 } },
                        React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } },
                            s.name || s.serverName || s.id),
                        s.name && s.serverName
                            ? React.createElement('span', {
                                style: {
                                    ...S.muted, fontSize: 12,
                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                },
                            }, s.serverName)
                            : null,
                        miniChip(s.statusText, color),
                        s.shadowed ? React.createElement('span', { style: S.chip('') }, '重复条目') : null,
                        React.createElement('span', { style: { flex: 1 } }),
                        btn('编辑', () => onEdit(s)),
                        btn('探测', () => onCheck(s))),
                    React.createElement('div', {
                        style: { ...S.muted, fontSize: 12, marginTop: 6, wordBreak: 'break-all' },
                    }, addr,
                        React.createElement('span', {
                            style: {
                                color: C.caption, marginLeft: 8,
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            },
                        }, `id=${s.id}`)),
                    probeResult
                        ? React.createElement('div', {
                            style: {
                                marginTop: 4, fontSize: 11.5,
                                color: probeResult.ok ? C.success : C.error,
                            },
                        }, `探测：${probeResult.detail ?? (probeResult.ok ? '通' : '不通')}`)
                        : null,
                    React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 6 } },
                        `${allTools.length} 个工具 · 连接器写在全局补丁里，所有 profile 共用`)),
                block('prompts', '系统提示词', s.prompt ? '1 段' : '没有',
                    s.prompt
                        ? React.createElement('div', null,
                            React.createElement('div', {
                                style: { ...S.row, marginBottom: 4 },
                            },
                                React.createElement('button', {
                                    type: 'button',
                                    onClick: () => setPromptOpen((p) => ({ ...p, [cardKey]: !promptOpenState })),
                                    style: { ...S.btn(false), padding: '2px 9px', fontSize: 11.5 },
                                }, `${promptOpenState ? '▾' : '▸'} ${s.prompt.injected ? '注入中' : '不注入'}`),
                                React.createElement('span', { style: S.muted }, `段落 ${s.prompt.name}`)),
                            promptOpenState
                                ? React.createElement(McpPromptBody, {
                                    s, promptEdit, setPromptEdit,
                                    togglePrompt: onTogglePrompt, savePrompt: onSavePrompt,
                                })
                                : null)
                        : React.createElement('div', { style: { ...S.muted, marginLeft: 14, padding: '4px 0' } },
                            '这台还没推系统提示词（连上以后服务器才会推）。')),
                block('tools', '工具', `${allTools.length} 个`,
                    React.createElement('div', { style: { marginLeft: 14, marginTop: 2 } },
                        React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginBottom: 4 } },
                            '关掉 = 模型看不见、调不动；开关跨层共用。'),
                        shownTools.length === 0
                            ? React.createElement('div', { style: S.muted },
                                allTools.length === 0
                                    ? '这台还没注册工具（可能没连上）。'
                                    : '没有匹配的工具。')
                            : null,
                        shownTools.map((t) => {
                            const off = toolStates[t.name]?.disabled === true
                            const editingThis = editing?.name === t.name
                            return React.createElement('div', { key: t.name, style: { marginBottom: 2 } },
                                React.createElement('div', {
                                    style: {
                                        ...S.row, padding: '3px 0', borderTop: `1px solid ${C.border}`,
                                        alignItems: 'flex-start',
                                    },
                                },
                                    React.createElement('input', {
                                        type: 'checkbox',
                                        checked: !off,
                                        style: { marginTop: 3 },
                                        onChange: (e) => onToggleTool(t.name, e.target.checked === false),
                                    }),
                                    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
                                        React.createElement('div', {
                                            style: {
                                                fontSize: 12,
                                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                                color: off ? C.dim : C.text, wordBreak: 'break-all',
                                            },
                                        },
                                            t.alias
                                                ? React.createElement(React.Fragment, null,
                                                    React.createElement('span', { style: { fontFamily: 'inherit' } }, `${t.alias} `),
                                                    React.createElement('span', { style: { color: C.dim } }, t.name))
                                                : t.name),
                                        React.createElement('div', {
                                            style: { fontSize: 11.5, color: C.dim, marginTop: 1, wordBreak: 'break-word' },
                                        }, t.note
                                            ? `备注：${t.note}`
                                            : (t.description || '（无描述）')),
                                        t.inject
                                            ? React.createElement('div', {
                                                style: { color: C.success, fontSize: 11.5, marginTop: 1 },
                                            }, '已作为注入描述生效')
                                            : null),
                                    btn(editingThis ? '收起' : '备注', stop(() => {
                                        setEditing(editingThis ? null : {
                                            name: t.name,
                                            alias: t.alias ?? '',
                                            description: t.note ?? '',
                                            inject: t.inject === true,
                                        })
                                    }))),
                                editingThis
                                    ? React.createElement(NoteEditor, {
                                        tool: t, editing, setEditing, busy: busy !== '',
                                        onSave: () => onSaveNote(editing.name, {
                                            alias: editing.alias,
                                            description: editing.description,
                                            inject: editing.inject,
                                        }),
                                    })
                                    : null)
                        }))))
        }

        // ——————————————————— MCP 页 ———————————————————
        // 这一页管两样东西：**连接器**（MCP 服务器）和它们带来的**工具**。
        //
        // 真源是两层 cordis.patch.yml（全局 $DSH_HOME / 本 profile），不是插件内存，
        // 所以改完宿主热重载即生效，不用重启。
        //
        // 「配了 MCP 却没被识别」只有把三样摆在一起才说得清：
        //   补丁里有这行  →  宿主挂上了（loader 里有 entry）  →  工具表里有它的工具
        // 少第一样 = 你没写进去；少第二样 = 被另一层补丁盖掉了；
        // 少第三样 = 挂上了但服务器没连上。

        /** 「key: value」每行一条 → 对象。 */
        function parseKv(text) {
            const out = {}
            for (const line of String(text ?? '').split('\n')) {
                const trimmed = line.trim()
                if (!trimmed) continue
                const at = trimmed.indexOf(':')
                if (at <= 0) continue
                const k = trimmed.slice(0, at).trim()
                const v = trimmed.slice(at + 1).trim()
                if (k) out[k] = v
            }
            return out
        }

        /** 对象 → 「key: value」每行一条。 */
        function formatKv(obj) {
            const entries = obj && typeof obj === 'object' ? Object.entries(obj) : []
            if (entries.length === 0) return ''
            return entries.map(([k, v]) => `${k}: ${v}`).join('\n')
        }

        /** 状态徽标的颜色。 */
        /** 名字 → 一个稳定的颜色（没有图标的技能用首字当图标，底色按名字散开但每次一样）。 */
        const AVATAR_COLORS = [
            '#2f6bff', '#1f8a4c', '#b7791f', '#d13c3c', '#7a44c9',
            '#0f8b8d', '#c2410c', '#2c5282', '#9d174d', '#4d7c0f',
        ]
        function avatarColorOf(name) {
            const text = String(name ?? '')
            let hash = 0
            for (let i = 0; i < text.length; i += 1) {
                hash = (hash * 31 + text.codePointAt(i)) % 100000
            }
            return AVATAR_COLORS[hash % AVATAR_COLORS.length]
        }

        /**
         * 技能图标：有图就用图，没有就用「名字的第一个字」。
         * 英文名首字母大写（`find-skills` → `F`），中文名取第一个字（`办公` → `办`）。
         */
        function SkillAvatar({ name, icon, size }) {
            const box = size ?? 26
            if (icon) {
                return React.createElement('img', {
                    src: icon, alt: '',
                    width: box, height: box,
                    style: { borderRadius: 6, flex: `0 0 ${box}px`, objectFit: 'cover' },
                })
            }
            const text = String(name ?? '').trim()
            const letter = text ? Array.from(text)[0].toUpperCase() : '?'
            return React.createElement('div', {
                style: {
                    width: box, height: box, flex: `0 0 ${box}px`,
                    borderRadius: 6, background: avatarColorOf(text),
                    color: '#fff', fontSize: Math.round(box * 0.46), fontWeight: 600,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    userSelect: 'none',
                },
            }, letter)
        }

        /** 一层灰底 + 居中的对话框。MCP 页那个弹窗是内联写的，这里抽一份给别处用。 */
        function Modal({ title, onClose, width, children }) {
            return React.createElement('div', {
                style: {
                    position: 'fixed', inset: 0, zIndex: 9999,
                    background: 'rgba(0,0,0,.38)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: 20,
                },
                onClick: onClose,
            },
                React.createElement('div', {
                    style: {
                        // C.bg 在当前这套皮肤里是半透明的（--dsw-alias-bg-base = 0.26 透明度），
                        // 当弹窗底会透出下面的列表。layer-1 是实色的，用它。
                        background: C.panel, borderRadius: 10, border: `1px solid ${C.border}`,
                        width: width ?? 620, maxWidth: '100%', maxHeight: '86vh',
                        overflow: 'auto', padding: 16, boxSizing: 'border-box',
                        boxShadow: '0 18px 50px rgba(0,0,0,.30)',
                    },
                    onClick: (e) => e.stopPropagation(),
                },
                    React.createElement('div', {
                        style: { ...S.row, marginBottom: 10, alignItems: 'flex-start' },
                    },
                        React.createElement('div', { style: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600 } }, title),
                        React.createElement('button', {
                            style: { ...S.btn(false), padding: '2px 8px' },
                            onClick: onClose,
                            type: 'button',
                        }, '×')),
                    children))
        }

        function mcpStatusColor(status) {
            if (status === 'connected') return C.success
            // 「正在启动」不是坏了：宿主刚把这台挂起来，等它连上就行。
            if (status === 'starting') return C.accent
            if (status === 'failed') return C.error
            if (status === 'no-tools' || status === 'no_tools' || status === 'inactive' || status === 'not-mounted') return C.warn
            if (status === 'disabled') return C.dim
            return C.text2
        }

        /** 一台连接器的系统提示词面板（绑在这台连接器上）。 */
        function McpPromptBody({ s, promptEdit, setPromptEdit, togglePrompt, savePrompt }) {
            const editing = s.prompt ? promptEdit[s.prompt.name] : undefined
            return React.createElement('div', { style: { marginTop: 6 } },
                !s.prompt
                    ? React.createElement('div', { style: S.muted },
                        '这台连接器还没有对应的系统提示词段落。'
                        + 'MCP 服务器连上以后会推一段过来（名字是 mcp:' + (s.serverName || '<服务器名>') + '），到那时就能在这里改它了。')
                    : React.createElement(React.Fragment, null,
                        React.createElement('div', { style: { ...S.row, gap: 6, marginBottom: 4 } },
                            React.createElement('label', {
                                style: { ...S.row, cursor: 'pointer', gap: 5, fontSize: 12.5 },
                            },
                                React.createElement('input', {
                                    type: 'checkbox',
                                    checked: s.prompt.injected === true,
                                    onChange: (e) => togglePrompt(s.prompt.name, e.target.checked === true),
                                }),
                                React.createElement('span', { style: { color: s.prompt.injected ? C.text : C.dim } },
                                    '注入到系统提示词')),
                            ),
                        React.createElement('div', {
                            style: {
                                ...S.muted, fontSize: 11.5, whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word', maxHeight: 140, overflow: 'auto',
                                border: `1px solid ${C.border}`, borderRadius: 6, padding: 8,
                            },
                        }, s.prompt.overrideText ?? s.prompt.text ?? ''),
                        s.prompt.overrideText
                            ? React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 4 } },
                                '（已经改写过：上面显示的是改写后的文字）')
                            : null,
                        React.createElement('div', { style: { ...S.row, gap: 6, marginTop: 6 } },
                            btn(editing === undefined ? '改写这段' : '收起改写', () => {
                                setPromptEdit((p) => {
                                    const next = { ...p }
                                    if (next[s.prompt.name] === undefined) {
                                        next[s.prompt.name] = s.prompt.overrideText ?? s.prompt.text ?? ''
                                    }
                                    else {
                                        delete next[s.prompt.name]
                                    }
                                    return next
                                })
                            }),
                            editing !== undefined
                                ? btn('保存改写', () => savePrompt(s.prompt.name, editing))
                                : null,
                            editing !== undefined
                                ? btn('还原原文', () => savePrompt(s.prompt.name, ''))
                                : null),
                        editing !== undefined
                            ? React.createElement('textarea', {
                                style: {
                                    ...S.textarea, marginTop: 6, minHeight: 130,
                                    fontSize: 12, whiteSpace: 'pre-wrap',
                                },
                                rows: 6,
                                value: editing,
                                placeholder: '写这段系统提示词要发给模型的内容',
                                onChange: (e) => setPromptEdit((p) => ({ ...p, [s.prompt.name]: e.target.value })),
                            })
                            : null))
        }

        function McpPage({ reloadToken, onChanged }) {
            const [data, setData] = useState(null)
            const [error, setError] = useState('')
            const [busy, setBusy] = useState('')
            const [form, setForm] = useState(null)
            const [formError, setFormError] = useState('')
            const [probe, setProbe] = useState({})
            const [toolQ, setToolQ] = useState('')
            /** 每台连接器的系统提示词面板展开状态：键 = `${layer}:${id}`。 */
            const [promptOpen, setPromptOpen] = useState({})
            /** 正在改写的系统提示词正文：键 = 段落名。 */
            const [promptEdit, setPromptEdit] = useState({})
            /** 正在改备注的那个工具（和插件页同一个编辑器、同一张表）。 */
            const [editing, setEditing] = useState(null)
            /** 打开详情的那台连接器 id；null = 卡片列表。 */
            const [openId, setOpenId] = useState(null)

            const load = useCallback(async () => {
                setError('')
                try {
                    const res = await apiCall('mcp-list', {})
                    setData(res)
                }
                catch (e) { setError(String(e.message ?? e)) }
            }, [])

            useEffect(() => { load() }, [load, reloadToken])

            /** 跑一个写操作：统一管 busy 与报错。 */
            const run = async (key, fn) => {
                setBusy(key)
                setError('')
                try {
                    await fn()
                }
                catch (e) {
                    setError(String(e.message ?? e))
                }
                finally {
                    setBusy('')
                }
            }

            const servers = data?.servers ?? []
            const toolStates = data?.toolStates ?? {}

            const openNew = () => {
                setFormError('')
                setForm({
                    name: '',
                    serverName: '', transport: 'streamable-http', url: '', headers: '',
                    command: '', args: '', env: '', cwd: '',
                    disabled: false,
                })
            }

            const openEdit = (s) => {
                setFormError('')
                setForm({
                    id: s.id,
                    name: s.name ?? '',
                    serverName: s.serverName ?? '',
                    transport: s.transport ?? 'stdio',
                    url: s.url ?? '',
                    headers: formatKv(s.headers),
                    command: s.command ?? '',
                    args: Array.isArray(s.args) ? s.args.join('\n') : '',
                    env: formatKv(s.env),
                    cwd: s.cwd ?? '',
                    disabled: s.disabled === true,
                })
            }

            const saveForm = () => {
                if (!form) return
                const payload = {
                    id: String(form.id ?? '').trim(),
                    // 显示名（给人看的）放最前面，服务器名（给机器看的）在后面。
                    name: String(form.name ?? '').trim(),
                    serverName: String(form.serverName ?? '').trim(),
                    transport: form.transport,
                    url: String(form.url ?? '').trim(),
                    headers: parseKv(form.headers),
                    command: String(form.command ?? '').trim(),
                    args: String(form.args ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
                    env: parseKv(form.env),
                    cwd: String(form.cwd ?? '').trim(),
                    disabled: form.disabled === true,
                }
                setFormError('')
                run('save', async () => {
                    await apiCall('mcp-save', payload)
                    setForm(null)
                    await load()
                    if (onChanged) onChanged()
                })
            }

            const toggleServer = (s) => {
                run(`toggle:${s.id}`, async () => {
                    const disabled = s.disabled !== true
                    // 宿主那边会等这一台真的挂起来（真的连上）才回话，
                    // 所以回话里带的就是最终状态 —— 不用界面自己猜。
                    const res = await apiCall('mcp-toggle', { id: s.id, disabled })
                    await load()
                    if (res?.statusText) {
                        setProbe((p) => ({ ...p, [s.id]: { ok: res.status !== 'failed', detail: res.statusText } }))
                    }
                })
            }

            /** 工具备注：改的就是插件页那张表（全局层的 tools）。 */
            const saveNote = (name, note) => {
                run(`note:${name}`, async () => {
                    await apiCall('tool-note-save', { scope: 'global', name, ...note })
                    setEditing(null)
                    await load()
                })
            }

            /** 让宿主重新读一遍补丁（刷新宿主那侧的连接器）。 */
            const refreshHost = () => {
                setProbe((p) => ({ ...p, __refresh: { ok: true, detail: '正在让宿主重新读一遍补丁，等连接器挂回去…' } }))
                run('refresh', async () => {
                    const res = await apiCall('mcp-refresh', {})
                    await load()
                    const fixed = (res?.healed?.fixed ?? []).length
                    setProbe((p) => ({
                        ...p,
                        __refresh: {
                            ok: res?.refreshed !== false || fixed > 0,
                            detail: res?.refreshed
                                ? `已让宿主重新读了一遍补丁${fixed > 0 ? `，顺手把 ${fixed} 台重新挂上了` : ''}`
                                : (fixed > 0
                                    ? `宿主没重读补丁，但把 ${fixed} 台重新挂上了`
                                    : `宿主没重读（${res?.reason ?? '不知道原因'}），等它自己发现补丁变了`),
                        },
                    }))
                })
            }

            /** 这台连接器的系统提示词：勾 = 注入，不勾 = 不进模型。 */
            const togglePrompt = (name, on) => {
                run(`prompt:${name}`, async () => {
                    await apiCall('section-state-save', { name, enabled: on })
                    await load()
                })
            }

            /** 改写这段系统提示词（空 = 回到原文）。 */
            const savePrompt = (name, text) => {
                run(`prompt-edit:${name}`, async () => {
                    await apiCall('section-layer-override-save', { name, text })
                    setPromptEdit((p) => { const next = { ...p }; delete next[name]; return next })
                    await load()
                })
            }

            const removeServer = (s) => {
                run(`remove:${s.id}`, async () => {
                    await apiCall('mcp-remove', { id: s.id })
                    await load()
                })
            }

            const copyServer = (s) => {
                run(`copy:${s.id}`, async () => {
                    const res = await apiCall('mcp-copy', { id: s.id })
                    await load()
                    if (res?.serverName) {
                        setProbe((p) => ({ ...p, [s.id]: { ok: true, detail: `已复制成「${res.serverName}」` } }))
                    }
                })
            }

            const checkServer = (s) => {
                run(`check:${s.id}`, async () => {
                    const res = await apiCall('mcp-check', { id: s.id })
                    setProbe((p) => ({ ...p, [s.id]: res }))
                })
            }

            const toggleTool = (name, off) => {
                run(`tool:${name}`, async () => {
                    await apiCall('mcp-tool-toggle', { name, disabled: off })
                    await load()
                })
            }

            /** 工具按服务器分组：清单就在各自那张卡片里展开。 */
            const toolsByServer = useMemo(() => {
                const map = new Map()
                for (const g of data?.tools ?? []) {
                    map.set(g.server, g)
                }
                return map
            }, [data])

            /** 搜索词（小写）：详情里的工具清单按它筛。 */
            const needle = toolQ.trim().toLowerCase()

            /** 打开着详情的那台（找不到 = 刚被删掉，落回列表）。 */
            const current = useMemo(
                () => (openId ? servers.find((s) => s.id === openId) ?? null : null),
                [servers, openId],
            )

            return React.createElement('div', { style: S.page },
                React.createElement(ErrorBar, { error }),
                // 进详情就把工具条收起来，只剩详情自己那颗「← 全部连接器」。
                current
                    ? null
                    : React.createElement('div', { style: { ...S.row, marginBottom: 10 } },
                        btn('新增连接器', openNew, true),
                        btn(busy === 'refresh' ? '刷新中…' : '刷新', refreshHost, false, busy === 'refresh'),
                        React.createElement('input', {
                            style: { ...S.input, width: 190 },
                            placeholder: '搜工具名',
                            value: toolQ,
                            onChange: (e) => setToolQ(e.target.value),
                        }),
                        React.createElement('span', { style: S.muted },
                            '连接器写在全局补丁里，所有 profile 共用；启用 = 默认启用，'
                            + '具体哪个预设用哪些工具，去「预设」页挑。')),
                probe.__refresh
                    ? React.createElement('div', {
                        style: {
                            fontSize: 11.5, marginBottom: 8,
                            color: busy === 'refresh' ? C.dim : (probe.__refresh.ok ? C.success : C.warn),
                        },
                    }, probe.__refresh.detail ?? '')
                    : null,
                !data ? React.createElement(Loading, null) : null,
                servers.length === 0 && data
                    ? React.createElement('div', { style: { ...S.muted, marginBottom: 10 } },
                        '还没有 MCP 连接器。点「新增连接器」写一台。')
                    : null,
                current
                    ? React.createElement(McpDetail, {
                        s: current,
                        group: toolsByServer.get(current.serverName),
                        needle,
                        toolStates,
                        onToggleTool: toggleTool,
                        promptOpen,
                        setPromptOpen,
                        promptEdit,
                        setPromptEdit,
                        onTogglePrompt: togglePrompt,
                        onSavePrompt: savePrompt,
                        probeResult: probe[current.id],
                        busy,
                        editing,
                        setEditing,
                        onSaveNote: saveNote,
                        onBack: () => setOpenId(null),
                        onEdit: openEdit,
                        onCheck: checkServer,
                    })
                    : React.createElement('div', {
                        style: { display: 'flex', flexWrap: 'wrap', gap: 10 },
                    },
                        servers.map((s) => React.createElement(McpCard, {
                            key: `${s.layer}:${s.id}`,
                            s,
                            toolsCount: (toolsByServer.get(s.serverName)?.tools ?? []).length,
                            probeResult: probe[s.id],
                            busy,
                            onOpen: () => setOpenId(s.id),
                            onToggle: () => toggleServer(s),
                            onEdit: () => openEdit(s),
                            onCheck: () => checkServer(s),
                            onCopy: () => copyServer(s),
                            onRemove: () => removeServer(s),
                        }))),
                // ——— 工具清单 ———
                // 工具不单开一栏，而是折在各自那张连接器卡片里（点「▸ 工具（N）」展开）。
                // 这里只留一个搜索框：搜的是所有卡片的工具清单，命中时对应卡片自动展开。
                // ——— 新增 / 编辑：弹窗 ———
                form
                    ? React.createElement('div', {
                        style: {
                            position: 'fixed', inset: 0, zIndex: 9999,
                            background: 'rgba(0,0,0,.38)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: '24px',
                        },
                        onClick: (e) => { if (e.target === e.currentTarget) setForm(null) },
                    },
                        React.createElement('div', {
                            style: {
                                background: C.panel, border: `1px solid ${C.border2}`, borderRadius: 10,
                                width: 560, maxWidth: '100%', maxHeight: '86vh', overflow: 'auto',
                                padding: 16, boxShadow: '0 16px 48px rgba(0,0,0,.28)',
                            },
                        },
                            React.createElement('div', { style: { ...S.row, marginBottom: 10 } },
                                React.createElement('div', { style: { ...S.h2, margin: 0, flex: 1 } },
                                    form.id ? `编辑 · ${form.name || form.serverName}` : '新增连接器'),
                                React.createElement('button', {
                                    type: 'button', onClick: () => setForm(null),
                                    style: { ...S.btn(false), padding: '1px 9px', fontSize: 14, lineHeight: '18px' },
                                }, '×')),
                            React.createElement(ErrorBar, { error: formError }),
                            React.createElement(Field, {
                                label: '名称（给人看的名字，比如「文档服务」）',
                                hint: '只存在这个插件自己的表里，不会写进补丁；下面那个「服务器名」才是机器认的。',
                            },
                                React.createElement(TextInput, {
                                    value: form.name,
                                    onChange: (v) => setForm({ ...form, name: v }),
                                    placeholder: '文档服务',
                                })),
                            React.createElement(Field, {
                                label: '服务器名（唯一，字母/数字/下划线/短横线，≤32 字符；工具名会是 mcp__<它>__<工具>）',
                                hint: form.id
                                    ? '改名字会连工具名前缀一起改（mcp__旧名__x → mcp__新名__x），按旧名字记的逐工具开关会失效。'
                                    : null,
                            },
                                React.createElement(TextInput, {
                                    value: form.serverName,
                                    onChange: (v) => setForm({ ...form, serverName: v }),
                                })),
                            React.createElement(Field, { label: '传输方式' },
                                React.createElement('select', {
                                    style: S.input, value: form.transport,
                                    onChange: (e) => setForm({ ...form, transport: e.target.value }),
                                },
                                    React.createElement('option', { value: 'streamable-http' }, 'streamable-http（HTTP 地址）'),
                                    React.createElement('option', { value: 'stdio' }, 'stdio（本机起一个进程）'))),
                            form.transport === 'streamable-http'
                                ? React.createElement(React.Fragment, null,
                                    React.createElement(Field, { label: 'URL' },
                                        React.createElement(TextInput, {
                                            value: form.url,
                                            onChange: (v) => setForm({ ...form, url: v }),
                                            placeholder: 'https://example.com/mcp',
                                        })),
                                    React.createElement(Field, {
                                        label: '请求头（每行一条「名字: 值」）',
                                        hint: 'Authorization 这类密钥会明文写进补丁文件——别把补丁文件发给别人。',
                                    },
                                        React.createElement(TextArea, {
                                            value: form.headers,
                                            onChange: (v) => setForm({ ...form, headers: v }),
                                            rows: 3,
                                            mono: true,
                                            style: { minHeight: 76 },
                                        })))
                                : React.createElement(React.Fragment, null,
                                    React.createElement(Field, { label: '命令' },
                                        React.createElement(TextInput, {
                                            value: form.command,
                                            onChange: (v) => setForm({ ...form, command: v }),
                                            placeholder: 'npx',
                                        })),
                                    React.createElement(Field, { label: '参数（每行一个）' },
                                        React.createElement(TextArea, {
                                            value: form.args,
                                            onChange: (v) => setForm({ ...form, args: v }),
                                            rows: 3,
                                            mono: true,
                                            style: { minHeight: 76 },
                                        })),
                                    React.createElement(Field, { label: '环境变量（每行一条「名字: 值」）' },
                                        React.createElement(TextArea, {
                                            value: form.env,
                                            onChange: (v) => setForm({ ...form, env: v }),
                                            rows: 3,
                                            mono: true,
                                            style: { minHeight: 76 },
                                        })),
                                    React.createElement(Field, { label: '工作目录（可留空）' },
                                        React.createElement(TextInput, {
                                            value: form.cwd,
                                            onChange: (v) => setForm({ ...form, cwd: v }),
                                        }))),
                            React.createElement('div', { style: { ...S.muted, marginBottom: 10 } },
                                '连接器写在全局补丁里，所有 profile 共用；'
                                + '启用 = 默认启用；具体哪个预设用哪些工具，去「预设」页挑。'),
                            React.createElement(Checkbox, {
                                checked: form.disabled === true,
                                onChange: (v) => setForm({ ...form, disabled: v }),
                                label: '新建后先停用（写 disabled: true，宿主不会挂它）',
                            }),
                            React.createElement('div', { style: { ...S.row, marginTop: 12 } },
                                btn('保存', saveForm, true),
                                btn('取消', () => setForm(null)),
                                busy === 'save' ? React.createElement('span', { style: S.muted }, '写入补丁…') : null)))
                    : null)
        }

        // ——————————————————— 预设页 ———————————————————
        function ScenePage({ reloadToken, onChanged, sessionId, cwd }) {
            const [list, setList] = useState(null)
            const [personas, setPersonas] = useState([])
            const [toolOptions, setToolOptions] = useState([])
            /** tools-list 的原始分组 —— 段落要按「挂在哪组工具下」找归属。 */
            const [toolGroups, setToolGroups] = useState([])
            const [skillOptions, setSkillOptions] = useState([])
            const [sectionOptions, setSectionOptions] = useState([])
            /** 全量段落（含已关联工具的）—— 只用来把存量预设里存下的名单还原成勾选。 */
            const [allSectionOptions, setAllSectionOptions] = useState([])
            /** 插件卡要用的原始段落 / 技能（带归属包名，才能挂到插件底下）。 */
            const [pickerSections, setPickerSections] = useState([])
            const [pickerSkills, setPickerSkills] = useState([])
            const [sectionMeta, setSectionMeta] = useState({})

            /** 上一次装配里没出现的段落（且没有覆写的才算「可清」）。 */
            const [staleCount, setStaleCount] = useState(0)
            // 正在覆写的段落：{ name, text, original }
            const [current, setCurrent] = useState(null)
            const [form, setForm] = useState(null)
            const [error, setError] = useState('')
            const [busy, setBusy] = useState(false)

            /** 宿主的 Agent 预设：花名册 + 本会话当前跑的是哪套。 */
            const [presetInfo, setPresetInfo] = useState(null)
            /** 每套 Agent 预设挂了哪些插件（模式卡用它算「这套预设带哪些工具」）。 */
            const [presetComp, setPresetComp] = useState([])
            /** 模式匹配引擎（编辑器与列表卡的标签共用；数据没到齐前为 null）。 */
            const [modeIndex, setModeIndex] = useState(null)

            const load = useCallback(async () => {
                setError('')
                try {
                    const [scenes, ps, tl, sk, sec, pl, pc, pcomp] = await Promise.all([
                        apiCall('scene-list', {}),
                        apiCall('persona-list', {}),
                        // scopeAll：预设是跨会话的资产，候选集取全量，别被「当前会话
                        // 看得见什么」限制住（否则满屏「不在当前列表里」）。
                        apiCall('tools-list', { sessionId: sessionId ?? '', scopeAll: true }),
                        apiCall('skill-list', { sessionId: sessionId ?? '', cwd: cwd ?? '', scopeAll: true }),
                        apiCall('sections-list', {}),
                        // 宿主级 Agent 预设：只读花名册。没装注册表的宿主返回 available:false。
                        apiCall('preset-list', {}).catch(() => ({ available: false, presets: [] })),
                        sessionId
                            ? apiCall('preset-current', { sessionId }).catch(() => null)
                            : Promise.resolve(null),
                        // 插件组成：模式卡拿它算「点这套会勾上哪些工具」。
                        apiCall('preset-composition', {}).catch(() => ({ presets: [] })),
                    ])
                    setPresetComp(pcomp?.presets ?? [])
                    setPresetInfo(pl?.available
                        ? { ...pl, current: pc?.preset ?? null }
                        : null)
                    setList(scenes.scenes ?? [])
                    setPersonas(ps.personas ?? [])
                    // 归属者也能起备注名（插件页「备注名」那一栏）：这里的分组标题跟着用
                    // 备注名，真名退到括号里。先把 owner→备注名 建成映射，段落分组也复用。
                    const ownerNote = new Map()
                    for (const g of (tl.groups ?? [])) {
                        if (g.note) ownerNote.set(g.owner, g.note)
                    }
                    const tOpts = []
                    for (const g of (tl.groups ?? [])) {
                        for (const t of (g.tools ?? [])) {
                            tOpts.push({
                                value: t.name,
                                label: t.alias || t.name,
                                // 系统插件那群工具**在不在**是 Agent 预设定的；这里能改的
                                // 只是「这次会话要不要收窄」。写进分组名，免得被当成开关。
                                top: g.category === 'system'
                                    ? `${g.categoryLabel || '系统工具'}（存在与否看 Agent 预设）`
                                    : (g.categoryLabel || '其他工具'),
                                group: g.owner || '',
                                groupLabel: g.note || g.owner || '',
                                // 卡片按插件归堆时要区分 MCP：MCP 工具不归 Agent 预设管。
                                category: g.category || 'other',
                            })
                        }
                    }
                    setToolOptions(tOpts)
                    setToolGroups(tl.groups ?? [])
                    setPickerSections(sec.sections ?? [])
                    // 列表卡上的模式标签要和编辑器算的一样 —— 灌同一份原始数据进去。
                    setModeIndex(buildModeIndex({
                        toolOptions: tOpts,
                        groups: tl.groups ?? [],
                        sections: sec.sections ?? [],
                        presets: pcomp?.presets ?? [],
                    }))
                    setPickerSkills(sk.skills ?? [])
                    // 插件技能、内置技能都挂到各自的插件卡底下去了；这里只留用户技能。
                    setSkillOptions((sk.skills ?? [])
                        .filter((x) => (x.origin?.bucket ?? 'other') === 'other')
                        .map((x) => ({
                            value: x.name, label: x.name, top: '用户技能', group: '',
                        })))
                    // 段落只有名字可靠（宿主不给归属）：owner 取名字冒号前的那截当分组。
                    // 来源（插件 / 文件 / 行号）是插件扫源码反查出来的，可能为 null。
                    const meta = {}
                    for (const x of (sec.sections ?? [])) {
                        meta[x.name] = x
                    }
                    setSectionMeta(meta)
                    setStaleCount((sec.sections ?? []).filter((x) => x.stale && !(x.override && x.override !== '')).length)
                    const allOpts = (sec.sections ?? []).map((x) => ({
                        value: x.name, label: x.name, top: '系统提示词段落', group: x.owner || '来源不明',
                        groupLabel: ownerNote.get(x.owner) || x.owner || '来源不明',
                    }))
                    setAllSectionOptions(allOpts)
                    // 已经关联到工具（或默认关联插件）的段落不进这个名单：
                    // 它们跟工具开关走，预设里再挑一遍就是第二份真相。
                    const bound = new Set()
                    for (const g of (tl.groups ?? [])) {
                        for (const x of (g.sections ?? [])) {
                            bound.add(x.name)
                        }
                    }
                    setSectionOptions(allOpts.filter((o) => !bound.has(o.value)))
                }
                catch (e) { setError(String(e.message ?? e)) }
            }, [])

            useEffect(() => { load() }, [load, reloadToken, sessionId, cwd])

            /**
             * 从一份预设记录还原出界面上的三本停用账（工具 / 提示词段落 / 技能）。
             * 打开和保存后都要用它：保存后如果把账清空，界面会一瞬间变成「全选」，
             * 看着像把整份预设重置了，其实只是账没还原。
             */
            const ledgersOf = (scene) => ({
                toolOff: denyOf(scene?.toolFilter, toolOptions),
                skillsOff: denyOf(scene?.skills, skillOptions),
                // 用全量还原：存量预设里可能存了「已关联工具」的段落名，
                // 拿过滤后的名单算会把它们静默丢掉。
                sectionsOff: denyOf(scene?.sectionFilter, allSectionOptions)
                    .filter((n) => !isAlwaysOnSection(n)),
                // 没有这个字段的预设当成「默认激活」，保持它原来的行为。
                newToolsActive: scene?.toolFilter?.newToolsActive !== false,
            })

            const open = async (id) => {
                setError('')
                try {
                    if (!id) {
                        setCurrent(null)
                        setForm({ id: '', name: '', description: '', persona: '', toolOff: [], skillsOff: [], sectionsOff: [], newToolsActive: true })
                        return
                    }
                    const res = await apiCall('scene-read', { id })
                    setCurrent(res.scene)
                    setForm({ ...res.scene, ...ledgersOf(res.scene) })
                }
                catch (e) { setError(String(e.message ?? e)) }
            }

            const save = async () => {
                setBusy(true); setError('')
                try {
                    const res = await apiCall('scene-save', {
                        id: form.id || undefined,
                        name: form.name,
                        description: form.description,
                        persona: form.persona || null,
                        toolFilter: ((form.toolOff ?? []).length || form.newToolsActive === false)
                            ? { mode: 'deny', names: form.toolOff ?? [], newToolsActive: form.newToolsActive !== false }
                            : undefined,
                        skills: (form.skillsOff ?? []).length ? { mode: 'deny', names: form.skillsOff } : undefined,
                        sectionFilter: (form.sectionsOff ?? []).length ? { mode: 'deny', names: form.sectionsOff } : undefined,
                        permission: form.permission || null,
                    })
                    setCurrent(res.scene)
                    // 保存后按落盘的那份还原停用账：清空会让界面一瞬间变成「全选」，
                    // 看着像把这份预设整个重置了，其实只是没把账读回来。
                    setForm({ ...res.scene, ...ledgersOf(res.scene) })
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            const del = async () => {
                if (!current) return
                setBusy(true); setError('')
                try {
                    await apiCall('scene-delete', { id: current.id })
                    setCurrent(null); setForm(null)
                    await load()
                    onChanged?.()
                }
                catch (e) { setError(String(e.message ?? e)) }
                finally { setBusy(false) }
            }

            if (!list) return React.createElement('div', { style: S.page }, React.createElement(Loading, null))

            const personaNameOf = (id) => {
                if (!id) return ''
                const hit = personas.find((p) => p.id === id)
                return hit ? (hit.name || hit.id) : id
            }
            const permissionLabel = (v) => (v
                ? (PERMISSION_CHOICES.find((p) => p.value === v)?.label ?? v)
                : '')

            /** 一套预设（和插件页 / MCP 页 / 技能页同一套卡片）。 */
            const card = (sc) => {
                const chips = []
                if (sc.permission) chips.push(miniChip(permissionLabel(sc.permission), C.warn))
                if (sc.toolFilter?.newToolsActive === false) chips.push(miniChip('新工具默认停用', C.accent))
                // 第三枚：这套预设对应哪种模式。停用名单恰好等于某套 Agent 预设的推算结果
                // 才是那套，差一项就是「自定义模式」—— 跟编辑器里的模式卡同一个引擎。
                if (modeIndex && modeIndex.hasPresets) {
                    const mode = modeIndex.modeOf({
                        toolOff: sc.toolFilter?.names ?? [],
                        sectionsOff: sc.sectionFilter?.names ?? [],
                    })
                    chips.push(miniChip(AGENT_PRESET_LABEL[mode] || '自定义模式',
                        mode === 'custom' ? C.dim : C.success))
                }
                return EntityCard({
                    key: sc.id,
                    avatar: React.createElement(SkillAvatar, { name: sc.name || sc.id, size: 26 }),
                    title: sc.name || sc.id,
                    titleAttr: sc.description || '',
                    desc: String(sc.description ?? '').trim() || '（没写说明）',
                    descMinHeight: 42,
                    // 标签不挤在标题右边（标题一长就被压掉），放到简介下面那一行。
                    meta: chips.length ? chips : null,
                    onClick: () => open(sc.id),
                    extra: React.createElement('div', {
                        // 没有脚注行了，让按钮自己贴到卡片底部，几张卡并排时才对得齐。
                        style: { ...S.row, gap: 4, flexWrap: 'nowrap', marginTop: 'auto' },
                    },
                        btn('编辑', (e) => { e?.stopPropagation?.(); open(sc.id) }),
                        btn('删除', (e) => {
                            e?.stopPropagation?.()
                            if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                                && !window.confirm(`删掉预设「${sc.name || sc.id}」？`)) return
                            setBusy(true)
                            apiCall('scene-delete', { id: sc.id })
                                .then(() => load())
                                .then(() => onChanged?.())
                                .catch((err) => setError(String(err.message ?? err)))
                                .finally(() => setBusy(false))
                        })),
                })
            }

            return React.createElement('div', { style: S.page },
                React.createElement(ErrorBar, { error }),
                form ? null : React.createElement('div', { style: { ...S.row, marginBottom: 10 } },
                    btn('新建预设', () => open(''), true),
                    React.createElement('span', { style: S.muted },
                        `共 ${list.length} 套 · 预设 = 一份「用哪些工具 / 技能 / 提示词」的清单，绑到某层就生效`),
                    presetInfo?.current
                        ? miniChip(`本会话跑 ${AGENT_PRESET_LABEL[presetInfo.current] || presetInfo.current}`, C.accent)
                        : null),
                form ? null : (list.length === 0
                    ? React.createElement('div', { style: S.muted }, '还没有预设。点「新建预设」做一套。')
                    : React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } },
                        list.map((sc) => card(sc)))),
                form ? React.createElement(React.Fragment, null,
                    React.createElement(BackBar, {
                        label: '全部预设',
                        onClick: () => { setForm(null); setCurrent(null) },
                    }),
                    current
                        ? React.createElement('div', { style: { ...S.card, padding: 14, marginBottom: 12 } },
                            React.createElement('div', { style: { ...S.row, alignItems: 'center', gap: 8 } },
                                React.createElement(SkillAvatar, { name: current.name || current.id, size: 32 }),
                                React.createElement('span', { style: { fontSize: 15, fontWeight: 600 } },
                                    current.name || current.id),
                                current.permission
                                    ? miniChip(permissionLabel(current.permission), C.warn)
                                    : null,
                                current.toolFilter?.newToolsActive === false
                                    ? miniChip('新工具默认停用', C.accent)
                                    : null,
                                React.createElement('span', { style: { flex: 1 } }),
                                current.updatedAt
                                    ? React.createElement('span', { style: { ...S.muted, fontSize: 11.5 } },
                                        `改于 ${String(current.updatedAt).slice(0, 16).replace('T', ' ')}`)
                                    : null),
                            React.createElement('div', { style: { ...S.muted, fontSize: 12, marginTop: 6, wordBreak: 'break-all' } },
                                `id=${current.id}`),
                            React.createElement('div', { style: { ...S.muted, fontSize: 11.5, marginTop: 4 } },
                                [
                                    `关掉 ${(current.toolFilter?.names ?? []).length} 个工具`,
                                    `关 ${(current.skills?.names ?? []).length} 个技能`,
                                    `关 ${(current.sectionFilter?.names ?? []).length} 段提示词`,
                                    current.persona ? `角色卡「${personaNameOf(current.persona)}」` : '不指定角色卡',
                                ].join(' · ')))
                        : null,
                    React.createElement('div', { style: S.card },
                    React.createElement(Field, { label: 'id（留空自动生成）' },
                        React.createElement('input', {
                            style: S.input, value: form.id ?? '', disabled: Boolean(current),
                            onChange: (e) => setForm({ ...form, id: e.target.value }),
                        })),
                    React.createElement(Field, { label: '名称' },
                        React.createElement('input', {
                            style: S.input, value: form.name ?? '',
                            onChange: (e) => setForm({ ...form, name: e.target.value }),
                        })),
                    React.createElement(Field, { label: '说明' },
                        React.createElement('input', {
                            style: S.input, value: form.description ?? '',
                            onChange: (e) => setForm({ ...form, description: e.target.value }),
                        })),
                    React.createElement(Field, { label: '角色卡' },
                        React.createElement('select', {
                            style: S.input, value: form.persona ?? '',
                            onChange: (e) => setForm({ ...form, persona: e.target.value }),
                        }, React.createElement('option', { value: '' }, '（不指定）'),
                            personas.map((p) => React.createElement('option', { key: p.id, value: p.id }, p.name || p.id)))),
                    React.createElement(Field, {
                        label: '权限（切进这套预设时把会话的权限档位切过去；「不设」= 不动它）',
                    },
                        React.createElement('select', {
                            style: S.input, value: form.permission ?? '',
                            onChange: (e) => setForm({ ...form, permission: e.target.value }),
                        }, React.createElement('option', { value: '' }, '（不设 — 不动会话当前权限）'),
                            PERMISSION_CHOICES.map((p) => React.createElement('option', { key: p.value, value: p.value },
                                p.label)))),
                    React.createElement(Field, {
                        label: '新增的插件工具（这套预设保存之后才装进来的工具；选「停用」= 要在这里勾上才生效）',
                    },
                        React.createElement('select', {
                            style: S.input,
                            value: form.newToolsActive === false ? 'off' : 'active',
                            onChange: (e) => setForm({ ...form, newToolsActive: e.target.value !== 'off' }),
                        },
                            React.createElement('option', { value: 'active' }, '激活（默认）'),
                            React.createElement('option', { value: 'off' }, '停用'))),
                    React.createElement(Field, {
                        label: '插件与工具（勾着 = 生效；点插件卡头展开，插件带的提示词 / 工具 / 技能都在里头）',
                    },
                        React.createElement(PluginToolPicker, {
                            toolOptions,
                            groups: toolGroups,
                            sections: pickerSections,
                            skills: pickerSkills,
                            presets: presetComp,
                            toolOff: form.toolOff ?? [],
                            sectionsOff: form.sectionsOff ?? [],
                            skillsOff: form.skillsOff ?? [],
                            onChange: (v) => setForm({ ...form, ...v }),
                        }),

                    staleCount > 0
                        ? React.createElement('div', { style: { ...S.row, marginTop: 6, marginBottom: 10 } },
                            React.createElement('button', {
                                type: 'button',
                                style: { ...S.btn(false), fontSize: 12 },
                                disabled: busy,
                                onClick: async () => {
                                    const yes = typeof window.confirm === 'function'
                                        && window.confirm(
                                            `清理 ${staleCount} 条「上次装配里没出现」的段落条目？\n\n`
                                            + '只删目录里的记录，不动插件；下次它出现会重新记进来。带覆写的会保留。',
                                        );
                                    if (!yes) {
                                        return;
                                    }
                                    setBusy(true)
                                    setError('')
                                    try {
                                        const r = await apiCall('sections-prune', {})
                                        await load()
                                        if ((r.removed ?? []).length === 0) {
                                            setError('没有可清理的条目（都会在下次装配时重新出现）')
                                        }
                                    }
                                    catch (e) { setError(String(e.message ?? e)) }
                                    finally { setBusy(false) }
                                },
                            }, `清理未出现的段落条目（${staleCount}）`))
                        : null),
                    React.createElement('div', { style: S.row },
                        btn('保存', save, true),
                        current ? btn('删除', del) : null,
                        busy ? React.createElement('span', { style: S.muted }, '处理中…') : null)))
                    : null)
        }

        // ——————————————————— 侧栏图标 ———————————————————
        function PanelIcon() {
            return React.createElement('span', {
                title: '功能管理和预设',
                style: { fontSize: 15, lineHeight: 1, opacity: 0.85 },
            }, '◧')
        }

        // ——————————————————— 主页面 ———————————————————
        function ScopeManagerPage() {
            const [ctx, setCtx] = useState(null)
            const [tab, setTab] = useState('scope')
            const [reloadToken, setReloadToken] = useState(0)
            const [sessionCtx, setSessionCtx] = useState({ rows: [], current: null, cwds: [] })

            useEffect(() => {
                // 宿主的 client ctx 怎么拿：apply 里把 ctx 传进来，组件再从 props 拿。
                // 这里用模块级的 currentCtx（apply 时赋值）。
                setCtx(currentCtx)
            }, [])

            useEffect(() => {
                if (!ctx) return
                const update = () => setSessionCtx(readSessionContext(ctx))
                update()
                const timer = setInterval(update, 3000)
                return () => clearInterval(timer)
            }, [ctx])

            const refresh = () => setReloadToken((n) => n + 1)

            // 「预设」挨着「作用域」：作用域那边是给每一层挑一套预设，先看层级再改预设，顺序顺手。
            // MCP 这一页保留英文缩写：它就是 MCP 连接器本身，写「连接器」看不出是哪种连接器。
            const TABS = [
                { key: 'scope', label: '作用域' },
                { key: 'scenes', label: '预设' },
                { key: 'persona', label: '角色卡' },
                { key: 'tools', label: '插件' },
                { key: 'mcp', label: 'MCP' },
                { key: 'skills', label: '技能' },
            ]

            // 根容器必须撑满宿主给的这一列并自己滚：主槽外面是固定高度的
            // flex 容器（overflow:hidden），只写 minHeight:100% 的话内容一长就被裁掉，
            // 连滚动条都没有 —— 插件页那种长列表会卡在屏幕上出不来。
            return React.createElement('div', {
                style: {
                    display: 'flex', flexDirection: 'column',
                    height: '100%', minHeight: 0, flex: '1 1 auto',
                    background: C.bg, boxSizing: 'border-box',
                },
            },
                React.createElement('div', { style: { ...S.tabs, flexShrink: 0 } },
                    TABS.map((x) => React.createElement('div', {
                        key: x.key,
                        style: { ...S.tab(tab === x.key), ...opticalTab(x.label) },
                        onClick: () => setTab(x.key),
                    }, x.label))),
                React.createElement('div', {
                    style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
                },
                React.createElement(PageBoundary, { key: tab },
                    tab === 'scope' ? React.createElement(ScopePage, {
                        ctx, sessionCtx, reloadToken,
                    }) : null,
                    tab === 'persona' ? React.createElement(PersonaPage, { reloadToken, onChanged: refresh }) : null,
                    tab === 'tools' ? React.createElement(PluginPage, {
                        reloadToken, onChanged: refresh, sessionCtx,
                    }) : null,
                    tab === 'mcp' ? React.createElement(McpPage, {
                        reloadToken, onChanged: refresh,
                    }) : null,
                    tab === 'skills' ? React.createElement(SkillPage, {
                        cwd: sessionCtx.current?.cwd ?? '',
                        sessionId: sessionCtx.current?.id ?? '',
                        reloadToken,
                    }) : null,
                    tab === 'scenes' ? React.createElement(ScenePage, {
                        reloadToken, onChanged: refresh,
                        sessionId: sessionCtx.current?.id ?? '',
                        cwd: sessionCtx.current?.cwd ?? '',
                    }) : null)))
        }

        // ——————————————————— 会话侧边栏（右侧面板） ———————————————————
        // 会话级只读视图：这个会话眼下生效的预设/角色卡/权限/工具/提示词段落。
        // 数据全走已有的 scope-context + tools-list（都吃 sessionId），不另造接口。
        // 对话那一排页签里的一条（对话 / 轨迹 / … 后面）。
        const SESSION_VIEW = 'scm-session-view'

        function kvRow(key, value) {
            return React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 4, alignItems: 'baseline' } },
                React.createElement('span', { style: { ...S.muted, fontSize: 11.5, flex: '0 0 62px' } }, key),
                React.createElement('span', { style: { fontSize: 12.5, wordBreak: 'break-word', flex: 1 } }, value))
        }

        function block(title, children) {
            return React.createElement('div', { style: { ...S.card, marginBottom: 8, padding: 10 } },
                React.createElement('div', { style: { ...S.label, marginBottom: 6 } }, title),
                children)
        }

        /**
         * 会话现状：预设 / 角色卡 / 权限 / 工具 / 系统提示词。
         * 数据只走已有的 scope-context 与 tools-list（都吃 sessionId）。
         */
        function SessionInfoContent(props) {
            const sessionId = String(props.sessionId ?? '')
            const dense = props.dense === true
            const [data, setData] = useState({ loading: true, error: '', scope: null, groups: [], catalog: [] })
            const [openOwners, setOpenOwners] = useState({})

            const load = useCallback(async () => {
                if (!sessionId) {
                    setData({ loading: false, error: '', scope: null, groups: [] })
                    return
                }
                setData((prev) => ({ ...prev, loading: true, error: '' }))
                try {
                    const [scope, tools, catalog] = await Promise.all([
                        apiCall('scope-context', { sessionId }),
                        apiCall('tools-list', { sessionId }),
                        apiCall('sections-list'),
                    ])
                    setData({
                        loading: false, error: '', scope,
                        groups: tools.groups ?? [],
                        catalog: catalog?.sections ?? [],
                    })
                }
                catch (err) {
                    setData({ loading: false, error: String(err?.message ?? err), scope: null, groups: [] })
                }
            }, [sessionId])

            useEffect(() => { load() }, [load])

            const effective = data.scope?.effective ?? null
            const groups = (data.groups ?? []).filter((g) => (g.tools ?? []).length > 0)
            const tools = (data.groups ?? []).flatMap((g) => g.tools ?? [])
            const sections = (data.groups ?? []).flatMap((g) => g.sections ?? [])
            const injected = sections.filter((x) => x.injected !== false).length
            const catCount = {}
            for (const g of groups) {
                const label = g.categoryLabel ?? g.category
                catCount[label] = (catCount[label] ?? 0) + g.tools.length
            }
            const persona = effective?.persona ?? null

            const personaNodes = []
            if (persona) {
                personaNodes.push(kvRow('名称', persona.name))
                personaNodes.push(kvRow('注入', persona.inject === 'system' ? '系统提示词覆盖' : '角色卡上下文'))
                if (persona.source) {
                    personaNodes.push(kvRow('来源', persona.source))
                }
                for (const [label, text] of [['世界观', persona.worldview], ['角色设定', persona.character], ['行为约束', persona.constraints]]) {
                    personaNodes.push(React.createElement('div', { key: label, style: { marginTop: 6 } },
                        React.createElement('div', { style: { ...S.muted, fontSize: 11 } }, label),
                        React.createElement('div', {
                            style: {
                                whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12,
                                maxHeight: dense ? 88 : 160, overflow: 'auto', marginTop: 2,
                            },
                        }, String(text ?? '').trim() || '（空）')))
                }
            }
            else {
                personaNodes.push(React.createElement('span', { key: 'none', style: S.muted }, '（未绑）'))
            }

            // 先按三大类分开，再在类里按归属者折叠：不分的话「系统/插件/MCP」
            // 三种来源的包名混在一列里，看不出谁是谁。
            const CATEGORY_ORDER = ['system', 'plugin', 'mcp']
            const toolNodes = []
            if (tools.length === 0) {
                toolNodes.push(React.createElement('span', { key: 'none', style: S.muted }, '（这个会话没有可见工具）'))
            }
            for (const category of CATEGORY_ORDER) {
                const inCategory = groups.filter((g) => g.category === category)
                if (inCategory.length === 0) {
                    continue
                }
                const count = inCategory.reduce((sum, g) => sum + g.tools.length, 0)
                toolNodes.push(React.createElement('div', {
                    key: `cat:${category}`,
                    style: { ...S.label, margin: '10px 0 2px', fontSize: 12 },
                }, `${inCategory[0].categoryLabel ?? category} · ${count} 个`))
                for (const g of inCategory) {
                    const key = `${g.category}::${g.owner}`
                    const open = openOwners[key] === true
                    toolNodes.push(React.createElement('div', { key, style: { marginTop: 2 } },
                        React.createElement('button', {
                            type: 'button',
                            style: { ...S.btn(false), padding: '1px 6px', fontSize: 11.5 },
                            onClick: () => { setOpenOwners((prev) => ({ ...prev, [key]: !open })) },
                        }, `${open ? '▾' : '▸'} ${g.owner} · ${g.tools.length}`)))
                    if (open) {
                        toolNodes.push(React.createElement('div', {
                            key: `${key}:list`,
                            style: dense
                                ? { margin: '3px 0 6px 10px' }
                                : { margin: '4px 0 8px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 2 },
                        }, g.tools.map((tool) => React.createElement('div', {
                            key: tool.name,
                            style: { ...S.muted, fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace' },
                        }, tool.name))))
                    }
                }
            }

            // 完整提示词构成：按宿主真实顺序（position）把每段摊开，原文照抄。
            // 只看名字看不出版面，用户要的是「模型到底读到了什么」。
            const injectedByName = new Map()
            for (const sec of sections) {
                injectedByName.set(sec.name, sec.injected !== false)
            }
            const orderedSections = [...(data.catalog ?? [])].sort((a, b) => {
                const pa = Number(a.position) > 0 ? Number(a.position) : 1e6
                const pb = Number(b.position) > 0 ? Number(b.position) : 1e6
                return pa - pb
            })
            const emptyCount = orderedSections.filter((sec) => String(sec.text ?? '').length === 0).length
            const injectedCount = orderedSections.filter((sec) => String(sec.text ?? '').length > 0
                && injectedByName.get(sec.name) !== false).length
            const mono = 'ui-monospace, Menlo, monospace'
            const sectionNodes = orderedSections.map((sec, index) => {
                const text = String(sec.text ?? '')
                // 空段宿主会在 renderPrompt 里整段丢掉，标成「空段」比标「注入」准。
                const empty = text.length === 0
                const on = !empty && injectedByName.get(sec.name) !== false
                return React.createElement('div', { key: sec.name, style: { marginTop: 10 } },
                    React.createElement('div', { style: { ...S.row, gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
                        React.createElement('span', { style: { fontWeight: 600, fontSize: 12 } },
                            `${sec.position ?? index + 1}. ${sec.name}`),
                        sec.pinned ? React.createElement('span', { style: S.chip('') }, '固定') : null,
                        React.createElement('span', { style: { ...S.muted, fontSize: 11 } },
                            `${text.length} 字`),
                        React.createElement('span', {
                            style: {
                                fontSize: 10.5, padding: '0 5px', borderRadius: 4,
                                background: on ? 'rgba(31,122,63,0.10)' : 'rgba(0,0,0,0.06)',
                                color: on ? '#1f7a3f' : '#777',
                            },
                        }, empty ? '空段' : (on ? '注入' : '关闭'))),
                    React.createElement('div', { style: { ...S.muted, fontSize: 10.5, fontFamily: mono } },
                        sec.pinnedOwner && sec.plugin === sec.pinnedOwner
                            ? `归属 ${sec.plugin}（手动指定）`
                            : sec.plugin ? `来源 ${sec.plugin}${sec.line ? ':' + sec.line : ''}` : '来源不明'),
                    React.createElement('pre', {
                        style: {
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: mono,
                            fontSize: 11.5, lineHeight: 1.55, margin: '4px 0 0',
                            padding: '8px 10px', borderRadius: 6,
                            background: 'rgba(0,0,0,0.035)', maxHeight: 320, overflow: 'auto',
                            opacity: on ? 1 : 0.55,
                        },
                    }, text.length > 0 ? text : '（空段，宿主会整段丢掉）'))
            })

            return React.createElement('div', null,
                React.createElement('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: 8 } },
                    React.createElement('span', { style: { ...S.label, marginBottom: 0 } }, '会话信息'),
                    React.createElement('button', {
                        type: 'button', style: S.btn(false), onClick: () => { load() },
                        title: '重新读一次这个会话的现状',
                    }, data.loading ? '读取中…' : '刷新')),
                data.error ? React.createElement('div', { style: { ...S.card, padding: 10, color: '#b42318' } }, data.error) : null,
                !sessionId ? React.createElement('div', { style: S.muted }, '没有选中的会话。') : null,
                block('预设',
                    React.createElement('div', null,
                        kvRow('名称', effective?.scene?.name ?? '（未绑）'),
                        effective?.scene?.source ? kvRow('来源', effective.scene.source) : null)),
                block('角色卡', React.createElement('div', null, personaNodes)),
                block('权限',
                    React.createElement('div', null,
                        kvRow('当前', effective?.permission?.label ?? '（默认）'),
                        effective?.permission?.source ? kvRow('来源', effective.permission.source) : null)),
                block(`工具（${tools.length}）`, React.createElement('div', null, toolNodes)),
                block(`系统提示词（${sections.length} 段 · ${injectedCount} 注入）`,
                    React.createElement('div', null,
                        kvRow('注入', `${injectedCount} 段`),
                        kvRow('停用', `${sections.length - injectedCount - emptyCount} 段`),
                        emptyCount > 0 ? kvRow('空段', `${emptyCount} 段（宿主丢弃）`) : null,
                        effective?.sectionFilter
                            ? kvRow('名单', `${effective.sectionFilter.mode === 'allow' ? '仅注入' : '屏蔽'} · ${effective.sectionFilter.source ?? ''}`)
                            : null,
                        React.createElement('div', { style: { ...S.muted, fontSize: 11, marginTop: 8 } },
                            '下面是模型实际读到的完整提示词，按宿主装配顺序排列。'),
                        sectionNodes)))
        }

        /** 会话主区页签里的那版：宽，摊开。 */
        function SessionInfoView(props) {
            // 底部留一截：这一页占的是会话主区，输入框浮在下面，
            // 不留白的话最后几行会被输入框压住。
            return React.createElement('div', { style: { height: '100%', overflow: 'auto', padding: '18px 24px 132px' } },
                React.createElement('div', { style: { maxWidth: 900, margin: '0 auto', fontSize: 13 } },
                    React.createElement(SessionInfoContent, { sessionId: props.sessionId })))
        }

        // ——————————————————— @mcp: 输入补全 ———————————————————
        // 宿主那边认的是正文里的 `@mcp:服务名`（见 lib/mcp-gesture.js）。这里做的事很窄：
        // 在输入框敲 `@` 时，把 MCP 连接器也列进候选，选中就**插一段纯文本**。
        // 不注册成引用块（reference）：那会被渲染成 chip、序列化时还要走 codec，
        // 而宿主只认字面文本 —— 越简单越不会错。

        /** 连接器清单的短缓存：每敲一个字符都问一次接口太浪费。 */
        let mcpSourceCache = { at: 0, servers: [] };
        const MCP_SOURCE_TTL = 5000;

        async function mcpSourceServers() {
            const now = Date.now();
            if (now - mcpSourceCache.at < MCP_SOURCE_TTL) {
                return mcpSourceCache.servers;
            }
            try {
                const data = await apiCall('mcp-list', {});
                const servers = Array.isArray(data?.servers) ? data.servers : [];
                mcpSourceCache = { at: now, servers };
                return servers;
            }
            catch {
                // 接口挂了不该让 `@` 菜单整个空掉：沿用上一次拿到的清单。
                mcpSourceCache = { at: now, servers: mcpSourceCache.servers };
                return mcpSourceCache.servers;
            }
        }

        function mcpServiceSource() {
            return {
                trigger: '@',
                name: 'mcp-service',
                // 排在文件/会话后面：用户敲 @ 最常见的还是找文件。
                order: 50,
                showGroupTitle: false,
                async candidates(_session, req) {
                    if (req?.quoted === true) {
                        return [];
                    }
                    const servers = await mcpSourceServers();
                    if (req?.signal?.aborted) {
                        return [];
                    }
                    // 已经写到 `@mcp:xxx` 时，query 整段是 `mcp:xxx`，得先把前缀剥掉再比。
                    const raw = String(req?.query ?? '').trim();
                    const needle = (raw.toLowerCase().startsWith('mcp:') ? raw.slice(4) : raw).trim().toLowerCase();
                    return servers
                        .map((server) => {
                            // 停用的服务列出来也选不中（宿主那边不会解锁），干脆不占位。
                            if (server?.disabled === true) {
                                return null;
                            }
                            const serverName = String(server?.serverName ?? '');
                            if (serverName === '') {
                                return null;
                            }
                            const display = String(server?.name ?? '').trim() || serverName;
                            const tools = Number(server?.toolCount ?? 0);
                            const state = server?.statusText ?? '';
                            const desc = [`@mcp:${serverName}`, `${tools} 个工具`, state].filter(Boolean).join(' · ');
                            return {
                                name: display,
                                description: desc,
                                section: 'MCP 服务',
                                value: serverName,
                            };
                        })
                        .filter((row) => row !== null)
                        .filter((row) => needle === ''
                            || row.name.toLowerCase().includes(needle)
                            || String(row.value).toLowerCase().includes(needle))
                        .sort((a, b) => a.name.localeCompare(b.name));
                },
                onPick({ candidate }) {
                    const serverName = String(candidate?.value ?? '');
                    if (serverName === '') {
                        return undefined;
                    }
                    // 末尾留一个空格：接着就能写「查一下……」。
                    return { text: `@mcp:${serverName} ` };
                },
            };
        }

        // ——————————————————— @技能名 输入补全 ———————————————————
        // 宿主侧（lib/at-skill.js）在 pre-step 把 `@技能名` 翻成 `/技能名` 再交给技能插件，
        // 所以这里同样只插纯文本，跟手打 `/名` 走的是同一条路。

        /** 技能清单的短缓存：按会话取，同一会话里 5 秒内不重复问。 */
        let skillSourceCache = { at: 0, sessionId: '', skills: [] };
        const SKILL_SOURCE_TTL = 5000;

        async function skillSourceRows(sessionId) {
            const now = Date.now();
            const key = String(sessionId ?? '');
            if (skillSourceCache.sessionId === key && now - skillSourceCache.at < SKILL_SOURCE_TTL) {
                return skillSourceCache.skills;
            }
            try {
                const data = await apiCall('skill-list', { sessionId: key });
                const skills = (Array.isArray(data?.skills) ? data.skills : [])
                    .filter((sk) => sk?.userInvocable !== false);
                skillSourceCache = { at: now, sessionId: key, skills };
                return skills;
            }
            catch {
                // 接口挂了沿用上一次：`@` 菜单不该因为技能表读不到就整个空掉。
                return skillSourceCache.sessionId === key ? skillSourceCache.skills : [];
            }
        }

        function skillSource() {
            return {
                trigger: '@',
                name: 'skill',
                // 排在文件之后、MCP 之前：找技能比找服务更常见。
                order: 20,
                showGroupTitle: false,
                async candidates(session, req) {
                    if (req?.quoted === true) {
                        return [];
                    }
                    // 用户已经在写给 MCP 的手势了，就别再塞技能进来凑热闹。
                    const raw = String(req?.query ?? '').trim();
                    if (raw.toLowerCase().startsWith('mcp:')) {
                        return [];
                    }
                    const skills = await skillSourceRows(session?.sessionId);
                    if (req?.signal?.aborted) {
                        return [];
                    }
                    const needle = raw.toLowerCase();
                    return skills
                        .map((sk) => {
                            const name = String(sk?.name ?? '');
                            if (name === '') {
                                return null;
                            }
                            const sourceLabel = String(sk?.sourceLabel ?? '').trim();
                            const desc = String(sk?.description ?? '').trim();
                            return {
                                name,
                                description: [sourceLabel, desc].filter(Boolean).join(' · '),
                                section: '技能',
                                value: name,
                            };
                        })
                        .filter((row) => row !== null)
                        .filter((row) => needle === ''
                            || row.name.toLowerCase().includes(needle)
                            || row.description.toLowerCase().includes(needle))
                        .sort((a, b) => a.name.localeCompare(b.name));
                },
                onPick({ candidate }) {
                    const name = String(candidate?.value ?? '');
                    if (name === '') {
                        return undefined;
                    }
                    return { text: `@${name} ` };
                },
            };
        }

        // ——————————————————— 装配 ———————————————————
        // apply 收到的 client ctx 存在模块级变量里，页面组件通过它取宿主能力
        // （slots / locale / sessions）。静态 client 模块里这是标准做法。
        var currentCtx = null

        function apply(ctx) {
            currentCtx = ctx
            // 必须写进 inject：cordis 的 ctx.get 只认「注入过的服务名」，
            // 不声明就永远拿到 undefined（不是抛错）。`@` 补全依赖它。
            const inputTriggers = ctx.get('inputTriggers')
            if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
                try {
                    ctx.effect(() => {
                        const disposers = [
                            inputTriggers.registerSource(mcpServiceSource()),
                            inputTriggers.registerSource(skillSource()),
                        ]
                        return () => {
                            for (const off of disposers) {
                                try {
                                    if (typeof off === 'function') {
                                        off()
                                    }
                                }
                                catch {
                                    /* 单个注销失败不影响其它的 */
                                }
                            }
                        }
                    }, 'scope-manager: @ 候选（技能 / MCP 服务）')
                }
                catch (err) {
                    console.warn('[scope-manager] @mcp 候选注册失败：' + String(err && err.message))
                }
            }
            const slots = ctx.get('slots')
            if (!slots) {
                return
            }
            // 两个槽同一个 id：左栏那行点了才有地方去。
            slots.inject('main', function () {
                return slots.register({ name: 'main', key: PANEL_ID }, ScopeManagerPage)
            })
            slots.inject('sidebar.panellist', function () {
                return slots.register({
                    name: 'sidebar.panellist', id: PANEL_ID, order: 20,
                    label: function () { return '功能管理和预设' }, locale: NS,
                }, PanelIcon)
            })

            // 会话标题下面那排页签（对话 / 轨迹 / …）。照 dsh-bili-scroll 的写法：
            // 先在外层 slots 上 inject 这个槽，再在回调里 register；直接在别处
            // register 会抛 `slot "conversation.view" is not declared`。
            try {
                slots.inject('conversation.view', function () {
                    return slots.register({
                        name: 'conversation.view',
                        id: SESSION_VIEW,
                        order: 15,
                        label: function () { return '会话信息' },
                        scope: 'session',
                    }, SessionInfoView)
                })
            }
            catch (err) {
                console.warn('[scope-manager] 会话页签注册失败：' + String(err && err.message))
            }
        }

        exports.NS = NS
        exports.PANEL_ID = PANEL_ID
        exports.apply = apply
        // `sessions` 必须写进 inject：cordis 里没声明的服务直接读会抛
        // "cannot get property X without inject"，被 try/catch 吞掉就成了「读不到」。
        exports.inject = ['slots', 'sessions', 'workspaces', 'inputTriggers']
        return module.exports
    }
})
