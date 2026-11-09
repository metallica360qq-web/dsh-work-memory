#!/usr/bin/env node
/**
 * 用真实会话事件回放，验证自动捕获在真实数据上的行为。
 * 沙箱 DSH_HOME，不污染真实账本。
 *
 *   node cli/replay.js <sessionId> [maxSeq]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionEvents } from '../lib/sessionlog.js'

const sessionId = process.argv[2]
if (!sessionId) {
  console.error('用法：node cli/replay.js <sessionId>')
  process.exit(2)
}

const sandbox = mkdtempSync(join(tmpdir(), 'wm-replay-'))
process.env.DSH_WORK_MEMORY_DIR = join(sandbox, 'work-memory')
const { apply } = await import('../lib/index.js')

const handlers = []
const tools = []
const ctx = {
  on: (name, fn) => {
    handlers.push({ name, fn })
    return () => {}
  },
  systemPrompt: { context: () => () => {} },
  tools: { register: (t) => tools.push(t) },
}
apply(ctx)

const { events, frames, file } = readSessionEvents(sessionId)
if (events.length === 0) {
  console.log('读不到事件：' + sessionId + ' file=' + file)
  process.exit(1)
}

const session = { id: sessionId, header: { cwd: process.cwd() } }
const feed = (ev) => {
  for (const h of handlers) if (h.name === 'session/event') h.fn(session, ev)
}

let n = 0
for (const ev of events) {
  if (typeof ev.seq !== 'number') continue
  feed(ev)
  n += 1
}

const hooksPath = join(sandbox, 'work-memory', 'hooks.jsonl')
let rows = []
try {
  rows = readFileSync(hooksPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
} catch {
  rows = []
}
const auto = rows.filter((r) => r.kind === 'auto')
console.log('file=' + file)
console.log('frames=' + frames + ' events=' + events.length + ' fed=' + n)
console.log('hooks total=' + rows.length + ' auto=' + auto.length)
const withArt = auto.filter((r) => r.artifacts.length > 0).length
console.log('auto with artifacts=' + withArt)
for (const r of auto.slice(0, 6)) {
  console.log('  ' + r.id + ' seq ' + r.startSeq + '-' + r.endSeq + ' | ' + r.title.slice(0, 60) + ' | art=' + r.artifacts.length)
}
if (auto.length > 0) {
  const spans = auto.map((r) => r.endSeq - r.startSeq).sort((a, b) => a - b)
  console.log('span median=' + spans[Math.floor(spans.length / 2)] + ' max=' + spans[spans.length - 1])
}

rmSync(sandbox, { recursive: true, force: true })
