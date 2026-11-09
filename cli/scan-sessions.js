#!/usr/bin/env node
/**
 * 扫描本机全部 DSH 会话，统计每个会话的规模与用户提问数。
 * 只读，输出 JSON 清单，供全量重建筛选。
 *
 *   node cli/scan-sessions.js <out.json>
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents, sessionsRoot } from '../lib/sessionlog.js'

const out = process.argv[2]
if (!out) {
  console.error('用法：node cli/scan-sessions.js <out.json>')
  process.exit(2)
}

const dirs = []
const walk = (dir, depth) => {
  if (depth > 2) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(dir, e.name)
    if (e.name.startsWith('session-') || /^[0-9a-f]{8}-/.test(e.name)) {
      dirs.push({ id: e.name, path: p })
    } else if (depth < 2) {
      walk(p, depth + 1)
    }
  }
}
walk(sessionsRoot(), 0)

const rows = []
let done = 0
for (const d of dirs) {
  done += 1
  const { events, frames, bytes, file } = readSessionEvents(d.id)
  if (events.length === 0) {
    rows.push({ id: d.id, file, bytes, frames, events: 0, userMsgs: 0, firstTs: null, lastTs: null })
    continue
  }
  const users = events.filter(
    (e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user',
  )
  const first = events[0]
  const last = events[events.length - 1]
  rows.push({
    id: d.id,
    file,
    bytes,
    frames,
    events: events.length,
    userMsgs: users.length,
    firstTs: first && typeof first.time === 'number' ? new Date(first.time).toISOString() : null,
    lastTs: last && typeof last.time === 'number' ? new Date(last.time).toISOString() : null,
  })
  if (done % 50 === 0) console.log('scanned ' + done + '/' + dirs.length)
}

rows.sort((a, b) => b.userMsgs - a.userMsgs)
writeFileSync(out, JSON.stringify({ total: rows.length, rows }, null, 2), 'utf8')
const withContent = rows.filter((r) => r.userMsgs >= 3)
console.log('sessions=' + rows.length + ' with>=3 userMsgs=' + withContent.length)
console.log('top5=' + JSON.stringify(rows.slice(0, 5).map((r) => [r.id, r.userMsgs, r.events])))
