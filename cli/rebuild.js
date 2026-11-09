#!/usr/bin/env node
/**
 * 全量重建：用 GLM 把每个会话的提问清单分成模块，写成模块级钩子。
 *
 *   node cli/rebuild.js --scan scan-sessions.json --out rebuilt.jsonl \
 *        [--min-asks 3] [--limit 0] [--concurrency 3] [--model glm-5.3-flash]
 *
 * 断点续跑：out 文件里已出现的会话会跳过。
 * 只读会话日志；不写真实账本（合并另跑 cli/merge-rebuilt.js）。
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readSessionEvents } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}

const scanFile = args.scan || 'scan-sessions.json'
const outFile = args.out || 'rebuilt.jsonl'
const minAsks = Number(args['min-asks'] || 3)
const limit = Number(args.limit || 0)
const concurrency = Math.max(1, Number(args.concurrency || 3))
const model = args.model || 'glm-5.3-flash'

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const API_KEY = __llm.key
const ENDPOINT = __llm.baseUrl

const scan = JSON.parse(readFileSync(scanFile, 'utf8'))
let targets = scan.rows.filter((r) => r.userMsgs >= minAsks && r.events > 0)
if (limit > 0) targets = targets.slice(0, limit)

const done = new Set()
if (existsSync(outFile)) {
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      done.add(JSON.parse(line).session)
    } catch {
      /* ignore */
    }
  }
}
const todo = targets.filter((t) => !done.has(t.id))
console.log(`targets=${targets.length} already=${done.size} todo=${todo.length} concurrency=${concurrency}`)

const TEMP_MARKERS = ['\\appdata\\local\\temp\\', '\\temp\\', 'node_modules', '\\.git\\']
function isJunk(p) {
  const low = String(p).toLowerCase().replace(/\//g, '\\')
  return low.endsWith('.tmp') || TEMP_MARKERS.some((m) => low.includes(m))
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks.trim() : ''
  const out = []
  for (const b of blocks) if (b && typeof b.text === 'string') out.push(b.text)
  return out.join('').trim()
}

function extractQuestions(events) {
  const qs = []
  let cur = null
  for (const ev of events) {
    if (ev.type === 'user/message') {
      const src = ev.data && ev.data.source ? ev.data.source.kind : 'none'
      if (src !== 'user') continue
      const text = blocksToText(ev.data && ev.data.content)
      if (text.length === 0) continue
      cur = { seq: ev.seq, time: ev.time, ask: text.replace(/\s+/g, ' ').slice(0, 220), after: '', artifacts: [] }
      qs.push(cur)
    } else if (ev.type === 'assistant/message' && cur !== null && cur.after.length === 0) {
      const t = blocksToText(ev.data && ev.data.message ? ev.data.message.content : ev.data && ev.data.content)
      if (t.length > 0) cur.after = t.slice(0, 80)
    } else if (ev.type === 'tool/call' && cur !== null) {
      const n = ev.data && ev.data.name
      if (n === 'write' || n === 'edit') {
        try {
          const a = JSON.parse(ev.data.arguments)
          if (typeof a.file_path === 'string' && !isJunk(a.file_path)) cur.artifacts.push(a.file_path)
        } catch {
          /* ignore */
        }
      }
    }
  }
  return qs
}

function buildPrompt(qs) {
  const lines = qs.map((q, i) => {
    const parts = ['Q' + (i + 1), q.ask]
    if (q.after.length > 0) parts.push('after: ' + q.after)
    if (q.artifacts.length > 0) parts.push('art: ' + q.artifacts.map((p) => basename(p)).slice(0, 3).join(','))
    return parts.join(' | ')
  })
  return [
    '下面是一个 AI 编程助手会话里，用户先后提出的 ' + qs.length + ' 条提问（编号 Q1..Qn，含助手首句与产物文件名）。',
    '请按「用户的工作目标变化」把它们划成模块（模块间是任务切换，不是按时间切），每个模块给一个小标题。',
    '',
    '要求：',
    '1. 标题写清做了什么 + 关键实体（如「003 正偏财：稿子定稿与分屏」），禁止用「优化」「探索」「改进」「讨论」这类空词单独成题。',
    '2. 每个模块至少 2 条提问；长模块（60 条以上）允许保留，不硬拆；单条提问的模块只在确实独立时才出现。',
    '3. 只输出 JSON 数组，每项 {"title":"...","q_start":1,"q_end":16,"kind":"设计|实现|制作|问答|复盘|杂项"}。不要代码块标记，不要解释。',
    '',
    '提问清单：',
    lines.join('\n'),
  ].join('\n')
}

async function callGlm(prompt) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 8192,
    stream: false,
    thinking: { type: 'disabled' },
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200))
  const json = JSON.parse(text)
  if (json.error) throw new Error('api: ' + JSON.stringify(json.error).slice(0, 200))
  const content = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : ''
  return { content: String(content || ''), usage: json.usage || null }
}

function parseModules(content) {
  let s = String(content).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  const arr = JSON.parse(s)
  if (!Array.isArray(arr)) throw new Error('not an array')
  return arr
    .filter((m) => m && Number.isFinite(m.q_start) && Number.isFinite(m.q_end) && typeof m.title === 'string')
    .map((m) => ({ title: String(m.title).slice(0, 120), q_start: m.q_start, q_end: m.q_end, kind: String(m.kind || 'other') }))
}

async function handle(item, idx, total) {
  const t0 = Date.now()
  const { events } = readSessionEvents(item.id)
  const qs = extractQuestions(events)
  if (qs.length === 0) {
    console.log(`[${idx}/${total}] ${item.id} SKIP no questions`)
    return
  }
  const prompt = buildPrompt(qs)
  let content = ''
  let usage = null
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await callGlm(prompt)
      content = r.content
      usage = r.usage
      break
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  if (content.length === 0) {
    console.log(`[${idx}/${total}] ${item.id} FAIL ${lastErr ? lastErr.message : 'empty'}`)
    appendFileSync('rebuilt-failed.jsonl', JSON.stringify({ session: item.id, error: String(lastErr) }) + '\n', 'utf8')
    return
  }
  let mods
  try {
    mods = parseModules(content)
  } catch (e) {
    console.log(`[${idx}/${total}] ${item.id} PARSE_FAIL ${String(e).slice(0, 80)}`)
    appendFileSync('rebuilt-failed.jsonl', JSON.stringify({ session: item.id, error: 'parse: ' + String(e), raw: content.slice(0, 400) }) + '\n', 'utf8')
    return
  }
  const lastSeq = events[events.length - 1].seq || qs[qs.length - 1].seq
  const rows = []
  mods.forEach((m, mi) => {
    const s = qs[m.q_start - 1]
    if (!s) return
    const nextStart = mi + 1 < mods.length ? qs[mods[mi + 1].q_start - 1] : null
    const endSeq = nextStart ? nextStart.seq : lastSeq + 1
    const arts = new Set()
    for (let i = m.q_start - 1; i <= m.q_end - 1 && i < qs.length; i += 1) {
      for (const a of qs[i].artifacts) arts.add(a)
    }
    rows.push({
      id: 'r-' + item.id.slice(-8) + '-' + String(mi + 1).padStart(2, '0'),
      session: item.id,
      startSeq: s.seq,
      endSeq,
      ask: s.ask.slice(0, 200),
      title: m.title,
      kind: m.kind,
      level: 'module',
      artifacts: [...arts],
      ts: new Date(s.time).toISOString(),
      agent: 'dsh',
      status: 'active',
    })
  })
  appendFileSync(outFile, JSON.stringify({ session: item.id, modules: rows, usage, ms: Date.now() - t0 }) + '\n', 'utf8')
  console.log(`[${idx}/${total}] ${item.id} ok modules=${rows.length} qs=${qs.length} ${Math.round((Date.now() - t0) / 1000)}s tokens=${usage ? usage.total_tokens : '?'}`)
}

let cursor = 0
let finished = 0
const workers = Array.from({ length: concurrency }, async () => {
  for (;;) {
    const my = cursor
    cursor += 1
    if (my >= todo.length) return
    finished += 1
    await handle(todo[my], finished, todo.length)
  }
})
await Promise.all(workers)
console.log('done')
