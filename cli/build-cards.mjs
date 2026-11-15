#!/usr/bin/env node
/**
 * build-cards.mjs — 给每一段工作生成一张「记忆卡」：这段做了什么、结论是什么、产物在哪。
 *
 *   node cli/build-cards.mjs [--limit 50] [--dry]
 *
 * 段标签（segLabel）只说「在做什么」，卡片补上「做到什么程度 / 结论 / 关键决定」，
 * 召回时注入卡片而不是裸标题——复杂知识进上下文靠的是这张卡，原文仍按 seq 回放。
 * 产出：<DSH_HOME>/work-memory/cards.jsonl
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { callLlmWithRetry } from './_llm.js'

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const LIMIT = num('--limit', 50)
const dry = args.includes('--dry')

const dir = join(dshHome(), 'work-memory')
const cardsFile = join(dir, 'cards.jsonl')
const segmentsFile = join(dir, '.induct', 'segments.json')
const topicsFile = join(dir, '.induct', 'segment-topics.json')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const segments = readJson(segmentsFile, null)
const segmentTopics = readJson(topicsFile, null)
if (segments === null) {
  console.log('缺切段结果')
  process.exit(1)
}

const rows = new Map(loadHooks().map((row) => [row.id, row]))
const table = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
const fineName = new Map((table.fine || []).map((fine) => [fine.id, fine.name]))

// 已有卡片：按段 id 去重，方便断点续跑
const existing = new Map()
if (existsSync(cardsFile)) {
  for (const line of readFileSync(cardsFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const card = JSON.parse(line)
      if (typeof card.segment === 'string') existing.set(card.segment, card)
    } catch {
      /* 坏行跳过 */
    }
  }
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

let done = 0
const failures = []
for (const [session, list] of Object.entries(segments.sessions)) {
  for (let index = 0; index < list.length; index += 1) {
    if (LIMIT > 0 && done >= LIMIT) break
    const segment = list[index]
    const id = session + '#' + index
    if (existing.has(id)) continue
    const members = segment.ids.map((hookId) => rows.get(hookId)).filter((row) => row !== undefined && isHumanRow(row))
    if (members.length === 0) continue
    const artifacts = [...new Set(members.flatMap((row) => Array.isArray(row.artifacts) ? row.artifacts : []))].slice(0, 6)
    const topicEntry = segmentTopics !== null ? segmentTopics.segments[id] : undefined
    const fine = topicEntry !== undefined && topicEntry !== 'NONE' ? topicEntry.fine : ''
    const prompt = [
      '你在一份长期工作记忆里给「一段工作」写一张卡片，方便以后检索时快速判断「这段里有什么」。',
      '',
      '段标签：' + (segment.label || '（无）'),
      fine === '' ? '' : '所属细线：' + (fineName.get(fine) || fine),
      '段内做的事（按时间，最多 6 条）：',
      members.slice(0, 6).map((row) => '· ' + String(row.title || row.ask).slice(0, 50)).join('\n'),
      artifacts.length === 0 ? '' : '涉及产物：' + artifacts.map((path) => String(path).split(/[\\/]/).pop()).join('、'),
      '',
      '写三样：',
      '1. summary：一两句话说明这段做到什么程度、得出什么结论（60 字以内，不要复述标签）',
      '2. decisions：这段里定下来的关键决定或约束（0–2 条，每条 30 字以内；没有就空数组）',
      '3. open：这段留下的未完成事项（0–2 条，每条 30 字以内；没有就空数组）',
      '只输出 JSON：{"summary":"...","decisions":["..."],"open":["..."]}',
    ].filter((line) => line !== '').join('\n')
    let parsed = null
    try {
      const result = await callLlmWithRetry(prompt, { maxTokens: 500, temperature: 0.1 }, 2)
      parsed = jsonOf(result.content)
    } catch (error) {
      failures.push({ id, error: String(error && error.message ? error.message : error).slice(0, 100) })
      continue
    }
    if (parsed === null || typeof parsed.summary !== 'string') {
      failures.push({ id, error: 'unparsable' })
      continue
    }
    existing.set(id, {
      segment: id,
      session,
      label: String(segment.label || '').slice(0, 60),
      summary: String(parsed.summary).slice(0, 120),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((item) => String(item).slice(0, 40)).slice(0, 2) : [],
      open: Array.isArray(parsed.open) ? parsed.open.map((item) => String(item).slice(0, 40)).slice(0, 2) : [],
      artifacts: artifacts.map((path) => String(path).split(/[\\/]/).pop()),
      topicFine: fine,
      topic: topicEntry !== undefined && topicEntry !== 'NONE' ? topicEntry.group : '',
      hooks: members.length,
      fromSeq: Number(members[0].startSeq),
      toSeq: Number(members[members.length - 1].endSeq),
      ts: String(members[members.length - 1].ts),
    })
    done += 1
    if (done % 10 === 0) {
      console.log('cards 进度 ' + done + '（累计 ' + existing.size + '）')
      if (!dry) writeFileSync(cardsFile, [...existing.values()].map((card) => JSON.stringify(card)).join('\n') + '\n', 'utf8')
    }
  }
}

if (dry) {
  console.log('（dry）将生成 ' + existing.size + ' 张卡')
  process.exit(0)
}
if (existsSync(cardsFile)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(cardsFile, cardsFile + '.bak-cards-' + stamp)
}
writeFileSync(cardsFile, [...existing.values()].map((card) => JSON.stringify(card)).join('\n') + '\n', 'utf8')
console.log('cards.jsonl 共 ' + existing.size + ' 张，本次新增 ' + done + '，失败 ' + failures.length)
