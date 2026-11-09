#!/usr/bin/env node
/**
 * 会话格式兼容自测：对本机的 v3 / 无版本号 / v4 三种文件各取一个会话，
 * 验证解压、事件解析、按 seq 回放都正常。
 *
 *   node cli/test-formats.js
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents, renderRange, sessionsRoot } from '../lib/sessionlog.js'

const root = sessionsRoot()
const files = []
const walk = (dir, depth) => {
  if (depth > 2) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, depth + 1)
    else if (e.name.endsWith('.zstd')) files.push({ p, name: e.name, size: statSync(p).size })
  }
}
walk(root, 0)

const kinds = {
  v3: files.filter((f) => f.name.includes('.v3.')),
  v4: files.filter((f) => f.name.includes('.v4.')),
  plain: files.filter((f) => !f.name.includes('.v3.') && !f.name.includes('.v4.')),
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name)
  } else {
    fail += 1
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
  }
}

for (const [kind, list] of Object.entries(kinds)) {
  const withContent = list.filter((f) => f.size > 20 * 1024).slice(0, 1)
  if (withContent.length === 0) {
    console.log('  SKIP ' + kind + '（没有足够大的样本）')
    continue
  }
  const f = withContent[0]
  const sid = f.p.split(/[\\/]/).slice(-2, -1)[0]
  const r = readSessionEvents(sid)
  console.log(kind + ': ' + sid.slice(0, 14) + ' size=' + Math.round(f.size / 1024) + 'KB frames=' + r.frames + ' events=' + r.events.length + ' version=' + r.version)
  check(kind + ' 解析出事件', r.events.length > 0, 'events=' + r.events.length)
  check(kind + ' 有版本号或可解析', r.version !== null, 'version=' + r.version)
  check(kind + ' 首事件是 session header', r.events[0] && r.events[0].type === 'session', String(r.events[0] && r.events[0].type))
  const users = r.events.filter((e) => e.type === 'user/message' && e.data && e.data.source && e.data.source.kind === 'user')
  if (users.length > 0) {
    const u = users[0]
    const range = renderRange(sid, u.seq, u.seq + 200, '', 2000)
    check(kind + ' 按 seq 回放出文本', typeof range.text === 'string' && range.text.length > 20, 'len=' + range.text.length)
  } else {
    console.log('  SKIP ' + kind + '（没有用户消息，跳过回放检查）')
  }
}

const bad = readSessionEvents('session-does-not-exist')
check('不存在的会话返回空且不抛错', bad.events.length === 0 && bad.file === null)

console.log('\nPASS=' + pass + ' FAIL=' + fail)
process.exit(fail === 0 ? 0 : 1)
