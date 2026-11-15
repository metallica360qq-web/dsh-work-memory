#!/usr/bin/env node
/**
 * recall-llm.mjs — 用模型判断「这条提问跟哪段历史有关」，替代字面重合打分。
 *
 *   node cli/recall-llm.mjs "你的问题" [--top 3] [--quiet]
 *   node cli/recall-llm.mjs --eval       // 跑一组真实问题，打印耗时与命中
 *
 * 做法：把历史压成「单元清单」（有段用段，没段用会话），一行一个单元；
 * 连同提问一起交给模型，让它挑出相关的几个单元并说明理由，再展开单元内容。
 * 不做了：TF-IDF、关键词、阈值打分。
 */
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { isBoilerplate } from '../lib/browse.js'
import { loadSegmentMap } from '../lib/units.js'
import { loadTopics } from '../lib/topics.js'
import { dshHome } from '../lib/sessionlog.js'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { callLlmWithRetry, llmConfig } from './_llm.js'

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const TOP = num('--top', 3)
const quiet = args.includes('--quiet')

/** 单元清单：多钩子会话用段，其余会话用整段（一条=一个单元）。 */
function buildUnits(rows) {
  const segments = loadSegmentMap(join(dshHome(), 'work-memory', 'segments.jsonl'))
  const topics = loadTopics()
  const fineTopics = (() => {
    try {
      const raw = JSON.parse(readFileSync(join(dshHome(), 'work-memory', 'topics.json'), 'utf8'))
      return Array.isArray(raw.fine) ? raw.fine : []
    } catch {
      return []
    }
  })()
  const topicName = new Map([...topics.map((topic) => [topic.id, topic.name]), ...fineTopics.map((topic) => [topic.id, topic.name])])
  const bySession = new Map()
  for (const row of rows) {
    if (!isHumanRow(row) || isBoilerplate(row)) continue
    if (!bySession.has(row.session)) bySession.set(row.session, [])
    bySession.get(row.session).push(row)
  }
  const units = []
  for (const [session, hooks] of bySession) {
    hooks.sort((left, right) => Number(left.startSeq) - Number(right.startSeq))
    const groups = new Map()
    for (const hook of hooks) {
      const key = typeof hook.segment === 'string' && hook.segment !== '' ? hook.segment : 'session:' + session
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(hook)
    }
    for (const [key, list] of groups) {
      const info = key.startsWith('session:') ? undefined : segments.get(key)
      const best = list.slice().sort((left, right) => String(right.title || '').length - String(left.title || '').length)[0]
      const topicId = list[0].topicFine || ''
      units.push({
        id: key,
        session,
        label: info !== undefined ? info.label : String(best.title || best.ask).slice(0, 46),
        title: String(best.title || best.ask).slice(0, 46),
        date: String(list[list.length - 1].ts).slice(0, 10),
        hooks: list.length,
        topic: topicId,
        topicName: topicId === '' ? '' : (topicName.get(topicId) || ''),
        fromSeq: Number(list[0].startSeq),
        toSeq: Number(list[list.length - 1].endSeq),
      })
    }
  }
  units.sort((left, right) => String(right.date).localeCompare(String(left.date)))
  return units
}

function unitLine(unit, index) {
  return index + '. ' + unit.date + ' ｜ ' + (unit.topicName || '未主题') + ' ｜ ' + unit.label + (unit.hooks > 1 ? '（' + unit.hooks + ' 条）' : '')
}

async function pick(query, units) {
  const lines = units.map(unitLine).join('\n')
  const prompt = [
    '你是这个开发者工作记忆的检索员。下面是历史工作单元清单（编号. 日期 ｜ 主题 ｜ 这段在做什么）。',
    '现在有一个新提问，请判断它跟清单里哪几个单元真正相关。',
    '',
    '清单：',
    lines,
    '',
    '新提问：' + query,
    '',
    '规则：',
    '1. 只挑真正相关的（同一件事的延续、同一项目、需要复用当时做法或产物的），不要因为字面有共同词就挑。',
    '2. 最多 ' + TOP + ' 个；一个都不相关就返回空数组。',
    '3. 每个给一句理由（为什么这条对这个提问有用）。',
    '只输出 JSON：{"picks":[{"n":12,"why":"..."}]}',
  ].join('\n')
  const started = Date.now()
  const result = await callLlmWithRetry(prompt, { maxTokens: 900, temperature: 0.1 }, 2)
  const elapsed = Date.now() - started
  const raw = String(result.content || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed = null
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1))
    } catch {
      parsed = null
    }
  }
  const picks = parsed !== null && Array.isArray(parsed.picks) ? parsed.picks : []
  return {
    picks: picks
      .map((item) => ({ unit: units[Number(item.n) - 1], why: String(item.why || '').slice(0, 80) }))
      .filter((item) => item.unit !== undefined),
    elapsed,
    promptChars: prompt.length,
    model: llmConfig().model,
  }
}

const rows = loadHooks()
const units = buildUnits(rows)

if (args.length === 0 || args[0].startsWith('--')) {
  // 评测：用几组「必然应该召回」的真实问题
  const cases = [
    '这个插件的星图为什么点不进去会话',
    '我想把记忆按主题整理一下，上次那个方案还能用吗',
    'ClinPGx 的 wiki 是怎么建的',
    '帮我做一个 PPT，用金域模板',
    '量化回测里 MACD 参数怎么定的',
    '抖音 005 那期视频的文案',
  ]
  let total = 0
  for (const query of cases) {
    const result = await pick(query, units)
    total += result.elapsed
    console.log('\n提问：' + query)
    console.log('  单元清单 ' + units.length + ' 条 / ' + result.promptChars + ' 字符 / 耗时 ' + result.elapsed + 'ms / 模型 ' + result.model)
    if (result.picks.length === 0) console.log('  （模型认为都不相关）')
    for (const pickItem of result.picks) {
      const unit = pickItem.unit
      console.log('  → ' + unit.date + ' ｜ ' + (unit.topicName || '未主题') + ' ｜ ' + unit.label)
      console.log('    理由：' + pickItem.why)
      console.log('    session=' + unit.session + ' seq ' + unit.fromSeq + '–' + unit.toSeq + '（' + unit.hooks + ' 条）')
    }
  }
  console.log('\n平均耗时 ' + Math.round(total / cases.length) + 'ms（单次调用，' + cases.length + ' 个提问）')
} else {
  const query = args[0]
  const result = await pick(query, units)
  if (!quiet) console.log('单元 ' + units.length + ' 条 / ' + result.promptChars + ' 字符 / ' + result.elapsed + 'ms')
  for (const pickItem of result.picks) {
    const unit = pickItem.unit
    console.log('\n→ ' + unit.date + ' ｜ ' + (unit.topicName || '未主题') + ' ｜ ' + unit.label)
    console.log('  理由：' + pickItem.why)
    console.log('  session=' + unit.session + ' seq ' + unit.fromSeq + '–' + unit.toSeq)
  }
  if (result.picks.length === 0) console.log('（模型认为都不相关）')
}
