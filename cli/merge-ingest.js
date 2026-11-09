#!/usr/bin/env node
/**
 * 把 ingest-*.jsonl 并入真实账本（按 agent 覆盖，保留其他来源）。
 *
 *   node cli/merge-ingest.js --file ingest-zcode.jsonl [--agent zcode]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const inFile = args.file
if (!inFile) {
  console.error('用法：node cli/merge-ingest.js --file ingest-zcode.jsonl [--agent zcode]')
  process.exit(2)
}
const ledger = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')
const incoming = readFileSync(inFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const agent = args.agent || (incoming[0] && incoming[0].agent) || 'unknown'

const existing = existsSync(ledger)
  ? readFileSync(ledger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  : []

const kept = existing.filter((r) => r.agent !== agent)
const byId = new Map()
for (const r of kept) byId.set(r.id, r)
for (const r of incoming) byId.set(r.id, r)
const finalRows = [...byId.values()].sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
if (existsSync(ledger)) copyFileSync(ledger, ledger + '.bak-ingest-' + ts)
writeFileSync(ledger, finalRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const byAgent = {}
for (const r of finalRows) byAgent[r.agent] = (byAgent[r.agent] || 0) + 1
console.log('agent=' + agent + ' incoming=' + incoming.length + ' kept=' + kept.length + ' final=' + finalRows.length)
console.log('byAgent=' + JSON.stringify(byAgent))
console.log('backup=' + ledger + '.bak-ingest-' + ts)
