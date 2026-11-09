#!/usr/bin/env node
/**
 * 召回评估：跑 eval-set.json，输出 Hit@1 / Hit@3 / MRR 与失败案例。
 *
 *   node cli/eval.js [eval-set.json] [--top 10] [--show-fail 12]
 */
import { readFileSync } from 'node:fs'
import { searchHooks, loadHooks } from '../lib/store.js'
import { dshHome } from '../lib/sessionlog.js'
import { join } from 'node:path'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const explicit = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null
const setFile = args._ || explicit || join(dshHome(), 'work-memory', 'eval-set.json')
const top = Number(args.top || 10)
const showFail = Number(args['show-fail'] || 12)

const set = JSON.parse(readFileSync(setFile, 'utf8'))
const cases = set.cases || []
const total = loadHooks().length

let hit1 = 0
let hit3 = 0
let hit10 = 0
let mrr = 0
const fails = []

for (const c of cases) {
  const hits = searchHooks(c.q, top)
  const idx = hits.findIndex((h) => h.id === c.expect)
  const rank = idx >= 0 ? idx + 1 : 0
  if (rank === 1) hit1 += 1
  if (rank > 0 && rank <= 3) hit3 += 1
  if (rank > 0) hit10 += 1
  if (rank > 0) mrr += 1 / rank
  if (rank === 0 || rank > 3) {
    fails.push({ q: c.q, expect: c.expect, rank, got: hits.slice(0, 3).map((h) => h.id + ' ' + h.title.slice(0, 34)) })
  }
}

const n = cases.length
const pct = (x) => (Math.round((x / n) * 1000) / 10).toFixed(1) + '%'
console.log('ledger=' + total + ' cases=' + n + ' top=' + top)
console.log('Hit@1=' + pct(hit1) + '  Hit@3=' + pct(hit3) + '  Hit@' + top + '=' + pct(hit10) + '  MRR=' + (mrr / n).toFixed(3))
if (fails.length > 0) {
  console.log('\n未进前 3 的 ' + fails.length + ' 例：')
  for (const f of fails.slice(0, showFail)) {
    console.log('- "' + f.q + '"  期望 ' + f.expect + '  排名=' + (f.rank || '未命中'))
    for (const g of f.got) console.log('    got: ' + g)
  }
}
