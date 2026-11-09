#!/usr/bin/env node
/**
 * 治理机制自测：在沙箱账本里构造冲突样本，验证 superseded / 时间衰减 / 过期不删。
 *
 *   node cli/test-governance.js
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'wm-gov-'))
process.env.DSH_WORK_MEMORY_DIR = sandbox

const { loadHooks, searchHooks, supersede, recency } = await import('../lib/store.js')

const now = new Date()
const iso = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString()
const row = (id, title, ask, daysAgo, extra = {}) => ({
  schema: 1,
  id,
  session: 'session-test',
  startSeq: 1,
  endSeq: 2,
  ask,
  title,
  kind: 'manual',
  level: 'module',
  artifacts: [],
  ts: iso(daysAgo),
  agent: 'dsh',
  status: 'active',
  ...extra,
})

// 三组冲突：同主题，旧新各一条
const rows = [
  row('t-1-old', '三层共振止损参数定稿', '三层共振的止损怎么定', 400),
  row('t-1-new', '三层共振止损改用 MAE_P90 推导', '三层共振止损参数改写', 5),
  row('t-2-old', 'GM 回测脚本用 1 分钟级别', '回测用哪个级别', 300),
  row('t-2-new', 'GM 回测改为 5 分钟级别', '回测级别调整', 10),
  row('t-3-old', 'AD 检测定价方案', 'AD 检测怎么定价', 500),
  row('t-3-new', 'AD 检测方案（不含定价）', 'AD 检测方案调整', 2),
]
writeFileSync(join(sandbox, 'hooks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

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

console.log('1) 时间衰减')
check('半年内 ×1.2', recency(iso(5)) === 1.2, String(recency(iso(5))))
check('一年内 ×1.0', recency(iso(300)) === 1, String(recency(iso(300))))
check('更旧 ×0.7', recency(iso(500)) === 0.7, String(recency(iso(500))))

console.log('2) 冲突未处理时，新旧都会出现')
const before = searchHooks('三层共振止损', 5)
check('未标记时旧条目可见', before.some((r) => r.id === 't-1-old'), JSON.stringify(before.map((r) => r.id)))

console.log('3) supersede 后默认只剩新条目')
supersede('t-1-old', 't-1-new')
supersede('t-2-old', 't-2-new')
supersede('t-3-old', 't-3-new')
const after = searchHooks('三层共振止损', 5)
check('旧条目被排除', !after.some((r) => r.id === 't-1-old'), JSON.stringify(after.map((r) => r.id)))
check('新条目仍在', after.some((r) => r.id === 't-1-new'))
const withOld = searchHooks('三层共振止损', 5, { includeSuperseded: true })
check('includeSuperseded 能查回旧条目', withOld.some((r) => r.id === 't-1-old'))

console.log('4) 旧条目没有被删除')
const all = loadHooks()
check('账本仍有 6 条', all.length === 6, 'len=' + all.length)
check('旧条目 status=superseded', all.find((r) => r.id === 't-1-old').status === 'superseded')
check('旧条目记录了取代者', all.find((r) => r.id === 't-1-old').supersededBy === 't-1-new')

console.log('5) 时间衰减影响同分排序（同分时新的靠前）')
const tie = searchHooks('回测级别', 5, { includeSuperseded: true })
check('新条目排在旧条目之前', tie.length >= 2 && tie[0].id === 't-2-new', JSON.stringify(tie.map((r) => r.id)))

console.log('\nPASS=' + pass + ' FAIL=' + fail)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
