/**
 * session-view-plugin — 会话视图（Host 半）。
 *
 * 浏览器半是主体（`lib/client.js`：侧栏图标 + 全屏面板 + 四个视图）。这里只做一件
 * 浏览器做不到的事：**只读地把工作记忆账本端出来**。
 *
 * 两条 exact 路由（同一来源，浏览器带 cookie 直接 fetch）：
 *   GET /session-view/api/memory/snapshot  账本全量的「瘦身快照」+ 主题定义
 *   GET /session-view/api/memory/hook?id=  单条钩子的完整记录（完整提问、完整产物）
 *
 * 为什么不走 dsh-work-memory 自己的 /work-memory/api/*：只有 search、上限 100 条、
 * 无聚合、无主题过滤，画时间线和主题矩阵要来回十几次。这里直接读同一个文件，
 * 按 mtime+size 缓存，账本变大才会重新解析。
 *
 * 账本路径与 dsh-work-memory 保持一致：
 *   <DSH_WORK_MEMORY_DIR>/hooks.jsonl 或 <DSH_HOME>/work-memory/hooks.jsonl
 *   <DSH_WORK_MEMORY_DIR>/topics.json
 */
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis 插件名（Loader 条目 id 与包名一致）。 */
export const name = 'session-view-plugin'

/** 只有 webServer 是必需的：路由挂不上去，这个 Host 半就没有存在意义。 */
export const inject = ['webServer']

const SNAPSHOT_PATH = '/session-view/api/memory/snapshot'
const HOOK_PATH = '/session-view/api/memory/hook'
const PIN_PATH = '/session-view/api/memory/pin'
const TOPIC_NEW_PATH = '/session-view/api/memory/topic-new'
const TITLE_MAX = 90
const ASK_PREVIEW_MAX = 120
const TOPIC_KEYWORDS_MAX = 12
const BODY_MAX = 1_000_000

/**
 * 读一个 JSON 文件，失败给兜底值。
 * @param {string} file 文件路径。
 * @param {unknown} fallback 读不到/解析失败时的返回值。
 * @returns {Promise<unknown>} 解析结果或兜底值。
 */
async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 读完整个请求体并解析成 JSON（只用于本插件自己的小接口）。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {Promise<object>} 解析后的对象。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > BODY_MAX) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * DSH 主目录。
 * @returns {string} 账本所在的主目录。
 */
function dshHome() {
  const override = process.env.DSH_HOME
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : join(homedir(), '.dsh')
}

/**
 * 工作记忆数据目录，跟 dsh-work-memory 的 `dataDir()` 同口径。
 * @returns {string} 数据目录路径。
 */
function dataDir() {
  const override = process.env.DSH_WORK_MEMORY_DIR
  return typeof override === 'string' && override.trim() !== ''
    ? override.trim()
    : join(dshHome(), 'work-memory')
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res Node 响应对象。
 * @param {number} status HTTP 状态码。
 * @param {unknown} value 可 JSON 化的值。
 * @returns {void}
 */
function sendJson(res, status, value) {
  let body
  try {
    body = JSON.stringify(value)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'serialize failed: ' + String(error) }))
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 账本解析缓存：mtime+size 没变就不重读。 */
let ledgerCache = { key: null, ledger: null }

/**
 * 读账本（JSONL，一行一条），按文件指纹缓存。
 * @returns {Promise<{file: string, missing: boolean, badLines: number, rows: object[], mtimeMs: number, size: number}>} 账本内容。
 */
async function readLedger() {
  const file = join(dataDir(), 'hooks.jsonl')
  let info
  try {
    info = await stat(file)
  } catch {
    return { file, missing: true, badLines: 0, rows: [], mtimeMs: 0, size: 0 }
  }
  const key = file + '|' + info.mtimeMs + '|' + info.size
  if (ledgerCache.key === key) return ledgerCache.ledger
  const text = await readFile(file, 'utf8')
  const rows = []
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') rows.push(parsed)
      else badLines += 1
    } catch {
      badLines += 1
    }
  }
  const ledger = { file, missing: false, badLines, rows, mtimeMs: info.mtimeMs, size: info.size }
  ledgerCache = { key, ledger }
  return ledger
}

/**
 * 账本路径与大小（给界面显示「数据从哪来」）。
 * @returns {{file: string, dir: string}} 展示用的路径信息。
 */
function paths() {
  return { file: join(dataDir(), 'hooks.jsonl'), dir: dataDir() }
}

/**
 * 一行账本 → 列表用的瘦身钩子。
 * @param {object} row 账本原始记录。
 * @returns {object} 去掉长文本的行。
 */
function trimHook(row) {
  return {
    id: String(row.id ?? ''),
    session: String(row.session ?? ''),
    agent: String(row.agent ?? 'dsh'),
    topic: String(row.topic ?? ''),
    topicFine: String(row.topicFine ?? ''),
    segment: String(row.segment ?? ''),
    segLabel: String(row.segLabel ?? ''),
    kind: String(row.kind ?? ''),
    level: String(row.level ?? 'turn'),
    title: String(row.title ?? '').slice(0, TITLE_MAX),
    ts: String(row.ts ?? ''),
    startSeq: Number(row.startSeq) || 0,
    endSeq: Number(row.endSeq) || 0,
    status: String(row.status ?? 'active'),
    // 来源（谁产生的）：dsh:user / zcode:subagent_child / hermes:cron …
    // 面板默认只看人类需求，这一层必须原样带出去（中间层丢字段是这个项目踩过的坑）。
    origin: typeof row.origin === 'string' ? row.origin : '',
    artifacts: Array.isArray(row.artifacts) ? row.artifacts.filter(item => typeof item === 'string') : [],
    ask: String(row.ask ?? '').slice(0, ASK_PREVIEW_MAX),
  }
}

/**
 * 读主题定义（缺文件就返回空，界面自己提示）。
 * 两遍读归纳之后 topics.json 是两层的：topics = 宽类（g01…），fine = 细类（i01…）。
 * @returns {Promise<{topics: Array, fine: Array}>} 宽类与细类清单。
 */
async function readTopics() {
  let raw
  try {
    raw = await readFile(join(dataDir(), 'topics.json'), 'utf8')
  } catch {
    return { topics: [], fine: [] }
  }
  try {
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed.topics) ? parsed.topics : []
    const fine = Array.isArray(parsed.fine) ? parsed.fine : []
    return {
      topics: list
        .map(item => ({
          id: String(item.id ?? ''),
          name: String(item.name ?? ''),
          desc: String(item.desc ?? ''),
          keywords: Array.isArray(item.keywords) ? item.keywords.slice(0, TOPIC_KEYWORDS_MAX).map(String) : [],
        }))
        .filter(item => item.id !== ''),
      fine: fine
        .map(item => ({
          id: String(item.id ?? ''),
          name: String(item.name ?? ''),
          desc: String(item.desc ?? ''),
          group: String(item.group ?? ''),
        }))
        .filter(item => item.id !== ''),
    }
  } catch {
    return { topics: [], fine: [] }
  }
}

/**
 * 挂载两条只读路由。
 * @param {object} ctx Cordis 上下文（已注入 webServer）。
 * @returns {void}
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null) return

  /**
   * 账本快照：全量瘦身钩子 + 主题定义 + 来源信息。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 写完响应。
   */
  const snapshot = async (req, res) => {
    try {
      const [ledger, topicTable] = await Promise.all([readLedger(), readTopics()])
      const meta = paths()
      sendJson(res, 200, {
        ok: true,
        generatedAt: new Date().toISOString(),
        source: {
          dir: meta.dir,
          file: ledger.file,
          missing: ledger.missing,
          badLines: ledger.badLines,
          size: ledger.size,
          mtimeMs: ledger.mtimeMs,
        },
        topics: topicTable.topics,
        fine: topicTable.fine,
        hooks: ledger.rows.map(trimHook),
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  /**
   * 单条钩子的完整记录（列表里只有 120 字预览）。
   * @param {import('node:http').IncomingMessage} req 请求（?id=）。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 写完响应。
   */
  const hook = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: '缺少 id' })
        return
      }
      const ledger = await readLedger()
      const row = ledger.rows.find(item => item.id === id)
      if (row === undefined) {
        sendJson(res, 404, { ok: false, error: '账本里没有这条钩子：' + id })
        return
      }
      sendJson(res, 200, {
        ok: true,
        hook: {
          id: String(row.id ?? ''),
          session: String(row.session ?? ''),
          agent: String(row.agent ?? 'dsh'),
          topic: String(row.topic ?? ''),
          topicFine: String(row.topicFine ?? ''),
          kind: String(row.kind ?? ''),
          level: String(row.level ?? 'turn'),
          title: String(row.title ?? ''),
          ask: String(row.ask ?? ''),
          ts: String(row.ts ?? ''),
          startSeq: Number(row.startSeq) || 0,
          endSeq: Number(row.endSeq) || 0,
          status: String(row.status ?? 'active'),
          artifacts: Array.isArray(row.artifacts) ? row.artifacts.filter(item => typeof item === 'string') : [],
          kw: Array.isArray(row.kw) ? row.kw : [],
          alts: Array.isArray(row.alts) ? row.alts : [],
        },
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  /**
   * 当前工作方向（pin）：面板上选了某个标签后写这里，召回按它注入。
   * GET 读、POST 写（{topic,fine,label} 或 {clear:true}）。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 写完响应。
   */
  const pin = async (req, res) => {
    try {
      const file = join(dataDir(), 'pins.json')
      const method = req.method ?? 'GET'
      if (method === 'GET') {
        const data = await readJsonFile(file, { pin: null })
        sendJson(res, 200, { ok: true, pin: data !== null && typeof data === 'object' ? (data.pin ?? null) : null })
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 GET/POST' })
        return
      }
      const body = await readBody(req)
      if (body.clear === true) {
        await writeFile(file, JSON.stringify({ pin: null }, null, 2) + '\n', 'utf8')
        sendJson(res, 200, { ok: true, pin: null })
        return
      }
      const topic = String(body.topic ?? '').trim()
      const fine = String(body.fine ?? '').trim()
      if (topic === '' && fine === '') {
        sendJson(res, 400, { ok: false, error: '缺少 topic 或 fine' })
        return
      }
      const value = {
        topic,
        fine,
        label: String(body.label ?? '').trim().slice(0, 80),
        createdAt: new Date().toISOString(),
        ttlHours: Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0 ? Number(body.ttlHours) : 8,
      }
      await writeFile(file, JSON.stringify({ pin: value }, null, 2) + '\n', 'utf8')
      sendJson(res, 200, { ok: true, pin: value })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  /**
   * 新开一个细类（模块）：写进 topics.json，之后归类/召回/面板都能用它。
   * POST {group, name, annotation}。
   * @param {import('node:http').IncomingMessage} req 请求。
   * @param {import('node:http').ServerResponse} res 响应。
   * @returns {Promise<void>} 写完响应。
   */
  const topicNew = async (req, res) => {
    try {
      if ((req.method ?? 'GET') !== 'POST') {
        sendJson(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      const body = await readBody(req)
      const group = String(body.group ?? '').trim()
      const name = String(body.name ?? '').trim()
      const annotation = String(body.annotation ?? '').trim()
      if (name === '') {
        sendJson(res, 400, { ok: false, error: '缺少模块名' })
        return
      }
      const file = join(dataDir(), 'topics.json')
      const table = await readJsonFile(file, null)
      if (table === null || !Array.isArray(table.topics)) {
        sendJson(res, 500, { ok: false, error: 'topics.json 读不到或格式不对' })
        return
      }
      const groupDef = table.topics.find((item) => item.id === group)
      if (group === '' || groupDef === undefined) {
        sendJson(res, 400, { ok: false, error: '要挂到一个已有的宽类下' })
        return
      }
      let max = 0
      for (const fine of Array.isArray(table.fine) ? table.fine : []) {
        const match = /^i(\d+)$/.exec(String(fine.id))
        if (match !== null) max = Math.max(max, Number(match[1]))
      }
      const id = 'i' + String(max + 1).padStart(2, '0')
      const record = { id, name: name.slice(0, 40), desc: '', annotation: annotation.slice(0, 120), group }
      table.fine = [...(Array.isArray(table.fine) ? table.fine : []), record]
      groupDef.members = [...(Array.isArray(groupDef.members) ? groupDef.members : []), id]
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      await copyFile(file, file + '.bak-topicnew-' + stamp)
      await writeFile(file, JSON.stringify(table, null, 2) + '\n', 'utf8')
      sendJson(res, 200, { ok: true, topic: record })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: SNAPSHOT_PATH, handler: snapshot }), 'session-view: memory snapshot route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: PIN_PATH, handler: pin }), 'session-view: memory pin route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: TOPIC_NEW_PATH, handler: topicNew }), 'session-view: new topic route')
  ctx.effect(() => webServer.register({ kind: 'exact', path: HOOK_PATH, handler: hook }), 'session-view: memory hook route')
}
