#!/usr/bin/env node
/**
 * 给账本条目打主题标签（GLM）。
 *
 *   node cli/tag-topics.js [--batch 30] [--limit 0] [--topics topics.json]
 *
 * 输出：账本每行加 topic（t01..t16）。断点续跑：已有 topic 的跳过。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const batch = Number(args.batch || 30)
const limit = Number(args.limit || 0)
const topicsFile = args.topics || 'topics.json'
const ledger = args.ledger || join(dshHome(), 'work-memory', 'hooks.jsonl')

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const KEY = __llm.key
const ENDPOINT = __llm.baseUrl

const { topics } = JSON.parse(readFileSync(topicsFile, 'utf8'))
const topicById = new Map(topics.map((t) => [t.id, t]))
const catalog = topics.map((t) => t.id + ' ' + t.name + '（' + t.keywords.slice(0, 4).join('/') + '）').join('\n')

const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const todo = rows.filter((r) => !r.topic)
const targets = limit > 0 ? todo.slice(0, limit) : todo
console.log('rows=' + rows.length + ' need_topic=' + todo.length + ' this_run=' + targets.length + ' batch=' + batch)

async function callGlm(prompt) {
  const body = {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 4096,
    stream: false,
    thinking: { type: 'disabled' },
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 160))
  const j = JSON.parse(text)
  return String((j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '') || '')
}

function parseMap(content) {
  let s = String(content).trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) s = fence[1].trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return JSON.parse(s)
}

const byId = new Map(rows.map((r) => [r.id, r]))
let done = 0
let unmapped = 0
for (let i = 0; i < targets.length; i += batch) {
  const chunk = targets.slice(i, i + batch)
  const list = chunk.map((r) => r.id + ' | ' + String(r.title).slice(0, 50) + ' | ' + String(r.ask).replace(/\s+/g, ' ').slice(0, 70)).join('\n')
  const prompt = [
    '下面是 ' + chunk.length + ' 条工作记录。请给每条分配一个主题编号。',
    '',
    '可选主题：',
    catalog,
    '',
    '规则：',
    '1. 只能选一个编号；拿不准就选 t16（杂项）。',
    '2. 短视频相关（抖音/成片/分屏/口播/期号）一律选 t15，即使内容是命理。',
    '3. 只输出 JSON：{"<记录id>": "tXX"}，不要代码块，不要解释。',
    '',
    '记录：',
    list,
  ].join('\n')
  let content = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      content = await callGlm(prompt)
      break
    } catch (e) {
      console.log('retry ' + attempt + ': ' + String(e).slice(0, 90))
      await new Promise((r) => setTimeout(r, 1200 * attempt))
    }
  }
  if (content.length === 0) continue
  try {
    const map = parseMap(content)
    for (const [id, tid] of Object.entries(map)) {
      const row = byId.get(id)
      if (!row || typeof tid !== 'string') continue
      const key = tid.trim()
      if (!topicById.has(key)) {
        unmapped += 1
        continue
      }
      row.topic = key
      done += 1
    }
  } catch (e) {
    console.log('parse fail @' + i + ': ' + String(e).slice(0, 80))
  }
  console.log('progress ' + Math.min(i + batch, targets.length) + '/' + targets.length + ' tagged=' + done)
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(ledger, ledger + '.bak-topics-' + ts)
writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
const dist = {}
for (const r of rows) dist[r.topic || '(none)'] = (dist[r.topic || '(none)'] || 0) + 1
console.log('tagged=' + done + ' unmapped=' + unmapped + ' backup=' + ledger + '.bak-topics-' + ts)
console.log('distribution=' + JSON.stringify(dist))
