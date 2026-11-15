/**
 * 会话视图插件的离线自检：不连 DSH，只验数据整形与文案工具。
 *
 * 用法：node scripts/selftest.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'lib', 'client.js')

let captured
globalThis.window = { __ModuleLoader__: { load: (value) => { captured = value } } }
try {
  vm.runInThisContext(readFileSync(file, 'utf8'), { filename: file })
} finally {
  delete globalThis.window
}

assert.equal(captured.id, 'session-view-plugin', 'factory id 必须是包名')
const loaded = captured.factory(() => ({}))
const { buildSessionModel, buildMemoryIndex, relativeTime, baseName, dirName, shortId, PANEL_ID } = loaded.__internals

assert.equal(PANEL_ID, 'session-view')
assert.equal(typeof loaded.apply, 'function')
assert.deepEqual(loaded.inject, ['slots', 'sessions', 'workspaces', 'uiWorkspace'])

const NOW = 1_700_000_000_000
const recent = (minutes) => NOW - minutes * 60_000

// ── 会话整形 ────────────────────────────────────────────────────────────────

const list = {
  ids: ['session-a', 'session-b', 'session-c', 'session-d', 'session-sub', 'session-e'],
  byId: {
    'session-a': { id: 'session-a', displayTitle: '修复上传失败', cwd: 'D:\\工作文件夹\\proj-a', updatedAt: recent(1), running: true, blank: false, retainedBy: { mainView: 1 } },
    'session-b': { id: 'session-b', displayTitle: '量化回测', cwd: 'D:\\工作文件夹\\proj-a', updatedAt: recent(5), running: false, blank: false, retainedBy: {} },
    'session-c': { id: 'session-c', displayTitle: '旧归档会话', cwd: 'D:\\工作文件夹\\proj-b', updatedAt: recent(60 * 24 * 40), running: false, blank: false, retainedBy: {} },
    'session-d': { id: 'session-d', displayTitle: '新空白', cwd: 'D:\\工作文件夹\\proj-b', updatedAt: recent(0.1), running: false, blank: true, retainedBy: {} },
    'session-sub': { id: 'session-sub', displayTitle: '子代理任务', cwd: 'D:\\工作文件夹\\proj-a', origin: 'subagent', parentId: 'session-a', updatedAt: recent(0.5), running: false, blank: false, retainedBy: {} },
    'session-e': { id: 'session-e', displayTitle: '未归组会话', cwd: 'D:\\other', updatedAt: recent(20), running: false, blank: false, retainedBy: {} },
  },
  phase: 'ready',
}

const workspaces = {
  items: [
    { workspaceId: 'ws1', title: '项目 A', path: 'D:\\工作文件夹\\proj-a', sessionIds: ['session-a', 'session-b'] },
    { workspaceId: 'ws2', title: '项目 B', path: 'D:\\工作文件夹\\proj-b', sessionIds: ['session-c', 'session-d'] },
  ],
  archivedSessionIds: ['session-c'],
  pinnedSessionIds: ['session-b'],
}

const sessionBase = { query: '', scope: 'all', sort: 'recent', showSubagents: false, now: NOW, memoryCounts: {} }

const view = buildSessionModel(list, workspaces, sessionBase)
assert.equal(view.total, 5, 'total 只数非子会话')
assert.equal(view.running, 1)
assert.equal(view.archivedTotal, 1)
assert.equal(view.visibleCount, 4, 'all 排除已归档与子会话')
assert.equal(view.currentId, 'session-a', 'retainedBy.mainView 就是当前会话')
assert.deepEqual(view.groups.map((group) => group.title), ['项目 A', '项目 B', '未归入工作区'])
assert.deepEqual(view.groups[0].rows.map((row) => row.id), ['session-b', 'session-a'], '置顶优先，其次按最近活动')
assert.equal(view.groups[0].rows[0].pinned, true)
assert.equal(view.groups[1].rows[0].id, 'session-d')
assert.equal(view.groups[2].rows[0].id, 'session-e')

assert.deepEqual(buildSessionModel(list, workspaces, { ...sessionBase, query: 'proj-b' }).groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-d'])
assert.deepEqual(buildSessionModel(list, workspaces, { ...sessionBase, query: 'session-a' }).groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-a'])
assert.equal(buildSessionModel(list, workspaces, { ...sessionBase, query: '不存在的' }).groups.length, 0)

const withSubs = buildSessionModel(list, workspaces, { ...sessionBase, showSubagents: true })
assert.equal(withSubs.visibleCount, 5)
assert.ok(withSubs.groups.flatMap((g) => g.rows.map((r) => r.id)).includes('session-sub'))

assert.deepEqual(buildSessionModel(list, workspaces, { ...sessionBase, scope: 'running' }).groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-a'])
assert.deepEqual(buildSessionModel(list, workspaces, { ...sessionBase, scope: 'blank' }).groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-d'])
assert.deepEqual(buildSessionModel(list, workspaces, { ...sessionBase, scope: 'archived' }).groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-c'])

const byTitle = buildSessionModel(list, workspaces, { ...sessionBase, sort: 'title' })
assert.deepEqual(byTitle.groups[0].rows.map((row) => row.title), ['量化回测', '修复上传失败'], '中文按拼音排序')

const empty = buildSessionModel({ ids: [], byId: {}, phase: 'pending' }, { items: [] }, sessionBase)
assert.equal(empty.pending, true)
assert.equal(empty.groups.length, 0)

const withMemory = buildSessionModel(list, workspaces, { ...sessionBase, memoryCounts: { 'session-a': 3, 'session-b': 1 } })
assert.equal(withMemory.withMemory, 2)
const onlyMemory = buildSessionModel(list, workspaces, { ...sessionBase, onlyWithMemory: true, memoryCounts: { 'session-a': 3 } })
assert.deepEqual(onlyMemory.groups.flatMap((g) => g.rows.map((r) => r.id)), ['session-a'])
assert.deepEqual(onlyMemory.groups[0].rows.map((r) => r.memCount), [3])

// ── 账本整形：主题 → 会话 → 钩子 ───────────────────────────────────────────

const snapshot = {
  ok: true,
  generatedAt: '2026-11-14T12:00:00.000Z',
  source: { dir: 'C:/wm', file: 'C:/wm/hooks.jsonl', missing: false, badLines: 0, size: 100, mtimeMs: NOW - 60_000 },
  topics: [
    { id: 't08', name: 'DSH插件生态', desc: '插件体系', keywords: ['dsh'] },
    { id: 't15', name: '抖音短视频', desc: '短视频', keywords: ['抖音'] },
  ],
  fine: [
    { id: 'i01', name: '会话视图插件开发', desc: '', group: 't08' },
    { id: 'i02', name: 'zcode 插件笔记', desc: '', group: 't08' },
    { id: 'i03', name: '抖音 005 制作', desc: '', group: 't15' },
  ],
  hooks: [
    { id: 'h1', session: 'session-a', agent: 'dsh', topic: 't08', kind: 'auto', level: 'module', title: '做会话视图插件', ts: '2026-11-14T10:00:00.000Z', startSeq: 20, endSeq: 30, status: 'active', topicFine: 'i01', artifacts: ['D:\\工作文件夹\\session-view-plugin\\lib\\client.js'], ask: '帮我做一个会话视图插件' },
    { id: 'h5', session: 'session-a', agent: 'dsh', topic: 't08', kind: 'auto', level: 'turn', title: '先做个雏形', ts: '2026-11-13T10:00:00.000Z', startSeq: 5, endSeq: 9, status: 'active', topicFine: 'i01', artifacts: [], ask: '先做个雏形' },
    { id: 'h6', session: 'zcode:abc', agent: 'zcode', topic: 't08', kind: 'auto', level: 'module', title: 'zcode 里的插件笔记', ts: '2026-10-02T10:00:00.000Z', startSeq: 0, endSeq: 4, status: 'active', topicFine: 'i02', artifacts: [], ask: 'zcode 里聊过插件' },
    { id: 'h2', session: 'session-b', agent: 'dsh', topic: '', kind: '', level: 'turn', title: '', ts: '2026-09-30T10:00:00.000Z', startSeq: 1, endSeq: 3, status: 'active', artifacts: [], ask: '' },
    { id: 'h3', session: 'hermes:1', agent: 'hermes', topic: '', kind: '', level: 'module', title: '迁移记忆', ts: '2026-08-02T10:00:00.000Z', startSeq: 0, endSeq: 3, status: 'active', artifacts: ['D:\\工作文件夹\\Hermes迁移计划与进度.md'], ask: '迁移' },
    { id: 'h4', session: 'session-zz', agent: 'dsh', topic: 't15', kind: 'cron', level: 'module', title: '抖音 005', ts: '2026-11-01T10:00:00.000Z', startSeq: 1, endSeq: 2, status: 'active', topicFine: 'i03', artifacts: [], ask: '005 分屏' },
    // 代理自产：zcode 子代理任务书，默认不该出现在人类视图里
    { id: 'h7', session: 'zcode:child', agent: 'zcode', topic: 't08', origin: 'zcode:subagent_child', kind: 'auto', level: 'turn', title: '你是 M2 引擎移植的实现者', ts: '2026-10-10T10:00:00.000Z', startSeq: 0, endSeq: 5, status: 'active', artifacts: [], ask: '负责 Task 5（安卓打包）' },
  ],
}

const index = buildMemoryIndex(snapshot)
assert.ok(index !== null)
assert.equal(index.stats.total, 6)
assert.equal(index.stats.tagged, 4)
assert.equal(index.stats.untagged, 2)
assert.equal(index.stats.withArtifacts, 2)
assert.equal(index.stats.artifactPaths, 2)
assert.equal(index.stats.sessions, 5, 'session-a / zcode:abc / session-b / hermes:1 / session-zz')
assert.deepEqual(index.agents, { dsh: 4, zcode: 1, hermes: 1 })
assert.deepEqual(index.months.map((m) => m.key), ['2026-08', '2026-09', '2026-10', '2026-11'])
assert.equal(index.months.find((m) => m.key === '2026-11').total, 3)
assert.equal(index.topicRows.length, 2)
assert.equal(index.topicRows.find((t) => t.id === 't08').total, 3)
assert.equal(index.untagged.total, 2)
assert.equal(index.dirs.length, 2)
assert.equal(index.dirs.reduce((sum, dir) => sum + dir.files.length, 0), 2)

// 主题 → 会话：同一主题下不同 agent 的会话并排（这就是「跨 agent 合并」）
const pluginTopic = index.topicNodes.t08
assert.ok(pluginTopic !== undefined)
assert.equal(pluginTopic.hooksTotal, 3)
assert.equal(pluginTopic.sessionCount, 2, 't08 下有两个会话')
assert.deepEqual(pluginTopic.sessions.map((s) => s.agent).sort(), ['dsh', 'zcode'], 'dsh 与 zcode 在同一主题下并存')
assert.deepEqual(pluginTopic.sessions.map((s) => s.id), ['session-a', 'zcode:abc'], '按钩子数降序：session-a 两条在前')
assert.equal(pluginTopic.sessions[0].count, 2)
assert.deepEqual(pluginTopic.sessions[0].hooks.map((h) => h.startSeq), [5, 20], '同一会话内钩子按 seq 升序')
assert.equal(pluginTopic.sessions[1].latest, '2026-10-02T10:00:00.000Z')

// 未打标主题同样跨 agent
const untaggedNode = index.topicNodes['']
assert.equal(untaggedNode.sessionCount, 2)
assert.deepEqual(untaggedNode.sessions.map((s) => s.agent).sort(), ['dsh', 'hermes'])

// 另一个主题只有一条
assert.equal(index.topicNodes.t15.sessionCount, 1)

// 两层：宽类节点 + 细类节点 + 宽类下的细线清单
assert.equal(index.topicNodes.t08.hooksTotal, 3, 't08 宽类 3 条（h7 是代理记录，默认不算）')
assert.equal(index.topicNodes.t08.sessionCount, 2)
assert.equal(index.fineNodes.i01.hooksTotal, 2, 'i01 细类 2 条（session-a 的两次）')
assert.equal(index.fineNodes.i01.sessionCount, 1)
assert.equal(index.fineNodes.i01.group, 't08')
assert.equal(index.fineNodes.i02.sessionCount, 1)
assert.equal(index.fineNodes.i03.hooksTotal, 1)
assert.deepEqual(index.fineByGroup.t08.map((row) => row.id), ['i01', 'i02'], '宽类下的细线按材料数降序')
assert.equal(index.fineByGroup.t15.length, 1)
assert.equal(index.fineByGroup.t08[0].hooks, 2)
const agentView = buildMemoryIndex(snapshot, { includeAgents: true })
assert.ok(agentView.fineNodes.i02.hooksTotal >= 1, '含代理时细类数量只增不减')
assert.equal(buildMemoryIndex(null), null)
assert.equal(buildMemoryIndex({ ok: false }), null)

// 来源口径：默认只要人类需求；includeAgents 把代理自产的带回来
assert.equal(index.stats.humanTotal, 6, '默认视图里 6 条人类需求')
assert.equal(index.stats.agentTotal, 1, '1 条 zcode 子代理记录被挡在外面')
assert.equal(index.topicNodes.t08.sessionCount, 2, 't08 默认只有两个人类会话')
assert.equal(bufferTotal(index), 6)
const withAgents = buildMemoryIndex(snapshot, { includeAgents: true })
assert.equal(withAgents.stats.total, 7, '含代理时 7 条')
assert.equal(withAgents.stats.humanTotal, 6)
assert.equal(withAgents.stats.agentTotal, 1)
assert.equal(withAgents.topicNodes.t08.sessionCount, 3, '含代理时 t08 三个会话')
assert.equal(bufferTotal(withAgents), 7)

function bufferTotal(api) {
  let sum = 0
  for (const key of Object.keys(api.topicNodes)) sum += api.topicNodes[key].hooksTotal
  return sum
}
const emptyIndex = buildMemoryIndex({ ok: true, hooks: [], topics: [], source: null })
assert.equal(emptyIndex.stats.total, 0)
assert.deepEqual(emptyIndex.topicNodes, {})

// ── 文案工具 ────────────────────────────────────────────────────────────────

assert.equal(relativeTime(NOW - 30_000, NOW), '刚刚')
assert.equal(relativeTime(NOW - 5 * 60_000, NOW), '5 分钟前')
assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), '3 小时前')
assert.equal(relativeTime(NOW - 36 * 3_600_000, NOW), '昨天')
assert.equal(relativeTime(NOW - 5 * 86_400_000, NOW), '5 天前')
assert.equal(relativeTime(0, NOW), '')
assert.equal(baseName('D:\\工作文件夹\\proj-a\\'), 'proj-a')
assert.equal(dirName('D:\\工作文件夹\\session-view-plugin\\lib\\client.js'), 'D:\\工作文件夹\\session-view-plugin\\lib')
assert.equal(shortId('session-2a564966-d1c1-42bd'), '2a564966')

console.log('selftest: 会话 + 主题/会话/钩子三级结构共 55 项断言全部通过')
