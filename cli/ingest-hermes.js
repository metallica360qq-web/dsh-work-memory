#!/usr/bin/env node
/**
 * 把 Hermes 的会话导入成钩子（每个会话一条 turn 级）。
 *
 *   node cli/ingest-hermes.js [--out ingest-hermes.jsonl] [--min-chars 10] [--skip-cron]
 */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { readHermesSession, listForeignSessions } from '../lib/foreign.js'
import { topKeywords } from '../lib/keywords.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const outFile = args.out || 'ingest-hermes.jsonl'
const minChars = Number(args['min-chars'] || 10)
const skipCron = Boolean(args['skip-cron'])

const sessions = listForeignSessions('hermes')
console.log('hermes sessions=' + sessions.length)

const NOISE = [/^\[system/i, /^<\/?[a-z-]+>/i, /^this is a reminder/i]
const isNoise = (t) => NOISE.some((re) => re.test(t))

const rows = []
let skipped = 0
for (const s of sessions) {
  const source = String(s.source || '')
  const isCron = source.includes('cron')
  if (skipCron && isCron) {
    skipped += 1
    continue
  }
  let events = []
  try {
    events = readHermesSession(s.id)
  } catch {
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
  rows.push({
    id: 'h-' + createHash('sha1').update(String(s.id)).digest('hex').slice(0, 10),
    session: 'hermes:' + s.id,
    startSeq: first.seq,
    endSeq: lastSeq,
    ask,
    title: first.text.split(/[。！？\n]/)[0].replace(/\s+/g, ' ').slice(0, 70),
    kw: topKeywords(events.map((e) => e.text), 20),
    kind: isCron ? 'cron' : 'auto',
    level: isCron ? 'turn' : 'turn',
    artifacts: [],
    ts: new Date(
      (() => {
        const t = Number(s.time_created)
        if (t > 1e12) return t
        if (t > 1e9) return t * 1000
        return first.time || Date.now()
      })(),
    ).toISOString(),
    agent: 'hermes',
    status: 'active',
  })
}

writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log('imported=' + rows.length + ' skipped=' + skipped + ' -> ' + outFile)
