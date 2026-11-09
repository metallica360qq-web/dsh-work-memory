#!/usr/bin/env node
/**
 * 账本去重：找出标题高度相似的条目对，报告或合并。
 *
 *   node cli/dedupe.js [--threshold 0.7] [--merge]
 *
 * 合并规则：保留 ts 较新的一条，把旧条目的 artifacts 并进来，旧条目标 superseded。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { tokens, invalidate } from '../lib/store.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const threshold = Number(args.threshold || 0.7)
const file = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')
const doMerge = Boolean(args.merge)

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const rows = lines.map((l) => JSON.parse(l))

const sets = rows.map((r) => new Set(tokens(r.title)))
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

const pairs = []
const askSets = rows.map((r) => new Set(tokens(String(r.ask || '').slice(0, 200))))
for (let i = 0; i < rows.length; i += 1) {
  for (let j = i + 1; j < rows.length; j += 1) {
    const s = jaccard(sets[i], sets[j])
    if (s < threshold) continue
    const askSim = jaccard(askSets[i], askSets[j])
    pairs.push({ i, j, s, askSim })
  }
}
pairs.sort((a, b) => b.s - a.s || b.askSim - a.askSim)
// 视为重复的条件：标题相似且提问也相似（只有标题像的不算，例如「第1批/第2批」）
const dupPairs = pairs.filter((p) => p.askSim >= Number(args['ask-threshold'] || 0.6))
console.log('rows=' + rows.length + ' threshold=' + threshold + ' titlePairs=' + pairs.length + ' dupPairs=' + dupPairs.length)
for (const p of pairs.slice(0, 12)) {
  const a = rows[p.i]
  const b = rows[p.j]
  console.log('  title=' + p.s.toFixed(2) + ' ask=' + p.askSim.toFixed(2) + (p.askSim >= 0.6 ? '  [DUP]' : '') +
    '  ' + a.id + ' ' + a.title.slice(0, 30) + ' || ' + b.id + ' ' + b.title.slice(0, 30))
}

if (doMerge && dupPairs.length > 0) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  let merged = 0
  const handled = new Set()
  for (const p of dupPairs) {
    const a = rows[p.i]
    const b = rows[p.j]
    if (handled.has(a.id) || handled.has(b.id)) continue
    const [keep, drop] = String(a.ts) >= String(b.ts) ? [a, b] : [b, a]
    keep.artifacts = [...new Set([...(keep.artifacts || []), ...(drop.artifacts || [])])]
    drop.status = 'superseded'
    drop.supersededBy = keep.id
    drop.supersededAt = new Date().toISOString()
    handled.add(a.id)
    handled.add(b.id)
    merged += 1
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(file, file + '.bak-dedupe-' + ts)
  writeFileSync(file, [...byId.values()].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  invalidate()
  console.log('merged=' + merged + ' backup=' + file + '.bak-dedupe-' + ts)
}
