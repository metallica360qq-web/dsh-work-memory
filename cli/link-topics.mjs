#!/usr/bin/env node
/**
 * link-topics.mjs — 给主题树加一层「连接」：跨宽类的细类↔细类、细类↔宽类，以及宽类↔宽类。
 *
 *   node cli/link-topics.mjs [--limit 3] [--dry]
 *
 * 做法：每个宽类一次调用，把它下面的细类跟全表比一遍，只报真正有关系的（共享交付物、
 * 复用工具/流程、同一件事的不同侧面）。结果写 links.jsonl；手工连的边不会被覆盖。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadLinks, saveLinks, linksFile } from '../lib/links.js'
import { callLlmWithRetry } from './_llm.js'

const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const LIMIT = num('--limit', 3)
const dry = args.includes('--dry')

const dir = join(dshHome(), 'work-memory')
const table = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
const broads = Array.isArray(table.topics) ? table.topics : []
const fines = Array.isArray(table.fine) ? table.fine : []
const nameOf = new Map(fines.map((fine) => [fine.id, fine.name]))
const groupOf = new Map(fines.map((fine) => [fine.id, fine.group]))

const fineLine = (fine) => fine.id + '｜' + fine.name
const short = (text) => String(text || '').replace(/\s+/g, ' ').slice(0, 40)

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

const collected = []
const stamp = new Date().toISOString()

for (const group of broads) {
  const own = fines.filter((fine) => fine.group === group.id)
  if (own.length === 0) continue
  const others = fines.filter((fine) => fine.group !== group.id)
  const prompt = [
    '下面是工作记忆的两层主题表：12 个宽类和它们下面的细线。请判断「本宽类下的每一条细线」跟其他宽类下的细线有没有真正的连接。',
    '',
    '宽类：' + group.name + '（' + (group.annotation || group.desc || '') + '）',
    '',
    '本宽类下的细线（需要判断出发的边）：',
    own.map((fine) => fineLine(fine) + '｜' + short(fine.annotation)).join('\n'),
    '',
    '其他宽类下的细线（候选目标）：',
    others.map((fine) => fineLine(fine) + '（' + (broads.find((b) => b.id === groupOf.get(fine.id)) || {}).name + '）').join('\n'),
    '',
    '规则：',
    '1. 只连真正有关系的：共享交付物、复用工具或流程、同一件事的不同侧面（例如「命理短视频制作」与「插件宣传片」都走视频生产流程）。',
    '2. 不要因为都是「开发」或都出现同一个泛词就连。',
    '3. 每条细线最多 ' + LIMIT + ' 条边。',
    '4. why 写清楚「这两条线在哪一点上相通」，20 字以内；weight 0.5–1，越可靠越高。',
    '只输出 JSON：{"links":[{"from":"<本组细线 id>","to":"<其他细线 id>","why":"...","weight":0.8}]}',
  ].join('\n')

  let parsed = null
  try {
    const result = await callLlmWithRetry(prompt, { maxTokens: 2000, temperature: 0.1 }, 2)
    parsed = jsonOf(result.content)
  } catch (error) {
    console.log(group.id + ' 调用失败：' + String(error && error.message ? error.message : error))
    continue
  }
  const links = parsed !== null && Array.isArray(parsed.links) ? parsed.links : []
  let kept = 0
  for (const link of links) {
    const from = String(link.from || '')
    const to = String(link.to || '')
    if (!nameOf.has(from) || !nameOf.has(to)) continue
    if (groupOf.get(from) === groupOf.get(to)) continue
    collected.push({
      from,
      to,
      kind: 'fine-fine',
      why: short(link.why),
      weight: Number.isFinite(Number(link.weight)) ? Number(link.weight) : 0.6,
      source: 'model',
      ts: stamp,
    })
    kept += 1
  }
  console.log(group.id + ' ' + group.name + '：提出 ' + links.length + ' 条，保留 ' + kept + ' 条')
}

// 宽类之间：一次调用
const broadPrompt = [
  '下面是工作记忆的 12 个宽类（名称 + 评述）。请判断哪些宽类之间本身就重叠或互相支撑。',
  '',
  broads.map((group) => group.id + '｜' + group.name + '｜' + short(group.annotation)).join('\n'),
  '',
  '规则：只连真正重叠的（同一批工作的两个面），不要因为都是知识工作就连；why 20 字以内，weight 0.5–1。',
  '只输出 JSON：{"links":[{"from":"g01","to":"g05","why":"...","weight":0.7}]}',
].join('\n')
try {
  const result = await callLlmWithRetry(broadPrompt, { maxTokens: 1200, temperature: 0.1 }, 2)
  const parsed = jsonOf(result.content)
  const links = parsed !== null && Array.isArray(parsed.links) ? parsed.links : []
  const broadIds = new Set(broads.map((group) => group.id))
  let kept = 0
  for (const link of links) {
    const from = String(link.from || '')
    const to = String(link.to || '')
    if (!broadIds.has(from) || !broadIds.has(to) || from === to) continue
    collected.push({ from, to, kind: 'broad-broad', why: short(link.why), weight: Number(link.weight) || 0.6, source: 'model', ts: stamp })
    kept += 1
  }
  console.log('宽类之间：提出 ' + links.length + ' 条，保留 ' + kept + ' 条')
} catch (error) {
  console.log('宽类调用失败：' + String(error && error.message ? error.message : error))
}

const existing = loadLinks(linksFile(dir))
const manual = existing.filter((link) => link.source === 'manual')
const merged = [...manual, ...collected, ...existing.filter((link) => link.source !== 'manual')]
if (dry) {
  console.log('（dry）将写入 ' + merged.length + ' 条（手工 ' + manual.length + ' 条）')
} else {
  const result = saveLinks(linksFile(dir), merged)
  console.log('写入 links.jsonl：' + result.written + ' 条（去重合并 ' + result.merged + ' 条，其中手工 ' + manual.length + ' 条）')
  console.log('文件：' + linksFile(dir))
}
