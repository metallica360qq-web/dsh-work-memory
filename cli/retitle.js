#!/usr/bin/env node
/**
 * 给跨 agent 导入的条目重写标题（GLM）。
 * 导入时的标题是"首条提问"，信息量低；这里按整段提问生成「做了什么 + 关键实体」的标题。
 *
 *   node cli/retitle.js [--agent zcode|hermes|all] [--batch 10] [--limit 0]
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const agentFilter = args.agent || 'all'
const batch = Number(args.batch || 10)
const limit = Number(args.limit || 0)
const file = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const KEY = __llm.key
const ENDPOINT = __llm.baseUrl

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const targets = rows.filter(
  (r) => (agentFilter === 'all' || r.agent === agentFilter) && r.agent !== 'dsh' && (!r.retitled),
)
const todo = limit > 0 ? targets.slice(0, limit) : targets
console.log('rows=' + rows.length + ' targets=' + targets.length + ' this_run=' + todo.length)

async function callGlm(prompt) {
  const body = {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
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
for (let i = 0; i < todo.length; i += batch) {
  const chunk = todo.slice(i, i + batch)
  const list = chunk.map((r) => r.id + ' | 提问：' + String(r.ask).replace(/\s+/g, ' ').slice(0, 180)).join('\n')
  const prompt = [
    '下面是 ' + chunk.length + ' 条工作记录（只有提问，没有回复）。请为每条写一句标题。',
    '要求：',
    '1. 标题写清「用户在这段里做了什么 + 关键实体」，例如「缠论策略止损参数推导」「AD 月报数据整理」。',
    '2. 不超过 30 字，不要用「讨论」「优化」「探索」这类空词单独成句。',
    '3. 只输出 JSON：{"<id>": "标题"}，不要代码块，不要解释。',
    '',
    list,
  ].join('\n')
  let content = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      content = await callGlm(prompt)
      break
    } catch (e) {
      console.log('retry ' + attempt + ': ' + String(e).slice(0, 100))
      await new Promise((r) => setTimeout(r, 1200 * attempt))
    }
  }
  if (content.length === 0) continue
  try {
    const map = parseMap(content)
    for (const [id, title] of Object.entries(map)) {
      const row = byId.get(id)
      if (!row || typeof title !== 'string' || title.trim().length === 0) continue
      row.title = title.trim().slice(0, 80)
      row.retitled = true
      done += 1
    }
  } catch (e) {
    console.log('parse fail @' + i + ': ' + String(e).slice(0, 80))
  }
  console.log('progress ' + Math.min(i + batch, todo.length) + '/' + todo.length + ' done=' + done)
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(file, file + '.bak-retitle-' + ts)
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log('retitled=' + done + ' backup=' + file + '.bak-retitle-' + ts)
