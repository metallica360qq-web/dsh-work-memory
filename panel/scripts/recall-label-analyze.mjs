/**
 * 汇总两位独立评判员的结果，按 A/B 组算精确率。
 *
 * 用法：node scripts/recall-label-analyze.mjs
 * 依赖：%TEMP%\recall-label.json（带组别）、recall-label-blind.json（盲评映射）、
 *       recall-labels-j1.json / recall-labels-j2.json（两位评判员）
 *
 * A 组 = 现状 0 命中、放宽到 0.3 才有候选；B 组 = 现状就能召回（精确率基线）。
 * 只有 A 的第一槽位精确率接近 B，降阈值才划算。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const read = (name) => JSON.parse(readFileSync(path.join(tmpdir(), name), 'utf8'))
const grouped = read('recall-label.json')
const blind = read('recall-label-blind.json')
const judge1 = read('recall-labels-j1.json').verdicts
const judge2 = read('recall-labels-j2.json').verdicts

/** 用「query + 第一个候选 id」当指纹，把盲评 caseId 映射回 A/B 组。 */
const fingerprint = (item) => item.query.trim() + '|' + (item.candidates[0] ? item.candidates[0].id : '')
const blindMap = new Map()
for (const item of blind.cases) blindMap.set(fingerprint(item), item.caseId)

const slotsOf = (source, caseId) => {
  const verdict = source[caseId]
  return verdict !== undefined && Array.isArray(verdict.slots) ? verdict.slots : []
}

function rowsOf(cases) {
  return cases.map((item) => {
    const caseId = blindMap.get(fingerprint(item))
    return {
      item,
      caseId: caseId === undefined ? null : caseId,
      j1: caseId === undefined ? [] : slotsOf(judge1, caseId),
      j2: caseId === undefined ? [] : slotsOf(judge2, caseId),
    }
  })
}

const pct = (value, total) => (total === 0 ? '—' : (Math.round((value / total) * 1000) / 10).toFixed(1) + '%')

function stats(rows, key) {
  const slotCounts = [0, 0, 0]
  const slotHits = [0, 0, 0]
  let candidates = 0
  let relevant = 0
  let casesWithAny = 0
  for (const row of rows) {
    const verdicts = row[key]
    let any = false
    verdicts.forEach((value, index) => {
      const hit = value === true
      candidates += 1
      if (hit) relevant += 1
      if (index < 3) {
        slotCounts[index] += 1
        if (hit) slotHits[index] += 1
      }
      if (hit) any = true
    })
    if (any) casesWithAny += 1
  }
  return {
    candidates,
    relevant,
    candidateRate: pct(relevant, candidates),
    casesWithAny,
    caseRate: pct(casesWithAny, rows.length),
    slot1: pct(slotHits[0], slotCounts[0]),
    slot2: pct(slotHits[1], slotCounts[1]),
    slot3: pct(slotHits[2], slotCounts[2]),
    slot1Hold: slotHits[0] + '/' + slotCounts[0],
  }
}

function agreement(rows) {
  let compared = 0
  let same = 0
  let bothTrue = 0
  let bothFalse = 0
  for (const row of rows) {
    for (let index = 0; index < row.j1.length; index += 1) {
      if (row.j2[index] === undefined) continue
      compared += 1
      const left = row.j1[index] === true
      const right = row.j2[index] === true
      if (left === right) {
        same += 1
        if (left) bothTrue += 1
        else bothFalse += 1
      }
    }
  }
  return { compared, same, bothTrue, bothFalse, rate: pct(same, compared) }
}

const rowsA = rowsOf(grouped.groupA)
const rowsB = rowsOf(grouped.groupB)
const missing = [...rowsA, ...rowsB].filter((row) => row.caseId === null)

console.log('样本：A 组（放宽才有候选）' + rowsA.length + ' 条，B 组（现状能召回）' + rowsB.length + ' 条')
if (missing.length > 0) console.log('⚠ 有 ' + missing.length + ' 条没映射到盲评 caseId（指纹对不上）')
console.log('')
console.log('组 | 候选数 | 相关数 | 候选级精确率 | ≥1 条相关的 case | 第一槽位精确率')
for (const [label, rows] of [['A 放宽 0.3', rowsA], ['B 现状 0.45', rowsB]]) {
  const one = stats(rows, 'j1')
  const two = stats(rows, 'j2')
  console.log(label + '（j1） | ' + one.candidates + ' | ' + one.relevant + ' | ' + one.candidateRate + ' | ' + one.casesWithAny + '/' + rows.length + '（' + one.caseRate + '） | ' + one.slot1 + '（' + one.slot1Hold + '）')
  console.log(label + '（j2） | ' + two.candidates + ' | ' + two.relevant + ' | ' + two.candidateRate + ' | ' + two.casesWithAny + '/' + rows.length + '（' + two.caseRate + '） | ' + two.slot1 + '（' + two.slot1Hold + '）')
}

const agreeA = agreement(rowsA)
const agreeB = agreement(rowsB)
console.log('')
console.log('两位评判员一致率：A 组 ' + agreeA.rate + '（同真 ' + agreeA.bothTrue + '，同假 ' + agreeA.bothFalse + '，共 ' + agreeA.compared + ' 条）')
console.log('                   B 组 ' + agreeB.rate + '（同真 ' + agreeB.bothTrue + '，同假 ' + agreeB.bothFalse + '，共 ' + agreeB.compared + ' 条）')

// 两票都判真才算真：更保守的口径
function statsConsensus(rows) {
  const slotCounts = [0, 0, 0]
  const slotHits = [0, 0, 0]
  let casesWithAny = 0
  for (const row of rows) {
    let any = false
    for (let index = 0; index < row.j1.length; index += 1) {
      const hit = row.j1[index] === true && row.j2[index] === true
      if (index < 3) {
        slotCounts[index] += 1
        if (hit) slotHits[index] += 1
      }
      if (hit) any = true
    }
    if (any) casesWithAny += 1
  }
  return { slot1: pct(slotHits[0], slotCounts[0]), caseRate: pct(casesWithAny, rows.length), casesWithAny }
}

const consensusA = statsConsensus(rowsA)
const consensusB = statsConsensus(rowsB)
console.log('')
console.log('保守口径（两票都真）：A 组第一槽位 ' + consensusA.slot1 + '，有相关的 case ' + consensusA.casesWithAny + '/' + rowsA.length + '（' + consensusA.caseRate + '）')
console.log('                      B 组第一槽位 ' + consensusB.slot1 + '，有相关的 case ' + consensusB.casesWithAny + '/' + rowsB.length + '（' + consensusB.caseRate + '）')
