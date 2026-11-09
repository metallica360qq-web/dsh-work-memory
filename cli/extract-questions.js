#!/usr/bin/env node
/**
 * 从 DSH 会话文件抽出「用户提问清单」，供离线批处理（模型分组/起标题）使用。
 *
 *   node cli/extract-questions.js <session.v4.jsonl.zstd> <out.json>
 *
 * 只抽 source.kind === "user" 的消息，附带：时间、该提问后第一条助手回复前 120 字、
 * 该轮的工具调用统计、写过的文件路径。不含模型输出正文。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'

const [, , file, out] = process.argv
if (!file || !out) {
  console.error('用法：node cli/extract-questions.js <session.*.jsonl.zstd> <out.json>')
  process.exit(2)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const buf = readFileSync(file)
const offs = []
let i = 0
for (;;) {
  const p = buf.indexOf(MAGIC, i)
  if (p < 0) break
  offs.push(p)
  i = p + 1
}
const parts = []
let fails = 0
for (let k = 0; k < offs.length; k += 1) {
  const s = offs[k]
  const e = k + 1 < offs.length ? offs[k + 1] : buf.length
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)))
  } catch {
    fails += 1
  }
}

const blocksToText = (blocks) =>
  Array.isArray(blocks)
    ? blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('').trim()
    : typeof blocks === 'string'
      ? blocks.trim()
      : ''

const questions = []
let cur = null
for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
  if (line.length === 0) continue
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    continue
  }
  if (ev.type === 'user/message') {
    const src = ev.data && ev.data.source ? ev.data.source.kind : 'none'
    if (src !== 'user') continue
    const text = blocksToText(ev.data && ev.data.content)
    if (text.length === 0) continue
    cur = { seq: ev.seq, time: ev.time, ask: text.slice(0, 300), after: '', tools: [], artifacts: [] }
    questions.push(cur)
  } else if (ev.type === 'assistant/message' && cur !== null && cur.after.length === 0) {
    const text = blocksToText(ev.data && ev.data.message ? ev.data.message.content : ev.data && ev.data.content)
    if (text.length > 0) cur.after = text.slice(0, 120)
  } else if (ev.type === 'tool/call' && cur !== null) {
    const toolName = ev.data && ev.data.name
    cur.tools.push(toolName)
    if (toolName === 'write' || toolName === 'edit') {
      try {
        const args = JSON.parse(ev.data.arguments)
        if (args.file_path) cur.artifacts.push(args.file_path)
      } catch {
        /* ignore */
      }
    }
  }
}

const cleaned = questions.map((q, idx) => ({
  qid: idx + 1,
  seq: q.seq,
  time: new Date(q.time).toISOString(),
  ask: q.ask,
  after: q.after,
  tools: Object.entries(
    q.tools.reduce((m, n) => {
      m[n] = (m[n] || 0) + 1
      return m
    }, {}),
  ),
  artifacts: [...new Set(q.artifacts)],
}))

writeFileSync(
  out,
  JSON.stringify({ source: file, frames: offs.length, frameFails: fails, questions: cleaned }, null, 2),
  'utf8',
)
console.log('frames=' + offs.length + ' fails=' + fails + ' questions=' + cleaned.length + ' -> ' + out)
