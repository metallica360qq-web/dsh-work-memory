#!/usr/bin/env node
/**
 * 离线别名扩展：给每条钩子生成 3 个「用户可能这样问」的口语说法，存进 alts 字段。
 * 目的：让字面检索也能覆盖同义不同词（运行时仍然零模型调用）。
 *
 *   node cli/gen-alts.js [--batch 12] [--limit 0] [--model glm-5.3-flash]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const batch = Number(args.batch || 12)
const limit = Number(args.limit || 0)
const model = args.model || 'glm-5.3-flash'
const file = args.out || join(dshHome(), 'work-memory', 'hooks.jsonl')

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const KEY = __llm.key
const URL = __llm.baseUrl

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const todo = rows.filter((r) => !Array.isArray(r.alts) || r.alts.length === 0)
const targets = limit > 0 ? todo.slice(0, limit) : todo
console.log('rows=' + rows.length + ' need_alts=' + todo.length + ' this_run=' + targets.length + ' batch=' + batch)

async function callGlm(prompt) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 4096,
    stream: false,
    thinking: { type: 'disabled' },
  }
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200))
  const j = JSON.parse(text)
  const c = j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : ''
  return { content: String(c || ''), usage: j.usage || null }
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
let tokens = 0
for (let i = 0; i < targets.length; i += batch) {
  const chunk = targets.slice(i, i + batch)
  const list = chunk.map((r) => r.id + ' | ' + r.title + (r.artifacts && r.artifacts.length ? ' | 文件:' + r.artifacts[0].split(/[\\/]/).pop() : '')).join('\n')
  const prompt = [
    '下面是工作记忆索引里的 ' + chunk.length + ' 个条目标题。请为每一条写 3 个「用户会这样问」的口语说法。',
    '要求：',
    '1. 不要照抄标题用词，用同义表达或更口语的说法（例如「TTS音色选型」→「配音怎么挑声音」）。',
    '2. 每条不超过 20 字，像人随口问的一句话。',
    '3. 只输出 JSON 对象：{"<id>": ["问法1","问法2","问法3"]}，不要代码块标记，不要解释。',
    '',
    '条目：',
    list,
  ].join('\n')
  let content = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const r = await callGlm(prompt)
      content = r.content
      if (r.usage) tokens += r.usage.total_tokens || 0
      break
    } catch (e) {
      console.log('retry ' + attempt + ': ' + String(e).slice(0, 120))
      await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  if (content.length === 0) continue
  let map
  try {
    map = parseMap(content)
  } catch (e) {
    console.log('parse fail @' + i + ': ' + String(e).slice(0, 100))
    continue
  }
  for (const [id, alts] of Object.entries(map)) {
    const row = byId.get(id)
    if (!row || !Array.isArray(alts)) continue
    row.alts = alts.map((x) => String(x).slice(0, 40)).filter((x) => x.length > 0).slice(0, 4)
    done += 1
  }
  console.log('progress ' + Math.min(i + batch, targets.length) + '/' + targets.length + ' filled=' + done)
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(file, file + '.bak-alts-' + ts)
writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
console.log('filled=' + done + ' tokens=' + tokens + ' backup=' + file + '.bak-alts-' + ts)
