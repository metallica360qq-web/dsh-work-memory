/**
 * 相关性抽样：给「降阈值 / 主题当加权」找依据。
 *
 * 用法：node scripts/recall-label.mjs [--per-group 40]
 *
 * 两组对照（同一批提问池，同一个检索实现，只差阈值）：
 *   A 组「被阈值挡掉的」：现状 0 命中，但放宽到 ≥0.3 有候选
 *   B 组「现在就能召回的」：现状 top1 ≥0.45
 * 只有 A 的精确率接近 B，降阈值才划算；否则就是在拿噪声换命中率。
 *
 * 输出 %TEMP%\recall-label.json，交给独立的评判者逐条判「这条候选对这个提问有用吗」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WM_ROOT = process.env.WM_ROOT || 'D:/Program Files/工作文件夹/dsh-work-memory'
const { searchHooks } = await import(pathToFileURL(path.join(WM_ROOT, 'lib/store.js')).href)
const { matchTopic } = await import(pathToFileURL(path.join(WM_ROOT, 'lib/topics.js')).href)

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const PER_GROUP = argOf('--per-group', 40)
const DAYS = 120
const RELAXED_MIN = 0.3
const NOW_MIN = 0.45
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
  .filter((row) => row !== null && String(row.ask || '').trim().length >= 8 && Date.parse(String(row.ts)) >= Date.now() - DAYS * 86400_000)
  .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))

/** 现状召回（与 recall 注入同一套逻辑）。 */
function recallNow(query, sessionId) {
  const topic = matchTopic(query)
  const minScore = topic !== null ? NOW_MIN : GLOBAL_MIN
  let hits = searchHooks(query, 3, { excludeSession: sessionId, topic: topic || undefined }).filter((hit) => hit.score >= minScore)
  if (hits.length === 0 && topic !== null) {
    hits = searchHooks(query, 2, { excludeSession: sessionId }).filter((hit) => hit.score >= GLOBAL_MIN)
  }
  return { topic, hits }
}

/** 放宽到 0.3 的候选（同样主题内优先、再全局兜底）。 */
function candidatesRelaxed(query, sessionId) {
  const topic = matchTopic(query)
  let pool = searchHooks(query, 5, { excludeSession: sessionId, topic: topic || undefined }).filter((hit) => hit.score >= RELAXED_MIN)
  if (pool.length === 0) pool = searchHooks(query, 5, { excludeSession: sessionId }).filter((hit) => hit.score >= RELAXED_MIN)
  return { topic, pool }
}

const brief = (hit) => ({
  id: hit.id,
  session: hit.session,
  agent: hit.agent,
  topic: hit.topic || '',
  ts: String(hit.ts).slice(0, 10),
  score: hit.score,
  title: String(hit.title || '').slice(0, 120),
  ask: String(hit.ask || '').replace(/\s+/g, ' ').slice(0, 240),
  artifacts: (hit.artifacts || []).map((item) => String(item).split(/[\\/]/).pop()).slice(0, 4),
})

const groupA = []
const groupB = []
const aPool = []
const bPool = []
// 每条 query 要跑 2–4 次全账本检索，1148 行全跑太慢；等间隔取 240 行做候选池，够抽两组各 40
const MAX_ROWS = 240
const rowStep = Math.max(1, Math.floor(rows.length / MAX_ROWS))
for (const row of rows.filter((_, index) => index % rowStep === 0).slice(0, MAX_ROWS)) {
  const query = String(row.ask).replace(/\s+/g, ' ').slice(0, 220)
  const now = recallNow(query, row.session)
  if (now.hits.length > 0) {
    bPool.push({ query, matchedTopic: now.topic || '', candidates: now.hits })
    continue
  }
  const relaxed = candidatesRelaxed(query, row.session)
  if (relaxed.pool.length === 0) continue
  aPool.push({ query, matchedTopic: now.topic || '', candidates: relaxed.pool.slice(0, 3) })
}

// 等间隔抽样：避免整个样本压在最近几天
const stride = (list, count) => {
  const step = Math.max(1, Math.floor(list.length / count))
  return list.filter((_, index) => index % step === 0).slice(0, count)
}

for (const item of stride(aPool, PER_GROUP)) {
  groupA.push({
    caseId: 'A' + String(groupA.length + 1).padStart(2, '0'),
    query: item.query,
    matchedTopic: item.matchedTopic,
    candidates: item.candidates.map((hit, index) => ({ ...brief(hit), slot: index + 1 })),
  })
}
for (const item of stride(bPool, PER_GROUP)) {
  groupB.push({
    caseId: 'B' + String(groupB.length + 1).padStart(2, '0'),
    query: item.query,
    matchedTopic: item.matchedTopic,
    candidates: item.candidates.map((hit, index) => ({ ...brief(hit), slot: index + 1 })),
  })
}

const payload = {
  generatedAt: new Date().toISOString(),
  ledger: ledgerFile,
  thresholds: { now: NOW_MIN, relaxed: RELAXED_MIN, global: GLOBAL_MIN },
  instructions: {
    groupA: '现状 0 命中、放宽阈值后才有的候选（判断放宽是否带来真相关）',
    groupB: '现状就能召回的候选（作为精确率基线）',
    rule: 'relevant=true 的条件：这条候选记录里的工作，是同一个提问者当下这件事的直接前情/同一件事，读它能帮上忙。仅仅"同属一个大主题"不算。',
  },
  groupA,
  groupB,
}

const out = path.join(tmpdir(), 'recall-label.json')
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')

// 盲评文件：把两组混在一起、去掉组别，只留 caseId，避免评判者按组别调节尺度
const blind = [...groupA, ...groupB].map((item) => ({ query: item.query, candidates: item.candidates }))
let seed = 20261114
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
for (let i = blind.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1))
  const temp = blind[i]
  blind[i] = blind[j]
  blind[j] = temp
}
const blindPayload = {
  generatedAt: new Date().toISOString(),
  rule: payload.instructions.rule,
  note: '80 个提问，每个最多 3 个候选；逐条判断候选是否对提问有用，不要区分组别（没有组别）。',
  cases: blind.map((item, index) => ({ caseId: 'C' + String(index + 1).padStart(3, '0'), query: item.query, candidates: item.candidates })),
}
const blindOut = path.join(tmpdir(), 'recall-label-blind.json')
writeFileSync(blindOut, JSON.stringify(blindPayload, null, 2), 'utf8')

console.log('A 组（放宽才有候选）：' + groupA.length + ' 条，候选 ' + groupA.reduce((sum, item) => sum + item.candidates.length, 0) + ' 个')
console.log('B 组（现状能召回）：' + groupB.length + ' 条，候选 ' + groupB.reduce((sum, item) => sum + item.candidates.length, 0) + ' 个')
console.log('待评判文件（带组别，给统计用）：' + out)
console.log('盲评文件（给评判者）：' + blindOut)
