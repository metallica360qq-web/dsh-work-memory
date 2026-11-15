#!/usr/bin/env node
/**
 * backfill-origin.js — 给账本里已有的记录补上 origin（谁产生的）。
 *
 *   node cli/backfill-origin.js [--dry-run] [--ledger <path>]
 *
 * 为什么要它：跨 agent 导入时把源系统的来源字段丢了。zcode 的 task_type 和
 * hermes 的 source 都还在源库里，按 session id 回查一遍就能补回来。
 * 纯确定性、可重复跑：已经有有效 origin 的行跳过。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { sessionMetaMap } from '../lib/foreign.js'
import { originBreakdown, isHumanRow } from '../lib/origin.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const dryRun = Boolean(args['dry-run'])
const ledger = args.ledger || join(dshHome(), 'work-memory', 'hooks.jsonl')

const rows = readFileSync(ledger, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const maps = {
  zcode: sessionMetaMap('zcode'),
  hermes: sessionMetaMap('hermes'),
  workbuddy: sessionMetaMap('workbuddy'),
}

let changed = 0
let unknownSource = 0
for (const row of rows) {
  const current = typeof row.origin === 'string' ? row.origin : ''
  // 已有明确来源就不动；:unknown 的重新算一次
  if (current.length > 0 && !current.endsWith(':unknown')) continue
  const agent = String(row.agent || 'dsh')
  let next = ''
  if (agent === 'dsh') {
    next = 'dsh:user'
  } else if (agent === 'workbuddy') {
    next = 'workbuddy:title'
  } else {
    const ref = String(row.session || '')
    const prefix = agent + ':'
    const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
    const map = maps[agent]
    const type = map instanceof Map ? map.get(id) : undefined
    if (type === undefined || type === null) {
      unknownSource += 1
      next = agent + ':unknown'
    } else {
      next = agent + ':' + type
    }
  }
  if (next !== current) {
    row.origin = next
    changed += 1
  }
}

const breakdown = originBreakdown(rows)
const human = rows.filter((row) => isHumanRow(row)).length
console.log('账本 ' + rows.length + ' 条，本次写入 origin 的 ' + changed + ' 条' + (unknownSource > 0 ? '（其中源库查不到的 ' + unknownSource + ' 条）' : ''))
for (const origin of Object.keys(breakdown).sort((a, b) => breakdown[b].total - breakdown[a].total)) {
  const entry = breakdown[origin]
  console.log('  ' + (entry.human ? '人  ' : '代理') + ' ' + origin.padEnd(26, ' ') + ' ' + String(entry.total).padStart(5, ' ') + '  ' + entry.label)
}
console.log('人类需求 ' + human + ' 条 / 代理自产 ' + (rows.length - human) + ' 条')

if (dryRun) {
  console.log('--dry-run：没有写盘')
} else if (changed > 0) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(ledger, ledger + '.bak-origin-' + stamp)
  writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log('已写回 ' + ledger + '（备份 .bak-origin-' + stamp + '）')
} else {
  console.log('没有需要补的记录')
}
