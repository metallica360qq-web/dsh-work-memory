#!/usr/bin/env node
/**
 * multi-label.mjs — 给跨界的工作补上第二个主题：一段工作可能同时属于两条线。
 *
 *   node cli/multi-label.mjs [--limit 50] [--dry]
 *
 * 候选不是全表，而是「主主题的一跳邻居」（links.jsonl 里权重 ≥0.5 的边），
 * 所以每次调用只问「这几个邻居里有没有真的也牵涉到的」，便宜且不容易乱连。
 * 结果写回账本的 topics 数组（原始 JSONL 读改写，写前备份）。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { loadLinks, neighbors, linksFile } from '../lib/links.js'
import { callLlmWithRetry } from './_llm.js'

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const LIMIT = num('--limit', 50)
const dry = args.includes('--dry')

const dir = join(dshHome(), 'work-memory')
const table = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
const fineName = new Map((table.fine || []).map((fine) => [fine.id, fine.name]))
const links = loadLinks(linksFile(dir))
const stateFile = join(dir, '.induct', 'multilabel.json')
const segmentsFile = join(dir, '.induct', 'segments.json')
const segmentTopicsFile = join(dir, '.induct', 'segment-topics.json')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')

const segments = readJson(segmentsFile, null)
const segmentTopics = readJson(segmentTopicsFile, null)
if (segments === null || segmentTopics === null) {
  console.log('缺切段或段归类结果')
  process.exit(1)
}

const rows = new Map(loadHooks().map((row) => [row.id, row]))
const state = readJson(stateFile, { version: 1, results: {}, failures: [] })

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
for (const [session, list] of Object.entries(segments.sessions)) {
  for (let index = 0; index < list.length; index += 1) {
    if (LIMIT > 0 && done >= LIMIT) break
    const key = session + '#' + index
    if (state.results[key] !== undefined) continue
    const topicEntry = segmentTopics.segments[key]
    if (topicEntry === undefined || topicEntry === 'NONE') continue
    const primary = topicEntry.fine
    const candidates = neighbors(links, primary)
      .filter((item) => fineName.has(item.node) && item.weight >= 0.5)
      .slice(0, 5)
    if (candidates.length === 0) {
      state.results[key] = []
      continue
    }
    const segment = list[index]
    const titles = segment.ids.map((id) => rows.get(id)).filter((row) => row !== undefined)
      .slice(0, 4).map((row) => String(row.title || row.ask).slice(0, 40))
    const prompt = [
      '一段工作主要属于「' + (fineName.get(primary) || primary) + '」（' + primary + '）。',
      '候选的相邻主题：',
      candidates.map((item) => '- ' + item.node + '｜' + fineName.get(item.node) + '（' + item.why + '）').join('\n'),
      '',
      '这段里实际做的事：', titles.map((title) => '· ' + title).join('\n'),
      '',
      '这段工作是否**真的也牵涉**到某个相邻主题（不是「有一点像」，而是确实用它/为它服务）？',
      '只输出 JSON：{"topics":["i65"]}（0–2 个 id，没有就空数组）',
    ].join('\n')
    try {
      const result = await callLlmWithRetry(prompt, { maxTokens: 200, temperature: 0.1 }, 2)
      const parsed = jsonOf(result.content)
      const picked = parsed !== null && Array.isArray(parsed.topics)
        ? parsed.topics.map(String).filter((id) => candidates.some((item) => item.node === id)).slice(0, 2)
        : []
      state.results[key] = picked
    } catch (error) {
      state.failures.push({ key, error: String(error && error.message ? error.message : error).slice(0, 120) })
    }
    done += 1
    writeJson(stateFile, state)
    if (done % 20 === 0) console.log('multi-label 进度 ' + done)
  }
}

const hits = Object.values(state.results).filter((list) => list.length > 0).length
console.log('multi-label：本次处理 ' + done + ' 段，累计有副标签的段 ' + hits + ' / ' + Object.keys(state.results).length)
if (dry) process.exit(0)

// 写回：把段里每条钩子的 topics 设成模型挑出来的副标签
const ledger = join(dir, 'hooks.jsonl')
if (!existsSync(ledger)) process.exit(0)
const raw = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
const byId = new Map(raw.map((row) => [row.id, row]))
let changed = 0
for (const [session, list] of Object.entries(segments.sessions)) {
  for (let index = 0; index < list.length; index += 1) {
    const picked = state.results[session + '#' + index]
    if (!Array.isArray(picked) || picked.length === 0) continue
    for (const id of list[index].ids) {
      const row = byId.get(id)
      if (row === undefined) continue
      if (!isHumanRow(row)) continue
      const merged = [...new Set([...(Array.isArray(row.topics) ? row.topics : []), ...picked])]
        .filter((item) => item !== row.topicFine)
      row.topics = merged
      changed += 1
    }
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(ledger, ledger + '.bak-multilabel-' + stamp)
writeFileSync(ledger, raw.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
console.log('写回 ' + changed + ' 条钩子的 topics，备份 .bak-multilabel-' + stamp)
