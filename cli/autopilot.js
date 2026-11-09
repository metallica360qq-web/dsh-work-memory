#!/usr/bin/env node
/**
 * autopilot：扫最近改动的 DSH 会话，把还没归块的交给 rebuild-one。
 *
 *   node cli/autopilot.js [--hours 24] [--limit 5] [--dry]
 *
 * 设计成"可以被计划任务直接调"的幂等形式：已经全部是 module 级的会话会被跳过。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dshHome, findSessionFile, readSessionEvents } from '../lib/sessionlog.js'

const REBUILD_ONE = fileURLToPath(new URL('./rebuild-one.js', import.meta.url))

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const hours = Number(args.hours || 24)
const limit = Number(args.limit || 5)
const dry = Boolean(args.dry)
const ledger = join(dshHome(), 'work-memory', 'hooks.jsonl')

const rows = existsSync(ledger)
  ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []
const bySession = new Map()
for (const r of rows) {
  if (!bySession.has(r.session)) bySession.set(r.session, { module: 0, turn: 0, lastTs: '' })
  const s = bySession.get(r.session)
  if (r.level === 'module') s.module += 1
  else s.turn += 1
  if (String(r.ts) > s.lastTs) s.lastTs = String(r.ts)
}

// 扫最近改动过的会话
const cutoff = Date.now() - hours * 3600 * 1000
const candidates = []
const seen = new Set()
for (const [sid, stat] of bySession) {
  void sid
  void stat
}
// 从账本里找最近有 turn 条目但没 module 的会话
for (const [sid, s] of bySession) {
  if (s.module > 0) continue
  if (s.turn === 0) continue
  const found = findSessionFile(sid)
  if (found === null) continue
  if (found.mtimeMs < cutoff) continue
  candidates.push({ sid, mtime: found.mtimeMs, turns: s.turn })
}
candidates.sort((a, b) => b.mtime - a.mtime)
const todo = candidates.slice(0, limit)

console.log('ledger=' + rows.length + ' sessions=' + bySession.size + ' candidates=' + candidates.length + ' todo=' + todo.length)
if (dry) {
  for (const c of todo) console.log('  would rebuild ' + c.sid + ' turns=' + c.turns)
  process.exit(0)
}

let ok = 0
let fail = 0
for (const c of todo) {
  const { events } = readSessionEvents(c.sid)
  const users = events.filter(
    (e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user',
  )
  if (users.length < 3) {
    console.log('  skip ' + c.sid + ' users=' + users.length)
    continue
  }
  const r = spawnSync(process.execPath, [REBUILD_ONE, '--session', c.sid], {
    encoding: 'utf8',
  })
  if (r.status === 0) {
    ok += 1
    console.log('  rebuilt ' + c.sid + ' | ' + String(r.stdout || '').split('\n')[0])
  } else {
    fail += 1
    console.log('  fail ' + c.sid + ' | ' + String(r.stderr || r.stdout || '').split('\n')[0])
  }
}
console.log('done ok=' + ok + ' fail=' + fail)
