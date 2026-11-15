#!/usr/bin/env node
/**
 * segment-sessions.mjs — 先把一段对话切成「事」，再给每件事归类。
 *
 * 为什么：会话是连续问答，单条看会误判（「继续吧」「那就这样」离开上下文没有意义）。
 * 实测：250 个人类会话里 41 个有 ≥2 条钩子，却覆盖了 376/585 条人类材料（64%），
 * 其中 36 个会话的钩子现在散在多个细类里。
 *
 *   node cli/segment-sessions.mjs --build      按会话切段（每个多钩子会话一次调用）
 *   node cli/segment-sessions.mjs --classify   每段归类（喂 81 条细类表）
 *   node cli/segment-sessions.mjs --apply      把段的分类写回它包含的每条钩子
 *   node cli/segment-sessions.mjs --report     看结果
 *
 * 只读账本（--apply 才写，写前备份）。
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { callLlmWithRetry, llmConfig } from './_llm.js'

const PROMPT_VERSION = 'segment-v1'
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const LIMIT = (() => {
  const index = args.indexOf('--limit')
  return index >= 0 && args[index + 1] !== undefined ? Number(args[index + 1]) : 0
})()

const stateDir = join(dshHome(), 'work-memory', '.induct')
mkdirSync(stateDir, { recursive: true })
const segmentsFile = join(stateDir, 'segments.json')
const segmentTopicsFile = join(stateDir, 'segment-topics.json')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

/** 多钩子的人类会话，按 seq 升序。 */
function sessions() {
  const bySession = new Map()
  for (const row of loadHooks()) {
    if (!isHumanRow(row)) continue
    if (!bySession.has(row.session)) bySession.set(row.session, [])
    bySession.get(row.session).push(row)
  }
  const out = []
  for (const [session, rows] of bySession) {
    if (rows.length < 2) continue
    rows.sort((left, right) => Number(left.startSeq) - Number(right.startSeq))
    out.push({ session, rows })
  }
  out.sort((left, right) => right.rows.length - left.rows.length)
  return out
}

function parseJsonObject(text) {
  const raw = String(text || '')
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const hookLine = (row) =>
  row.id + '｜seq ' + row.startSeq + '–' + row.endSeq + '｜' + String(row.ts).slice(0, 10) + '｜' +
  String(row.title || row.ask).slice(0, 50) + '｜' + String(row.ask || '').replace(/\s+/g, ' ').slice(0, 90)

// ── 切段 ────────────────────────────────────────────────────────────────────
async function build() {
  const all = sessions()
  const state = readJson(segmentsFile, { version: 1, promptVersion: PROMPT_VERSION, model: llmConfig().model, sessions: {}, failures: [] })
  let done = 0
  for (const { session, rows } of all) {
    if (LIMIT > 0 && done >= LIMIT) break
    if (state.sessions[session] !== undefined) continue
    const prompt = [
      '下面是同一个会话里按时间排列的 ' + rows.length + ' 条用户请求（id｜seq｜日期｜标题｜提问摘要）。',
      '',
      rows.map(hookLine).join('\n'),
      '',
      '请把它们按「用户在做的事」切成连续的若干段：同一次推进/同一个子任务算一段；换了事情就切。',
      '规则：',
      '1. 每段用第一条和最后一条的 id 表示，段与段必须首尾相接、覆盖全部 ' + rows.length + ' 条，不许重叠或遗漏。',
      '2. 一段里可以只有一条。',
      '3. 每段给一句话标签，写「这段在做什么」。',
      '只输出 JSON：{"segments":[{"from":"<id>","to":"<id>","label":"..."}]}',
    ].join('\n')
    let segments = null
    for (let attempt = 0; attempt < 2 && segments === null; attempt += 1) {
      try {
        const result = await callLlmWithRetry(prompt, { maxTokens: 1200, temperature: 0.1 }, 3)
        const parsed = parseJsonObject(result.content)
        if (parsed !== null && Array.isArray(parsed.segments)) segments = normalizeSegments(parsed.segments, rows)
      } catch {
        /* 重试 */
      }
    }
    if (segments === null) {
      // 兜底：整段当一个段，至少不丢材料
      segments = [{ from: rows[0].id, to: rows[rows.length - 1].id, label: '（切分失败，整段保留）', ids: rows.map((row) => row.id) }]
      state.failures.push({ session, error: 'segment failed, fallback to one segment' })
    }
    state.sessions[session] = segments
    done += 1
    writeJson(segmentsFile, state)
    if (done % 10 === 0) console.log('build 进度 ' + done + '/' + all.length + ' 个会话')
  }
  writeJson(segmentsFile, state)
  const total = Object.values(state.sessions).reduce((sum, list) => sum + list.length, 0)
  console.log('build 完成：会话 ' + Object.keys(state.sessions).length + ' 个 → 段 ' + total + ' 个，失败 ' + state.failures.length)
}

/**
 * 把模型给的 from/to 展开成 id 列表，并**修补**覆盖性：
 * 模型偶尔会漏掉中间几条或收尾早一点，这里把缺口补成一段，而不是整段作废。
 */
function normalizeSegments(raw, rows) {
  const order = rows.map((row) => row.id)
  const position = new Map(order.map((id, index) => [id, index]))
  const out = []
  let cursor = 0
  let repaired = false
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const from = position.get(String(item.from))
    const to = position.get(String(item.to))
    if (from === undefined || to === undefined) continue
    const start = Math.max(from, cursor)
    const end = Math.max(to, start)
    if (start > cursor) {
      // 缺口：补一段，别把材料丢掉
      out.push({ from: order[cursor], to: order[start - 1], label: '（补：模型未覆盖）', ids: order.slice(cursor, start) })
      repaired = true
    }
    if (end < start) continue
    out.push({
      from: order[start],
      to: order[end],
      label: String(item.label || '').slice(0, 60),
      ids: order.slice(start, end + 1),
      ...(start !== from || end !== to ? { repaired: true } : {}),
    })
    if (start !== from || end !== to) repaired = true
    cursor = end + 1
  }
  if (cursor < order.length) {
    out.push({ from: order[cursor], to: order[order.length - 1], label: '（补：模型未覆盖）', ids: order.slice(cursor) })
    repaired = true
  }
  if (out.length === 0) return null
  if (repaired) out[out.length - 1].repairedTail = true
  return out
}

// ── 逐段归类 ─────────────────────────────────────────────────────────────────
async function classify() {
  const final = readJson(join(stateDir, 'final-topics.json'), null)
  const grouped = readJson(join(stateDir, 'final-topics.grouped.json'), null)
  const segments = readJson(segmentsFile, null)
  if (final === null || segments === null) {
    console.log('缺定稿表或切段结果')
    return
  }
  const groupOf = new Map()
  if (grouped !== null) for (const group of grouped.groups) for (const id of group.members) groupOf.set(id, group.id)
  const table = final.topics.map((topic) => topic.id + '｜' + topic.name + '｜' + (topic.desc || '')).join('\n')
  const byId = new Map(loadHooks().map((row) => [row.id, row]))
  const state = readJson(segmentTopicsFile, { version: 1, promptVersion: PROMPT_VERSION, model: llmConfig().model, segments: {}, failures: [] })
  let done = 0
  for (const [session, list] of Object.entries(segments.sessions)) {
    for (let index = 0; index < list.length; index += 1) {
      const key = session + '#' + index
      if (state.segments[key] !== undefined) continue
      if (LIMIT > 0 && done >= LIMIT) break
      const segment = list[index]
      const rows = segment.ids.map((id) => byId.get(id)).filter((row) => row !== undefined)
      const prompt = [
        '下面是已定稿的主题表（细类 id｜名称｜一句话定义），和一段同一会话里连续的用户请求。',
        '',
        table,
        '',
        '这段在做什么：' + segment.label,
        '段内请求（按时间）：',
        rows.map((row) => '· ' + String(row.ts).slice(0, 10) + ' ' + String(row.title || row.ask).slice(0, 60)).join('\n'),
        '',
        '把**整段**归到一个细类。规则：只能从表里选；整段落不进任何一类才用 NONE。',
        '只输出 JSON：{"topic":"i07"} 或 {"topic":"NONE"}',
      ].join('\n')
      let topic = ''
      try {
        const result = await callLlmWithRetry(prompt, { maxTokens: 512, temperature: 0.1 }, 3)
        const parsed = parseJsonObject(result.content)
        topic = parsed !== null && typeof parsed.topic === 'string' ? parsed.topic : ''
      } catch (error) {
        state.failures.push({ key, error: String(error && error.message ? error.message : error).slice(0, 160) })
        writeJson(segmentTopicsFile, state)
        done += 1
        continue
      }
      if (topic === 'NONE') state.segments[key] = 'NONE'
      else if (final.topics.some((item) => item.id === topic)) state.segments[key] = { fine: topic, group: groupOf.get(topic) || '' }
      else {
        state.failures.push({ key, error: 'bad reply: ' + topic })
        writeJson(segmentTopicsFile, state)
        done += 1
        continue
      }
      done += 1
      writeJson(segmentTopicsFile, state)
      if (done % 20 === 0) console.log('classify 进度 ' + done)
    }
  }
  writeJson(segmentTopicsFile, state)
  const assigned = Object.values(state.segments).filter((value) => value !== 'NONE').length
  console.log('classify 完成：已归类段 ' + assigned + '，NONE ' + Object.values(state.segments).filter((value) => value === 'NONE').length + '，失败 ' + state.failures.length)
}

// ── 写回 ────────────────────────────────────────────────────────────────────
function applySegments() {
  const segments = readJson(segmentsFile, null)
  const topics = readJson(segmentTopicsFile, null)
  if (segments === null || topics === null) {
    console.log('缺切段或归类结果')
    return
  }
  const filed = join(dshHome(), 'work-memory', 'hooks.jsonl')
  const raw = readFileSync(filed, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(raw.map((row) => [row.id, row]))
  let changed = 0
  let skipped = 0
  const dist = {}
  for (const [session, list] of Object.entries(segments.sessions)) {
    for (let index = 0; index < list.length; index += 1) {
      const entry = topics.segments[session + '#' + index]
      if (entry === undefined || entry === 'NONE') {
        skipped += list[index].ids.length
        continue
      }
      for (const id of list[index].ids) {
        const row = byId.get(id)
        if (row === undefined) continue
        row.topic = entry.group || ''
        row.topicFine = entry.fine
        changed += 1
        dist[entry.fine] = (dist[entry.fine] || 0) + 1
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(filed, filed + '.bak-segment-' + stamp)
  writeFileSync(filed, raw.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log('写回 ' + changed + ' 条（保持未归类 ' + skipped + ' 条），备份 .bak-segment-' + stamp)
  const final = readJson(join(stateDir, 'final-topics.json'), null)
  const nameOf = new Map((final === null ? [] : final.topics).map((topic) => [topic.id, topic.name]))
  const ordered = Object.entries(dist).sort((left, right) => right[1] - left[1]).slice(0, 15)
  for (const [id, count] of ordered) console.log('  ' + id + ' ' + (nameOf.get(id) || '') + ' ' + count + ' 条')
}

function report() {
  const segments = readJson(segmentsFile, null)
  const topics = readJson(segmentTopicsFile, null)
  if (segments === null) {
    console.log('还没有切段结果')
    return
  }
  const sessionCount = Object.keys(segments.sessions).length
  const segmentCount = Object.values(segments.sessions).reduce((sum, list) => sum + list.length, 0)
  console.log('多钩子会话 ' + sessionCount + ' 个 → ' + segmentCount + ' 段（平均 ' + (segmentCount / Math.max(1, sessionCount)).toFixed(2) + ' 段/会话）')
  const none = topics === null ? 0 : Object.values(topics.segments).filter((value) => value === 'NONE').length
  console.log('段级归类：' + (topics === null ? '未跑' : Object.keys(topics.segments).length + ' 段已判，NONE ' + none))
  const multi = Object.values(segments.sessions).filter((list) => list.length >= 2).length
  console.log('切成多段的会话：' + multi + ' 个')
}

/**
 * 把段固化成正式数据：写 segments.jsonl，并给段内每条钩子打上 segment/segLabel。
 * 侧文件 + 钩子上带引用，面板与召回都按段聚合。
 */
function emit() {
  const segments = readJson(segmentsFile, null)
  const topics = readJson(segmentTopicsFile, { segments: {} })
  if (segments === null) {
    console.log('缺切段结果')
    return
  }
  const filed = join(dshHome(), 'work-memory', 'hooks.jsonl')
  const raw = readFileSync(filed, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const byId = new Map(raw.map((row) => [row.id, row]))
  const final = readJson(join(stateDir, 'final-topics.json'), null)
  const nameOf = new Map((final === null ? [] : final.topics).map((topic) => [topic.id, topic.name]))

  const out = []
  let tagged = 0
  for (const [session, list] of Object.entries(segments.sessions)) {
    for (let index = 0; index < list.length; index += 1) {
      const segment = list[index]
      const entry = topics.segments[session + '#' + index]
      const topicFine = entry !== undefined && entry !== 'NONE' ? entry.fine : ''
      const record = {
        id: session + '#' + index,
        session,
        index,
        fromSeq: segment.ids.length > 0 && byId.has(segment.ids[0]) ? Number(byId.get(segment.ids[0]).startSeq) : 0,
        toSeq: segment.ids.length > 0 && byId.has(segment.ids[segment.ids.length - 1]) ? Number(byId.get(segment.ids[segment.ids.length - 1]).endSeq) : 0,
        label: segment.label,
        hookIds: segment.ids,
        hooks: segment.ids.length,
        topicFine,
        topic: topicFine === '' ? '' : (entry.group || ''),
        topicName: topicFine === '' ? '' : (nameOf.get(topicFine) || ''),
      }
      out.push(record)
      for (const id of segment.ids) {
        const row = byId.get(id)
        if (row === undefined) continue
        row.segment = record.id
        row.segLabel = segment.label
        tagged += 1
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  copyFileSync(filed, filed + '.bak-emit-' + stamp)
  writeFileSync(filed, raw.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  const segmentsOut = join(dshHome(), 'work-memory', 'segments.jsonl')
  writeFileSync(segmentsOut, out.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
  console.log('段表写入 ' + segmentsOut + '（' + out.length + ' 段）')
  console.log('钩子标注 ' + tagged + ' 条，备份 .bak-emit-' + stamp)
  const withTopic = out.filter((record) => record.topicFine !== '').length
  console.log('有主题的段 ' + withTopic + ' / ' + out.length)
}

if (flag('--build')) await build()
else if (flag('--classify')) await classify()
else if (flag('--apply')) applySegments()
else if (flag('--emit')) emit()
else if (flag('--report')) report()
else console.log('用法：--build | --classify | --apply | --emit | --report（可加 --limit N）')
