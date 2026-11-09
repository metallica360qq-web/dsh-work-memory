#!/usr/bin/env node
/**
 * 账本校验：逐行 schema 检查，坏行隔离到 hooks.bad.jsonl。
 *
 *   node cli/verify.js [--fix]
 *
 * 检查项：JSON 可解析、id/session 非空、seq 为数字且 start<end、ts 可解析、
 * level/status/agent 在已知枚举内。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = true
}
const file = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')
const fix = Boolean(args.fix)

const LEVELS = new Set(['module', 'turn'])
const STATUSES = new Set(['active', 'superseded', 'archived', 'stale'])
const AGENTS = new Set(['dsh', 'zcode', 'hermes', 'workbuddy'])

if (!existsSync(file)) {
  console.log('账本不存在: ' + file)
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const good = []
const bad = []
const stats = { schemaMissing: 0, badSeq: 0, badTs: 0, unknownLevel: 0, unknownStatus: 0, unknownAgent: 0, dupId: 0 }
const seen = new Set()

for (const line of lines) {
  let row
  try {
    row = JSON.parse(line)
  } catch (e) {
    bad.push({ reason: 'json: ' + String(e).slice(0, 80), line: line.slice(0, 200) })
    continue
  }
  const errs = []
  if (typeof row.id !== 'string' || row.id.length === 0) errs.push('id 缺失')
  if (typeof row.session !== 'string' || row.session.length === 0) errs.push('session 缺失')
  if (!Number.isFinite(row.startSeq) || !Number.isFinite(row.endSeq) || row.startSeq > row.endSeq) {
    errs.push('seq 非法')
    stats.badSeq += 1
  }
  if (!Number.isFinite(Date.parse(String(row.ts || '')))) {
    errs.push('ts 非法')
    stats.badTs += 1
  }
  if (row.level !== undefined && !LEVELS.has(row.level)) {
    errs.push('level 未知: ' + row.level)
    stats.unknownLevel += 1
  }
  if (row.status !== undefined && !STATUSES.has(row.status)) {
    errs.push('status 未知: ' + row.status)
    stats.unknownStatus += 1
  }
  if (row.agent !== undefined && !AGENTS.has(row.agent)) {
    errs.push('agent 未知: ' + row.agent)
    stats.unknownAgent += 1
  }
  if (row.schema === undefined) stats.schemaMissing += 1
  if (typeof row.id === 'string' && seen.has(row.id)) {
    errs.push('id 重复')
    stats.dupId += 1
  }
  if (typeof row.id === 'string') seen.add(row.id)
  if (errs.length === 0) good.push(row)
  else bad.push({ reason: errs.join('; '), id: row.id })
}

console.log('total=' + lines.length + ' good=' + good.length + ' bad=' + bad.length)
console.log('schemaMissing=' + stats.schemaMissing + ' badSeq=' + stats.badSeq + ' badTs=' + stats.badTs +
  ' unknownLevel=' + stats.unknownLevel + ' unknownStatus=' + stats.unknownStatus +
  ' unknownAgent=' + stats.unknownAgent + ' dupId=' + stats.dupId)
for (const b of bad.slice(0, 10)) console.log('  BAD ' + JSON.stringify(b))

if (fix && bad.length > 0) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(file, file + '.bak-verify-' + ts)
  writeFileSync(file, good.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  writeFileSync(file.replace(/\.jsonl$/, '') + '.bad.jsonl', bad.map((b) => JSON.stringify(b)).join('\n') + '\n', 'utf8')
  console.log('已隔离 ' + bad.length + ' 条坏行 -> hooks.bad.jsonl，备份 ' + file + '.bak-verify-' + ts)
}
