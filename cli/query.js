#!/usr/bin/env node
/**
 * CLI 验证脚本（不依赖 DSH 运行时，不需要重启）。
 *
 *   node cli/query.js search "005 分屏"
 *   node cli/query.js open m-015
 *   node cli/query.js open m-015 "分屏"
 *   node cli/query.js stats
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSeeded, hooksFile, loadHooks, searchHooks, getHook } from '../lib/store.js'
import { renderRange } from '../lib/sessionlog.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
ensureSeeded(join(ROOT, 'seed', 'hooks-b9a938eb.jsonl'))

const [cmd, ...rest] = process.argv.slice(2)

function printSearch(query, limit = 5) {
  const hits = searchHooks(query, limit)
  if (hits.length === 0) {
    console.log('(无命中)')
    return
  }
  for (const h of hits) {
    console.log(`[${h.id}] score=${h.score} ${h.title}`)
    console.log(`  提问：${h.ask}`)
    console.log(`  时间：${h.ts}  seq：${h.startSeq}-${h.endSeq}`)
    if (h.artifacts.length > 0) console.log(`  产物：${h.artifacts.slice(0, 3).join(' | ')}`)
    console.log('')
  }
}

if (cmd === 'search') {
  const query = rest.join(' ').trim()
  printSearch(query, 5)
} else if (cmd === 'open') {
  const id = rest[0]
  const query = rest.slice(1).join(' ').trim()
  const hook = getHook(id)
  if (hook === null) {
    console.log('没有这个钩子：' + id)
    process.exit(1)
  }
  console.log(`# ${hook.title}`)
  console.log(`提问：${hook.ask}`)
  console.log(`会话：${hook.session}  seq：${hook.startSeq}-${hook.endSeq}`)
  console.log('—— 原文 ——')
  const range = renderRange(hook.session, hook.startSeq, hook.endSeq, query, 6000)
  console.log(`file=${range.file} lines=${range.count}`)
  console.log(range.text)
} else if (cmd === 'stats') {
  const rows = loadHooks()
  const sessions = new Set(rows.map((r) => r.session))
  console.log('账本：' + hooksFile())
  console.log('钩子数：' + rows.length + ' ｜ 会话数：' + sessions.size)
  const kinds = {}
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1
  console.log('类型分布：' + JSON.stringify(kinds))
} else {
  console.log('用法：search "<query>" | open <id> ["query"] | stats')
}
