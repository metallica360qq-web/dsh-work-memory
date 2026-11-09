#!/usr/bin/env node
/**
 * bootstrap — 首次使用的一键流程：把本机历史对话变成可检索的账本。
 *
 *   node cli/bootstrap.js --dry-run          # 只看会做什么、大概花多少
 *   node cli/bootstrap.js --all              # 全跑（需要模型 key）
 *   node cli/bootstrap.js --all --skip-llm   # 只跑不需要模型的步骤
 *   node cli/bootstrap.js --all --max-sessions 50   # 限制归块的会话数（控制成本）
 *
 * 阶段顺序：scan → ingest → rebuild → topics → alts → doctor
 * 每步都可单独重跑（各脚本自身支持断点续跑），失败不阻塞后续阶段。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dshHome, sessionsRoot } from '../lib/sessionlog.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const DATA_DIR = process.env.DSH_WORK_MEMORY_DIR || join(dshHome(), 'work-memory')
const WORK = join(DATA_DIR, '.bootstrap')
const NODE = process.execPath

const args = {}
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const v = process.argv[i + 1]
    if (v !== undefined && !v.startsWith('--')) {
      args[a.slice(2)] = v
      i += 1
    } else {
      args[a.slice(2)] = true
    }
  }
}

const dryRun = Boolean(args['dry-run'])
const skipLlm = Boolean(args['skip-llm'])
const maxSessions = Number(args['max-sessions'] || 0)
const runAll = Boolean(args.all) || (!dryRun && !skipLlm && Boolean(args.all))

function sh(script, scriptArgs, label) {
  const scriptPath = join(HERE, script)
  const cmd = [scriptPath, ...scriptArgs]
  if (dryRun) {
    console.log('  [dry] node ' + basename(script) + ' ' + scriptArgs.join(' '))
    return { ok: true, dry: true }
  }
  console.log('  $ ' + basename(script) + ' ' + scriptArgs.join(' '))
  const t0 = Date.now()
  const r = spawnSync(NODE, cmd, { encoding: 'utf8', cwd: DATA_DIR })
  const ms = Date.now() - t0
  const out = String(r.stdout || '').trim()
  const err = String(r.stderr || '').trim()
  if (out) console.log(out.split('\n').slice(-6).map((l) => '    ' + l).join('\n'))
  if (r.status !== 0) {
    console.log('  ⚠ ' + label + ' 退出码 ' + r.status + (err ? '：' + err.split('\n')[0].slice(0, 120) : ''))
    return { ok: false }
  }
  console.log('  ✓ ' + label + ' (' + Math.round(ms / 1000) + 's)')
  return { ok: true }
}

function haveLlmKey() {
  if (process.env.DSH_WM_LLM_API_KEY) return true
  const p = join(process.env.DSH_HOME || join(dshHome()), '.credentials.yaml')
  try {
    return /ZAI_CODING_CN_API_KEY\s*:\s*\S/.test(readFileSync(p, 'utf8'))
  } catch {
    return false
  }
}

function dshSessionCount() {
  // 粗略统计：sessions 根目录下的会话目录数
  try {
    let n = 0
    for (const ws of readdirSync(sessionsRoot(), { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      for (const s of readdirSync(join(sessionsRoot(), ws.name), { withFileTypes: true })) {
        if (s.isDirectory()) n += 1
      }
    }
    return n
  } catch {
    return 0
  }
}

if (!dryRun && !runAll) {
  console.log('用法：node cli/bootstrap.js --all [--skip-llm] [--max-sessions N]')
  console.log('      node cli/bootstrap.js --dry-run    # 只看会做什么')
  process.exit(0)
}

console.log('=== dsh-work-memory bootstrap ===')
console.log('数据目录: ' + DATA_DIR)
if (dryRun) console.log('模式: 预演（不做任何写入）')
if (skipLlm) console.log('模式: 跳过所有需要模型的步骤')
if (maxSessions > 0) console.log('归块上限: ' + maxSessions + ' 个会话')
console.log('')

if (!dryRun) mkdirSync(WORK, { recursive: true })

const scanFile = join(WORK, 'scan.json')
const rebuiltFile = join(WORK, 'rebuilt.jsonl')
const llm = haveLlmKey() && !skipLlm

console.log('阶段 1/6 · 扫描 DSH 会话')
console.log('  会话目录约 ' + dshSessionCount() + ' 个')
sh('scan-sessions.js', [scanFile], 'scan')

let sessionsWithContent = 0
if (existsSync(scanFile)) {
  try {
    const scan = JSON.parse(readFileSync(scanFile, 'utf8'))
    sessionsWithContent = (scan.rows || []).filter((r) => r.userMsgs >= 3).length
    console.log('  有效会话（≥3 条提问）: ' + sessionsWithContent + ' 个')
  } catch {
    /* ignore */
  }
}

console.log('')
console.log('阶段 2/6 · 导入其他 agent（有则导，没有自动跳过）')
const sources = [
  { id: 'zcode', script: 'ingest-zcode.js', out: 'ingest-zcode.jsonl' },
  { id: 'hermes', script: 'ingest-hermes.js', out: 'ingest-hermes.jsonl' },
  { id: 'workbuddy', script: 'ingest-workbuddy.js', out: 'ingest-workbuddy.jsonl' },
]
for (const s of sources) {
  const out = join(WORK, s.out)
  const r = sh(s.script, ['--out', out], 'ingest ' + s.id)
  if (r.ok && existsSync(out)) {
    sh('merge-ingest.js', ['--file', out, '--agent', s.id], 'merge ' + s.id)
  }
}

console.log('')
console.log('阶段 3/6 · 归块（module 级）')
if (!llm) {
  console.log('  跳过：没有模型 key 或指定了 --skip-llm')
} else if (sessionsWithContent === 0) {
  console.log(dryRun ? '  （预演：有效会话数要等扫描后才知道；真实运行时这里会归块）' : '  跳过：没有 ≥3 条提问的会话')
} else {
  const rebuildArgs = ['--scan', scanFile, '--out', rebuiltFile, '--min-asks', '3', '--concurrency', '3']
  if (maxSessions > 0) rebuildArgs.push('--limit', String(maxSessions))
  sh('rebuild.js', rebuildArgs, 'rebuild')
  if (existsSync(rebuiltFile)) sh('merge-rebuilt.js', ['--rebuilt', rebuiltFile, '--scan', scanFile, '--lite'], 'merge rebuilt')
}

console.log('')
console.log('阶段 4/6 · 主题')
if (!llm) {
  console.log('  跳过：需要模型归纳主题')
} else {
  const topicsFile = join(DATA_DIR, 'topics.json')
  if (existsSync(topicsFile)) {
    console.log('  已有 topics.json，跳过归纳')
  } else {
    sh('derive-topics.js', ['--out', topicsFile], 'derive topics')
  }
  if (existsSync(topicsFile)) {
    sh('tag-topics.js', ['--topics', topicsFile], 'tag topics')
    sh('fix-topics.js', [], 'fix topics')
  }
}

console.log('')
console.log('阶段 5/6 · 别名扩展（提升同义召回）')
if (!llm) {
  console.log('  跳过：需要模型生成别名')
} else {
  sh('gen-alts.js', ['--batch', '12'], 'gen alts')
  sh('retitle.js', ['--agent', 'all', '--batch', '10'], 'retitle')
}

console.log('')
console.log('阶段 6/6 · 体检')
sh('doctor.js', [], 'doctor')
sh('verify.js', [], 'verify')

console.log('')
console.log('=== 完成 ===')
console.log('下一步：')
console.log('  node cli/query.js stats                    # 看账本规模')
console.log('  node cli/eval.js                           # 如果你有 eval-set.json')
console.log('  node cli/test-governance.js                # 治理机制自测')
console.log('重启 DSH 后面板可用：http://127.0.0.1:8282/work-memory/')
