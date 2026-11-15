/**
 * 召回对账：现状（按钩子取 3 条）vs 会话级聚合（按会话取 3 条）。
 *
 * 用法：node scripts/recall-ab.mjs [--queries 120] [--days 120]
 *
 * 输入：
 *   - 账本 ~/.dsh/work-memory/hooks.jsonl（只读）
 *   - dsh-work-memory 的真实召回实现（lib/store.js 的 searchHooks、lib/topics.js 的 matchTopic），
 *     不复制一份近似实现，避免对账对象本身失真
 * 做法：把账本里最近的用户提问当作 query（这些就是召回层实际看到的句子），
 *       每条 query 都用「排除自己会话」跑一遍（生产里也是这样排除当前会话），
 *       然后比较两种取法覆盖到多少不同会话、有多少行是同一会话的重复占位。
 * 注意：主题「正确率」是关键词判定与 GLM 打标的一致率，不是绝对真值。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WM_ROOT = process.env.WM_ROOT || 'D:/Program Files/工作文件夹/dsh-work-memory'
const { searchHooks } = await import(pathToFileURL(path.join(WM_ROOT, 'lib/store.js')).href)
const { matchTopic, topicName } = await import(pathToFileURL(path.join(WM_ROOT, 'lib/topics.js')).href)

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const QUERIES = argOf('--queries', 120)
const DAYS = argOf('--days', 120)
const TOPIC_MIN = 0.45
const GLOBAL_MIN = 0.6

const ledgerFile = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'work-memory', 'hooks.jsonl')
const rows = readFileSync(ledgerFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  })
  .filter((row) => row !== null)

const cutoff = Date.now() - DAYS * 86400_000
// 注入型提示词（cron 投递样板、技能加载样板）被当成用户提问记进账本了；
// 它们会互相匹配，把召回位占满。对账时默认剔除，另给一个 --keep-boilerplate 看污染量。
const boilerplate = /^\[IMPORTANT:|scheduled cron job|has invoked the "/
const keepBoilerplate = args.includes('--keep-boilerplate')
const candidates = rows
  .filter((row) => String(row.ask || '').trim().length >= 8 && Date.parse(String(row.ts)) >= cutoff)
  .filter((row) => keepBoilerplate || !boilerplate.test(String(row.ask || '')))
  .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
const boilerplateRows = rows.filter((row) => boilerplate.test(String(row.ask || '')))
console.log('账本里注入型提示词当成提问的条目：' + boilerplateRows.length + ' 条（本次对账' + (keepBoilerplate ? '包含' : '已剔除') + '）')

// 等间隔抽样，避免全挤在最近几天
const step = Math.max(1, Math.floor(candidates.length / QUERIES))
const sample = candidates.filter((_, index) => index % step === 0).slice(0, QUERIES)

/** 现状：一次取 3 条钩子（含主题内 → 全局兜底两段）。 */
function recallNow(query, sessionId) {
  const topic = matchTopic(query)
  const minScore = topic !== null ? TOPIC_MIN : GLOBAL_MIN
  let hits = searchHooks(query, 3, { excludeSession: sessionId, topic: topic || undefined })
    .filter((hit) => hit.score >= minScore)
  let usedFallback = false
  if (hits.length === 0 && topic !== null) {
    hits = searchHooks(query, 2, { excludeSession: sessionId }).filter((hit) => hit.score >= GLOBAL_MIN)
    usedFallback = hits.length > 0
  }
  return { topic, hits, usedFallback }
}

/** 聚合：宽取 12 条，按会话去重（每会话留最高分那条），再取 3 个会话。 */
function recallAggregated(query, sessionId) {
  const topic = matchTopic(query)
  const minScore = topic !== null ? TOPIC_MIN : GLOBAL_MIN
  let pool = searchHooks(query, 12, { excludeSession: sessionId, topic: topic || undefined })
    .filter((hit) => hit.score >= minScore)
  let usedFallback = false
  if (pool.length === 0 && topic !== null) {
    pool = searchHooks(query, 8, { excludeSession: sessionId }).filter((hit) => hit.score >= GLOBAL_MIN)
    usedFallback = pool.length > 0
  }
  const bySession = new Map()
  for (const hit of pool) {
    if (!bySession.has(hit.session)) bySession.set(hit.session, { best: hit, count: 0, ids: [] })
    const entry = bySession.get(hit.session)
    entry.count += 1
    entry.ids.push(hit.id)
  }
  const sessions = [...bySession.values()].slice(0, 3)
  return { topic, sessions, usedFallback }
}

/** 主题当加权而不是门槛：全局取候选，命中主题的 ×1.25 再排前 3。 */
function recallBoosted(query, sessionId) {
  const topic = matchTopic(query)
  const minScore = topic !== null ? TOPIC_MIN : GLOBAL_MIN
  const pool = searchHooks(query, 12, { excludeSession: sessionId })
    .filter((hit) => hit.score >= minScore)
    .map((hit) => ({ ...hit, boosted: hit.score * (topic !== null && hit.topic === topic ? 1.25 : 1) }))
    .sort((left, right) => right.boosted - left.boosted)
  return { topic, hits: pool.slice(0, 3) }
}

const records = []
for (const row of sample) {
  const query = String(row.ask).replace(/\s+/g, ' ').slice(0, 200)
  const now = recallNow(query, row.session)
  const agg = recallAggregated(query, row.session)
  const boost = recallBoosted(query, row.session)
  const nowSessions = new Set(now.hits.map((hit) => hit.session))
  // 诊断：不过阈值时最高分是多少（看有多少 query 是「差一点」还是「完全无关」）
  const topic = matchTopic(query)
  const rawScoped = searchHooks(query, 3, { excludeSession: row.session, topic: topic || undefined })
  const rawGlobal = searchHooks(query, 3, { excludeSession: row.session })
  records.push({
    id: row.id,
    session: row.session,
    agent: row.agent,
    expectedTopic: row.topic || '',
    matchedTopic: now.topic,
    topicAgrees: (row.topic || '') === (now.topic || '') || row.topic === undefined,
    query,
    queryLen: query.length,
    bestScoped: rawScoped.length > 0 ? rawScoped[0].score : 0,
    bestGlobal: rawGlobal.length > 0 ? rawGlobal[0].score : 0,
    now: {
      hits: now.hits.length,
      distinctSessions: nowSessions.size,
      duplicateSlots: now.hits.length - nowSessions.size,
      fallback: now.usedFallback,
      top: now.hits[0] ? { id: now.hits[0].id, title: now.hits[0].title, session: now.hits[0].session, score: now.hits[0].score } : null,
      list: now.hits.map((hit) => ({ id: hit.id, session: hit.session, score: hit.score, title: hit.title })),
    },
    agg: {
      hits: agg.sessions.length,
      distinctSessions: agg.sessions.length,
      fallback: agg.usedFallback,
      top: agg.sessions[0] ? { id: agg.sessions[0].best.id, title: agg.sessions[0].best.title, session: agg.sessions[0].best.session, score: agg.sessions[0].best.score, hooksInSession: agg.sessions[0].count } : null,
      list: agg.sessions.map((entry) => ({ id: entry.best.id, session: entry.best.session, score: entry.best.score, hooks: entry.count, title: entry.best.title })),
    },
    boost: {
      hits: boost.hits.length,
      top: boost.hits[0] ? { id: boost.hits[0].id, title: boost.hits[0].title, session: boost.hits[0].session, score: boost.hits[0].score, topic: boost.hits[0].topic } : null,
      list: boost.hits.map((hit) => ({ id: hit.id, session: hit.session, score: hit.score, topic: hit.topic, title: hit.title })),
    },
  })
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const n = records.length
const withExpected = records.filter((record) => record.expectedTopic !== '')
const topicAgree = withExpected.filter((record) => record.topicAgrees).length
const matchedNone = records.filter((record) => record.matchedTopic === null).length
const nowHits = records.reduce((sum, record) => sum + record.now.hits, 0)
const aggHits = records.reduce((sum, record) => sum + record.agg.hits, 0)
const emptyNow = records.filter((record) => record.now.hits === 0).length
const emptyAgg = records.filter((record) => record.agg.hits === 0).length
const dupQueries = records.filter((record) => record.now.duplicateSlots > 0).length
const dupSlots = records.reduce((sum, record) => sum + record.now.duplicateSlots, 0)
const nowDistinct = records.reduce((sum, record) => sum + record.now.distinctSessions, 0)
const aggDistinct = records.reduce((sum, record) => sum + record.agg.distinctSessions, 0)
const top1Same = records.filter((record) => record.now.top !== null && record.agg.top !== null && record.now.top.id === record.agg.top.id).length
const fallbackNow = records.filter((record) => record.now.fallback).length
const fallbackAgg = records.filter((record) => record.agg.fallback).length
const avg = (value) => (n === 0 ? 0 : Math.round((value / n) * 100) / 100)

console.log('样本：' + n + ' 条提问，来自 ' + new Set(records.map((record) => record.session)).size + ' 个会话，最近 ' + DAYS + ' 天')
console.log('口径：主题内 ≥' + TOPIC_MIN + ' / 全局 ≥' + GLOBAL_MIN + ' / 每次 3 行；query 排除了它自己所在的会话')
console.log('')
console.log('指标 | 现状（按钩子） | 聚合（按会话）')
console.log('命中行数合计 | ' + nowHits + ' | ' + aggHits)
console.log('零命中 query | ' + emptyNow + ' | ' + emptyAgg)
console.log('平均行数 | ' + avg(nowHits) + ' | ' + avg(aggHits))
console.log('平均覆盖会话数 | ' + avg(nowDistinct) + ' | ' + avg(aggDistinct))
console.log('同一会话重复占位的 query 数 | ' + dupQueries + ' | 0（按构造）')
console.log('被浪费的注入位合计 | ' + dupSlots + ' | 0')
console.log('走全局兜底的 query 数 | ' + fallbackNow + ' | ' + fallbackAgg)
console.log('top1 与现状一致 | ' + top1Same + ' / ' + records.filter((r) => r.now.top !== null).length)
console.log('')
console.log('主题判定（关键词判定 vs GLM 打标，仅统计有主题的 ' + withExpected.length + ' 条）一致：' + topicAgree + '（' + (withExpected.length === 0 ? 0 : Math.round((topicAgree / withExpected.length) * 1000) / 10) + '%），判定为空 ' + matchedNone + ' 条')

// ── 为什么零命中：阈值 vs 主题门 ────────────────────────────────────────────
const bucket = (score) => (score === 0 ? '0（完全没匹配）' : score < 0.2 ? '0–0.2' : score < 0.4 ? '0.2–0.4' : score < 0.6 ? '0.4–0.6' : '≥0.6')
const countBuckets = (key) => {
  const map = new Map()
  for (const record of records) {
    const label = bucket(record[key])
    map.set(label, (map.get(label) || 0) + 1)
  }
  return [...map.entries()].sort().map(([label, count]) => label + ': ' + count).join('  ')
}
const passAt = (threshold, key) => records.filter((record) => record[key] >= threshold).length
const lenOf = (list) => (list.length === 0 ? 0 : Math.round(list.reduce((sum, item) => sum + item.queryLen, 0) / list.length))
const hitRecords = records.filter((record) => record.now.hits > 0)
const missRecords = records.filter((record) => record.now.hits === 0)
console.log('')
console.log('最高分分布（主题内检索，不过阈值）：' + countBuckets('bestScoped'))
console.log('最高分分布（全局检索，不过阈值）  ：' + countBuckets('bestGlobal'))
console.log('放宽阈值后能命中的 query 数：≥0.45 ' + passAt(0.45, 'bestScoped') + ' ｜ ≥0.3 ' + passAt(0.3, 'bestScoped') + ' ｜ ≥0.2 ' + passAt(0.2, 'bestScoped') + ' ｜ ≥0.1 ' + passAt(0.1, 'bestScoped'))
console.log('只去掉主题门（全局检索 ≥0.45）能命中：' + passAt(0.45, 'bestGlobal') + ' 条（现状主题内 ≥0.45 是 ' + passAt(0.45, 'bestScoped') + ' 条）')
console.log('命中 query 平均长度 ' + lenOf(hitRecords) + ' 字；零命中 query 平均长度 ' + lenOf(missRecords) + ' 字')

// ── 第三种取法：主题当加权而不是门槛 ────────────────────────────────────────
const boostHits = records.reduce((sum, record) => sum + record.boost.hits, 0)
const boostEmpty = records.filter((record) => record.boost.hits === 0).length
const nowTop = records.filter((record) => record.now.top !== null)
const boostTopSame = nowTop.filter((record) => record.boost.top !== null && record.boost.top.id === record.now.top.id).length
const recovered = records.filter((record) => record.now.hits === 0 && record.boost.hits > 0)
console.log('')
console.log('主题当加权（全局候选 + 同主题 ×1.25）：命中行数合计 ' + boostHits + '，零命中 ' + boostEmpty + ' 条，top1 与现状一致 ' + boostTopSame + ' / ' + nowTop.length)
console.log('现状零命中但加权后能命中的 query：' + recovered.length + ' 条')
if (recovered.length > 0) {
  console.log('  其中前 5 条（看它捞回来的是什么）：')
  for (const record of recovered.slice(0, 5)) {
    console.log('  · query：' + record.query.slice(0, 50))
    console.log('      捞回：[' + record.boost.top.id + '] score=' + record.boost.top.score + ' topic=' + (record.boost.top.topic || '(无)') + ' ' + record.boost.top.title.slice(0, 40))
  }
}

// 覆盖会话数的分布
const histogram = (list) => {
  const map = new Map()
  for (const value of list) map.set(value, (map.get(value) || 0) + 1)
  return [...map.entries()].sort((left, right) => left[0] - right[0]).map(([value, count]) => value + '个会话:' + count).join('  ')
}
console.log('覆盖会话数分布 | 现状 ' + histogram(records.map((record) => record.now.distinctSessions)))
console.log('                 | 聚合 ' + histogram(records.map((record) => record.agg.distinctSessions)))

// ── 例子 ────────────────────────────────────────────────────────────────────
const examples = records.filter((record) => record.now.duplicateSlots > 0).slice(0, 6)
if (examples.length > 0) {
  console.log('\n=== 重复占位的例子（现状 3 行里有同一会话的多条）===')
  for (const record of examples) {
    console.log('\nquery：' + record.query.slice(0, 60))
    console.log('  判定主题：' + (record.matchedTopic === null ? '(无)' : record.matchedTopic + ' ' + topicName(record.matchedTopic)))
    console.log('  现状：')
    for (const hit of record.now.list) console.log('    · ' + short(hit.session) + '  score=' + hit.score + '  ' + hit.title.slice(0, 34))
    console.log('  聚合：')
    for (const entry of record.agg.list) console.log('    · ' + short(entry.session) + '  score=' + entry.score + '  ' + entry.title.slice(0, 34) + '  (该会话命中 ' + entry.hooks + ' 条)')
  }
}

function short(id) {
  return String(id).replace(/^session-/, '').slice(0, 12).padEnd(12, ' ')
}

const out = path.join(tmpdir(), 'recall-ab.json')
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), queries: n, days: DAYS, records }, null, 2), 'utf8')
console.log('\n原始记录：' + out)
