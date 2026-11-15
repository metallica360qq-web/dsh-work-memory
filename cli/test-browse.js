#!/usr/bin/env node
/**
 * test-browse.js — 结构浏览（memory_map）的自检，读真实账本，只读不写。
 *
 *   node cli/test-browse.js
 *
 * 两层：① lib/browse.js 的纯函数；② 真跑一遍 apply()，用假 ctx 截住注册的
 * memory_map 工具，喂四种参数（无参 / topic / session / recent）看输出。
 */
import assert from 'node:assert/strict'
import { loadHooks } from '../lib/store.js'
import { loadTopics } from '../lib/topics.js'
import { browsableRows, isBoilerplate, topicOverview, topicSessions, sessionHooks, recentSessions } from '../lib/browse.js'
import { isHumanRow, originLabel, originBreakdown } from '../lib/origin.js'
import { apply } from '../lib/index.js'

const rows = loadHooks()
const topics = loadTopics()

// ── ① 纯函数 ────────────────────────────────────────────────────────────────
assert.ok(rows.length > 0, '账本不能为空')
assert.equal(isBoilerplate({ ask: '[IMPORTANT: You are running as a scheduled cron job', title: 'x' }), true, 'cron 样板要能认出来')
assert.equal(isBoilerplate({ ask: 'The user has invoked the "hermes-second-brain" skill', title: 'x' }), true, '技能样板要能认出来')
assert.equal(isBoilerplate({ ask: '帮我做一个会话视图插件', title: '会话视图' }), false, '正常提问不算样板')

// 来源：账本已被 backfill-origin 补全，人类/代理要分得开
const breakdown = originBreakdown(rows)
assert.ok(Object.keys(breakdown).length >= 4, '来源分类至少 4 类，实际 ' + Object.keys(breakdown).length)
assert.equal(rows.filter((row) => isHumanRow(row)).length + rows.filter((row) => !isHumanRow(row)).length, rows.length)
assert.ok(isHumanRow({ agent: 'dsh' }), '没有 origin 的 DSH 行按人算')
assert.equal(isHumanRow({ agent: 'zcode', origin: 'zcode:subagent_child' }), false, 'zcode 子代理会话不算人')
assert.equal(isHumanRow({ agent: 'hermes', origin: 'hermes:cron' }), false, 'hermes cron 不算人')
assert.equal(isHumanRow({ agent: 'zcode', origin: 'zcode:interactive' }), true)
assert.match(originLabel({ agent: 'zcode', origin: 'zcode:subagent_child' }), /子代理/)

const browsable = browsableRows(rows)
const browsableAll = browsableRows(rows, { includeAgents: true })
assert.ok(browsable.length > 0 && browsable.length < browsableAll.length, '默认要比含代理时少')
assert.ok(browsable.every((row) => !isBoilerplate(row)), '可浏览集合里不能有样板')
assert.ok(browsable.every((row) => isHumanRow(row)), '可浏览集合默认只要人类需求')
assert.ok(browsable.every((row) => row.status !== 'archived' && row.status !== 'superseded'))
assert.ok(browsableAll.some((row) => !isHumanRow(row)), 'includeAgents 时要能看到代理记录')

const overview = topicOverview(rows, topics)
const overviewAll = topicOverview(rows, topics, { includeAgents: true })
assert.ok(overview.length >= 10, '主题总览至少 10 个桶，实际 ' + overview.length)
assert.ok(overviewAll.length >= overview.length, '含代理时主题不会少')
const overviewHooks = overview.reduce((sum, topic) => sum + topic.hooks, 0)
assert.equal(overviewHooks, browsable.length, '总览的钩子数合计要等于可浏览总数')
assert.ok(overview.every((topic) => topic.sessions > 0))
assert.ok(overview.every((topic) => topic.hooks >= topic.sessions), '钩子数不少于会话数')
for (let index = 1; index < overview.length; index += 1) {
  assert.ok(overview[index - 1].hooks >= overview[index].hooks, '主题按钩子数降序')
}

const top = overview[0]
const detail = topicSessions(rows, top.id, 40)
const detailAll = topicSessions(rows, top.id, 1000)
assert.ok(detail.total > 0, '最大主题下应有会话')
assert.equal(detail.hooks, top.hooks, '主题会话页的钩子数要和总览一致')
assert.equal(detailAll.sessions.reduce((sum, session) => sum + session.hooks, 0), detailAll.hooks, '会话钩子数合计 = 主题钩子数（不限条数时）')
assert.ok(detail.sessions.length <= 40)
assert.equal(detailAll.sessions.length, detail.total, '不限条数时能拿全')
for (let index = 1; index < detail.sessions.length; index += 1) {
  assert.ok(detail.sessions[index - 1].hooks >= detail.sessions[index].hooks, '会话按钩子数降序')
}

const firstSession = detail.sessions[0]
const hooks = sessionHooks(rows, firstSession.session)
// 会话页给的是这个会话的全部钩子（可能跨多个主题），所以只会比主题页里那部分多
assert.ok(hooks.length >= firstSession.hooks, '会话全部钩子数不少于该主题下的条数')
assert.ok(firstSession.ids.every((id) => hooks.some((row) => row.id === id)), '主题页列出的钩子都要在会话页里')
assert.ok(hooks.every((row) => row.session === firstSession.session))
for (let index = 1; index < hooks.length; index += 1) {
  assert.ok(Number(hooks[index - 1].startSeq) <= Number(hooks[index].startSeq), '钩子按 seq 升序')
}
assert.deepEqual(hooks.map((row) => row.id).filter((id) => firstSession.ids.includes(id)), firstSession.ids, '主题内钩子的相对顺序一致')

const recent = recentSessions(rows, 10)
assert.ok(recent.length > 0 && recent.length <= 10)
for (let index = 1; index < recent.length; index += 1) {
  assert.ok(String(recent[index - 1].lastTs) >= String(recent[index].lastTs), '最近会话按时间降序')
}

// ── ② 工具输出（真跑 apply，假 ctx 截工具）────────────────────────────────
const tools = new Map()
const fakeCtx = {
  get: () => undefined,
  effect: (fn) => {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  on: () => () => {},
  systemPrompt: { context: () => () => {} },
  tools: {
    register: (definition) => {
      tools.set(definition.name, definition)
      return () => {}
    },
  },
}
apply(fakeCtx)

const memoryMap = tools.get('memory_map')
assert.ok(memoryMap !== undefined, 'apply 之后应注册 memory_map')
assert.ok(tools.has('memory_search') && tools.has('memory_open') && tools.has('memory_write'), '其它工具还在')
assert.equal(memoryMap.parameters.type, 'object')
assert.deepEqual(Object.keys(memoryMap.parameters.properties).sort(), ['includeAgents', 'limit', 'recent', 'session', 'topic'])

const overviewText = await memoryMap.execute({})
assert.match(overviewText, /个主题/)
assert.match(overviewText, /人类需求 \d+ 条/)
assert.match(overviewText, /代理自产 \d+ 条/)
assert.match(overviewText, /下一步：memory_map\(topic=/)
assert.ok(overviewText.includes(top.id), '总览里应有最大主题的 id')

const topicText = await memoryMap.execute({ topic: top.id })
assert.match(topicText, /个会话 \/ \d+ 条钩子/)
assert.ok(topicText.includes(firstSession.session), '主题页里应有会话 id')
assert.match(topicText, /memory_map\(session=/)

const sessionText = await memoryMap.execute({ session: firstSession.session })
assert.match(sessionText, /条钩子/)
assert.match(sessionText, /memory_open\(id=/)
assert.ok(sessionText.includes(firstSession.ids[0]), '会话页里应有钩子 id')

const recentText = await memoryMap.execute({ recent: 5 })
assert.match(recentText, /最近动过的/)
assert.match(recentText, /memory_map\(session=/)

const missing = await memoryMap.execute({ session: 'session-不存在' })
assert.match(missing, /没有这个会话的钩子/)
const noTopic = await memoryMap.execute({ topic: 't99' })
assert.match(noTopic, /没有可浏览的记录|可用主题/)

// ── ③ 两遍归纳后的主题表：只剩 12 个 g 开头宽类，旧的 t 类已废弃 ──
const ids = overview.map((topic) => topic.id)
assert.ok(ids.every((id) => id === '' || /^g\d+$/.test(id)), '主题 id 应该是 g01…g12，实际 ' + ids.join(','))
assert.ok(ids.length >= 10, '宽类至少 10 个')
const legacy = await memoryMap.execute({ topic: 't11' })
assert.match(legacy, /没有人类需求的记录/, '旧主题 id 不再有记录')
const agentOnlyText = legacy
const withAgentsText = await memoryMap.execute({ topic: 't11', includeAgents: true })
assert.match(withAgentsText, /没有人类需求的记录/)
assert.ok(withAgentsText.length >= agentOnlyText.length)

const boilerCount = browsableAll.length - browsable.length
console.log('test-browse: 全部通过')
console.log('  账本 ' + rows.length + ' 条：人类需求 ' + (rows.length - (rows.length - browsable.length)) + ' 条视图内，代理自产/样板 ' + boilerCount + ' 条默认不显示')
console.log('  主题 ' + overview.length + ' 个（含代理时 ' + overviewAll.length + ' 个），最大的是 ' + top.id + ' ' + top.name + '（' + top.hooks + ' 条 / ' + top.sessions + ' 个会话）')
console.log('  总览输出 ' + overviewText.length + ' 字，主题页 ' + topicText.length + ' 字，会话页 ' + sessionText.length + ' 字')
console.log('  来源分布：' + Object.entries(breakdown).map(([origin, entry]) => origin + '=' + entry.total).join('，'))
