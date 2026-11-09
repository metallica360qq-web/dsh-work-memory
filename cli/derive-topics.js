#!/usr/bin/env node
/**
 * 第一步：从现有账本归纳"工程主题"（10~15 个大主题）。
 *
 *   node cli/derive-topics.js [--out topics.json] [--sample 200]
 *
 * 抽样按 agent 分层，避免被某一个源的量压住。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const outFile = args.out || 'topics.json'
const sample = Number(args.sample || 200)
const ledger = args.ledger || join(dshHome(), 'work-memory', 'hooks.jsonl')

import { llmConfig } from './_llm.js'
// endpoint / model / key 统一由 _llm.js 决定（可用 DSH_WM_LLM_* 环境变量覆盖）
const __llm = llmConfig()
const KEY = __llm.key
const ENDPOINT = __llm.baseUrl

const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byAgent = new Map()
for (const r of rows) {
  if (!byAgent.has(r.agent)) byAgent.set(r.agent, [])
  byAgent.get(r.agent).push(r)
}
const perAgent = Math.max(10, Math.floor(sample / byAgent.size))
const picked = []
for (const [agent, list] of byAgent) {
  const step = Math.max(1, Math.floor(list.length / perAgent))
  for (let i = 0; i < list.length && picked.filter((x) => x.agent === agent).length < perAgent; i += step) {
    picked.push(list[i])
  }
}
console.log('ledger=' + rows.length + ' sample=' + picked.length + ' agents=' + [...byAgent.keys()].join(','))

const list = picked.map((r) => '- [' + r.agent + '] ' + r.title).join('\n')
const prompt = [
  '下面是一个人的 AI 助手历史工作条目（' + picked.length + ' 条，来自 dsh/zcode/hermes 三个 agent）。',
  '请把它们归纳成 8~15 个「工程项目级」的大主题。',
  '',
  '要求：',
  '1. 主题是一个完整工程或长期方向，例如「命理短视频账号」「AD 检测项目」「DSH 插件生态」——不是单个任务。',
  '2. 每条主题给出：name（不超过 12 字）、keywords（4~8 个能触发它的关键词）、desc（一句话说明这个主题在做什么）。',
  '3. 杂项、一次性小任务归到「杂项与工具」，但不要占比过大。',
  '4. 只输出 JSON 数组：[{"name":"...","keywords":["..."],"desc":"..."}]，不要代码块，不要解释。',
  '',
  '条目：',
  list,
].join('\n')

async function callGlm() {
  const body = {
    model: 'glm-5.3-flash',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 8192,
    stream: false,
    thinking: { type: 'disabled' },
  }
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200))
  const j = JSON.parse(text)
  return String((j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '') || '')
}

let content = ''
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    content = await callGlm()
    break
  } catch (e) {
    console.log('retry ' + attempt + ': ' + String(e).slice(0, 100))
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
}
let s = content.trim()
const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
if (fence) s = fence[1].trim()
const a = s.indexOf('[')
const b = s.lastIndexOf(']')
if (a >= 0 && b > a) s = s.slice(a, b + 1)
const topics = JSON.parse(s)
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), source: ledger, topics }, null, 2), 'utf8')
console.log('topics=' + topics.length + ' -> ' + outFile)
for (const t of topics) console.log('  ' + t.name + ' | ' + (t.keywords || []).join('/') + ' | ' + String(t.desc || '').slice(0, 40))
