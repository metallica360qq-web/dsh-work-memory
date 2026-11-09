#!/usr/bin/env node
/**
 * 主题标签规则修正（零成本，不调模型）。
 *
 *   node cli/fix-topics.js [--dry]
 *
 * 修正 GLM 打标里三类系统性偏差：
 *   1. 短视频系列（以 001~006 开头、或含成片/口播/分屏等）被分到 t10 命理
 *   2. 「流日月历」App 工程被分到 t16 杂项
 *   3. 与短视频无关的内容（演讲比赛海报、素材加工）被分到 t15
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) args[a.slice(2)] = true
}
const dry = Boolean(args.dry)
const ledger = join(dshHome(), 'work-memory', 'hooks.jsonl')

const VIDEO = /短视频|成片|口播|分屏|封面|期号|完播率|发布数据|配音|TTS|音色/
const APP = /流日月历|安卓|i18n|AAB|签名|M[1-8]|多语言/
const SERIES = /^0\d\d[^0-9]/
const VIDEO_TOPIC = /月柱|大运|正偏财|食神|伤官|比肩|劫财|官杀|十神|短视频|命理视频|流日月历/
const VIDEO_WORK = /稿|文案|选题|分屏|成片|录音|封面|数据|期|镜|字幕|配音/

const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const changes = []

for (const r of rows) {
  const title = String(r.title || '')
  const ask = String(r.ask || '')
  const text = title + ' ' + ask
  const before = r.topic || null
  let after = before

  // 1) 短视频系列 → t15：期号 + 命理选题，或明确视频工序，或命理选题 + 稿/分屏等工序
  if ((SERIES.test(title) && VIDEO_TOPIC.test(title)) || VIDEO.test(title) || (VIDEO_TOPIC.test(title) && VIDEO_WORK.test(title))) {
    after = 't15'
  }
  // 2) 「流日月历」App 工程 → t11（短视频化的不算）
  else if (APP.test(title) && !VIDEO.test(title)) {
    after = 't11'
  }
  // 3) 误入 t15 的非视频内容 → t16
  else if (before === 't15' && /演讲比赛|花花草草|蝴蝶|透明底/.test(text)) {
    after = 't16'
  }

  if (after !== before) {
    r.topic = after
    changes.push({ id: r.id, from: before, to: after, title: title.slice(0, 40) })
  }
}

if (dry) {
  console.log('would change=' + changes.length)
  for (const c of changes.slice(0, 30)) console.log('  ' + c.id + ' ' + (c.from || '?') + ' -> ' + c.to + ' | ' + c.title)
  process.exit(0)
}

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
copyFileSync(ledger, ledger + '.bak-fix-' + ts)
writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

const dist = {}
for (const r of rows) dist[r.topic || '(none)'] = (dist[r.topic || '(none)'] || 0) + 1
console.log('changed=' + changes.length + ' backup=' + ledger + '.bak-fix-' + ts)
console.log('distribution=' + JSON.stringify(dist))
for (const c of changes.slice(0, 12)) console.log('  ' + c.id + ' ' + (c.from || '?') + ' -> ' + c.to + ' | ' + c.title)
