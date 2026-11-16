#!/usr/bin/env node
/**
 * extract-artifacts.mjs — 从导入源（hermes / zcode）的对话正文里抽产物路径。
 *
 *   node cli/extract-artifacts.mjs [--dry] [--limit 50] [--agent hermes|zcode|all]
 *
 * 为什么需要：导入源的数据库只有对话，没有文件事件，所以 745 行导入记忆的 artifacts
 * 全是空的，产物视图只覆盖 DSH 自己的记录。这里按会话把正文读回来，用正则抽路径，
 * 再按 seq 区间归到对应的钩子上。只补空的那部分，已有产物的一律不动。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { readForeignEvents, sourceOf } from '../lib/foreign.js'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const LIMIT = num('--limit', 0)
const only = (() => {
  const index = args.indexOf('--agent')
  return index >= 0 && args[index + 1] ? args[index + 1] : 'all'
})()

const JUNK = ['\\appdata\\local\\temp\\', '\\temp\\', '/tmp/', 'node_modules', '\\.git\\', '/.git/']
const isJunk = (path) => {
  const low = path.toLowerCase()
  if (low.endsWith('.tmp')) return true
  return JUNK.some((marker) => low.includes(marker))
}
// Windows 绝对路径；排除 URL（https:// 里的 "s:" 会被误认成盘符），后面紧跟标点/引号就截断
const PATH_RE = /(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s"'<>|?*，。；：、）】\)\]]+/g
const hasExtension = (path) => /\.[A-Za-z0-9]{1,8}$/.test(path)

function pathsIn(text) {
  const out = new Set()
  for (const match of String(text || '').matchAll(PATH_RE)) {
    let path = match[0].replace(/[.,;:]+$/, '')
    // 正文里常见被 JSON 转义过、甚至多重转义的路径：反复还原到单反斜杠
    while (/\\\\/.test(path)) path = path.replace(/\\\\/g, '\\')
    if (/^[a-z]+:\/\//i.test(path)) continue
    if (path.length < 8 || path.length > 260) continue
    if (!hasExtension(path)) continue
    if (isJunk(path)) continue
    out.add(path)
  }
  return [...out]
}

const rows = loadHooks()
const targets = rows.filter((row) => {
  if (Array.isArray(row.artifacts) && row.artifacts.length > 0) return false
  const agent = String(row.agent || '')
  if (agent !== 'hermes' && agent !== 'zcode') return false
  if (only !== 'all' && agent !== only) return false
  return true
})

const bySession = new Map()
for (const row of targets) {
  if (!bySession.has(row.session)) bySession.set(row.session, [])
  bySession.get(row.session).push(row)
}
const sessions = [...bySession.keys()].slice(0, LIMIT > 0 ? LIMIT : undefined)

let touchedHooks = 0
let addedPaths = 0
let failedSessions = 0
const patch = new Map() // row.id → Set(paths)

for (const session of sessions) {
  let events = []
  try {
    events = readForeignEvents(session)
  } catch {
    failedSessions += 1
    continue
  }
  if (events.length === 0) continue
  const hooks = bySession.get(session).sort((left, right) => Number(left.startSeq) - Number(right.startSeq))
  for (const event of events) {
    const found = pathsIn(event.text)
    if (found.length === 0) continue
    // 归到 seq 区间包含这条事件的钩子；找不到就落到最近的钩子
    let target = hooks.find((row) => event.seq >= Number(row.startSeq ?? 0) && event.seq < Number(row.endSeq ?? Infinity))
    if (target === undefined) {
      target = hooks.filter((row) => Number(row.startSeq ?? 0) <= event.seq).pop() || hooks[hooks.length - 1]
    }
    if (target === undefined) continue
    if (patch.get(target.id) === undefined) patch.set(target.id, new Set())
    for (const path of found) {
      // 大小写去重：同一个文件只留第一次出现的写法
      const lower = path.toLowerCase()
      const exists = [...patch.get(target.id)].some((item) => item.toLowerCase() === lower)
      if (!exists) patch.get(target.id).add(path)
    }
  }
}

for (const [id, set] of patch) {
  addedPaths += set.size
  touchedHooks += 1
}

console.log('扫描会话 ' + sessions.length + ' 个（' + [...new Set(targets.map((row) => row.agent))].join('/') + '），失败 ' + failedSessions)
console.log('命中 ' + touchedHooks + ' 条钩子，抽出 ' + addedPaths + ' 条路径')

if (patch.size > 0) {
  const sample = [...patch.entries()].slice(0, 3)
  for (const [id, set] of sample) console.log('  ' + id + ' → ' + [...set].slice(0, 3).join('、'))
}

if (dry) {
  console.log('（dry）没有写盘')
  process.exit(0)
}
if (patch.size === 0) process.exit(0)

const ledger = join(dshHome(), 'work-memory', 'hooks.jsonl')
const raw = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
let changed = 0
for (const row of raw) {
  const set = patch.get(row.id)
  if (set === undefined) continue
  const existing = Array.isArray(row.artifacts) ? row.artifacts : []
  const merged = [...existing]
  for (const path of set) if (!merged.some((item) => String(item).toLowerCase() === path.toLowerCase())) merged.push(path)
  row.artifacts = merged
  changed += 1
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(ledger, ledger + '.bak-artifacts-' + stamp)
writeFileSync(ledger, raw.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
console.log('写回 ' + changed + ' 条钩子，备份 .bak-artifacts-' + stamp)
