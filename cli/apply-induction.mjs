#!/usr/bin/env node
/**
 * apply-induction.mjs — 把两遍读出来的主题表落地：写 topics.json + 回写账本 topic/topicFine。
 *
 *   node cli/apply-induction.mjs [--dry-run]
 *
 * 数据形状（schema 2）：
 *   topics[]  宽类（g01…g12），带 keywords（从成员材料反推，供 matchTopic 用）
 *   fine[]    细类（i01…i81），带 group 指回宽类
 *   账本       topic = 宽类 id（检索/统计按这层），topicFine = 细类 id（面板中间层）
 *
 * 代理自产记录（origin 非人类）不参与这套主题，topic 清空，靠 origin 拦在人类视图外。
 * 会先备份账本与 topics.json。
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks, tokens } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

const dataDir = join(dshHome(), 'work-memory')
const inductDir = join(dataDir, '.induct')
const topicsFile = join(dataDir, 'topics.json')
const ledgerFile = join(dataDir, 'hooks.jsonl')

const fine = JSON.parse(readFileSync(join(inductDir, 'final-topics.json'), 'utf8'))
const grouped = JSON.parse(readFileSync(join(inductDir, 'final-topics.grouped.json'), 'utf8'))
const pass1 = JSON.parse(readFileSync(join(inductDir, 'pass1.json'), 'utf8'))

const groupOf = new Map()
for (const group of grouped.groups) for (const id of group.members) groupOf.set(id, group.id)
const fineOf = new Map(fine.topics.map((topic) => [topic.id, topic]))
const rows = loadHooks()

/** 宽类关键词：成员材料里出现频次高、且不是所有宽类都有的词。 */
const STOP = new Set(['不是', '是不', '现在', '可以', '一下', '一个', '这个', '我们', '什么', '怎么', '为什', '没有', '就是', '还是', '然后', '之后', '的话', '这样', '那样', '里面', '东西', '问题', '地方', '知道', '觉得', '需要', '应该', '可能', '一直', '已经', '时候', '所以', '因为', '但是', '不过'])
const groupTerms = new Map()
const globalTerm = new Map()
for (const group of grouped.groups) groupTerms.set(group.id, new Map())
for (const row of rows) {
  if (!isHumanRow(row)) continue
  const group = groupOf.get(pass1.assignments[row.id])
  if (group === undefined) continue
  const text = [row.title, row.ask, (row.artifacts || []).map((path) => String(path).split(/[\\/]/).pop()).join(' ')].join(' ')
  const seen = new Set(tokens(text))
  for (const term of seen) {
    if (STOP.has(term) || term.length < 2) continue
    const bucket = groupTerms.get(group)
    if (bucket === undefined) continue
    bucket.set(term, (bucket.get(term) || 0) + 1)
    globalTerm.set(term, (globalTerm.get(term) || 0) + 1)
  }
}
const humanTotal = rows.filter((row) => isHumanRow(row)).length || 1
/**
 * 宽类关键词：手写。自动从材料里抽出来的中文 bigram 跨词边界（「物基」「与精」「的记」），
 * 拿去做查询字面匹配只会制造噪声。这 12 个宽类的边界已经很清楚，直接写词更准。
 */
const CURATED = {
  g01: ['药物浓度', 'TDM', '药物基因', 'PGx', 'ClinPGx', 'DDI', '药物相互作用', '基因检测', '位点'],
  g02: ['神经免疫', '自免脑', '抗体', 'AD', '阿尔茨海默', '标志物', 'p-tau', 'GFAP', '脑脊液', '游离轻链'],
  g03: ['销量', '立项', '商业化', '招标', '阳光行动', '基层', '千县', '学术推广', '项目'],
  g04: ['量化', '因子', '策略', '回测', '信号', '止损', '止盈', '缠论', '中枢', 'MACD', '通道'],
  g05: ['dsh', '插件', 'cordis', 'skill', '技能', '侧栏', 'token', 'provider', '模型接入'],
  g06: ['hermes', '记忆', '记忆系统', 'mem0', '知识库', '迁移', 'gateway', 'zcode'],
  g07: ['小游戏', '网页', 'html', 'python', '脚本', '录音', '投屏', '工具'],
  g08: ['ppt', 'pptx', '幻灯片', '模板', '海报', '宣传片', '短视频', '视频', '排版'],
  g09: ['八字', '紫微', '命理', '排盘', '卦', '择吉', '佛经', '佛陀说什么', '六爻'],
  g10: ['写作', '小说', '简历', '论文写作', '材料', '手抄报'],
  g11: ['游戏', '小丑牌', '植物大战僵尸', '横版', '火柴人'],
  g12: [],
}
const NOISE = new Set(['index', 'index.js', 'json', 'md', 'py', 'js', 'readme', 'readme.md', 'file', 'txt', 'html', '文件', '进行', '不能', '没有', '什么', '这个', '一个'])
const latinOf = (text) => (String(text).match(/[A-Za-z][A-Za-z0-9._-]{1,}/g) || []).map((word) => word.toLowerCase())
const keywordsFor = (group) => {
  const curated = CURATED[group.id]
  if (Array.isArray(curated)) return curated
  const scored = [...(groupTerms.get(group.id) || new Map()).entries()]
    .filter(([term]) => !STOP.has(term) && !NOISE.has(term) && term.length >= 3 && (groupTerms.get(group.id).get(term) || 0) >= 3)
    .map(([term, count]) => ({ term, score: count / ((globalTerm.get(term) || 0) + 3) }))
    .filter((item) => item.score >= 0.35)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.term)
  const latin = [...new Set([...latinOf(group.name), ...latinOf(group.desc)])]
  const out = []
  for (const term of [...latin, ...scored]) {
    if (!out.includes(term)) out.push(term)
    if (out.length >= 12) break
  }
  return out
}

const topicsOut = {
  generatedAt: new Date().toISOString(),
  schema: 2,
  note: '两遍读归纳出来的主题表（cli/induct-topics.mjs 生成）：topics = 宽类（检索/统计用），fine = 细类（面板中间层）。旧的手工 16 类已废弃。',
  topics: grouped.groups.map((group) => ({
    id: group.id,
    name: group.name,
    desc: group.desc,
    keywords: keywordsFor(group),
    members: group.members,
  })),
  fine: fine.topics.map((topic) => ({
    id: topic.id,
    name: topic.name,
    desc: topic.desc,
    group: groupOf.get(topic.id),
  })),
}

// 先备份
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
if (!dryRun) {
  copyFileSync(topicsFile, topicsFile + '.bak-induct-' + stamp)
  copyFileSync(ledgerFile, ledgerFile + '.bak-induct-' + stamp)
}

const counts = { humanAssigned: 0, humanUnassigned: 0, agentCleared: 0 }
const broadCount = {}
for (const row of rows) {
  if (!isHumanRow(row)) {
    if (row.topic !== '' && row.topic !== undefined) counts.agentCleared += 1
    row.topic = ''
    row.topicFine = ''
    continue
  }
  const fineId = pass1.assignments[row.id]
  const fineTopic = fineId === undefined ? undefined : fineOf.get(fineId)
  if (fineTopic === undefined) {
    counts.humanUnassigned += 1
    row.topic = ''
    row.topicFine = ''
    continue
  }
  row.topic = groupOf.get(fineId) || ''
  row.topicFine = fineId
  counts.humanAssigned += 1
  broadCount[row.topic] = (broadCount[row.topic] || 0) + 1
}

console.log('人类记录：已指派 ' + counts.humanAssigned + ' 条，未指派（新写入还没跑过归纳）' + counts.humanUnassigned + ' 条')
console.log('代理自产：清掉旧主题 ' + counts.agentCleared + ' 条（仍留在账本，靠 origin 拦在人类视图外）')
console.log('宽类分布：')
for (const [id, count] of Object.entries(broadCount).sort((left, right) => right[1] - left[1])) {
  const group = topicsOut.topics.find((topic) => topic.id === id)
  console.log('  ' + id + ' ' + (group === undefined ? id : group.name) + ' ' + count + ' 条')
}
console.log('关键词样例：')
for (const topic of topicsOut.topics.slice(0, 6)) console.log('  ' + topic.id + ' ' + topic.name + ' → ' + topic.keywords.slice(0, 8).join('、'))

if (dryRun) {
  console.log('\n--dry-run：没有写盘')
} else {
  writeFileSync(topicsFile, JSON.stringify(topicsOut, null, 2) + '\n', 'utf8')
  writeFileSync(ledgerFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  console.log('\n已写回：' + topicsFile)
  console.log('已写回：' + ledgerFile)
  console.log('备份后缀：.bak-induct-' + stamp)
}
