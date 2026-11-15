/**
 * 按候选的「性质」切一刀：cron 自动化、模块级、跨来源导入……哪一类在拖精确率。
 *
 * 用法：node scripts/recall-label-kinds.mjs
 * 依赖：%TEMP%\recall-label.json、recall-label-blind.json、recall-labels-j1/j2.json、
 *       以及账本本身（按 id 回查 kind / level / agent / 标题长度）
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WM_ROOT = process.env.WM_ROOT || 'D:/Program Files/工作文件夹/dsh-work-memory'
const { loadHooks } = await import(pathToFileURL(path.join(WM_ROOT, 'lib/store.js')).href)

const read = (name) => JSON.parse(readFileSync(path.join(tmpdir(), name), 'utf8'))
const grouped = read('recall-label.json')
const blind = read('recall-label-blind.json')
const judge1 = read('recall-labels-j1.json').verdicts
const judge2 = read('recall-labels-j2.json').verdicts

const ledger = new Map(loadHooks().map((row) => [row.id, row]))
const fingerprint = (item) => item.query.trim() + '|' + (item.candidates[0] ? item.candidates[0].id : '')
const caseOf = new Map(blind.cases.map((item) => [fingerprint(item), item.caseId]))

const buckets = new Map()
const push = (key, who, index, verdicts) => {
  const entry = buckets.get(key) || { candidates: 0, j1: 0, j2: 0, top1: 0, top1j1: 0 }
  entry.candidates += 1
  if (verdicts.j1[index] === true) entry.j1 += 1
  if (verdicts.j2[index] === true) entry.j2 += 1
  if (index === 0) {
    entry.top1 += 1
    if (verdicts.j1[0] === true) entry.top1j1 += 1
  }
  buckets.set(key, entry)
}

for (const group of ['A', 'B']) {
  for (const item of grouped['group' + group]) {
    const caseId = caseOf.get(fingerprint(item))
    if (caseId === undefined) continue
    const verdicts = { j1: judge1[caseId] ? judge1[caseId].slots : [], j2: judge2[caseId] ? judge2[caseId].slots : [] }
    item.candidates.forEach((candidate, index) => {
      const row = ledger.get(candidate.id)
      const kind = row === undefined ? '(账本里没有)' : row.kind || '(空)'
      const level = row === undefined ? '?' : row.level || '?'
      const agent = row === undefined ? '?' : row.agent || '?'
      const titleLen = row === undefined ? 0 : String(row.title || '').length
      push(group + ' | kind=' + kind, 'kind', index, verdicts)
      push(group + ' | level=' + level, 'level', index, verdicts)
      push(group + ' | agent=' + agent, 'agent', index, verdicts)
      push(group + ' | 标题长度 ' + (titleLen < 12 ? '<12' : titleLen < 30 ? '12–30' : '≥30'), 'title', index, verdicts)
    })
  }
}

const pct = (value, total) => (total === 0 ? '—' : (Math.round((value / total) * 1000) / 10).toFixed(1) + '%')
console.log('分组 | 候选数 | j1 判真率 | j2 判真率 | 第一槽位 j1 判真率')
for (const key of [...buckets.keys()].sort()) {
  const entry = buckets.get(key)
  console.log(key + ' | ' + entry.candidates + ' | ' + pct(entry.j1, entry.candidates) + ' | ' + pct(entry.j2, entry.candidates) + ' | ' + pct(entry.top1j1, entry.top1))
}
