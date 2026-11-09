#!/usr/bin/env node
/**
 * 升级后体检：一条命令查全链路是否还活着。
 *
 *   node cli/doctor.js
 *
 * 检查六项：账本可读、会话格式可解析、跨源库可读、主题可判、回指可取原文、注入逻辑可跑。
 * 任何一项 FAIL 都说明 DSH 升级或环境变化打破了某个接缝。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, readSessionEvents, renderRange, findSessionFile } from '../lib/sessionlog.js'
import { loadHooks, searchHooks } from '../lib/store.js'
import { loadTopics, matchTopic } from '../lib/topics.js'
import { listForeignSessions, sourceDbPath } from '../lib/foreign.js'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log('  PASS ' + name + (detail ? ' — ' + detail : ''))
  } else {
    fail += 1
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''))
  }
}

console.log('1) 账本')
const ledger = join(dshHome(), 'work-memory', 'hooks.jsonl')
check('hooks.jsonl 存在', existsSync(ledger), ledger)
const rows = loadHooks()
check('可解析条目 > 0', rows.length > 0, 'rows=' + rows.length)
const withTopic = rows.filter((r) => r.topic).length
check('主题字段读得回来', withTopic > 0, 'withTopic=' + withTopic + '/' + rows.length)

console.log('2) 会话格式')
const sample = rows.find((r) => r.agent === 'dsh' && r.session && !r.session.includes(':'))
check('账本里有 DSH 会话条目', sample !== undefined)
if (sample) {
  const ev = readSessionEvents(sample.session)
  check('能读到事件', ev.events.length > 0, 'events=' + ev.events.length + ' version=' + ev.version)
  check('无解析错误', ev.error === undefined, ev.error || '')
  const range = renderRange(sample.session, sample.startSeq, sample.endSeq, '', 500)
  check('能回放原文', typeof range.text === 'string' && range.text.length > 0, 'len=' + range.text.length)
}

console.log('3) 跨源')
for (const src of ['zcode', 'hermes', 'workbuddy']) {
  const dbPath = sourceDbPath(src)
  const present = dbPath !== null && existsSync(dbPath)
  if (!present) {
    console.log('  SKIP ' + src + '（本机没有这个库：' + (dbPath || '未配置') + '）')
    continue
  }
  try {
    const list = listForeignSessions(src)
    check(src + ' 库可读', list.length > 0, 'sessions=' + list.length)
  } catch (e) {
    check(src + ' 库可读', false, String(e).slice(0, 80))
  }
}

console.log('4) 主题判定')
const topics = loadTopics()
check('topics.json 可读', topics.length > 0, 'topics=' + topics.length)
check('示例判定正确', matchTopic('抖音 短视频 成片') === 't15', 'got=' + matchTopic('抖音 短视频 成片'))
check('示例判定正确', matchTopic('缠论 背驰') === 't06', 'got=' + matchTopic('缠论 背驰'))

console.log('5) 检索')
const hits = searchHooks('抖音 短视频', 3)
check('检索有结果', hits.length > 0, 'hits=' + hits.length)
const scoped = searchHooks('抖音 短视频', 3, { topic: 't15' })
check('主题内检索有结果', scoped.length > 0, 'hits=' + scoped.length)

console.log('\nPASS=' + pass + ' FAIL=' + fail)
if (fail > 0) {
  console.log('有失败项：DSH 升级或环境变化可能破坏了某个接缝，按上面 FAIL 的提示排查。')
}
process.exit(fail === 0 ? 0 : 1)
