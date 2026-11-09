#!/usr/bin/env node
/**
 * WorkBuddy 接入（仅标题级）。
 *
 *   node cli/ingest-workbuddy.js [--out ingest-workbuddy.jsonl]
 *
 * 为什么只有标题：workbuddy.db 只有 sessions 表（47 行），没有消息正文表；
 * 会话内容在更早的版本里已停止写入（08-19 后停写）。所以这里只导入标题与时间，
 * memory_open 对该源会明确说明"没有消息正文"。
 */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { listForeignSessions } from '../lib/foreign.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const outFile = args.out || 'ingest-workbuddy.jsonl'

const sessions = listForeignSessions('workbuddy')
console.log('workbuddy sessions=' + sessions.length)

const rows = []
for (const s of sessions) {
  const title = String(s.title || '').trim()
  if (title.length < 4) continue
  const t = Number(s.time_created)
  const ms = t > 1e12 ? t : t > 1e9 ? t * 1000 : Date.now()
  rows.push({
    schema: 1,
    id: 'w-' + createHash('sha1').update(String(s.id)).digest('hex').slice(0, 10),
    session: 'workbuddy:' + s.id,
    startSeq: 0,
    endSeq: 1,
    ask: title.slice(0, 200),
    title: title.slice(0, 80),
    kind: 'title-only',
    level: 'turn',
    artifacts: [],
    ts: new Date(ms).toISOString(),
    agent: 'workbuddy',
    status: 'active',
  })
}

writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log('imported=' + rows.length + ' -> ' + outFile)
