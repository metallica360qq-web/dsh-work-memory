/**
 * store.js — 钩子账本（append-only）的读写与检索。
 *
 * 一条钩子 = 一段工作的指针：
 *   { id, session, startSeq, endSeq, ask, title, kind, artifacts[], ts, agent, status }
 * 正文不存；要正文用 memory_open 按 seq 回放会话日志。
 *
 * 检索用中文 bigram + 英文/数字词，纯本地、不调模型、不建库。
 * 账本文件：<DSH_HOME>/work-memory/hooks.jsonl（首次启动从插件 seed/ 复制）
 */

import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dshHome } from './sessionlog.js'

/* ── 账本锁 ────────────────────────────────────────────────────────
 * 写入方有两类：插件 append、CLI 读—改—写。后者会把前者刚追加的行覆盖掉。
 * 用 .lock 文件做互斥；陈旧锁（>30s）自动接管，等待超时抛错而不是静默丢数据。
 */
const LOCK_RETRY_MS = 40
const LOCK_MAX_WAIT_MS = 5000
const LOCK_STALE_MS = 30000

function acquireLock(file) {
  const lockPath = file + '.lock'
  const start = Date.now()
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      closeSync(fd)
      return lockPath
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        /* 锁刚被释放 */
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) throw new Error('账本锁等待超时（另一个写入方还在跑）')
      const until = Date.now() + LOCK_RETRY_MS
      while (Date.now() < until) {
        /* 同步短等待：CLI 是同步代码，等几十毫秒代价可接受 */
      }
    }
  }
}

/** 在账本锁内执行 fn（读—改—写 必须用它）。 */
export function withLedgerLock(fn, file = hooksFile()) {
  const lockPath = acquireLock(file)
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
  }
}

/* ── 备份与轮转 ────────────────────────────────────────────────────
 * 每次写前留一份 .bak-<时间戳>，只保留最近 BACKUP_KEEP_DAYS 天且最多 BACKUP_MAX_COUNT 份。
 */
const BACKUP_KEEP_DAYS = 7
const BACKUP_MAX_COUNT = 10

export function pruneBackups(file) {
  const dir = join(file, '..')
  const base = basename(file)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const baks = names
    .filter((n) => n.startsWith(base + '.bak-'))
    .map((n) => {
      const full = join(dir, n)
      try {
        return { full, mtimeMs: statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 86400000
  let removed = 0
  for (let i = 0; i < baks.length; i += 1) {
    const item = baks[i]
    if (i < BACKUP_MAX_COUNT && item.mtimeMs >= cutoff) continue
    try {
      unlinkSync(item.full)
      removed += 1
    } catch {
      /* ignore */
    }
  }
  return removed
}

/** 写前备份并轮转；文件不存在则跳过。 */
export function backupLedger(file = hooksFile()) {
  if (!existsSync(file)) return null
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const target = file + '.bak-' + ts
  try {
    copyFileSync(file, target)
  } catch {
    return null
  }
  pruneBackups(file)
  return target
}

export function dataDir() {
  // 测试/回放时可用独立目录，避免把实验数据写进真实账本
  const override = process.env.DSH_WORK_MEMORY_DIR
  const dir = typeof override === 'string' && override.trim().length > 0
    ? override.trim()
    : join(dshHome(), 'work-memory')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function hooksFile() {
  return join(dataDir(), 'hooks.jsonl')
}

/** 把文本切成可检索的 token：中文 bigram + 拉丁词。 */
export function tokens(text) {
  const raw = String(text || '').toLowerCase()
  const out = new Set()
  for (const m of raw.match(/[a-z0-9][a-z0-9_.\-]{1,}/g) || []) {
    out.add(m)
    // 复合词再拆一层：ppt-plugin → ppt, plugin；tts-mimo → tts, mimo
    for (const part of m.split(/[_.\-]+/)) {
      if (part.length >= 2) out.add(part)
    }
  }
  for (const seg of raw.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length === 1) out.add(seg)
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2))
  }
  return [...out]
}

function normalize(row) {
  const artifacts = Array.isArray(row.artifacts) ? row.artifacts.filter((x) => typeof x === 'string') : []
  const kind = String(row.kind || 'other')
  return {
    schema: Number.isFinite(row.schema) ? row.schema : 1,
    id: String(row.id || ''),
    session: String(row.session || ''),
    startSeq: Number.isFinite(row.startSeq) ? row.startSeq : 0,
    endSeq: Number.isFinite(row.endSeq) ? row.endSeq : 0,
    ask: String(row.ask || ''),
    title: String(row.title || ''),
    kind,
    // module = 一个工作模块（可检索的主索引）；turn = 单轮流水（细节，仅在模块未命中时兜底）
    level: String(row.level || (kind === 'auto' ? 'turn' : 'module')),
    artifacts,
    // 离线生成的「用户可能问法」，只用于召回，不展示
    alts: Array.isArray(row.alts) ? row.alts.filter((x) => typeof x === 'string') : [],
    // 会话全文抽出的高频领域词（跨 agent 导入时生成），低权重参与召回
    kw: Array.isArray(row.kw) ? row.kw.filter((x) => typeof x === 'string') : [],
    ts: String(row.ts || ''),
    agent: String(row.agent || 'dsh'),
    // 主题归属（t01..t16），主题层检索用
    topic: typeof row.topic === 'string' ? row.topic : undefined,
    status: String(row.status || 'active'),
    supersededBy: typeof row.supersededBy === 'string' ? row.supersededBy : undefined,
    supersededAt: typeof row.supersededAt === 'string' ? row.supersededAt : undefined,
  }
}

let cache = null
let cacheAt = 0
const CACHE_TTL_MS = 5 * 1000

/** 首次使用：把插件 seed 复制成账本。 */
export function ensureSeeded(seedFile) {
  const target = hooksFile()
  if (existsSync(target)) return false
  if (!existsSync(seedFile)) {
    writeFileSync(target, '', 'utf8')
    return false
  }
  writeFileSync(target, readFileSync(seedFile, 'utf8'), 'utf8')
  return true
}

export function loadHooks() {
  if (cache !== null && Date.now() - cacheAt < CACHE_TTL_MS) return cache
  const file = hooksFile()
  const rows = []
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    raw = ''
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const row = normalize(JSON.parse(line))
      if (row.id.length > 0) rows.push(row)
    } catch {
      /* 坏行跳过 */
    }
  }
  cache = rows
  cacheAt = Date.now()
  return rows
}

export function invalidate() {
  cache = null
  cacheAt = 0
}

export function appendHook(row) {
  const normalized = normalize(row)
  return withLedgerLock(() => {
    appendFileSync(hooksFile(), JSON.stringify(normalized) + '\n', 'utf8')
    invalidate()
    return normalized
  })
}

export function getHook(id) {
  return loadHooks().find((r) => r.id === id) || null
}

export function nextId() {
  const rows = loadHooks()
  let max = 0
  for (const r of rows) {
    const m = /^m-(\d+)$/.exec(r.id)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return 'm-' + String(max + 1).padStart(3, '0')
}

/**
 * 查询扩展表：把用户口语映射到账本里常用的词。
 * 只扩展查询侧（不对称），避免把索引搅脏。
 */
const SYNONYMS = {
  配音: ['tts', '音色', '克隆', '声音', '语音'],
  录屏: ['录制', 'cdp', '帧率', 'screencast'],
  手机: ['局域网', 'mobile', '移动端', '手机访问'],
  起卦: ['周易', '蓍草', '占卜', '问事'],
  算命: ['命理', '八字', '紫微'],
  月报: ['总结', '月度', '汇报', '计划'],
  海报: ['封面', '主视觉', '公众号头图'],
  插件: ['plugin', '扩展', 'bundle'],
  课件: ['ppt', '幻灯片', '演示'],
  报表: ['excel', '表格', '统计'],
  单价: ['价格', '扣率', '报价', '实收'],
  会诊: ['联盟', '多中心', '会诊网'],
  立项: ['申请', '预算', '方案'],
  隧道: ['frp', '穿透', '服务器'],
  桌宠: ['桌面应用', 'electron', '壳'],
}

function expandQuery(text) {
  const base = String(text || '')
  const extra = []
  for (const [key, values] of Object.entries(SYNONYMS)) {
    if (base.includes(key)) extra.push(...values)
  }
  return base + ' ' + extra.join(' ')
}

/** token 频率 → idf；随账本缓存一起失效。 */
let idfCache = null
function idfOf(rows) {
  if (idfCache !== null && idfCache.rows === rows) return idfCache.fn
  const df = new Map()
  for (const r of rows) {
    const set = new Set(
      tokens(
        r.title + ' ' + r.ask + ' ' + r.artifacts.join(' ') + ' ' + (r.alts || []).join(' ') + ' ' + (r.kw || []).join(' '),
      ),
    )
    for (const t of set) df.set(t, (df.get(t) || 0) + 1)
  }
  const n = rows.length
  const fn = (t) => Math.log(1 + n / (1 + (df.get(t) || 0)))
  idfCache = { rows, fn }
  return fn
}

/**
 * 检索钩子。打分 = IDF 加权命中率；标题命中再加权；module 级 ×1.15。
 * @returns 形如 [{ ...hook, score }] 的数组（score 降序）
 */
export function searchHooks(query, limit = 3, options = {}) {
  const rows = loadHooks().filter(
    (r) =>
      r.status !== 'archived' &&
      (options.includeSuperseded === true || r.status !== 'superseded') &&
      // 注入场景里要排除"当前会话自己刚写的条目"，否则会自我复读
      (typeof options.excludeSession !== 'string' || r.session !== options.excludeSession) &&
      // 主题层：限定在某工程主题内检索，避免跨主题噪声
      (typeof options.topic !== 'string' || r.topic === options.topic),
  )
  const qTokens = tokens(expandQuery(query))
  if (qTokens.length === 0) {
    const modules = rows.filter((r) => r.level === 'module')
    const pool = modules.length > 0 ? modules : rows
    return pool
      .slice()
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
      .slice(0, limit)
      .map((r) => ({ ...r, score: 0 }))
  }
  const idf = idfOf(rows)
  const qWeight = qTokens.reduce((s, t) => s + idf(t), 0) || 1
  const scored = []
  for (const row of rows) {
    const titleTokens = new Set(tokens(row.title))
    const bodyTokens = new Set(tokens(row.ask + ' ' + row.artifacts.map((p) => basename(p)).join(' ')))
    // 别名单独低权重：帮助召回，但不许压过标题与原始提问
    const altTokens = new Set(tokens((row.alts || []).join(' ')))
    const kwTokens = new Set(tokens((row.kw || []).join(' ')))
    let hitWeight = 0
    let titleWeight = 0
    for (const t of qTokens) {
      if (titleTokens.has(t)) {
        hitWeight += idf(t)
        titleWeight += idf(t)
      } else if (bodyTokens.has(t)) {
        hitWeight += idf(t)
      } else if (altTokens.has(t)) {
        hitWeight += idf(t) * 0.55
      } else if (kwTokens.has(t)) {
        hitWeight += idf(t) * 0.45
      }
    }
    if (hitWeight === 0) continue
    const score = (hitWeight / qWeight) * (1 + 0.4 * (titleWeight / qWeight))
    scored.push({ ...row, score: Math.round(score * 1000) / 1000 })
  }
  // cron 派发的自动化任务会话：保留可查，但降权，避免干扰真实工作召回
  const kindWeight = (r) => (r.kind === 'cron' ? 0.7 : 1)
  const weighted = (r) => r.score * (r.level === 'module' ? 1.15 : 1) * recency(r.ts) * kindWeight(r)
  scored.sort((a, b) => weighted(b) - weighted(a) || String(b.ts).localeCompare(String(a.ts)))
  return scored.slice(0, limit)
}

/**
 * 时间衰减：半年内 ×1.2，一年内 ×1.0，更旧 ×0.7。
 * 只影响排名，不删除任何条目——旧结论仍然查得到，只是排在后面。
 */
export function recency(ts) {
  const t = Date.parse(String(ts || ''))
  if (!Number.isFinite(t)) return 1
  const days = (Date.now() - t) / 86400000
  if (days < 180) return 1.2
  if (days < 365) return 1
  return 0.7
}

/** 标记旧条目被新条目取代（不删除，只改 status）。 */
export function supersede(oldId, newId) {
  return updateHook(oldId, { status: 'superseded', supersededBy: newId, supersededAt: new Date().toISOString() })
}

/**
 * 在锁内「读最新账本 → 变换 → 写回」。
 * CLI 归块/合并必须用它，而不是「拿旧快照调 saveLedger」——后者会覆盖并发追加的条目。
 */
export function updateLedger(fn, file = hooksFile()) {
  return withLedgerLock(() => {
    const raw = readFileSync(file, 'utf8')
    const rows = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* 坏行跳过（verify 会单独报告） */
      }
    }
    const next = fn(rows) || rows
    backupLedger(file)
    writeFileSync(file, next.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    invalidate()
    return next.length
  }, file)
}

/**
 * 全量重写账本（只有在调用方已经持有完整最新数据时才用）。
 * 优先用 updateLedger。
 */
export function saveLedger(rows, file = hooksFile()) {
  return withLedgerLock(() => {
    backupLedger(file)
    writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    invalidate()
    return rows.length
  }, file)
}

/** 按 id 就地修改一条记录（面板改标题/归档用）。 */
export function updateHook(id, patch) {
  const file = hooksFile()
  return withLedgerLock(() => {
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    let changed = 0
    const out = lines.map((line) => {
      try {
        const row = JSON.parse(line)
        if (row.id !== id) return line
        Object.assign(row, patch)
        changed += 1
        return JSON.stringify(row)
      } catch {
        return line
      }
    })
    if (changed > 0) {
      backupLedger(file)
      writeFileSync(file, out.join('\n') + '\n', 'utf8')
      invalidate()
    }
    return changed
  }, file)
}

/** 一行钩子摘要（注入用，控制在 ~90 字符）。 */
export function formatLine(row) {
  const when = row.ts.length >= 10 ? row.ts.slice(0, 10) : ''
  const art = row.artifacts.length > 0 ? ' ｜' + basename(row.artifacts[0]) : ''
  const title = row.title.length > 0 ? row.title : row.ask
  return '· [' + row.id + '] ' + when + ' ' + title.slice(0, 80) + art
}
