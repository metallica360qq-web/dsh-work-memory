#!/usr/bin/env node
/**
 * recall-hier.mjs — 按图谱分级召回：标签 → 子标签 → 具体单元，每层只给模型看一小撮。
 *
 *   node cli/recall-hier.mjs "问题"
 *   node cli/recall-hier.mjs            // 跑一组评测用例
 *
 * 跟平铺版（recall-llm.mjs）的区别：那个把 421 个单元一次性塞给模型（~27k 字符），
 * 这里第一层只看 12 条宽类评述（~1.5k 字符），判出方向后才展开下一层。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { isBoilerplate } from '../lib/browse.js'
import { loadSegmentMap } from '../lib/units.js'
import { dshHome } from '../lib/sessionlog.js'
import { callLlmWithRetry } from './_llm.js'

const args = process.argv.slice(2)
const table = JSON.parse(readFileSync(join(dshHome(), 'work-memory', 'topics.json'), 'utf8'))
const rows = loadHooks().filter((row) => isHumanRow(row) && !isBoilerplate(row))
const segmentTable = loadSegmentMap(join(dshHome(), 'work-memory', 'segments.jsonl'))

/** 某个细类下的单元：有段的用段，没段用会话。 */
function unitsOf(fineId) {
  const units = []
  const seenSegments = new Set()
  const bySession = new Map()
  for (const row of rows) {
    if (row.topicFine !== fineId) continue
    if (typeof row.segment === 'string' && row.segment !== '') {
      if (seenSegments.has(row.segment)) continue
      seenSegments.add(row.segment)
      const info = segmentTable.get(row.segment)
      units.push({
        kind: 'seg',
        id: row.segment,
        session: row.session,
        label: info !== undefined && info.label !== '' ? info.label : String(row.title || row.ask).slice(0, 40),
        date: String(row.ts).slice(0, 10),
        hooks: info !== undefined ? info.hooks : 1,
        fromSeq: info !== undefined ? info.fromSeq : Number(row.startSeq),
        toSeq: info !== undefined ? info.toSeq : Number(row.endSeq),
      })
      continue
    }
    if (!bySession.has(row.session)) bySession.set(row.session, [])
    bySession.get(row.session).push(row)
  }
  for (const [session, list] of bySession) {
    const best = list.slice().sort((left, right) => String(right.ts).localeCompare(String(left.ts)))[0]
    units.push({
      kind: 'session',
      id: 'session:' + session,
      session,
      label: String(best.title || best.ask).slice(0, 40),
      date: String(best.ts).slice(0, 10),
      hooks: list.length,
      fromSeq: Number(best.startSeq),
      toSeq: Number(best.endSeq),
    })
  }
  units.sort((left, right) => String(right.date).localeCompare(String(left.date)))
  return units
}

function jsonOf(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

async function ask(prompt, maxTokens) {
  const started = Date.now()
  const result = await callLlmWithRetry(prompt, { maxTokens, temperature: 0.1 }, 2)
  return { parsed: jsonOf(result.content), elapsed: Date.now() - started, chars: prompt.length }
}

async function hier(query) {
  const steps = []
  // 第一层：12 个宽类（零散事务是兜底筐，不参与第一层判断）
  const candidates = table.topics.filter((group) => group.id !== 'g12')
  const level1 = candidates.map((group, index) => (index + 1) + '. ' + group.name + ' — ' + (group.annotation || group.desc || '')).join('\n')
  const step1 = await ask([
    '下面是工作记忆的 ' + candidates.length + ' 个方向（编号. 名称 — 评述）。请判断这个新提问应该从哪个方向找。',
    '', level1, '', '新提问：' + query, '',
    '最多选 2 个；一个都不沾边就返回空数组。只输出 JSON：{"picks":[1]}',
  ].join('\n'), 200)
  const picks1 = (step1.parsed && Array.isArray(step1.parsed.picks) ? step1.parsed.picks : [])
    .map((n) => candidates[Number(n) - 1]).filter(Boolean)
  steps.push({ level: 1, chars: step1.chars, elapsed: step1.elapsed, picked: picks1.map((group) => group.name) })
  if (picks1.length === 0) return { steps, units: [] }

  // 第二层：选中宽类下的细类（只有一个就没有选择余地，直接进）
  const fineList = []
  for (const group of picks1) for (const id of group.members || []) {
    const fine = table.fine.find((item) => item.id === id)
    if (fine) fineList.push(fine)
  }
  if (fineList.length === 1) {
    steps.push({ level: 2, chars: 0, elapsed: 0, picked: [fineList[0].name + '（唯一）'] })
    return finishLevel3(query, steps, fineList)
  }
  const level2 = fineList.map((fine, index) => (index + 1) + '. ' + fine.name + ' — ' + (fine.annotation || '') + '（' + unitsOf(fine.id).length + ' 个单元）').join('\n')
  const step2 = await ask([
    '下面是候选细方向（编号. 名称 — 评述 — 单元数）。请判断这个新提问该进哪个细方向。',
    '', level2, '', '新提问：' + query, '',
    '最多选 2 个；都不合适就返回空数组。只输出 JSON：{"picks":[1]}',
  ].join('\n'), 200)
  const picks2 = (step2.parsed && Array.isArray(step2.parsed.picks) ? step2.parsed.picks : [])
    .map((n) => fineList[Number(n) - 1]).filter(Boolean)
  steps.push({ level: 2, chars: step2.chars, elapsed: step2.elapsed, picked: picks2.map((fine) => fine.name) })
  // 第二层判空时别直接放弃：退回第一层的第一个宽类，交给第三层逐条判断
  if (picks2.length === 0) {
    const fallback = picks1[0]
    const fallbackFines = fallback === undefined
      ? []
      : (fallback.members || []).map((id) => table.fine.find((item) => item.id === id)).filter(Boolean)
    if (fallbackFines.length === 0) return { steps, units: [] }
    steps.push({ level: 2, chars: 0, elapsed: 0, picked: ['(判空 → 退回 ' + fallback.name + ')'] })
    return finishLevel3(query, steps, fallbackFines)
  }
  return finishLevel3(query, steps, picks2)
}

/** 第三层：在选定细类的单元里挑。 */
async function finishLevel3(query, steps, pickedFines) {
  const units = []
  for (const fine of pickedFines) for (const unit of unitsOf(fine.id)) units.push(unit)
  const level3 = units.map((unit, index) => (index + 1) + '. ' + unit.date + ' ｜ ' + unit.label + (unit.hooks > 1 ? '（' + unit.hooks + ' 条）' : '')).join('\n')
  const step3 = await ask([
    '下面是候选历史工作单元（编号. 日期 ｜ 这段在做什么）。请判断这个新提问跟哪几个真正相关。',
    '', level3, '', '新提问：' + query, '',
    '最多选 3 个，只挑真正相关的（同一件事、同一项目、要复用当时做法），不要因为字面有共同词就挑；都不相关返回空数组。',
    '只输出 JSON：{"picks":[{"n":1,"why":"一句话"}]}',
  ].join('\n'), 900)
  const picks3 = (step3.parsed && Array.isArray(step3.parsed.picks) ? step3.parsed.picks : [])
    .map((item) => ({ unit: units[Number(item.n) - 1], why: String(item.why || '').slice(0, 70) }))
    .filter((item) => item.unit !== undefined)
  steps.push({ level: 3, chars: step3.chars, elapsed: step3.elapsed, picked: picks3.map((item) => item.unit.label) })
  return { steps, units: picks3 }
}

const cases = args.length > 0 && !args[0].startsWith('--')
  ? [args[0]]
  : [
    '这个插件的星图为什么点不进去会话',
    '我想把记忆按主题整理一下，上次那个方案还能用吗',
    'ClinPGx 的 wiki 是怎么建的',
    '帮我做一个 PPT，用金域模板',
    '量化回测里 MACD 参数怎么定的',
    '抖音 005 那期视频的文案',
  ]

let totalChars = 0
let totalMs = 0
for (const query of cases) {
  const result = await hier(query)
  const chars = result.steps.reduce((sum, step) => sum + step.chars, 0)
  const elapsed = result.steps.reduce((sum, step) => sum + step.elapsed, 0)
  totalChars += chars
  totalMs += elapsed
  console.log('\n提问：' + query)
  for (const step of result.steps) console.log('  L' + step.level + ' ' + step.chars + ' 字符 ' + step.elapsed + 'ms → ' + (step.picked.length === 0 ? '(空)' : step.picked.join(' / ')))
  for (const pickItem of result.units) {
    console.log('  ◆ ' + pickItem.unit.date + ' ｜ ' + pickItem.unit.label)
    console.log('    理由：' + pickItem.why)
    console.log('    session=' + pickItem.unit.session + ' seq ' + pickItem.unit.fromSeq + '–' + pickItem.unit.toSeq)
  }
  if (result.units.length === 0) console.log('  （没有相关单元）')
}
console.log('\n合计：' + cases.length + ' 个提问，平均 ' + Math.round(totalChars / cases.length) + ' 字符 / ' + Math.round(totalMs / cases.length) + 'ms')
console.log('（平铺版是 27k 字符一次调用；这里是三层，每层只给一小撮）')
