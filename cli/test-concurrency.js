#!/usr/bin/env node
/**
 * 并发与备份自测：验证账本锁能防止「重写覆盖追加」，以及备份轮转生效。
 *
 *   node cli/test-concurrency.js
 *
 * 做法：沙箱账本，起 N 个并发写入方（append）+ 一个重写方，最后核对条目数不丢。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'wm-conc-'))
process.env.DSH_WORK_MEMORY_DIR = sandbox

const { appendHook, loadHooks, saveLedger, pruneBackups, backupLedger } = await import('../lib/store.js')

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

const row = (id) => ({
  schema: 1,
  id,
  session: 'session-conc-test',
  startSeq: 1,
  endSeq: 2,
  ask: '并发测试 ' + id,
  title: '并发测试 ' + id,
  kind: 'manual',
  level: 'module',
  artifacts: [],
  ts: new Date().toISOString(),
  agent: 'dsh',
  status: 'active',
})

console.log('1) 顺序写 20 条')
for (let i = 0; i < 20; i += 1) appendHook(row('c-' + i))
check('20 条都在', loadHooks().length === 20, 'got=' + loadHooks().length)

console.log('2) 重写与追加并发（模拟 CLI 重写时插件追加）')
const before = loadHooks()
// 先拿到重写方的快照（模拟"读到旧内容"），期间追加 3 条，再重写
const snapshot = before.map((r) => ({ ...r }))
for (let i = 0; i < 3; i += 1) appendHook(row('late-' + i))
// 重写方把快照写回去（没有锁时会把 late-* 覆盖掉）
saveLedger(snapshot)
const after = loadHooks()
check('重写后 late-* 已丢失（这是预期：saveLedger 只写调用方给的数据）', after.some((r) => r.id === 'late-0') === false)
check('重写后条目数等于快照', after.length === snapshot.length, 'got=' + after.length + ' expect=' + snapshot.length)

console.log('3) 真实并发：子进程追加 + 主进程锁内变换')
import { spawn } from 'node:child_process'
import { writeFileSync as wf2 } from 'node:fs'
const storeUrl = new URL('../lib/store.js', import.meta.url).href
const childScript = join(sandbox, 'child.mjs')
wf2(
  childScript,
  `import { appendHook } from ${JSON.stringify(storeUrl)}
for (let i = 0; i < 10; i += 1) {
  appendHook({ schema:1, id:'par-'+i, session:'s', startSeq:1, endSeq:2, ask:'x', title:'x', kind:'manual', level:'module', artifacts:[], ts:new Date().toISOString(), agent:'dsh', status:'active' })
}
`,
  'utf8',
)
const child = spawn(process.execPath, [childScript], { stdio: 'ignore', env: { ...process.env } })
const childExit = new Promise((resolve) => child.on('exit', resolve))
// 主进程同时做一次「读最新 → 空变换 → 写回」：锁保证它能看到子进程已写的条目
const { updateLedger } = await import('../lib/store.js')
updateLedger((rows) => rows)
await childExit
const finalRows = loadHooks()
const parIds = finalRows.filter((r) => r.id.startsWith('par-')).length
check('并发下没有丢数据（par-* 全部存在）', parIds === 10, 'par=' + parIds + ' total=' + finalRows.length)

console.log('4) 备份轮转')
const ledger = join(sandbox, 'hooks.jsonl')
// 造 15 个备份
for (let i = 0; i < 15; i += 1) {
  writeFileSync(ledger + '.bak-2026-01-0' + (i % 10) + 'T00-00-0' + (i % 10), 'x', 'utf8')
}
const beforeCount = readdirSync(sandbox).filter((n) => n.includes('.bak-')).length
const removed = pruneBackups(ledger)
const afterCount = readdirSync(sandbox).filter((n) => n.includes('.bak-')).length
check('轮转删掉了多余备份', removed > 0 && afterCount <= 10, 'before=' + beforeCount + ' removed=' + removed + ' after=' + afterCount)

console.log('5) backupLedger 会先备份再轮转')
const bak = backupLedger(ledger)
check('返回了备份路径', typeof bak === 'string' && bak.includes('.bak-'), String(bak))

console.log('\nPASS=' + pass + ' FAIL=' + fail)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
