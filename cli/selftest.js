#!/usr/bin/env node
/**
 * 自测：不需要 DSH 运行时，用 mock ctx 验证「自动捕获」与「上下文注入」两条链路。
 * 用独立的 DSH_HOME 沙箱，不污染真实账本。
 *
 *   node cli/selftest.js
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'wm-selftest-'))
process.env.DSH_HOME = sandbox

const { apply } = await import('../lib/index.js')
const { appendHook } = await import('../lib/store.js')

// 一条"其他会话"的旧条目：注入应该命中它，而不是当前会话自己的新条目
appendHook({
  schema: 1,
  id: 'o-seed-1',
  session: 'session-other-9999',
  startSeq: 1,
  endSeq: 9,
  ask: '记忆系统为什么用 seq 指针而不是存全文摘要',
  title: '记忆系统：seq 指针与原文回放的取舍',
  kind: 'manual',
  level: 'module',
  artifacts: [],
  ts: new Date().toISOString(),
  agent: 'dsh',
  status: 'active',
})

const handlers = []
const tools = []
let contextDef = null

const ctx = {
  on: (name, fn) => {
    handlers.push({ name, fn })
    return () => {}
  },
  systemPrompt: {
    context: (def) => {
      contextDef = def
      return () => {}
    },
  },
  tools: { register: (tool) => tools.push(tool) },
}

apply(ctx)

const emit = (session, event) => {
  for (const h of handlers) if (h.name === 'session/event') h.fn(session, event)
}

const session = { id: 'session-selftest-0001' }
let seq = 1
const user = (text) => emit(session, { type: 'user/message', seq: seq++, time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const toolCall = (name, args, callId) => emit(session, { type: 'tool/call', seq: seq++, data: { name, arguments: JSON.stringify(args), callId } })
const turnEnd = () => emit(session, { type: 'turn/end', seq: seq++, time: Date.now(), data: { reason: { kind: 'completed' } } })

console.log('tools registered: ' + tools.map((t) => t.name).join(', '))
console.log('context registered: ' + (contextDef ? contextDef.name : '(none)'))

// 1) 真实工作轮：够长 + 有产物 → 应落一条
user('把这段视频按五屏重新分屏，然后生成封面，背景不要循环')
toolCall('write', { file_path: 'D:/work/demo/output.html' }, 'c1')
turnEnd()

// 2) 碎片轮：太短且无产物 → 不应落
user('继续')
turnEnd()

// 3) 只读轮：有提问长度但无产物 → 落
user('说一下这段记忆系统为什么用 seq 指针而不是存全文摘要')
turnEnd()

const file = join(sandbox, 'work-memory', 'hooks.jsonl')
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const rows = lines.map((l) => JSON.parse(l))
const auto = rows.filter((r) => r.kind === 'auto')
console.log('total=' + rows.length + ' (seed 30 + auto ' + auto.length + ')')
for (const r of auto) console.log('  auto: ' + r.title + ' | seq ' + r.startSeq + '-' + r.endSeq + ' | artifacts=' + r.artifacts.length)

// 4) 注入：模拟 assembly 拿到当前用户消息
const injected = contextDef.text({ agent: { session } })
console.log('--- injected context ---')
console.log(injected || '(空)')

const ok =
  tools.length === 3 &&
  contextDef !== null &&
  auto.length === 2 &&
  auto[0].artifacts.length === 1 &&
  auto.some((r) => r.title.includes('记忆系统')) &&
  injected.includes('工作记忆') &&
  injected.includes('o-seed-1') &&
  !injected.includes('m-0')

console.log(ok ? 'SELFTEST: PASS' : 'SELFTEST: FAIL')
rmSync(sandbox, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
