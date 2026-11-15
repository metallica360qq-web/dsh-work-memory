/**
 * 会话视图插件的离线渲染自检（两遍归纳后的两层结构）。
 *
 * 用法：node scripts/render-test.mjs
 * 覆盖：宽类方块 → 细线清单 → 细类星图（会话/钩子）→ 展开原文/打开会话；
 *       含代理自产开关；单钩子会话退化成列表；未打标散点；会话徽章与产物跳转。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'lib', 'client.js')

// ── 最小 React 垫片 ─────────────────────────────────────────────────────────
let slots = []
let cursor = 0
let pendingEffects = []
let dirty = false
const depsEqual = (left, right) => {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
  return true
}
const React = {
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState(initial) {
    const i = cursor++
    if (slots[i] === undefined) {
      const entry = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      entry.setter = (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next
        if (entry.value !== value) { entry.value = value; dirty = true }
      }
      slots[i] = entry
    }
    return [slots[i].value, slots[i].setter]
  },
  useCallback(fn, deps) {
    const i = cursor++
    if (slots[i] === undefined) { slots[i] = { kind: 'cb', fn, deps }; return fn }
    if (!depsEqual(slots[i].deps, deps)) { slots[i].fn = fn; slots[i].deps = deps }
    return slots[i].fn
  },
  useMemo(factory, deps) {
    const i = cursor++
    if (slots[i] === undefined || !depsEqual(slots[i].deps, deps)) slots[i] = { kind: 'memo', value: factory(), deps }
    return slots[i].value
  },
  useEffect(fn, deps) {
    const i = cursor++
    if (slots[i] === undefined) { slots[i] = { kind: 'effect', deps }; pendingEffects.push({ i, fn }); return }
    if (!depsEqual(slots[i].deps, deps)) { slots[i].deps = deps; pendingEffects.push({ i, fn }) }
  },
  useRef(value) { const i = cursor++; if (slots[i] === undefined) slots[i] = { current: value }; return slots[i] },
  useSyncExternalStore(_subscribe, getSnapshot) { cursor++; return getSnapshot() },
}
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}

let captured
globalThis.window = { __ModuleLoader__: { load: (value) => { captured = value } } }
try {
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
} finally {
  delete globalThis.window
}
const loaded = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

// ── 假数据 ──────────────────────────────────────────────────────────────────
const NOW = Date.now()
const list = {
  ids: ['session-a', 'session-b', 'session-c'],
  byId: {
    'session-a': { id: 'session-a', displayTitle: '修复上传失败', cwd: 'D:\\工作文件夹\\proj-a', updatedAt: NOW - 60_000, running: true, blank: false, retainedBy: { mainView: 1 } },
    'session-b': { id: 'session-b', displayTitle: '量化回测', cwd: 'D:\\工作文件夹\\proj-a', updatedAt: NOW - 600_000, running: false, blank: false, retainedBy: {} },
    'session-c': { id: 'session-c', displayTitle: '旧归档会话', cwd: 'D:\\工作文件夹\\proj-b', updatedAt: NOW - 90_000_000, running: false, blank: false, retainedBy: {} },
  },
  phase: 'ready',
}
const workspaceSnapshot = {
  items: [
    { workspaceId: 'ws1', title: '项目 A', path: 'D:\\工作文件夹\\proj-a', sessionIds: ['session-a', 'session-b'] },
    { workspaceId: 'ws2', title: '项目 B', path: 'D:\\工作文件夹\\proj-b', sessionIds: ['session-c'] },
  ],
  archivedSessionIds: ['session-c'],
  pinnedSessionIds: ['session-b'],
}
const snapshot = {
  ok: true,
  generatedAt: '2026-11-14T12:00:00.000Z',
  source: { dir: 'C:/wm', file: 'C:/wm/hooks.jsonl', missing: false, badLines: 0, size: 100, mtimeMs: NOW - 60_000 },
  topics: [
    { id: 'g05', name: 'DSH桌面应用与插件生态', desc: '插件体系', keywords: ['dsh'] },
    { id: 'g08', name: 'PPT与宣传内容制作', desc: '短视频', keywords: ['抖音'] },
    { id: 'g04', name: '量化交易Agent开发', desc: '策略与回测', keywords: ['回测'] },
  ],
  fine: [
    { id: 'i01', name: '会话视图插件开发', desc: '', group: 'g05' },
    { id: 'i02', name: 'zcode 插件笔记', desc: '', group: 'g05' },
    { id: 'i03', name: '抖音 005 制作', desc: '', group: 'g08' },
    { id: 'i04', name: '回测重跑与归因', desc: '', group: 'g04' },
    { id: 'i05', name: '因子研究', desc: '', group: 'g04' },
  ],
  links: [
    { from: 'i01', to: 'i03', kind: 'fine-fine', why: '插件宣传片走短视频流程', weight: 0.8 },
    { from: 'g05', to: 'g08', kind: 'broad-broad', why: '开发产出要用宣传物料', weight: 0.6 },
  ],
  hooks: [
    { id: 'h1', session: 'session-a', agent: 'dsh', topic: 'g05', topicFine: 'i01', topics: ['i03'], kind: 'auto', level: 'module', title: '做会话视图插件', ts: '2026-11-14T10:00:00.000Z', startSeq: 20, endSeq: 30, status: 'active', artifacts: ['D:\\工作文件夹\\session-view-plugin\\lib\\client.js'], ask: '帮我做一个会话视图插件' },
    { id: 'h5', session: 'session-a', agent: 'dsh', topic: 'g05', topicFine: 'i01', kind: 'auto', level: 'turn', title: '先做个雏形', ts: '2026-11-13T10:00:00.000Z', startSeq: 5, endSeq: 9, status: 'active', artifacts: [], ask: '先做个雏形' },
    { id: 'h6', session: 'zcode:abc', agent: 'zcode', topic: 'g05', topicFine: 'i02', kind: 'auto', level: 'module', title: 'zcode 里的插件笔记', ts: '2026-10-02T10:00:00.000Z', startSeq: 0, endSeq: 4, status: 'active', artifacts: [], ask: 'zcode 里聊过插件' },
    { id: 'h7', session: 'zcode:abc', agent: 'zcode', topic: 'g05', topicFine: 'i02', kind: 'auto', level: 'turn', title: 'zcode 里的第二轮', ts: '2026-10-03T10:00:00.000Z', startSeq: 5, endSeq: 8, status: 'active', artifacts: [], ask: '继续聊插件' },
    { id: 'h4', session: 'session-zz', agent: 'dsh', topic: 'g08', topicFine: 'i03', kind: 'cron', level: 'module', title: '抖音 005', ts: '2026-11-01T10:00:00.000Z', startSeq: 1, endSeq: 2, status: 'active', artifacts: [], ask: '005 分屏' },
    { id: 'h8', session: 'session-yy', agent: 'dsh', topic: 'g04', topicFine: 'i04', kind: 'auto', level: 'module', title: '回测重跑', ts: '2026-10-20T10:00:00.000Z', startSeq: 1, endSeq: 6, status: 'active', artifacts: [], ask: '重跑一遍' },
    { id: 'h9', session: 'session-yy', agent: 'dsh', topic: 'g04', topicFine: 'i04', kind: 'auto', level: 'turn', title: '回测归因', ts: '2026-10-21T10:00:00.000Z', startSeq: 7, endSeq: 12, status: 'active', artifacts: [], ask: '看归因' },
    { id: 'h10', session: 'hermes:2', agent: 'hermes', topic: 'g04', topicFine: 'i05', kind: 'auto', level: 'turn', title: 'hermes 时代的因子研究', ts: '2026-07-04T10:00:00.000Z', startSeq: 1, endSeq: 3, status: 'active', artifacts: [], ask: '因子' },
    { id: 'h2', session: 'session-b', agent: 'dsh', topic: '', kind: '', level: 'turn', title: '量化回测复盘', ts: '2026-09-30T10:00:00.000Z', startSeq: 1, endSeq: 3, status: 'active', artifacts: [], ask: '复盘' },
    { id: 'h3', session: 'hermes:1', agent: 'hermes', topic: '', kind: '', level: 'module', title: '迁移记忆', ts: '2026-08-02T10:00:00.000Z', startSeq: 0, endSeq: 3, status: 'active', artifacts: ['D:\\工作文件夹\\Hermes迁移计划与进度.md'], ask: '迁移' },
    { id: 'h11', session: 'zcode:child', agent: 'zcode', topic: 'g05', topicFine: 'i02', origin: 'zcode:subagent_child', kind: 'auto', level: 'turn', title: '你是视觉验收 judge', ts: '2026-10-15T10:00:00.000Z', startSeq: 0, endSeq: 3, status: 'active', artifacts: [], ask: '验收这张海报' },
  ],
}

const fetched = []
const posted = []
globalThis.fetch = async (url, init) => {
  const text = String(url)
  fetched.push(text)
  if (init !== undefined && init.method === 'POST') {
    const body = JSON.parse(init.body || '{}')
    posted.push({ url: text, body })
    if (text.startsWith('/session-view/api/memory/pin')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, pin: body.clear === true ? null : { topic: body.topic, fine: body.fine, label: body.label } }) }
    }
    if (text.startsWith('/session-view/api/memory/topic-new')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, topic: { id: 'i99', name: body.name } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  if (text.startsWith('/session-view/api/memory/pin')) return { ok: true, status: 200, json: async () => ({ ok: true, pin: null }) }
  if (text.startsWith('/session-view/api/memory/snapshot')) return { ok: true, status: 200, json: async () => snapshot }
  if (text.startsWith('/session-view/api/memory/hook')) {
    const id = new URL(text, 'http://x').searchParams.get('id')
    const hook = snapshot.hooks.find((item) => item.id === id)
    return { ok: true, status: 200, json: async () => ({ ok: true, hook: { ...hook, ask: '完整提问：' + (hook ? hook.ask : '') } }) }
  }
  if (text.startsWith('/work-memory/api/open')) {
    return { ok: true, status: 200, json: async () => ({ id: 'h1', title: 'x', session: 'session-a', text: '用户：帮我做一个会话视图插件\n助手：好的', file: 'f' }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no route ' + text }) }
}

const registered = []
const opened = []
const ctx = {
  get(name) {
    if (name === 'slots') return { inject: (_slot, callback) => callback(), register: (options, component) => { registered.push({ options, component }); return () => {} } }
    if (name === 'sessions') return { list: { getSnapshot: () => list, subscribe: () => () => {} }, refresh: async () => {} }
    if (name === 'workspaces') return { list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => {} } }
    if (name === 'uiWorkspace') return { openSession: (id) => { opened.push(id) }, startSession: () => {} }
    return undefined
  },
}
loaded.apply(ctx)
const panel = registered.find((entry) => entry.options.name === 'main')
assert.equal(panel.options.key, 'session-view')

// ── 渲染工具 ────────────────────────────────────────────────────────────────
async function settle() {
  let tree
  for (let pass = 0; pass < 30; pass += 1) {
    cursor = 0
    dirty = false
    tree = panel.component({})
    const toRun = pendingEffects
    pendingEffects = []
    for (const item of toRun) item.fn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) return tree
  }
  throw new Error('渲染没有收敛')
}
function html(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(html).join('')
  const { type, props } = node
  if (typeof type === 'function') return html(type(props))
  const attrs = Object.keys(props).filter((key) => key !== 'children' && props[key] !== undefined && props[key] !== null && props[key] !== false && typeof props[key] !== 'function')
    .map((key) => ` ${key}="${String(props[key]).replace(/"/g, '&quot;')}"`).join('')
  return `<${type}${attrs}>${props === undefined ? '' : html(props.children)}</${type}>`
}
const text = (node) => html(node).replace(/<[^>]*>/g, ' ')
function collect(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) collect(item, out); return out }
  out.push(node)
  if (node.props !== undefined) collect(node.props.children, out)
  return out
}
const pick = (tree, className, contains) => collect(tree, []).filter((element) => {
  if (element.props === undefined) return false
  const tokens = String(element.props.className || '').split(/\s+/)
  return tokens.includes(className) && (contains === undefined || text(element).includes(contains))
})
const click = (element) => element.props.onClick({ stopPropagation() {}, preventDefault() {}, target: { value: '' } })

// 1. 总览：宽类方块
let tree = await settle()
let body = text(tree)
assert.match(body, /DSH桌面应用与插件生态/)
assert.match(body, /4 条钩子 · 2 个会话/, 'g05 有 4 条人类钩子 / 2 个会话')
assert.match(body, /另有 1 条代理自产/)
const tiles = pick(tree, 'svp-tile')
assert.equal(tiles.length, 4, '3 个宽类 + 未打标')

// 1c. 记忆方向条：选宽类 → 设为当前方向（POST 到 pin 接口）
assert.match(body, /记忆方向/)
const broadSelect = collect(tree, []).find((element) => element.type === 'select' && element.props['aria-label'] === '宽类')
assert.ok(broadSelect !== undefined, '有宽类下拉')
broadSelect.props.onChange({ target: { value: 'g05' } })
tree = await settle()
const setButton = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '设为当前方向')
assert.ok(setButton !== undefined)
click(setButton)
await new Promise((resolve) => setTimeout(resolve, 0))
tree = await settle()
const pinPosts = posted.filter((item) => item.url.startsWith('/session-view/api/memory/pin'))
assert.equal(pinPosts.length, 1, '设置方向只发一次')
assert.equal(pinPosts[0].body.topic, 'g05')
// 输入框不抢焦点：方向条还在
assert.match(text(tree), /记忆方向/)

// 1d. 新开模块：填名字 → 保存 → POST topic-new
const openNew = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '新开模块')
click(openNew)
tree = await settle()
const nameInput = collect(tree, []).find((element) => element.type === 'input' && element.props.placeholder !== undefined && String(element.props.placeholder).includes('模块名'))
assert.ok(nameInput !== undefined, '有新模块名输入框')
nameInput.props.onChange({ target: { value: '星图交互改版' } })
tree = await settle()
const saveButton = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '保存')
click(saveButton)
await new Promise((resolve) => setTimeout(resolve, 0))
const topicPosts = posted.filter((item) => item.url.startsWith('/session-view/api/memory/topic-new'))
assert.equal(topicPosts.length, 1)
assert.equal(topicPosts[0].body.name, '星图交互改版')
assert.equal(topicPosts[0].body.group, 'g05')

// 1e. 全库图谱：宽类 + 细线都画成节点，连接画成线；点细线节点进入它
const wholeButton = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '全库图谱')
assert.ok(wholeButton !== undefined, '总览有「全库图谱」入口')
click(wholeButton)
tree = await settle()
body = text(tree)
assert.match(body, /全库图谱/)
const wholeNodes = pick(tree, 'svp-whole-node')
assert.equal(wholeNodes.length, 8, '3 个宽类 + 5 条细线')
const edgeLines = collect(tree, []).filter((element) => element.type === 'line')
assert.ok(edgeLines.length >= 2, '至少画出连接线')
const i02Node = wholeNodes.find((node) => text(node).includes('zcode 插件笔记'))
click(i02Node)
tree = await settle()
body = text(tree)
assert.match(body, /zcode 插件笔记/, '点细线节点进入该细线')
// 回到总览继续后面的用例
const backButton = collect(tree, []).find((element) => element.type === 'button' && text(element).includes('全部主题'))
click(backButton)
tree = await settle()

// 2. 进宽类：细线清单
click(tiles.find((tile) => text(tile).includes('DSH桌面应用与插件生态')))
tree = await settle()
body = text(tree)
assert.match(body, /4 条钩子 · 2 个会话 · 2 条细线/)
const lines = pick(tree, 'svp-line')
assert.equal(lines.length, 2)
assert.match(text(lines[0]), /会话视图插件开发/)
assert.match(text(lines[0]), /2 条 · 1 个会话/)
assert.match(text(lines[1]), /zcode 插件笔记/)

// 2b. 横向连接：宽类页显示跨类别的边（g05 ⇒ g08）
assert.match(body, /相关/)
const groupLink = pick(tree, 'svp-link').find((link) => text(link).includes('PPT与宣传内容制作'))
assert.ok(groupLink !== undefined, '宽类页有跨类别连接')

// 3. 进细类：星图
click(lines[0])
tree = await settle()
body = text(tree)
assert.match(body, /会话视图插件开发/)
assert.match(body, /点节点看它的钩子/)
let nodes = pick(tree, 'svp-graph-node')
assert.equal(nodes.length, 1, 'i01 只有 session-a 一个会话')
click(nodes[0])
tree = await settle()
body = text(tree)
assert.match(body, /2 条钩子/)
const rows = pick(tree, 'svp-hookrow')
assert.equal(rows.length, 2)
// 多标签：这条记录除了主主题还挂在 i03 上，行内应该有 + 标签
const tags = pick(tree, 'svp-tag')
assert.ok(tags.length >= 1, '多标签记录要显示 + 标签')
assert.match(text(tags[0]), /\+抖音/)
click(rows.find((row) => text(row).includes('seq 20–30')))
tree = await settle()
assert.match(text(tree), /完整提问：帮我做一个会话视图插件/)
const transcriptButton = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '展开原文')
assert.ok(transcriptButton !== undefined)
click(transcriptButton)
tree = await settle()
assert.match(text(tree), /助手：好的/)
const openButton = collect(tree, []).find((element) => element.type === 'button' && text(element).trim() === '打开会话')
assert.ok(openButton !== undefined)
click(openButton)
assert.deepEqual(opened, ['session-a'])

// 4. 面包屑回宽类，再回总览
const crumbButtons = collect(tree, []).filter((element) => element.type === 'button' && /← 全部主题/.test(text(element)))
click(crumbButtons[0])
tree = await settle()
assert.ok(pick(tree, 'svp-tile').length === 4, '回到总览')

// 5. 含代理自产：g05 多一条（h11 没有 topicFine，只进宽类）
const toggle = collect(tree, []).find((element) => element.type === 'input' && element.props !== undefined && element.props.type === 'checkbox')
toggle.props.onChange({ target: { checked: true } })
tree = await settle()
body = text(tree)
assert.match(body, /5 条钩子 · 3 个会话/, '含代理后 g05 多一个会话')
toggle.props.onChange({ target: { checked: false } })
tree = await settle()

// 6. 单钩子会话的细类退化成列表（i03 只有一个会话一条钩子）
click(pick(tree, 'svp-tile').find((tile) => text(tile).includes('PPT与宣传内容制作')))
tree = await settle()
click(pick(tree, 'svp-line')[0])
tree = await settle()
body = text(tree)
assert.match(body, /都是单次会话/)
assert.ok(pick(tree, 'svp-graph-node').length === 0, '单次会话不画星图')
assert.equal(pick(tree, 'svp-file').length, 1)

// 7. 未打标回退：散点
click(collect(tree, []).find((element) => element.type === 'button' && text(element).includes('全部主题')))
tree = await settle()
click(pick(tree, 'svp-tile').find((tile) => text(tile).includes('未打标')))
tree = await settle()
assert.match(text(tree), /散落在 2 个会话里/)
assert.equal(pick(tree, 'svp-pile-dot').length, 2)

// 8. 会话页「记忆 N」徽章 → 跳到细类星图
click(pick(tree, 'svp-tab').find((tab) => text(tab).includes('会话')))
tree = await settle()
const rowA = collect(tree, []).find((element) => element.props !== undefined && element.props.className === 'svp-row' && text(element).includes('修复上传失败'))
const pill = collect(rowA, []).find((element) => element.type === 'button' && element.props.className === 'svp-mem-pill')
click(pill)
tree = await settle()
body = text(tree)
assert.match(body, /会话视图插件开发/, '落在 i01 细类')
assert.equal(pick(tree, 'svp-graph-node').length, 1)

// 9. 产物页 → 跳回细类
click(pick(tree, 'svp-tab').find((tab) => text(tab).includes('产物')))
tree = await settle()
const fileButton = pick(tree, 'svp-file').find((file) => text(file).includes('client.js'))
click(fileButton)
tree = await settle()
assert.match(text(tree), /会话视图插件开发/)

console.log('render-test: 宽类 → 细线 → 星图三层 + 代理开关 + 退化列表 + 两处跳转全部通过')
