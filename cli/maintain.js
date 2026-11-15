#!/usr/bin/env node
/**
 * maintain.js — 让两遍归纳后的数据模型跟得上新对话（给计划任务调）。
 *
 *   node cli/maintain.js [--assign 20] [--segment 3] [--classify 10] [--dry]
 *
 * 做三件事，每件都只处理「还缺的」：
 *   1. 有没归类的（缺 topicFine）→ induct-topics --assign + --assign-apply
 *   2. 有新的多钩子会话没切段 → segment-sessions --build + --classify + --apply + --emit
 *   3. 清理过期备份
 * 幂等：没有要补的就直接退出，不调模型。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHooks, pruneBackups } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { dshHome } from '../lib/sessionlog.js'

const cliDir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const num = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : fallback
}
const ASSIGN_LIMIT = num('--assign', 20)
const SEGMENT_LIMIT = num('--segment', 3)
const CLASSIFY_LIMIT = num('--classify', 10)
const dry = args.includes('--dry')

const run = (script, scriptArgs) => {
  console.log('  → ' + script + ' ' + scriptArgs.join(' '))
  if (dry) return 0
  const result = spawnSync(process.execPath, [join(cliDir, script), ...scriptArgs], { stdio: 'inherit' })
  return result.status === null ? 1 : result.status
}

const rows = loadHooks()
// 判过 NONE 的不要每小时重判：assign.json 里出现过的 id 一律不再送模型
let judged = {}
try {
  const state = JSON.parse(readFileSync(join(dshHome(), 'work-memory', '.induct', 'assign.json'), 'utf8'))
  judged = state !== null && typeof state === 'object' && state.assignments !== undefined ? state.assignments : {}
} catch {
  judged = {}
}
const unassigned = rows.filter(
  (row) => isHumanRow(row) && row.status !== 'superseded' && !row.topicFine && judged[row.id] === undefined,
)
const segmentsFile = join(dshHome(), 'work-memory', 'segments.jsonl')
const segmented = new Set()
if (existsSync(segmentsFile)) {
  for (const line of readFileSync(segmentsFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (typeof record.session === 'string') segmented.add(record.session)
    } catch {
      /* 坏行跳过 */
    }
  }
}
const bySession = new Map()
for (const row of rows) {
  if (!isHumanRow(row)) continue
  if (!bySession.has(row.session)) bySession.set(row.session, 0)
  bySession.set(row.session, bySession.get(row.session) + 1)
}
const needSegments = [...bySession.entries()].filter(([session, count]) => count >= 2 && !segmented.has(session)).length

console.log('maintain: 待归类 ' + unassigned.length + ' 条，待切段会话 ' + needSegments + ' 个' + (dry ? '（dry）' : ''))

let failed = 0
if (unassigned.length > 0) {
  failed |= run('induct-topics.mjs', ['--assign', '--limit', String(ASSIGN_LIMIT)])
  failed |= run('induct-topics.mjs', ['--assign-apply'])
}
if (needSegments > 0) {
  failed |= run('segment-sessions.mjs', ['--build', '--limit', String(SEGMENT_LIMIT)])
  failed |= run('segment-sessions.mjs', ['--classify', '--limit', String(CLASSIFY_LIMIT)])
  failed |= run('segment-sessions.mjs', ['--apply'])
  failed |= run('segment-sessions.mjs', ['--emit'])
}

if (!dry) {
  const removedHooks = pruneBackups(join(dshHome(), 'work-memory', 'hooks.jsonl'))
  const removedTopics = pruneBackups(join(dshHome(), 'work-memory', 'topics.json'))
  console.log('maintain: 清理备份 ' + (removedHooks + removedTopics) + ' 个')
}
console.log('maintain: done' + (failed === 0 ? '' : '（有步骤失败，退出码 ' + failed + '）'))
process.exit(failed === 0 ? 0 : 1)
