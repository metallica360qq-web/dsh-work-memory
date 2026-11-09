#!/usr/bin/env node
/**
 * 把全量重建结果并入真实账本。
 *
 *   node cli/merge-rebuilt.js [--out <hooks.jsonl>] [--rebuilt rebuilt.jsonl] [--scan scan-sessions.json] [--lite]
 *
 * 规则：
 *   1. rebuilt 覆盖的会话，先删掉账本里该会话的 module 级旧条目（保留 turn/manual）
 *   2. 写入 rebuilt 的模块
 *   3. --lite：userMsgs 1~2 的短会话（id 以 session- 开头）按规则补一条 module 级钩子
 *   4. 合并前备份原账本为 hooks.jsonl.bak-<时间戳>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { dshHome, readSessionEvents } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}

const outFile = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')
const rebuiltFile = args.rebuilt || 'rebuilt.jsonl'
const scanFile = args.scan || 'scan-sessions.json'
const lite = Boolean(args.lite)

const readJsonl = (file) => {
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* ignore */
    }
  }
  return rows
}

const existing = readJsonl(outFile)
const rebuilt = readJsonl(rebuiltFile)
const rebuiltSessions = new Set(rebuilt.map((r) => r.session))

const kept = existing.filter((r) => !(r.level !== 'turn' && rebuiltSessions.has(r.session) && r.kind !== 'manual'))

const merged = [...kept]
let moduleCount = 0
for (const rec of rebuilt) {
  for (const m of rec.modules || []) {
    merged.push({ ...m, level: 'module' })
    moduleCount += 1
  }
}

let liteCount = 0
if (lite && existsSync(scanFile)) {
  const scan = JSON.parse(readFileSync(scanFile, 'utf8'))
  const covered = new Set([...rebuiltSessions, ...merged.map((r) => r.session)])
  const shortSessions = scan.rows.filter(
    (r) => r.userMsgs >= 1 && r.userMsgs <= 2 && r.id.startsWith('session-') && !covered.has(r.id),
  )
  for (const s of shortSessions) {
    const { events } = readSessionEvents(s.id)
    const users = events.filter(
      (e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user',
    )
    if (users.length === 0) continue
    const first = users[0]
    const text = (first.data.content || []).map((b) => b.text || '').join('').trim()
    if (text.length === 0) continue
    const lastSeq = events[events.length - 1].seq || first.seq
    merged.push({
      id: 's-' + s.id.slice(-8),
      session: s.id,
      startSeq: first.seq,
      endSeq: lastSeq + 1,
      ask: text.replace(/\s+/g, ' ').slice(0, 200),
      title: text.split(/[。！？\n]/)[0].replace(/\s+/g, ' ').slice(0, 60),
      kind: 'auto',
      level: 'turn',
      artifacts: [],
      ts: new Date(first.time).toISOString(),
      agent: 'dsh',
      status: 'active',
    })
    liteCount += 1
  }
}

// 去重：同 id 保留后者
const byId = new Map()
for (const r of merged) byId.set(r.id, r)
const finalRows = [...byId.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
if (existsSync(outFile)) copyFileSync(outFile, outFile + '.bak-' + ts)
writeFileSync(outFile, finalRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const modules = finalRows.filter((r) => r.level === 'module').length
const turns = finalRows.filter((r) => r.level === 'turn').length
console.log('existing=' + existing.length + ' rebuiltSessions=' + rebuiltSessions.size + ' addedModules=' + moduleCount)
console.log('lite=' + liteCount + ' final=' + finalRows.length + ' (module=' + modules + ', turn=' + turns + ')')
console.log('backup=' + (existsSync(outFile + '.bak-' + ts) ? outFile + '.bak-' + ts : '(none)'))
