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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendHook, ensureSeeded, formatLine, getHook, nextId, searchHooks, supersede } from './store.js'
import { renderRange } from './sessionlog.js'
import { matchTopic, topicName } from './topics.js'
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
            topic: matchTopic(askText2 + ' ' + autoTitle(p.asks[0].text)) || undefined,
            kind: 'auto',
            artifacts: [...p.artifacts],
            ts: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
            agent: 'dsh',
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
        // 先判主题：命中主题就只在该主题内检索，避免跨主题噪声
        const topic = matchTopic(query)
        // 「好的」「成功了」这类短句没有信息量，跨主题时直接不注入（判得出主题才放行）
        if (query.trim().length < 6 && topic === null) return ''
        // 主题已知时放宽（0.45），跨主题时收紧（0.6）——否则「已经重启了」这种泛词会拉出一堆无关历史
        const minScore = topic !== null ? 0.45 : 0.6
        let hits = searchHooks(query, 3, { excludeSession: sid, topic: topic || undefined }).filter((h) => h.score >= minScore)
        if (hits.length === 0 && topic !== null) {
          // 主题内没命中 → 退回全局（让泛化的问法仍有收获）
          hits = searchHooks(query, 2, { excludeSession: sid }).filter((h) => h.score >= 0.6)
        }
        if (hits.length === 0) return ''
        const lines = hits.map((h) => formatLine(h))
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
        return head + '：需要当时的过程细节时调用 memory_open。\n' + lines.join('\n') + excerpt
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
              '[' + h.id + '] ' + h.title +
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

  // ── 工具 3：手动记一条（模型判断值得记时用）──────────────────
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
          topic: matchTopic(title + ' ' + String((args && args.ask) || '')) || undefined,
          kind: 'manual',
          artifacts,
          ts: new Date().toISOString(),
          agent: 'dsh',
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
