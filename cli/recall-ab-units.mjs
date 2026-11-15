#!/usr/bin/env node
/**
 * recall-ab-units.mjs — 段级注入 vs 钩子级注入的离线对账。
 *
 *   node cli/recall-ab-units.mjs [--limit 60] [--examples 8]
 *
 * 对每个抽样查询，用生产同款检索（searchHooks + 主题门）取命中，然后分别按
 * 「一行一条钩子」和「一行一段」渲染注入文本，对比：
 *   · 覆盖的会话数 / 重复会话占位（同一次工作被拆成几行）
 *   · 每行携带的上下文（段标签 vs 裸标题）
 *   · 文本长度
 * 真实相关性要靠人工判定，这里只给结构数据和样例，别拿结构当结论。
 */
import { loadHooks, searchHooks, formatLine } from '../lib/store.js'
import { matchTopic } from '../lib/topics.js'
import { isHumanRow } from '../lib/origin.js'
import { isBoilerplate } from '../lib/browse.js'
import { recallUnits, formatUnitLine, loadSegmentMap } from '../lib/units.js'
import { dshHome } from '../lib/sessionlog.js'
import { join } from 'node:path'

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const LIMIT = num('--limit', 60)
const segmentFile = join(dshHome(), 'work-memory', 'segments.jsonl')
const segmentTable = loadSegmentMap(segmentFile)
const EXAMPLES = num('--examples', 8)

const all = loadHooks()
// 抽样：全账本按时间分层，挑有信息量的提问（长一点、不是评判员任务书、不是样板）
const segmentedOnly = args.includes('--from-segmented')
const segmentedSessions = new Set([...segmentTable.keys()].map((key) => key.split('#')[0]))
const pool = all
  .filter((row) => isHumanRow(row) && !isBoilerplate(row))
  .filter((row) => !segmentedOnly || segmentedSessions.has(row.session))
  .filter((row) => String(row.ask || '').trim().length >= 12)
  .filter((row) => !String(row.ask || '').trim().startsWith('你是'))
  .sort((left, right) => String(left.ts).localeCompare(String(right.ts)))
const stride = Math.max(1, Math.floor(pool.length / LIMIT))
const queries = []
for (let i = 0; i < pool.length && queries.length < LIMIT; i += stride) queries.push(pool[i])

const stats = {
  queries: 0,
  hitQueries: 0,
  hooks: { lines: 0, sessions: new Set(), duplicateSlots: 0, chars: 0 },
  units: { lines: 0, sessions: new Set(), duplicateSlots: 0, chars: 0, segLines: 0, multi: 0 },
  examples: [],
}

for (const query of queries) {
  const queryText = String(query.ask || '').trim()
  const topic = matchTopic(queryText)
  const minScore = topic !== null ? 0.45 : 0.6
  let hits = searchHooks(queryText, 8, { excludeSession: query.session, topic: topic || undefined, humanOnly: true })
    .filter((hit) => hit.score >= minScore)
  if (hits.length === 0 && topic !== null) {
    hits = searchHooks(queryText, 6, { excludeSession: query.session, humanOnly: true }).filter((hit) => hit.score >= 0.6)
  }
  stats.queries += 1
  if (hits.length === 0) continue
  stats.hitQueries += 1

  // A：钩子级（生产默认）
  const hookLines = hits.slice(0, 3).map((hit) => formatLine(hit))
  const hookSessions = hits.slice(0, 3).map((hit) => hit.session)
  stats.hooks.lines += hookLines.length
  for (const id of new Set(hookSessions)) stats.hooks.sessions.add(id)
  stats.hooks.duplicateSlots += hookSessions.length - new Set(hookSessions).size
  stats.hooks.chars += hookLines.join('\n').length

  // B：段级
  const units = recallUnits(hits, segmentTable).slice(0, 3)
  const unitLines = units.map((unit) => formatUnitLine(unit))
  const unitSessions = units.map((unit) => unit.top.session)
  stats.units.lines += unitLines.length
  for (const id of new Set(unitSessions)) stats.units.sessions.add(id)
  stats.units.duplicateSlots += unitSessions.length - new Set(unitSessions).size
  stats.units.chars += unitLines.join('\n').length
  stats.units.segLines += units.filter((unit) => typeof unit.top.segLabel === 'string' && unit.top.segLabel !== '').length
  stats.units.multi += units.filter((unit) => unit.hits.length > 1).length
  // 命中里有多少条属于「被切过段」的会话——只有这些才可能从段级注入里获益
  stats.segmentedHits = (stats.segmentedHits || 0) + hits.filter((hit) => typeof hit.segment === 'string' && hit.segment !== '').length

  if (stats.examples.length < EXAMPLES) {
    stats.examples.push({ query: queryText.slice(0, 50), topic, a: hookLines, b: unitLines })
  }
}

const pct = (part, total) => (total === 0 ? '0%' : Math.round((part / total) * 1000) / 10 + '%')
console.log('查询 ' + stats.queries + ' 条，有命中 ' + stats.hitQueries + ' 条（' + pct(stats.hitQueries, stats.queries) + '）')
console.log('')
console.log('指标                      钩子级        段级')
console.log('注入行数                  ' + String(stats.hooks.lines).padEnd(14) + stats.units.lines)
console.log('覆盖会话数                ' + String(stats.hooks.sessions.size).padEnd(14) + stats.units.sessions.size)
console.log('同会话重复占位            ' + String(stats.hooks.duplicateSlots).padEnd(14) + stats.units.duplicateSlots)
console.log('平均每行字数              ' + String(Math.round(stats.hooks.chars / Math.max(1, stats.hooks.lines))).padEnd(14) + Math.round(stats.units.chars / Math.max(1, stats.units.lines)))
console.log('带段标签的行              -              ' + stats.units.segLines + '/' + stats.units.lines)
console.log('跨多条钩子的行            -              ' + stats.units.multi + '/' + stats.units.lines)
console.log('')
for (const example of stats.examples) {
  console.log('查询：' + example.query + (example.topic === null ? '' : '（主题 ' + example.topic + '）'))
  console.log('  A 钩子级：')
  for (const line of example.a) console.log('    ' + line)
  console.log('  B 段级：')
  for (const line of example.b) console.log('    ' + line)
  console.log('')
}
