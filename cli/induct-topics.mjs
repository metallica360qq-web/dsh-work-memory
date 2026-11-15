#!/usr/bin/env node
/**
 * induct-topics.mjs — 两遍读出来的主题表（归纳编码），不是聚类、也不是固定目录分类。
 *
 * 第一遍：按时间正序，一条一条读材料。每条要么归入已有主题，要么新拟一个主题
 *         （只有和现有主题都不是同一条工作线时才允许新开）。读完材料，主题表就定了。
 * 合并：  第一遍结束后把主题表整体过一遍，把其实是同一件事的几对合并、重编号。
 * 第二遍：拿定稿的主题表再读一遍全部材料，逐条落位（不许新开；确实归不进去的记 NONE）。
 * 报告：  分布、代表材料、未归类比例、与现有主题的对照。
 *
 *   node cli/induct-topics.mjs --pass 1 [--limit 20]    第一遍（可断点续跑）
 *   node cli/induct-topics.mjs --merge                  合并同义主题，产出定稿表
 *   node cli/induct-topics.mjs --pass 2 [--limit 20]    第二遍（用定稿表指派）
 *   node cli/induct-topics.mjs --report                 看结果
 *   node cli/induct-topics.mjs --reset                  清空状态（不动账本）
 *
 * 只读账本；所有中间结果在 <DSH_HOME>/work-memory/.induct/ 下。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { browsableRows } from '../lib/browse.js'
import { loadTopics } from '../lib/topics.js'
import { callLlmWithRetry, llmConfig } from './_llm.js'

const PROMPT_VERSION = 'induct-v1'
const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true
}
const mode = args.pass !== undefined
  ? String(args.pass)
  : args.merge !== undefined
    ? 'merge'
    : args.group !== undefined
      ? 'group'
      : args.assign !== undefined
        ? 'assign'
        : args['assign-apply'] !== undefined
          ? 'assign-apply'
          : args.report !== undefined
            ? 'report'
            : args.reset !== undefined
              ? 'reset'
              : ''
const LIMIT = Number(args.limit || 0)

const stateDir = join(dshHome(), 'work-memory', '.induct')
mkdirSync(stateDir, { recursive: true })
const pass1File = join(stateDir, 'pass1.json')
const finalFile = join(stateDir, 'final-topics.json')
const pass2File = join(stateDir, 'pass2.json')

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
/** 原子写：先写临时文件再改名，断电也不会留半截 JSON。 */
const writeJson = (file, value) => {
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

/** 材料清单：人类提的需求、按时间正序（工作就是这么长出来的）。 */
function materials() {
  const rows = browsableRows(loadHooks())
  rows.sort((left, right) => String(left.ts).localeCompare(String(right.ts)))
  return rows
}

/** 一条材料给模型看的文本。 */
function itemText(row) {
  const arts = (row.artifacts || []).slice(0, 3).map((path) => String(path).split(/[\\/]/).pop()).join('、')
  return 'id=' + row.id + '\n日期=' + String(row.ts).slice(0, 10) + '\n标题=' + String(row.title || row.ask).slice(0, 80) +
    '\n提问=' + String(row.ask || '').replace(/\s+/g, ' ').slice(0, 160) +
    (arts === '' ? '' : '\n产物=' + arts)
}

/** 主题表给模型看的文本。 */
function topicTable(topics) {
  if (topics.length === 0) return '（还没有主题，这是第一条）'
  return topics.map((topic) => topic.id + '｜' + topic.name + '｜' + topic.desc).join('\n')
}

/** 从模型回复里抠出第一个能解析的 JSON 对象。 */
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

function nextTopicId(topics) {
  let max = 0
  for (const topic of topics) {
    const match = /^i(\d+)$/.exec(topic.id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return 'i' + String(max + 1).padStart(2, '0')
}

// ── 第一遍：一条一条长主题 ─────────────────────────────────────────────────
async function runPass1() {
  const rows = materials()
  const state = readJson(pass1File, { version: 1, promptVersion: PROMPT_VERSION, cursor: 0, topics: [], assignments: {}, failures: [], startedAt: new Date().toISOString() })
  state.promptVersion = PROMPT_VERSION
  state.model = llmConfig().model
  let done = 0
  let created = 0
  for (let index = state.cursor; index < rows.length; index += 1) {
    if (LIMIT > 0 && done >= LIMIT) break
    const row = rows[index]
    state.cursor = index + 1
    if (state.assignments[row.id] !== undefined) continue
    const prompt = [
      '你在整理一个开发者近半年的工作记忆。下面是一条材料，和到目前为止已经归纳出的主题表。',
      '',
      '已有的主题（id｜名称｜一句话定义）：',
      topicTable(state.topics),
      '',
      '这条材料：',
      itemText(row),
      '',
      '判断：这条材料属于哪条工作线？',
      '规则：',
      '1. 主题是**工作线**，不是单次任务：一条工作线会反复回来（几周内多次出现）、有明确的交付物或知识积累。',
      '2. 如果这条材料只是一次性小任务，挑一条最接近的工作线归进去，允许略宽——不要为它单开主题。',
      '3. 已有主题里意思相近的，选更宽的那个。',
      '4. 只有当这条材料开出了**新的长期方向**（你会预期它以后还会再出现）时，才新开主题。',
      '5. 新主题名要具体到「做了什么事」，不要用「工具」「杂项」「各种」这类筐；一句话定义写清这条线的边界。',
      '只输出 JSON，二选一：',
      '{"topic":"i01"}',
      '{"topic":"NEW","name":"主题名","desc":"一句话定义"}',
    ].join('\n')
    let reply = ''
    try {
      const result = await callLlmWithRetry(prompt, { maxTokens: 400, temperature: 0.1 }, 3)
      reply = result.content
    } catch (error) {
      state.failures.push({ id: row.id, error: String(error && error.message ? error.message : error).slice(0, 160) })
      writeJson(pass1File, state)
      done += 1
      continue
    }
    const parsed = parseJsonObject(reply)
    if (parsed === null || typeof parsed.topic !== 'string') {
      state.failures.push({ id: row.id, error: 'unparsable: ' + reply.slice(0, 100) })
      writeJson(pass1File, state)
      done += 1
      continue
    }
    if (parsed.topic === 'NEW') {
      const name = String(parsed.name || '').trim().slice(0, 30)
      const desc = String(parsed.desc || '').trim().slice(0, 60)
      if (name.length === 0) {
        state.failures.push({ id: row.id, error: 'NEW without name' })
        writeJson(pass1File, state)
        done += 1
        continue
      }
      const id = nextTopicId(state.topics)
      state.topics.push({ id, name, desc, bornFrom: row.id })
      state.assignments[row.id] = id
      created += 1
    } else {
      const known = state.topics.some((topic) => topic.id === parsed.topic)
      if (!known) {
        state.failures.push({ id: row.id, error: 'unknown topic ' + parsed.topic })
        writeJson(pass1File, state)
        done += 1
        continue
      }
      state.assignments[row.id] = parsed.topic
    }
    done += 1
    writeJson(pass1File, state)
    if (done % 20 === 0) {
      console.log('pass1 进度 ' + state.cursor + '/' + rows.length + '（主题 ' + state.topics.length + ' 个，失败 ' + state.failures.length + '）')
    }
  }
  writeJson(pass1File, state)
  console.log('pass1 本次处理 ' + done + ' 条，新开主题 ' + created + ' 个；累计主题 ' + state.topics.length + ' 个，失败 ' + state.failures.length + ' 条，游标 ' + state.cursor + '/' + rows.length)
  if (state.cursor >= rows.length) console.log('pass1 读完，接着跑 --merge')
}

// ── 合并：把其实是同一件事的主题合掉 ───────────────────────────────────────
async function runMerge() {
  const state = readJson(pass1File, null)
  if (state === null) {
    console.log('没有 pass1 状态，先跑 --pass 1')
    return
  }
  const prompt = [
    '下面是从工作材料里逐条归纳出来的主题表。有些主题其实是同一条工作线被拆成了两个（换了说法、或只是同一个项目的不同阶段）。',
    '',
    topicTable(state.topics),
    '',
    '请找出需要合并的组。规则：',
    '1. 只有确实是同一条工作线才合并；同一项目的不同模块、不同阶段如果值得分开看，就不要合。',
    '2. 每个组用第一个 id 作为合并后的 id，名称取更准确的那个（可以改写）。',
    '3. 不需要合并的主题不要出现在结果里。',
    '只输出 JSON：{"merges":[{"ids":["i03","i07"],"name":"合并后的名称","desc":"一句话定义"}]}',
  ].join('\n')
  const result = await callLlmWithRetry(prompt, { maxTokens: 2000, temperature: 0.1 }, 3)
  const parsed = parseJsonObject(result.content)
  if (parsed === null || !Array.isArray(parsed.merges)) {
    console.log('合并结果解析失败：' + String(result.content).slice(0, 200))
    return
  }
  const removed = new Map()
  for (const merge of parsed.merges) {
    const ids = Array.isArray(merge.ids) ? merge.ids.filter((id) => typeof id === 'string') : []
    if (ids.length < 2) continue
    const keep = ids[0]
    const target = state.topics.find((topic) => topic.id === keep)
    if (target === undefined) continue
    if (typeof merge.name === 'string' && merge.name.trim().length > 0) target.name = merge.name.trim().slice(0, 30)
    if (typeof merge.desc === 'string' && merge.desc.trim().length > 0) target.desc = merge.desc.trim().slice(0, 60)
    for (const id of ids.slice(1)) removed.set(id, keep)
  }
  if (removed.size === 0) {
    console.log('模型认为不需要合并，直接出定稿表')
  }
  state.topics = state.topics.filter((topic) => !removed.has(topic.id))
  for (const [id, keep] of removed) {
    for (const materialId of Object.keys(state.assignments)) {
      if (state.assignments[materialId] === id) state.assignments[materialId] = keep
    }
  }
  // 重编号，保持稳定顺序
  const renumber = new Map()
  state.topics.sort((left, right) => String(left.id).localeCompare(String(right.id)))
  state.topics.forEach((topic, index) => {
    const next = 'i' + String(index + 1).padStart(2, '0')
    renumber.set(topic.id, next)
    topic.id = next
  })
  for (const materialId of Object.keys(state.assignments)) {
    const mapped = renumber.get(state.assignments[materialId])
    if (mapped !== undefined) state.assignments[materialId] = mapped
  }
  writeJson(pass1File, state)
  writeJson(finalFile, { version: 1, promptVersion: PROMPT_VERSION, model: state.model, topics: state.topics, merged: removed.size, createdAt: new Date().toISOString() })
  console.log('合并了 ' + removed.size + ' 个主题，定稿主题 ' + state.topics.length + ' 个 → ' + finalFile)
}

// ── 第二遍：用定稿表逐条落位 ───────────────────────────────────────────────
async function runPass2() {
  const final = readJson(finalFile, null)
  if (final === null) {
    console.log('没有定稿表，先跑 --merge')
    return
  }
  const rows = materials()
  const state = readJson(pass2File, { version: 1, promptVersion: PROMPT_VERSION, cursor: 0, assignments: {}, failures: [] })
  let done = 0
  let none = 0
  for (let index = state.cursor; index < rows.length; index += 1) {
    if (LIMIT > 0 && done >= LIMIT) break
    const row = rows[index]
    state.cursor = index + 1
    if (state.assignments[row.id] !== undefined) continue
    const prompt = [
      '下面是一份已定稿的主题表，和一条材料。请把它指派到其中一个主题。',
      '',
      topicTable(final.topics),
      '',
      '这条材料：',
      itemText(row),
      '',
      '规则：',
      '1. 只能从上表里选一个 id，不许新开主题。',
      '2. 确实一条都归不进去，才用 NONE（这种情况应该很少）。',
      '只输出 JSON：{"topic":"i01"} 或 {"topic":"NONE"}',
    ].join('\n')
    let reply = ''
    try {
      const result = await callLlmWithRetry(prompt, { maxTokens: 512, temperature: 0.1 }, 3)
      reply = result.content
    } catch (error) {
      state.failures.push({ id: row.id, error: String(error && error.message ? error.message : error).slice(0, 160) })
      writeJson(pass2File, state)
      done += 1
      continue
    }
    const parsed = parseJsonObject(reply)
    const topic = parsed !== null && typeof parsed.topic === 'string' ? parsed.topic : ''
    if (topic === 'NONE') {
      state.assignments[row.id] = 'NONE'
      none += 1
    } else if (final.topics.some((item) => item.id === topic)) {
      state.assignments[row.id] = topic
    } else {
      state.failures.push({ id: row.id, error: 'bad reply: ' + reply.slice(0, 100) })
      writeJson(pass2File, state)
      done += 1
      continue
    }
    done += 1
    writeJson(pass2File, state)
    if (done % 20 === 0) console.log('pass2 进度 ' + state.cursor + '/' + rows.length + '（未归类 ' + none + '，失败 ' + state.failures.length + '）')
  }
  writeJson(pass2File, state)
  console.log('pass2 本次处理 ' + done + ' 条，未归类 ' + none + '；累计未归类 ' + Object.values(state.assignments).filter((value) => value === 'NONE').length + '，失败 ' + state.failures.length + ' 条，游标 ' + state.cursor + '/' + rows.length)
}

// ── 分组：把 80 多条细线收成一层可浏览的宽类 ─────────────────────────────
async function runGroup() {
  const final = readJson(finalFile, null)
  const state = readJson(pass1File, null)
  if (final === null) {
    console.log('没有定稿表，先跑 --pass 1 和 --merge')
    return
  }
  const counts = {}
  if (state !== null) {
    for (const topic of Object.values(state.assignments)) counts[topic] = (counts[topic] || 0) + 1
  }
  const list = final.topics.map((topic) => topic.id + '｜' + topic.name + '｜' + (counts[topic.id] || 0) + ' 条')
  const prompt = [
    '下面是一个开发者近半年的工作线清单（id｜名称｜材料条数），共 ' + final.topics.length + ' 条。',
    '',
    list.join('\n'),
    '',
    '请把它们整理成 15–25 个**宽类**，作为上层导航（下层仍然是这些细线）。规则：',
    '1. 每个宽类覆盖若干 id，所有 id 必须恰好出现一次，不许遗漏、不许重复。',
    '2. 宽类名字要具体到「这一类在做什么」，不要「其他」「杂项」这种筐；只有确实无归处的才放进一个「零散事务」。',
    '3. 条数只有 1–2 的细线优先并进相近的宽类。',
    '4. 同一项目的不同模块可以合进同一个宽类（例如各种 PPT 相关、各种 DSH 插件相关）。',
    '只输出 JSON：{"groups":[{"name":"宽类名","desc":"一句话","ids":["i01","i03"]}]}',
  ].join('\n')
  const result = await callLlmWithRetry(prompt, { maxTokens: 4000, temperature: 0.1 }, 3)
  const parsed = parseJsonObject(result.content)
  if (parsed === null || !Array.isArray(parsed.groups)) {
    console.log('分组结果解析失败：' + String(result.content).slice(0, 200))
    return
  }
  const assigned = new Set()
  const groups = []
  for (const group of parsed.groups) {
    const ids = Array.isArray(group.ids) ? group.ids.filter((id) => typeof id === 'string' && final.topics.some((topic) => topic.id === id)) : []
    if (ids.length === 0) continue
    for (const id of ids) assigned.add(id)
    groups.push({
      id: 'g' + String(groups.length + 1).padStart(2, '0'),
      name: String(group.name || '').trim().slice(0, 30) || '(未命名)',
      desc: String(group.desc || '').trim().slice(0, 60),
      members: ids,
      hooks: ids.reduce((sum, id) => sum + (counts[id] || 0), 0),
    })
  }
  // 漏掉的细线兜底进「零散事务」，不丢数据
  const missing = final.topics.filter((topic) => !assigned.has(topic.id)).map((topic) => topic.id)
  if (missing.length > 0) {
    groups.push({ id: 'g' + String(groups.length + 1).padStart(2, '0'), name: '零散事务', desc: '模型没归类的细线，兜底', members: missing, hooks: missing.reduce((sum, id) => sum + (counts[id] || 0), 0) })
  }
  const grouped = { version: 1, promptVersion: PROMPT_VERSION, model: final.model, groups, createdAt: new Date().toISOString() }
  writeJson(join(stateDir, 'final-topics.grouped.json'), grouped)
  console.log('宽类 ' + groups.length + ' 个（漏掉的 ' + missing.length + ' 条细线兜底进零散事务）')
  for (const group of groups) console.log('  ' + group.id + ' ' + group.name + ' — ' + group.members.length + ' 条细线 / ' + group.hooks + ' 条材料')
}

// ── 全量归类：把还没归属的记录落到定稿表 ───────────────────────────────────
const assignFile = join(stateDir, 'assign.json')

/**
 * 需要归类的记录：还没有 topicFine 的行（代理自产 + 归纳之后新写入的）。
 * 每次都按当前账本重算，状态里已有的跳过，因此可断点续跑、也不怕账本增长。
 */
function needAssign() {
  return loadHooks().filter((row) => typeof row.topicFine !== 'string' || row.topicFine === '')
}

async function runAssign() {
  const final = readJson(finalFile, null)
  const grouped = readJson(join(stateDir, 'final-topics.grouped.json'), null)
  if (final === null) {
    console.log('没有定稿表，先跑 --pass 1 / --merge')
    return
  }
  const groupOf = new Map()
  if (grouped !== null) for (const group of grouped.groups) for (const id of group.members) groupOf.set(id, group.id)
  const table = final.topics.map((topic) => topic.id + '｜' + topic.name + '｜' + (topic.desc || '')).join('\n')
  const rows = needAssign()
  const state = readJson(assignFile, { version: 1, promptVersion: PROMPT_VERSION, model: llmConfig().model, assignments: {}, failures: [] })
  let done = 0
  let none = 0
  for (const row of rows) {
    if (LIMIT > 0 && done >= LIMIT) break
    if (state.assignments[row.id] !== undefined) continue
    const origin = typeof row.origin === 'string' && row.origin !== '' ? row.origin : (row.agent || 'dsh')
    const prompt = [
      '下面是一份已定稿的工作记忆主题表（细类 id｜名称｜一句话定义）。请给这条材料选一个最合适的细类。',
      '',
      table,
      '',
      '这条材料：',
      'id=' + row.id + '\n来源=' + origin + '\n日期=' + String(row.ts).slice(0, 10) +
      '\n标题=' + String(row.title || row.ask).slice(0, 80) +
      '\n提问=' + String(row.ask || '').replace(/\s+/g, ' ').slice(0, 160),
      '',
      '规则：',
      '1. 只能从上表里选一个 id，不许新开。',
      '2. 来源是子代理任务的，落到它当时在做的那个项目对应的细类——不要因为"它是任务书"就选不相关的类。',
      '3. 确实一条都归不进去，才用 NONE。',
      '只输出 JSON：{"topic":"i07"} 或 {"topic":"NONE"}',
    ].join('\n')
    let reply = ''
    try {
      const result = await callLlmWithRetry(prompt, { maxTokens: 512, temperature: 0.1 }, 3)
      reply = result.content
    } catch (error) {
      state.failures.push({ id: row.id, error: String(error && error.message ? error.message : error).slice(0, 160) })
      writeJson(assignFile, state)
      done += 1
      continue
    }
    const parsed = parseJsonObject(reply)
    const topic = parsed !== null && typeof parsed.topic === 'string' ? parsed.topic : ''
    if (topic === 'NONE') {
      state.assignments[row.id] = 'NONE'
      none += 1
    } else if (final.topics.some((item) => item.id === topic)) {
      state.assignments[row.id] = { fine: topic, group: groupOf.get(topic) || '' }
    } else {
      state.failures.push({ id: row.id, error: 'bad reply: ' + reply.slice(0, 100) })
      writeJson(assignFile, state)
      done += 1
      continue
    }
    done += 1
    writeJson(assignFile, state)
    if (done % 20 === 0) console.log('assign 进度 ' + done + '/' + rows.length + '（NONE ' + none + '，失败 ' + state.failures.length + '）')
  }
  writeJson(assignFile, state)
  const assigned = Object.values(state.assignments).filter((value) => value !== 'NONE').length
  console.log('assign 本次处理 ' + done + ' 条，NONE ' + none + ' 条；累计已归类 ' + assigned + '，失败 ' + state.failures.length + '，待归类还剩 ' + Math.max(0, needAssign().length - assigned))
}

/** 把归类结果写回账本（原文读、原文写，避免 normalize 丢字段）。 */
function runAssignApply() {
  const state = readJson(assignFile, null)
  if (state === null) {
    console.log('没有归类状态，先跑 --assign')
    return
  }
  const filed = join(dshHome(), 'work-memory', 'hooks.jsonl')
  const raw = readFileSync(filed, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  let changed = 0
  let none = 0
  const dist = {}
  for (const row of raw) {
    const entry = state.assignments[row.id]
    if (entry === undefined) continue
    if (entry === 'NONE') {
      none += 1
      continue
    }
    row.topic = entry.group || ''
    row.topicFine = entry.fine
    changed += 1
    dist[entry.group] = (dist[entry.group] || 0) + 1
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (changed === 0) {
    console.log('没有需要写回的记录')
    return
  }
  copyFileSync(filed, filed + '.bak-assign-' + stamp)
  writeFileSync(filed, raw.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log('写回 ' + changed + ' 条（NONE ' + none + ' 条保持未归类），备份 .bak-assign-' + stamp)
  for (const [group, count] of Object.entries(dist).sort((left, right) => right[1] - left[1])) console.log('  ' + group + ' ' + count + ' 条')
}

// ── 报告 ────────────────────────────────────────────────────────────────────
function runReport() {
  const final = readJson(finalFile, null)
  const pass2 = readJson(pass2File, null)
  if (final === null) {
    console.log('还没有定稿表，先跑 --pass 1 和 --merge')
    return
  }
  const rows = materials()
  const byId = new Map(rows.map((row) => [row.id, row]))
  // 第二遍完整才用它；否则退回第一遍（第一遍是增量的，但覆盖全）
  const pass2Complete = pass2 !== null && pass2.assignments !== undefined && Object.keys(pass2.assignments).length >= rows.length * 0.9
  const assignments = pass2Complete ? pass2.assignments : ((readJson(pass1File, {}).assignments) || {})
  console.log('指派来源：' + (pass2Complete ? '第二遍（定稿表重读）' : '第一遍（增量长表；第二遍不完整，仅用于一致率对照）'))
  const buckets = new Map()
  for (const [id, topic] of Object.entries(assignments)) {
    if (!byId.has(id)) continue
    if (!buckets.has(topic)) buckets.set(topic, [])
    buckets.get(topic).push(byId.get(id))
  }
  const total = rows.length
  const pass1 = readJson(pass1File, null)
  if (pass2 !== null && pass1 !== null && pass2.assignments !== undefined) {
    let compared = 0
    let same = 0
    for (const [id, topic] of Object.entries(pass2.assignments)) {
      if (pass1.assignments[id] === undefined) continue
      compared += 1
      if (pass1.assignments[id] === topic) same += 1
    }
    if (compared > 0) {
      console.log('两遍一致率（第一遍增量长表 vs 第二遍用定稿表重读）：' + same + '/' + compared + '（' + Math.round((same / compared) * 1000) / 10 + '%）')
    }
  }
  const assigned = [...buckets.entries()].reduce((sum, [topic, list]) => sum + (topic === 'NONE' ? 0 : list.length), 0)
  const none = buckets.has('NONE') ? buckets.get('NONE').length : 0
  console.log('材料 ' + total + ' 条，已指派 ' + assigned + ' 条，未归类 ' + none + ' 条' + (total > 0 ? '（' + Math.round((none / total) * 1000) / 10 + '%）' : ''))
  console.log('定稿主题 ' + final.topics.length + ' 个；未出现在材料里的主题 ' + final.topics.filter((topic) => !buckets.has(topic.id)).length + ' 个')
  console.log('')
  const current = loadTopics()
  const currentName = new Map(current.map((topic) => [topic.id, topic.name]))
  const ordered = final.topics.slice().sort((left, right) => (buckets.get(right.id) || []).length - (buckets.get(left.id) || []).length)
  for (const topic of ordered) {
    const list = buckets.get(topic.id) || []
    if (list.length === 0) continue
    const oldTopics = {}
    for (const row of list) oldTopics[row.topic || '(未打标)'] = (oldTopics[row.topic || '(未打标)'] || 0) + 1
    const oldTop = Object.entries(oldTopics).sort((left, right) => right[1] - left[1]).slice(0, 3)
      .map(([id, count]) => (currentName.get(id) || id) + ' ' + count).join('、')
    console.log(topic.id + ' ' + topic.name + '（' + list.length + ' 条）— ' + topic.desc)
    console.log('   旧主题对应：' + oldTop)
    for (const row of list.slice(0, 3)) console.log('   · ' + String(row.ts).slice(0, 10) + ' ' + String(row.title || row.ask).slice(0, 50))
  }
  if (none > 0) {
    console.log('\n未归类样例：')
    for (const row of buckets.get('NONE').slice(0, 8)) console.log('   · ' + String(row.title || row.ask).slice(0, 60))
  }
}

if (mode === 'reset') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const file of [pass1File, finalFile, pass2File]) {
    if (existsSync(file)) copyFileSync(file, file + '.bak-' + stamp)
  }
  for (const file of [pass1File, finalFile, pass2File]) {
    writeFileSync(file, '', 'utf8')
  }
  console.log('状态已清空（旧文件留了 .bak-' + stamp + '）')
} else if (mode === '1') {
  await runPass1()
} else if (mode === '2') {
  await runPass2()
} else if (mode === 'merge') {
  await runMerge()
} else if (mode === 'group') {
  await runGroup()
} else if (mode === 'assign') {
  await runAssign()
} else if (mode === 'assign-apply') {
  runAssignApply()
} else if (mode === 'report') {
  runReport()
} else {
  console.log('用法：--pass 1 | --merge | --group | --pass 2 | --assign | --assign-apply | --report | --reset（可加 --limit N 只跑前 N 条试水）')
}
