/**
 * dsh-work-memory — 对话级工作记忆索引。
 *
 * 解决什么：长会话里被压缩掉的工作（提问、做法、产物）在后续对话中找不回来，
 * 于是反复重造轮子。本插件只做三件事：
 *   1. 记住「用户提过什么需求」→ 钩子（一句话 + 时间 + 产物路径 + seq 指针）
 *   2. 命中钩子后，按 seq 回放当时那段原文（压缩不删日志）
 *   3. 每轮把最相关的钩子注入运行时上下文（只给标题行，正文按需展开）
 *
 * 不做什么：不总结对话、不存模型输出、不建向量库、不调模型、不改 cairn。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendHook, dataDir, ensureSeeded, formatLine, getHook, nextId, searchHooks, supersede, loadHooks } from './store.js'
import { renderRange } from './sessionlog.js'
import { matchTopic, topicName, loadTopics } from './topics.js'
import { topicOverview, topicSessions, sessionHooks, recentSessions, browsableRows, isBoilerplate } from './browse.js'
import { isHumanRow, originLabel } from './origin.js'
import { recallUnits, formatUnitLine, loadSegmentMap } from './units.js'
import { loadLinks, neighbors, linksFile } from './links.js'

let segmentCache = { at: -1, map: new Map() }
let pinCache = { at: -1, pin: null }
let linkCache = { at: -1, list: [] }
let fineCache = { at: -1, map: new Map() }

/**
 * 连接表（links.jsonl）按 mtime 缓存。
 * @returns {Array} 边列表。
 */
function linkTable() {
  const file = linksFile(dataDir())
  let mtime = -1
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return []
  }
  if (linkCache.at !== mtime) linkCache = { at: mtime, list: loadLinks(file) }
  return linkCache.list
}

/**
 * 细类 id → 名称（从 topics.json 的 fine 段读，按 mtime 缓存）。
 * @returns {Map<string, string>} 名称表。
 */
function fineNames() {
  const file = join(dataDir(), 'topics.json')
  let mtime = -1
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return new Map()
  }
  if (fineCache.at !== mtime) {
    const map = new Map()
    try {
      const table = JSON.parse(readFileSync(file, 'utf8'))
      for (const fine of Array.isArray(table.fine) ? table.fine : []) map.set(String(fine.id), String(fine.name || fine.id))
    } catch {
      /* 读不到就空表 */
    }
    fineCache = { at: mtime, map }
  }
  return fineCache.map
}

/**
 * 「相关主题」一行：顺着连接表走一跳，让召回能跨模块切换。
 * @param {string} nodeId 节点 id（细类或宽类）。
 * @returns {string} 形如「\n相关主题：A、B」；没有连接时为空串。
 */
function relatedLine(nodeId) {
  if (typeof nodeId !== 'string' || nodeId === '') return ''
  const nb = neighbors(linkTable(), nodeId)
  if (nb.length === 0) return ''
  const names = fineNames()
  const labels = nb.slice(0, 4).map((item) => names.get(item.node) || topicName(item.node) || item.node)
  return '\n相关主题（可切过去）：' + labels.join('、')
}

/**
 * 面板上选定的「当前工作方向」。过期（默认 8 小时）就当没有。
 * @returns {{topic?: string, fine?: string, label?: string, createdAt?: string, ttlHours?: number}|null} 有效 pin 或 null。
 */
function activePin() {
  const file = join(dataDir(), 'pins.json')
  let mtime = -1
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return null
  }
  if (pinCache.at !== mtime) {
    let pin = null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      pin = parsed !== null && typeof parsed === 'object' && parsed.pin !== undefined ? parsed.pin : null
    } catch {
      pin = null
    }
    pinCache = { at: mtime, pin }
  }
  const pin = pinCache.pin
  if (pin === null || typeof pin !== 'object') return null
  const created = Date.parse(String(pin.createdAt || ''))
  const ttl = Number(pin.ttlHours) > 0 ? Number(pin.ttlHours) : 8
  if (Number.isFinite(created) && Date.now() - created > ttl * 3600 * 1000) return null
  return pin
}

/**
 * 段表（segments.jsonl）按 mtime 缓存，调用频繁也不反复读盘。
 * @returns {Map<string, {label: string, fromSeq: number, toSeq: number, hooks: number}>} 段 id → 段信息。
 */
function segmentMap() {
  const file = join(dataDir(), 'segments.jsonl')
  let mtime = -1
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    return new Map()
  }
  if (segmentCache.at !== mtime) segmentCache = { at: mtime, map: loadSegmentMap(file) }
  return segmentCache.map
}
import { registerWebPanel } from './webpanel.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// 可选种子：默认没有（包内不含任何个人数据）；需要预置时用 DSH_WM_SEED 指向自己的文件
const SEED_FILE = process.env.DSH_WM_SEED || ''

export const name = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name
  } catch {
    /* 兜底 */
  }
  return 'dsh-work-memory'
})()

/**
 * 只声明 web/host 两个平面都存在的服务。
 * tokenMeter / compaction 只挂 host 平面，写进来会让 fiber 永久 pending。
 */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** 等价于 dsh-tools 的 defineTool，只保留本插件用到的字段（插件必须零外部依赖）。 */
function defineTool({ name, description, parameters, output, execute }) {
  return {
    name,
    description,
    parameters: parameters ?? { type: 'object', properties: {} },
    output: {
      schema: output.schema,
      render: (args, value) => output.render(args, value),
    },
    execute,
  }
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks.trim() : ''
  const out = []
  for (const b of blocks) if (b && typeof b.text === 'string') out.push(b.text)
  return out.join('').trim()
}

const TEMP_MARKERS = ['\\appdata\\local\\temp\\', '\\temp\\', '/tmp/', 'node_modules', '\\.git\\', '/.git/']

function isJunkPath(p) {
  const low = String(p).toLowerCase().replace(/\//g, '\\')
  if (low.endsWith('.tmp')) return true
  return TEMP_MARKERS.some((m) => low.includes(m.replace(/\//g, '\\')))
}

/**
 * 新钩子的主题归属：面板上选了「当前方向」就跟着它走，否则按关键词判。
 * 这样在面板里选定一条线之后，新写入的记忆会归到这条线下，而不是被自动判定带到别处。
 * @param {string} text 判主题用的文本（提问 + 标题）。
 * @returns {{topic?: string, topicFine?: string}} 要写进钩子的主题字段。
 */
export function topicForNewHook(text) {
  const pin = activePin()
  if (pin !== null && (typeof pin.fine === 'string' || typeof pin.topic === 'string')) {
    return {
      topic: typeof pin.topic === 'string' && pin.topic !== '' ? pin.topic : undefined,
      topicFine: typeof pin.fine === 'string' && pin.fine !== '' ? pin.fine : undefined,
    }
  }
  const topic = matchTopic(text)
  return topic !== null ? { topic } : {}
}

function toolPath(ev) {
  if (!ev || ev.type !== 'tool/call') return null
  const toolName = ev.data && ev.data.name
  if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'notebook_write') return null
  try {
    const args = JSON.parse(ev.data.arguments)
    for (const k of ['file_path', 'notebook_path', 'path']) {
      if (typeof args[k] === 'string' && args[k].length > 0) return args[k]
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 没有模型标题时的兜底标题：取第一句，截 60 字。 */
function autoTitle(text) {
  const first = String(text || '').split(/[。！？\n]/)[0].trim()
  return (first.length > 0 ? first : String(text || '')).slice(0, 60)
}

export function apply(ctx) {
  try {
    ensureSeeded(SEED_FILE)
  } catch {
    /* 种子复制失败不影响工具注册 */
  }

  // ── Web 面板：检索 / 展开原文 / 改标题 / 归档 ──────────────────────
  try {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && webServer !== null) {
      ctx.effect(() => {
        const disposers = registerWebPanel(ctx, webServer)
        return () => {
          for (const d of disposers) {
            try {
              if (typeof d === 'function') d()
            } catch {
              /* ignore */
            }
          }
        }
      }, 'work-memory: web panel')
    }
  } catch {
    /* 面板不可用不影响工具/注入 */
  }

  /** 当前会话最近一条用户消息（注入召回用）。 */
  const lastUser = new Map()
  /** 当前轮次累积：提问与产物。 */
  const pending = new Map()

  // ── 捕获层：从事件流抓提问与产物，turn/end 落一条钩子 ──────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || typeof session.id !== 'string' || !event) return
      const sid = session.id
      if (event.type === 'user/message') {
        const src = event.data && event.data.source ? event.data.source.kind : 'none'
        const text = blocksToText(event.data && event.data.content)
        if (src !== 'user' || text.length === 0) return
        lastUser.set(sid, text)
        let p = pending.get(sid)
        if (p === undefined) {
          p = { asks: [], artifacts: new Set(), startSeq: event.seq }
          pending.set(sid, p)
        }
        if (p.asks.length === 0) p.startSeq = event.seq
        p.asks.push({ seq: event.seq, text })
        return
      }
      if (event.type === 'tool/call') {
        const p = pending.get(sid)
        if (p === undefined) return
        const p2 = toolPath(event)
        if (p2 !== null && !isJunkPath(p2)) p.artifacts.add(p2)
        return
      }
      if (event.type === 'turn/end') {
        const p = pending.get(sid)
        if (p === undefined) return
        pending.delete(sid)
        const askText = p.asks.map((a) => a.text).join(' ')
        const hasArtifact = p.artifacts.size > 0
        // 只记「有实义」的轮次：提问够长，或落下了产物
        if (p.asks.length === 0 || (askText.length < 20 && !hasArtifact)) return
        const endSeq = typeof event.seq === 'number' ? event.seq + 1 : p.startSeq + 1
        try {
          const id = nextId()
          const askText2 = p.asks[0].text.replace(/\s+/g, ' ').slice(0, 200)
          appendHook({
            id,
            session: sid,
            startSeq: p.startSeq,
            endSeq,
            ask: askText2,
            title: autoTitle(p.asks[0].text),
            // 新条目即时判主题（关键词字面匹配，零模型）；判不出留空，之后可批量补
            ...topicForNewHook(askText2 + ' ' + autoTitle(p.asks[0].text)),
            kind: 'auto',
            artifacts: [...p.artifacts],
            ts: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
            agent: 'dsh',
            origin: 'dsh:user',
            status: 'active',
          })
        } catch {
          /* 写盘失败不影响会话 */
        }
      }
    } catch {
      /* 事件处理永不让会话失败 */
    }
  })

  // ── 召回层：每步按当前用户消息命中钩子，只注入标题行 ──────────────
  ctx.systemPrompt.context({
    name: 'work-memory:recall',
    order: 205,
    text: (assembly) => {
      try {
        const agent = assembly && assembly.agent
        const sid = agent && agent.session ? agent.session.id : undefined
        const query = sid !== undefined ? lastUser.get(sid) : undefined
        if (typeof query !== 'string' || query.length === 0) return ''
        // 面板上选定了方向：直接按那一类注入，不再猜
        const pin = activePin()
        if (pin !== null) {
          const pinned = loadHooks()
            .filter((row) => isHumanRow(row) && (pin.fine ? row.topicFine === pin.fine : row.topic === pin.topic))
            .sort((left, right) => String(right.ts).localeCompare(String(left.ts)))
            .slice(0, 5)
          if (pinned.length > 0) {
            const label = String(pin.label || pinned[0].title || pin.fine || '').slice(0, 40)
            return '工作记忆（当前方向：' + label + '）：需要当时的过程细节时调用 memory_open。\n' + pinned.map((row) => formatLine(row)).join('\n') + relatedLine(pin.fine || pin.topic)
          }
        }
        // 先判主题：命中主题就只在该主题内检索，避免跨主题噪声
        const topic = matchTopic(query)
        // 「好的」「成功了」这类短句没有信息量，跨主题时直接不注入（判得出主题才放行）
        if (query.trim().length < 6 && topic === null) return ''
        // 主题已知时放宽（0.45），跨主题时收紧（0.6）——否则「已经重启了」这种泛词会拉出一堆无关历史
        const minScore = topic !== null ? 0.45 : 0.6
        // 注入单元：hook = 一条钩子一行；segment = 一段一行（同一段里的多条钩子合并成一行）
        const unitMode = String(process.env.DSH_WM_RECALL_UNIT || 'hook').toLowerCase()
        const pool = unitMode === 'segment' ? 8 : 3
        let hits = searchHooks(query, pool, { excludeSession: sid, topic: topic || undefined, humanOnly: true }).filter((h) => h.score >= minScore)
        if (hits.length === 0 && topic !== null) {
          // 主题内没命中 → 退回全局（让泛化的问法仍有收获）
          hits = searchHooks(query, unitMode === 'segment' ? 6 : 2, { excludeSession: sid, humanOnly: true }).filter((h) => h.score >= 0.6)
        }
        if (hits.length === 0) return ''
        const lines = (unitMode === 'segment' ? recallUnits(hits, segmentMap()).slice(0, 3).map(formatUnitLine) : hits.map((h) => formatLine(h)))
        const head = topic !== null ? '工作记忆（主题：' + topicName(topic) + '）' : '工作记忆（跨主题）'
        // B：强相关时自动带前 300 字原文摘录，省一次 memory_open
        const top = hits[0]
        let excerpt = ''
        if (top.score >= 0.6) {
          try {
            const r = renderRange(top.session, top.startSeq, top.endSeq, '', 300)
            if (r.text.length > 20) excerpt = '\n· 摘录（' + top.id + '）：' + r.text.replace(/\n/g, ' ').slice(0, 300)
          } catch {
            /* 摘录失败不影响注入 */
          }
        }
        return head + '：需要当时的过程细节时调用 memory_open。\n' + lines.join('\n') + excerpt +
          relatedLine(topic !== null ? topic : (top.topicFine || ''))
      } catch {
        return ''
      }
    },
  })

  // ── 工具 1：检索 ─────────────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        '检索本机工作记忆索引：用户历史提过的需求 + 当时产出的文件路径 + 时间。只返回钩子（一句话 + 产物），' +
        '不返回正文；要看当时的过程细节，用返回的 id 调 memory_open 回放原会话。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的内容：任务描述、文件名、关键词（中文或英文）' },
          limit: { type: 'number', description: '返回条数，默认 3，最大 10' },
          includeSuperseded: {
            type: 'boolean',
            description: '是否包含已被新结论取代的旧条目（默认不含；查历史演变时用 true）',
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const query = String((args && args.query) || '').trim()
        const limit = Math.min(Math.max(Number(args && args.limit) || 3, 1), 10)
        const hits = searchHooks(query, limit, { includeSuperseded: args && args.includeSuperseded === true })
        if (hits.length === 0) return '没有命中任何历史工作。'
        return hits
          .map(
            (h) =>
              '[' + h.id + '] ' + h.title + (isHumanRow(h) ? '' : ' ｜' + originLabel(h)) +
              '\n  提问：' + h.ask +
              '\n  时间：' + h.ts + ' ｜ 产物：' + (h.artifacts.slice(0, 4).join(', ') || '(无)') +
              '\n  展开原文：memory_open(id="' + h.id + '")',
          )
          .join('\n\n')
      },
    }),
  )

  // ── 工具 2：按 seq 回放当时那段原文 ─────────────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_open',
      description:
        '按钩子 id 回放当时那段会话原文（含被上下文压缩遮蔽的部分）。返回用户提问、助手回复摘要与写过的文件。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'memory_search 返回的钩子 id，如 m-015' },
          query: { type: 'string', description: '可选：只在原文里保留包含该词的行（长区间瘦身）' },
          maxChars: { type: 'number', description: '返回字符上限，默认 4000，最大 12000' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const id = String((args && args.id) || '').trim()
        const hook = getHook(id)
        if (hook === null) return '没有这个钩子：' + (id || '(空)')
        const maxChars = Math.min(Math.max(Number(args && args.maxChars) || 4000, 500), 12000)
        const query = String((args && args.query) || '').trim()
        const range = renderRange(hook.session, hook.startSeq, hook.endSeq, query, maxChars)
        return (
          '# ' + hook.title +
          '\n提问：' + hook.ask +
          '\n会话：' + hook.session + ' ｜ seq：' + hook.startSeq + '–' + hook.endSeq +
          '\n产物：' + (hook.artifacts.join('\n     ') || '(无)') +
          '\n—— 原文 ——\n' + range.text
        )
      },
    }),
  )

  // ── 工具 3：结构浏览（主题 → 会话 → 钩子，不依赖词面重叠）──────
  ctx.tools.register(
    defineTool({
      name: 'memory_map',
      description:
        '按结构浏览工作记忆：不给参数看主题总览（每个主题多少钩子/多少会话），给 topic 看该主题下的会话，' +
        '给 session 看该会话里的钩子。关键词检索没命中、或者你想先看看"那个方向都有什么历史"时用它——' +
        '它不依赖词面重叠。默认只看「用户提的需求」；子代理任务、cron 样板这些代理自产的记录要 includeAgents=true 才出来。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '主题 id（t01…t16）；省略则返回主题总览' },
          session: { type: 'string', description: '会话 id（从主题的会话列表里拿到的完整 id），返回该会话的钩子' },
          recent: { type: 'number', description: '给数字时改为列出最近动过的 N 个会话（忽略 topic/session）' },
          limit: { type: 'number', description: '会话数上限，默认 40，最大 100' },
          includeAgents: { type: 'boolean', description: 'true 时把代理自产的记录（子代理任务书、cron 样板）也算进来' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const rows = loadHooks()
        const includeAgents = args !== undefined && args !== null && args.includeAgents === true
        const options = { includeAgents: includeAgents }
        const limit = Math.min(Math.max(Number(args && args.limit) || 40, 1), 100)
        const humanTotal = rows.filter((row) => isHumanRow(row)).length
        const agentTotal = rows.length - humanTotal
        const skipped = rows.length - browsableRows(rows, options).length
        const scopeNote = includeAgents
          ? '；已含代理自产记录，跳过 ' + skipped + ' 条样板/失效'
          : '；只看人类需求（跳过 ' + skipped + ' 条代理自产/样板/失效；另有 ' + agentTotal + ' 条代理记录，includeAgents=true 可看）'
        const sessionId = String((args && args.session) || '').trim()
        const recent = Number(args && args.recent)

        if (sessionId !== '') {
          const hooks = sessionHooks(rows, sessionId, options)
          if (hooks.length === 0) {
            return '没有这个会话的钩子：' + sessionId + scopeNote + '\n试试 memory_map() 看主题，或 memory_search 按关键词找。'
          }
          const head = hooks[0]
          const shown = hooks.slice(0, limit)
          const lines = shown.map((row) => {
            const art = row.artifacts.length > 0 ? '\n     产物：' + row.artifacts.slice(0, 3).join('、') : ''
            return '· [' + row.id + '] seq ' + row.startSeq + '–' + row.endSeq + ' · ' + String(row.ts).slice(0, 10) + ' · ' + (row.topic || '(未打标)') + ' · ' + originLabel(row) + '\n     ' + (row.title || row.ask).slice(0, 80) + art
          })
          return '# 会话 ' + sessionId + '（' + (head.agent || 'dsh') + '，' + hooks.length + ' 条钩子）' + scopeNote +
            '\n' + lines.join('\n') +
            (hooks.length > shown.length ? '\n（还有 ' + (hooks.length - shown.length) + ' 条没列，加大 limit 再看）' : '') +
            '\n\n下一步：memory_open(id="' + head.id + '") 回放这段原文。'
        }

        if (Number.isFinite(recent) && recent > 0) {
          const list = recentSessions(rows, Math.min(Math.max(recent, 1), 50), options)
          if (list.length === 0) return '账本里还没有可浏览的记录。'
          return '# 最近动过的 ' + list.length + ' 个会话' + scopeNote + '\n' +
            list.map((session, index) => (index + 1) + '. ' + session.session + ' · ' + session.agent + ' · ' + session.hooks + ' 条 · ' + session.firstTs + '〜' + session.lastTs + '\n   ' + session.label).join('\n') +
            '\n\n下一步：memory_map(session="<上面的会话 id>") 看它的钩子。'
        }

        const topics = loadTopics()
        if (args && args.topic !== undefined && args.topic !== null) {
          const topicId = String(args.topic).trim()
          const known = topics.find((topic) => topic.id === topicId)
          const name = topicId === '' ? '未打标' : (known !== undefined ? known.name : topicId)
          const result = topicSessions(rows, topicId, limit, options)
          if (result.total === 0) {
            const agentOnly = browsableRows(rows, { includeAgents: true }).filter((row) => (row.topic || '') === topicId).length
            const hint = agentOnly > 0 ? '\n这个主题下有 ' + agentOnly + ' 条代理自产记录（子代理任务、cron 样板），加 includeAgents=true 才看得到。' : ''
            return '主题「' + name + '」下没有人类需求的记录。' + hint + '\n可用主题：' + topics.map((topic) => topic.id + ' ' + topic.name).join('、')
          }
          const lines = result.sessions.map((session, index) =>
            (index + 1) + '. ' + session.session + ' · ' + session.agent + ' · ' + session.hooks + ' 条 · ' + session.firstTs + '〜' + session.lastTs + '\n   ' + session.label)
          return '# ' + topicId + ' ' + name + '：' + result.total + ' 个会话 / ' + result.hooks + ' 条钩子（显示 ' + result.sessions.length + ' 个）' + scopeNote +
            '\n' + lines.join('\n') +
            '\n\n下一步：memory_map(session="<上面的会话 id>") 看某个会话的钩子；memory_open(id="…") 回放原文。'
        }

        const overview = topicOverview(rows, topics, options)
        if (overview.length === 0) return '账本里还没有可浏览的记录。'
        const lines = overview.map((topic) =>
          (topic.id === '' ? '(未打标) ' : topic.id + ' ') + topic.name + ' — ' + topic.hooks + ' 条 / ' + topic.sessions + ' 个会话' +
          '（' + Object.entries(topic.agents).map(([agent, count]) => agent + ' ' + count).join(' · ') + '），最近 ' + topic.lastTs +
          (topic.desc === '' ? '' : '\n   ' + topic.desc))
        let agentOnlyNote = ''
        if (!includeAgents) {
          const allTopics = topicOverview(rows, topics, { includeAgents: true })
          const shown = new Set(overview.map((topic) => topic.id))
          const hidden = allTopics.filter((topic) => !shown.has(topic.id))
          if (hidden.length > 0) {
            agentOnlyNote = '\n只有代理自产记录、默认不显示的主题：' +
              hidden.map((topic) => (topic.id || '(未打标)') + ' ' + topic.name + '（' + topic.hooks + ' 条）').join('、')
          }
        }
        return '# 工作记忆：' + overview.length + ' 个主题（人类需求 ' + humanTotal + ' 条；代理自产 ' + agentTotal + ' 条' + (includeAgents ? '，本次已含' : '，默认不看') + '）' + scopeNote + '\n' +
          lines.join('\n') + agentOnlyNote +
          '\n\n下一步：memory_map(topic="t08") 看某个主题下的会话；memory_map(recent=15) 看最近动过的；关键词已知时仍用 memory_search。'
      },
    }),
  )

  // ── 工具 4：手动记一条（模型判断值得记时用）──────────────────
  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description:
        '手动把一条工作记进索引（标题 + 提问 + 产物路径 + 当前会话的 seq 区间）。自动捕获已覆盖大部分场景，' +
        '这个用于补记或给自动条目改标题。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '一句话标题：做了什么 + 关键实体' },
          ask: { type: 'string', description: '对应的用户需求原文（可省略，省略时用 title）' },
          artifacts: { type: 'string', description: '产物路径，多个用换行或分号分隔（可省略）' },
          supersedes: {
            type: 'string',
            description: '被这条新结论取代的旧钩子 id，多个用逗号分隔（可省略）。旧条目不会删除，只标 superseded',
          },
          startSeq: { type: 'number', description: '区间起始 seq（可省略，默认本轮起点）' },
          endSeq: { type: 'number', description: '区间结束 seq（可省略，默认当前）' },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        const title = String((args && args.title) || '').trim()
        if (title.length === 0) return 'memory_write 需要 title。'
        const session = exec && exec.agent && exec.agent.session
        if (!session || typeof session.id !== 'string') return '没有绑定会话，无法记录。'
        const rawArtifacts = String((args && args.artifacts) || '')
        const artifacts = rawArtifacts
          .split(/[\n;]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        const p = pending.get(session.id)
        const startSeq = Number.isFinite(args && args.startSeq)
          ? Number(args.startSeq)
          : p !== undefined
            ? p.startSeq
            : 0
        const endSeq = Number.isFinite(args && args.endSeq) ? Number(args.endSeq) : startSeq + 100000
        const row = appendHook({
          id: nextId(),
          session: session.id,
          startSeq,
          endSeq,
          ask: String((args && args.ask) || title).replace(/\s+/g, ' ').slice(0, 200),
          title: title.slice(0, 120),
          ...topicForNewHook(title + ' ' + String((args && args.ask) || '')),
          kind: 'manual',
          artifacts,
          ts: new Date().toISOString(),
          agent: 'dsh',
          origin: 'dsh:user',
          status: 'active',
        })
        const oldIds = String((args && args.supersedes) || '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        let supersededCount = 0
        for (const oldId of oldIds) supersededCount += supersede(oldId, row.id)
        return (
          '已记录 [' + row.id + '] ' + row.title + '（seq ' + row.startSeq + '–' + row.endSeq + '）' +
          (supersededCount > 0 ? '，并取代了 ' + supersededCount + ' 条旧记录' : '')
        )
      },
    }),
  )
}
