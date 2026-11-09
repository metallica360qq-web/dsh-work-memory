#!/usr/bin/env node
/**
 * 把 ZCode 的会话导入成钩子（每个会话一条 turn 级，标题=首问）。
 *
 *   node cli/ingest-zcode.js [--out ingest-zcode.jsonl] [--min-chars 10] [--limit 0]
 *
 * 只读 ZCode 的 sqlite；不写对方任何数据。
 */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readZcodeSession, listForeignSessions } from '../lib/foreign.js'
import { topKeywords } from '../lib/keywords.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const outFile = args.out || 'ingest-zcode.jsonl'
const minChars = Number(args['min-chars'] || 10)
const limit = Number(args.limit || 0)

const sessions = listForeignSessions('zcode')
console.log('zcode sessions=' + sessions.length)

const NOISE = [
  /the todowrite tool/i,
  /tool has(n't| not) been used recently/i,
  /^this is a reminder/i,
  /^<\/?[a-z-]+>/i,
  /^\[system/i,
  /^系统提示/i,
]
const isNoise = (t) => NOISE.some((re) => re.test(t))

const rows = []
let skipped = 0
let scanned = 0
for (const s of sessions) {
  if (limit > 0 && scanned >= limit) break
  scanned += 1
  let events = []
  try {
    events = readZcodeSession(s.id)
  } catch (e) {
    skipped += 1
    continue
  }
  const users = events.filter(
    (e) => e.role === 'user' && typeof e.text === 'string' && e.text.trim().length >= minChars && !isNoise(e.text.trim()),
  )
  if (users.length === 0) {
    skipped += 1
    continue
  }
  const first = users[0]
  const lastSeq = events.length > 0 ? events[events.length - 1].seq + 1 : first.seq + 1
  const ask = users.map((u) => u.text.replace(/\s+/g, ' ')).join(' / ').slice(0, 200)
  const title = String(s.title || '').trim().length > 0 ? String(s.title).trim().slice(0, 80) : first.text.split(/[。！？\n]/)[0].slice(0, 60)
  rows.push({
    id: 'z-' + createHash('sha1').update(String(s.id)).digest('hex').slice(0, 10),
    session: 'zcode:' + s.id,
    startSeq: first.seq,
    endSeq: lastSeq,
    ask,
    title,
    kw: topKeywords(events.map((e) => e.text), 20),
    kind: 'auto',
    level: 'turn',
    artifacts: [],
    ts: new Date(Number(s.time_created) || Date.now()).toISOString(),
    agent: 'zcode',
    status: 'active',
  })
}

writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log('scanned=' + scanned + ' imported=' + rows.length + ' skipped=' + skipped + ' -> ' + outFile)
const withTitle = rows.filter((r) => r.title).length
console.log('sample: ' + JSON.stringify(rows.slice(0, 2), null, 0).slice(0, 400))
