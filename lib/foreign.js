/**
 * foreign.js — 读其他 agent 的会话原文（ZCode / Hermes），供 memory_open 回指。
 *
 * hooks 里的 session 字段带来源前缀：
 *   zcode:<sessionId> / hermes:<sessionId> /（DSH 自己不带前缀）
 * 这里把三个源统一成 [{ seq, role, text, time }] 事件数组。
 *
 * 用 node:sqlite（Node 22 内置，实验特性）；库以只读方式打开，不写别人数据。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = homedir()

/**
 * 每个源都可以用环境变量覆盖数据库路径：
 *   DSH_WM_ZCODE_DB / DSH_WM_HERMES_DB / DSH_WM_WORKBUDDY_DB
 * 找不到库时该源自动跳过（返回空），不抛错。
 */
const SOURCES = {
  zcode: {
    db: process.env.DSH_WM_ZCODE_DB || join(HOME, '.zcode', 'cli', 'db', 'db.sqlite'),
    sessions: 'select id, title, directory, time_created from session',
  },
  hermes: {
    db: process.env.DSH_WM_HERMES_DB || join(HOME, 'AppData', 'Local', 'hermes', 'state.db'),
    sessions: 'select id, started_at as time_created, cwd as directory, source from sessions',
  },
  workbuddy: {
    db: process.env.DSH_WM_WORKBUDDY_DB || join(HOME, '.workbuddy', 'workbuddy.db'),
    // 只有会话标题，没有消息正文表
    sessions: 'select id, title, cwd as directory, created_at as time_created from sessions where deleted_at is null',
    titleOnly: true,
  },
}

export function sourceOf(sessionRef) {
  const m = /^([a-z]+):(.+)$/.exec(String(sessionRef || ''))
  if (m === null) return { source: 'dsh', id: String(sessionRef || '') }
  return { source: m[1], id: m[2] }
}

function open(dbPath) {
  if (!existsSync(dbPath)) return null
  return new DatabaseSync(dbPath, { readOnly: true })
}

/** 该源配置的数据库路径（不检查存在性），供体检/文档用。 */
export function sourceDbPath(id) {
  const cfg = SOURCES[id]
  return cfg === undefined ? null : cfg.db
}

export function sourceIds() {
  return Object.keys(SOURCES)
}

/** ZCode：用户文本在 part 表（type=text），tool 调用在 part（type=tool）。 */
export function readZcodeSession(sessionId) {
  const db = open(SOURCES.zcode.db)
  if (db === null) return []
  try {
    const msgs = db
      .prepare('select id, time_created, data from message where session_id = ? order by time_created')
      .all(sessionId)
    const parts = db
      .prepare('select message_id, sequence, data from part where session_id = ? order by sequence')
      .all(sessionId)
    const byMsg = new Map()
    for (const p of parts) {
      if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, [])
      byMsg.get(p.message_id).push(p.data)
    }
    const out = []
    let seq = 0
    for (const m of msgs) {
      let role = 'unknown'
      try {
        role = JSON.parse(m.data).role || 'unknown'
      } catch {
        /* ignore */
      }
      const texts = []
      for (const raw of byMsg.get(m.id) || []) {
        try {
          const p = JSON.parse(raw)
          if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
        } catch {
          /* ignore */
        }
      }
      const text = texts.join('\n').trim()
      seq += 1
      if (text.length > 0) out.push({ seq, role, text, time: m.time_created })
    }
    return out
  } finally {
    db.close()
  }
}

/** Hermes：content 直接在 messages 表。 */
export function readHermesSession(sessionId) {
  const db = open(SOURCES.hermes.db)
  if (db === null) return []
  try {
    const rows = db
      .prepare('select id, role, content, timestamp from messages where session_id = ? order by timestamp, id')
      .all(sessionId)
    const out = []
    let seq = 0
    for (const r of rows) {
      const text = typeof r.content === 'string' ? r.content.trim() : ''
      seq += 1
      if (text.length === 0) continue
      out.push({ seq, role: String(r.role || 'unknown'), text, time: Math.round(Number(r.timestamp) * 1000) })
    }
    return out
  } finally {
    db.close()
  }
}

export function readForeignEvents(sessionRef) {
  const { source, id } = sourceOf(sessionRef)
  if (source === 'zcode') return readZcodeSession(id)
  if (source === 'hermes') return readHermesSession(id)
  // workbuddy 库里没有消息正文，只能返回空（renderRange 会给出说明）
  return []
}

/** 列出某源的全部会话（导入用）。 */
export function listForeignSessions(source) {
  const cfg = SOURCES[source]
  if (cfg === undefined) return []
  const db = open(cfg.db)
  if (db === null) return []
  try {
    return db.prepare(cfg.sessions).all()
  } finally {
    db.close()
  }
}
