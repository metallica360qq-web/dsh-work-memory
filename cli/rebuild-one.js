#!/usr/bin/env node
/**
 * 单会话归块：把一个 DSH 会话的 turn 级条目替换成 module 级（GLM 分组）。
 *
 *   node cli/rebuild-one.js --session <sessionId> [--min-asks 3] [--keep-turn]
 *
 * 供 autopilot / 计划任务调用；不依赖 DSH 运行时。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome, readSessionEvents } from '../lib/sessionlog.js'
import { updateLedger } from '../lib/store.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const sessionId = args.session
if (!sessionId) {
  console.error('用法：node cli/rebuild-one.js --session <sessionId>')
  process.exit(2)
}
const minAsks = Number(args['min-asks'] || 3)
const keepTurn = Boolean(args['keep-turn'])
const ledger = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const KEY = __llm.key
const ENDPOINT = __llm.baseUrl

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks.trim() : ''
  const out = []
  for (const b of blocks) if (b && typeof b.text === 'string') out.push(b.text)
  return out.join('').trim()
}

const { events } = readSessionEvents(sessionId)
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
        if (typeof a.file_path === 'string') cur.artifacts.push(a.file_path)
      } catch {
        /* ignore */
      }
    }
  }
}
if (qs.length < minAsks) {
  console.log('skip: questions=' + qs.length + ' < ' + minAsks)
  process.exit(0)
}

const list = qs
  .map((q, i) => {
    const parts = ['Q' + (i + 1), q.ask]
    if (q.after.length > 0) parts.push('after: ' + q.after)
    if (q.artifacts.length > 0) parts.push('art: ' + q.artifacts.map((p) => basename(p)).slice(0, 2).join(','))
    return parts.join(' | ')
  })
  .join('\n')

const prompt = [
  '下面是一个会话里用户先后提出的 ' + qs.length + ' 条提问（含助手首句与产物文件名）。',
  '按「用户的工作目标变化」划成模块，每个模块给一个小标题。',
  '要求：标题写清做了什么 + 关键实体，不用「优化/探索/讨论」这类空词；每模块至少 2 条；',
  '只输出 JSON 数组：[{"title":"...","q_start":1,"q_end":16,"kind":"设计|实现|制作|问答|复盘|杂项"}]，不要代码块。',
  '',
  list,
].join('\n')

async function callGlm() {
  const body = {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 8192,
    stream: false,
    thinking: { type: 'disabled' },
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const j = JSON.parse(text)
  return String((j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '') || '')
}

let content = ''
for (let attempt = 1; attempt <= 2; attempt += 1) {
  try {
    content = await callGlm()
    break
  } catch (e) {
    console.log('retry ' + attempt + ': ' + String(e).slice(0, 80))
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
}
if (content.length === 0) {
  console.log('fail: empty response')
  process.exit(1)
}
let s = content.trim()
const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
if (fence) s = fence[1].trim()
const a = s.indexOf('[')
const b = s.lastIndexOf(']')
if (a >= 0 && b > a) s = s.slice(a, b + 1)
const mods = JSON.parse(s)
if (!Array.isArray(mods) || mods.length === 0) {
  console.log('fail: no modules')
  process.exit(1)
}

const lastSeq = events[events.length - 1].seq || qs[qs.length - 1].seq
const newRows = []
mods.forEach((m, i) => {
  const start = qs[m.q_start - 1]
  if (!start) return
  const next = i + 1 < mods.length ? qs[mods[i + 1].q_start - 1] : null
  const arts = new Set()
  for (let k = m.q_start - 1; k <= m.q_end - 1 && k < qs.length; k += 1) for (const x of qs[k].artifacts) arts.add(x)
  newRows.push({
    schema: 1,
    id: 'm-' + sessionId.slice(-8) + '-' + String(i + 1).padStart(2, '0'),
    session: sessionId,
    startSeq: start.seq,
    endSeq: next ? next.seq : lastSeq + 1,
    ask: start.ask.slice(0, 200),
    title: String(m.title).slice(0, 120),
    kind: String(m.kind || 'other'),
    level: 'module',
    artifacts: [...arts],
    ts: new Date(start.time).toISOString(),
    agent: 'dsh',
    status: 'active',
  })
})

const existing = existsSync(ledger)
  ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
const isThisSessionModule = (r) => r.session === sessionId && r.level === 'module'
const kept = existing.filter((r) => !isThisSessionModule(r) && (keepTurn || !(r.session === sessionId && r.level === 'turn')))
const byId = new Map()
for (const r of kept) byId.set(r.id, r)
for (const r of newRows) byId.set(r.id, r)
const finalRows = [...byId.values()].sort((x, y) => String(x.ts).localeCompare(String(y.ts)))

// 锁内重新读最新账本再变换，避免覆盖插件在此期间追加的条目
updateLedger((rows) => {
  const kept = rows.filter((r) => !isThisSessionModule(r) && (keepTurn || !(r.session === sessionId && r.level === 'turn')))
  const merged = new Map()
  for (const r of kept) merged.set(r.id, r)
  for (const r of newRows) merged.set(r.id, r)
  return [...merged.values()].sort((x, y) => String(x.ts).localeCompare(String(y.ts)))
}, ledger)

console.log('session=' + sessionId + ' questions=' + qs.length + ' modules=' + newRows.length + ' final=' + finalRows.length)
for (const r of newRows.slice(0, 8)) console.log('  ' + r.id + ' ' + r.title)
