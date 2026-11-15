#!/usr/bin/env node
/**
 * annotate-topics.mjs — 给每个标签写一条「评述」：这个标签大概跟什么有关。
 *
 *   node cli/annotate-topics.mjs [--force]
 *
 * 评述是分层召回的第一道过滤器：新问题只跟 12 条宽类评述比，判出方向后再往下走。
 * 评述写进 topics.json 的 annotation 字段，可以手改——改完重跑即可，不会被覆盖
 * （不带 --force 时已有的 annotation 保留）。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { isBoilerplate } from '../lib/browse.js'
import { callLlmWithRetry } from './_llm.js'

const args = process.argv.slice(2)
const force = args.includes('--force')
const topicsFile = join(dshHome(), 'work-memory', 'topics.json')
const table = JSON.parse(readFileSync(topicsFile, 'utf8'))
const rows = loadHooks().filter((row) => isHumanRow(row) && !isBoilerplate(row))

/** 每个细类下的代表句：标题最长、最近的几条。 */
function samplesFor(fineId, limit = 6) {
  return rows
    .filter((row) => row.topicFine === fineId)
    .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
    .slice(0, limit)
    .map((row) => String(row.title || row.ask).slice(0, 40))
}

const stem = (text) => String(text || '').replace(/[（(].*$/, '').slice(0, 14)
let changed = 0
for (const group of table.topics) {
  const fines = (group.members || []).map((id) => table.fine.find((item) => item.id === id)).filter(Boolean)
  if (fines.length === 0) continue
  const needGroup = force || !group.annotation
  const needFine = fines.filter((fine) => force || !fine.annotation)
  if (!needGroup && needFine.length === 0) continue
  const prompt = [
    '下面是一个工作记忆主题下的细分主题，以及每个细主题下的真实工作标题（代表句）。',
    '宽类：' + group.id + ' ' + group.name + ' — ' + (group.desc || ''),
    '',
    fines.map((fine) => [
      fine.id + '｜' + fine.name,
      '  代表句：' + samplesFor(fine.id).join(' / '),
    ].join('\n')).join('\n'),
    '',
    '请给宽类和每个细类各写一条「评述」：一段 30–50 字的话，说明这一类大概收什么事、边界在哪、什么情况下该来这里找。',
    '要写成能被用来做相关性判断的说明，不要复述名字。',
    '只输出 JSON：{"group":"<宽类评述>","fine":{"i01":"<细类评述>", ...}}',
  ].join('\n')
  const result = await callLlmWithRetry(prompt, { maxTokens: 2600, temperature: 0.1 }, 2)
  const raw = String(result.content || '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  let parsed = null
  try {
    parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null
  } catch {
    parsed = null
  }
  if (parsed === null) {
    console.log(group.id + ' 解析失败，跳过')
    continue
  }
  if (needGroup && typeof parsed.group === 'string' && parsed.group.trim() !== '') {
    group.annotation = parsed.group.trim().slice(0, 120)
    changed += 1
  }
  const fineMap = parsed.fine !== null && typeof parsed.fine === 'object' ? parsed.fine : {}
  for (const fine of needFine) {
    const text = fineMap[fine.id]
    if (typeof text === 'string' && text.trim() !== '') {
      fine.annotation = text.trim().slice(0, 120)
      changed += 1
    }
  }
  console.log(group.id + ' 宽类 + ' + needFine.length + ' 条细类评述已生成')
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(topicsFile, topicsFile + '.bak-annot-' + stamp)
writeFileSync(topicsFile, JSON.stringify(table, null, 2) + '\n', 'utf8')
console.log('写回 topics.json，更新 ' + changed + ' 条评述，备份 .bak-annot-' + stamp)
console.log('\n样例：')
for (const group of table.topics.slice(0, 3)) console.log('  ' + group.id + ' ' + group.name + ' — ' + (group.annotation || '(无)'))
for (const fine of table.fine.slice(0, 3)) console.log('  ' + fine.id + ' ' + fine.name + ' — ' + (fine.annotation || '(无)'))
