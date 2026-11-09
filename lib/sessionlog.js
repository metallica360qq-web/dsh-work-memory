/**
 * sessionlog.js — 读 DSH 会话日志并按 seq 区间取回原文。
 *
 * 为什么自己解 zstd：
 *   DSH 的会话文件是「多帧 zstd + JSON lines」，一个 19MB 的会话有 1.4 万个 zstd 帧。
 *   Node 的 zstdDecompressSync 只解第一帧，所以必须先按 0x28B52FFD 切帧再逐帧解。
 *   实测：21MB / 14055 帧 / 0 失败；live 文件（1.1MB / 540 帧）也能读。
 *
 * 数据来源：<DSH_HOME>/sessions/<workspace-slug>/<sessionId>/session*.jsonl.zstd
 * 压缩只遮蔽 surface，原始事件永远在日志里，所以按 seq 能取回被压缩的历史。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { readForeignEvents, sourceOf } from './foreign.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const CACHE_TTL_MS = 30 * 1000
const cache = new Map()

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** 在 sessions/<ws>/<sessionId>/ 下找最新的 session*.jsonl.zstd。 */
export function findSessionFile(sessionId) {
  if (!sessionId) return null
  const root = sessionsRoot()
  let best = null
  const visit = (dir, depth) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (!e.isDirectory()) continue
      if (e.name === sessionId) {
        let files
        try {
          files = readdirSync(p)
        } catch {
          continue
        }
        for (const f of files) {
          if (!f.endsWith('.zstd')) continue
          const fp = join(p, f)
          try {
            const st = statSync(fp)
            if (best === null || st.mtimeMs > best.mtimeMs) {
              best = { path: fp, mtimeMs: st.mtimeMs, size: st.size }
            }
          } catch {
            /* ignore */
          }
        }
      } else if (depth < 2) {
        visit(p, depth + 1)
      }
    }
  }
  visit(root, 0)
  return best
}

/** 多帧 zstd → 事件数组。带 30s 缓存（live 会话会持续增长）。 */
export function readSessionEvents(sessionId) {
  const hit = cache.get(sessionId)
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const found = findSessionFile(sessionId)
  if (found === null) {
    const value = { file: null, events: [], bytes: 0, frames: 0 }
    cache.set(sessionId, { at: Date.now(), value })
    return value
  }
  let buf
  try {
    buf = readFileSync(found.path)
  } catch {
    const value = { file: found.path, events: [], bytes: 0, frames: 0 }
    cache.set(sessionId, { at: Date.now(), value })
    return value
  }
  const offs = []
  let i = 0
  for (;;) {
    const p = buf.indexOf(MAGIC, i)
    if (p < 0) break
    offs.push(p)
    i = p + 1
  }
  const parts = []
  for (let k = 0; k < offs.length; k += 1) {
    const s = offs[k]
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)))
    } catch {
      /* 误切帧：跳过 */
    }
  }
  const events = []
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 半截帧：跳过 */
    }
  }
  let version = null
  if (events.length > 0 && events[0] && events[0].type === 'session' && typeof events[0].version === 'number') {
    version = events[0].version
  }
  const value = {
    file: found.path,
    events,
    bytes: buf.length,
    frames: offs.length,
    version,
    // 解压成功但没有任何有效事件时给出明确原因，而不是静默返回空
    error: events.length === 0 ? '解压后没有可解析的 JSON 事件（格式可能已变，需检查 sessionlog 的解析逻辑）' : undefined,
  }
  cache.set(sessionId, { at: Date.now(), value })
  return value
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : ''
  const out = []
  for (const b of blocks) {
    if (b && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('').trim()
}

const TOOL_PATH_KEYS = ['file_path', 'path', 'notebook_path']

function toolPath(ev) {
  if (ev.type !== 'tool/call') return null
  const name = ev.data && ev.data.name
  if (name !== 'write' && name !== 'edit' && name !== 'notebook_write') return null
  try {
    const args = JSON.parse(ev.data.arguments)
    for (const k of TOOL_PATH_KEYS) {
      if (typeof args[k] === 'string' && args[k].length > 0) return args[k]
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 单个会话里被 write/edit 写过的路径（去重）。 */
export function artifactsOfSession(sessionId) {
  const { events } = readSessionEvents(sessionId)
  const seen = new Set()
  for (const ev of events) {
    const p = toolPath(ev)
    if (p !== null) seen.add(p)
  }
  return [...seen]
}

/**
 * 按 seq 区间渲染原文。
 * session 可以是 DSH 会话 id，也可以带来源前缀（zcode:/hermes:）。
 * @param {string} sessionId
 * @param {number} startSeq 含
 * @param {number} endSeq 不含
 * @param {string} [query] 可选的过滤词（原文包含才保留，用于长区间瘦身）
 * @param {number} [maxChars]
 */
export function renderRange(sessionId, startSeq, endSeq, query, maxChars = 4000) {
  const ref = sourceOf(sessionId)
  if (ref.source !== 'dsh') {
    let events = []
    try {
      events = readForeignEvents(sessionId)
    } catch (e) {
      return { file: '(foreign:' + ref.source + ')', text: '读取失败：' + String(e && e.message ? e.message : e), count: 0 }
    }
    const lines = []
    let chars = 0
    const q = typeof query === 'string' ? query.trim() : ''
    for (const ev of events) {
      if (ev.seq < startSeq || ev.seq >= endSeq) continue
      let line = (ev.role === 'user' ? '用户：' : ev.role === 'assistant' ? '助手：' : '[' + ev.role + ']：') + ev.text
      if (line.length > 700) line = line.slice(0, 700) + '…'
      if (q.length > 0 && !line.includes(q) && !line.startsWith('用户：')) continue
      lines.push('#' + ev.seq + ' ' + line)
      chars += line.length
      if (chars >= maxChars) {
        lines.push('…（已达 ' + maxChars + ' 字符上限）')
        break
      }
    }
    return {
      file: '(foreign:' + ref.source + ':' + ref.id + ')',
      text:
        lines.length > 0
          ? lines.join('\n')
          : ref.source === 'workbuddy'
            ? '（WorkBuddy 只保存了会话标题，没有消息正文，无法回放）'
            : '（该区间没有可渲染的对话事件）',
      count: lines.length,
    }
  }
  const { events, file } = readSessionEvents(sessionId)
  const lines = []
  let chars = 0
  const q = typeof query === 'string' ? query.trim() : ''
  for (const ev of events) {
    if (typeof ev.seq !== 'number') continue
    if (ev.seq < startSeq || ev.seq >= endSeq) continue
    let line = null
    if (ev.type === 'user/message') {
      const src = ev.data && ev.data.source ? ev.data.source.kind : 'none'
      const text = blocksToText(ev.data && ev.data.content)
      if (text.length === 0) continue
      const label = src === 'user' ? '用户' : '[系统 ' + src + ']'
      line = label + '：' + text
    } else if (ev.type === 'assistant/message') {
      const text = blocksToText(
        ev.data && ev.data.message ? ev.data.message.content : ev.data && ev.data.content,
      )
      if (text.length === 0) continue
      line = '助手：' + text
    } else if (ev.type === 'tool/call') {
      const p = toolPath(ev)
      if (p !== null) line = '✎ 写入 ' + p
    }
    if (line === null) continue
    if (line.length > 700) line = line.slice(0, 700) + '…'
    if (q.length > 0 && !line.includes(q)) {
      // 查询词过滤模式：保留命中行，也保留用户消息（上下文锚点）
      if (!line.startsWith('用户：')) continue
    }
    lines.push('#' + ev.seq + ' ' + line)
    chars += line.length
    if (chars >= maxChars) {
      lines.push('…（已达 ' + maxChars + ' 字符上限，区间共 ' + (endSeq - startSeq) + ' 个 seq）')
      break
    }
  }
  return {
    file,
    text: lines.length > 0 ? lines.join('\n') : '（该区间没有可渲染的对话事件）',
    count: lines.length,
  }
}
