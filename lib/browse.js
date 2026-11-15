/**
 * browse.js — 结构浏览：主题 → 会话 → 钩子。
 *
 * 关键词检索解决「我记得有个词」；这里解决「那个方向都有什么」。
 * 对账数据（2026-11-14）：现状召回 71% 的提问零命中，而主题分层永远有东西可看，
 * 所以给模型一条不依赖词面重叠的入口。
 *
 * 纯函数：只吃 loadHooks() 给出的行，不读文件、不调模型、不写账本。
 */

/** 系统注入样板（cron 投递模板、技能加载模板）被当成用户提问记进了账本，浏览时跳过。 */
const BOILERPLATE = /^\[IMPORTANT:|scheduled cron job|has invoked the "/

import { isHumanRow } from './origin.js'

/**
 * 这条记录是不是系统样板，而不是用户提的需求。
 * @param {object} row 账本行。
 * @returns {boolean} true 表示应跳过。
 */
export function isBoilerplate(row) {
  return BOILERPLATE.test(String(row.ask || '')) || BOILERPLATE.test(String(row.title || ''))
}

/**
 * 过滤出可浏览的行：有效、非归档/被取代、非样板；默认只要「人提的需求」。
 * @param {object[]} rows 账本行。
 * @param {{includeAgents?: boolean}} [options] includeAgents=true 时也带上代理自产的记录。
 * @returns {object[]} 可浏览的行。
 */
export function browsableRows(rows, options = {}) {
  const includeAgents = options.includeAgents === true
  return rows.filter(
    (row) =>
      row.status !== 'archived' &&
      row.status !== 'superseded' &&
      !isBoilerplate(row) &&
      (includeAgents || isHumanRow(row)),
  )
}

/**
 * 一个会话在一批行里的摘要。
 * @param {object[]} rows 同一会话的行。
 * @returns {{session: string, agent: string, hooks: number, firstTs: string, lastTs: string, label: string, ids: string[]}} 摘要。
 */
function sessionSummary(rows) {
  const sorted = rows.slice().sort((left, right) => Number(left.startSeq) - Number(right.startSeq))
  const moduleRow = sorted.find((row) => row.level === 'module')
  const labelRow = moduleRow || sorted[0]
  const label = String(labelRow.title || labelRow.ask || '').replace(/\s+/g, ' ').slice(0, 60)
  const stamps = sorted.map((row) => String(row.ts || '')).filter((value) => value.length >= 10).sort()
  return {
    session: sorted[0].session,
    agent: sorted[0].agent || 'dsh',
    hooks: sorted.length,
    firstTs: stamps.length > 0 ? stamps[0].slice(0, 10) : '',
    lastTs: stamps.length > 0 ? stamps[stamps.length - 1].slice(0, 10) : '',
    label: label.length > 0 ? label : '(无标题)',
    ids: sorted.map((row) => row.id),
  }
}

/**
 * 按会话聚合。
 * @param {object[]} rows 可浏览的行。
 * @returns {Map<string, object[]>} session → 该会话的行。
 */
function groupBySession(rows) {
  const map = new Map()
  for (const row of rows) {
    const list = map.get(row.session)
    if (list === undefined) map.set(row.session, [row])
    else list.push(row)
  }
  return map
}

/**
 * 一级：主题总览。
 * @param {object[]} rows 账本行。
 * @param {Array<{id: string, name: string}>} topics 主题定义。
 * @returns {Array<object>} 每个主题的钩子数、会话数、来源分布、最近时间。
 */
export function topicOverview(rows, topics, options = {}) {
  const browsable = browsableRows(rows, options)
  const buckets = new Map()
  for (const row of browsable) {
    const key = row.topic || ''
    const entry = buckets.get(key) || { hooks: 0, sessions: new Set(), agents: {}, lastTs: '' }
    entry.hooks += 1
    entry.sessions.add(row.session)
    entry.agents[row.agent || 'dsh'] = (entry.agents[row.agent || 'dsh'] || 0) + 1
    const stamp = String(row.ts || '')
    if (stamp > entry.lastTs) entry.lastTs = stamp
    buckets.set(key, entry)
  }
  const known = new Map(topics.map((topic) => [topic.id, topic]))
  for (const [key, entry] of buckets) {
    if (key !== '' && !known.has(key)) {
      known.set(key, { id: key, name: key, desc: '' })
    }
  }
  const result = []
  for (const [id, topic] of known) {
    const entry = buckets.get(id)
    if (entry === undefined) continue
    result.push({
      id,
      name: topic.name || id,
      desc: topic.desc || '',
      hooks: entry.hooks,
      sessions: entry.sessions.size,
      agents: entry.agents,
      lastTs: entry.lastTs.slice(0, 10),
    })
  }
  const untagged = buckets.get('')
  if (untagged !== undefined) {
    result.push({
      id: '',
      name: '未打标',
      desc: '',
      hooks: untagged.hooks,
      sessions: untagged.sessions.size,
      agents: untagged.agents,
      lastTs: untagged.lastTs.slice(0, 10),
    })
  }
  result.sort((left, right) => right.hooks - left.hooks)
  return result
}

/**
 * 二级：一个主题下的会话（按钩子数降序，其次最近时间）。
 * @param {object[]} rows 账本行。
 * @param {string} topicId 主题 id；空字符串表示未打标。
 * @param {number} [limit] 返回会话数上限。
 * @returns {{sessions: object[], total: number, hooks: number}} 会话清单与总量。
 */
export function topicSessions(rows, topicId, limit = 40, options = {}) {
  const wanted = topicId || ''
  // 主主题（宽类或其细类）匹配，或多标签里挂了这个细类
  const inTopic = (row) => {
    if ((row.topic || '') === wanted) return true
    if (wanted !== '' && row.topicFine === wanted) return true
    return wanted !== '' && Array.isArray(row.topics) && row.topics.includes(wanted)
  }
  const browsable = browsableRows(rows, options).filter(inTopic)
  const grouped = groupBySession(browsable)
  const sessions = [...grouped.values()].map(sessionSummary)
  sessions.sort((left, right) => (right.hooks - left.hooks) || String(right.lastTs).localeCompare(String(left.lastTs)))
  return {
    sessions: sessions.slice(0, Math.max(1, limit)),
    total: sessions.length,
    hooks: browsable.length,
  }
}

/**
 * 三级：一个会话里的钩子（按 seq 升序）。
 * @param {object[]} rows 账本行。
 * @param {string} sessionId 会话 id。
 * @returns {object[]} 该会话的钩子（已按 seq 排序）。
 */
export function sessionHooks(rows, sessionId, options = {}) {
  return browsableRows(rows, options)
    .filter((row) => row.session === sessionId)
    .sort((left, right) => Number(left.startSeq) - Number(right.startSeq))
}

/**
 * 最近动过的会话（不按主题，给「我最近在做什么」这类问题用）。
 * @param {object[]} rows 账本行。
 * @param {number} [limit] 会话数上限。
 * @returns {object[]} 会话摘要，按最近时间降序。
 */
export function recentSessions(rows, limit = 15, options = {}) {
  const grouped = groupBySession(browsableRows(rows, options))
  const sessions = [...grouped.values()].map(sessionSummary)
  sessions.sort((left, right) => String(right.lastTs).localeCompare(String(left.lastTs)))
  return sessions.slice(0, Math.max(1, limit))
}
