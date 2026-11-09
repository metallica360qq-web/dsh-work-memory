/**
 * topics.js — 主题层：加载主题清单，按关键词给查询判主题。
 *
 * 用途：新任务先判它属于哪个工程主题，再只在该主题内检索，避免跨主题噪声
 * （例：做「记忆系统」时不该弹出「AD 项目」的条目）。
 *
 * 判定是字面匹配，零模型调用。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './sessionlog.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
let cache = null

/**
 * 主题文件查找顺序：
 *   1. 显式传入的路径
 *   2. <DSH_WORK_MEMORY_DIR>/topics.json（用户自己的主题，运行时用这个）
 *   3. <包根>/topics.example.json（通用示例，仅在用户尚未创建主题时兜底）
 *
 * 这样插件包可以安全分发给别人：包内不含任何个人主题。
 */
function candidatePaths(file) {
  if (file) return [file]
  const dataDir =
    typeof process.env.DSH_WORK_MEMORY_DIR === 'string' && process.env.DSH_WORK_MEMORY_DIR.trim().length > 0
      ? process.env.DSH_WORK_MEMORY_DIR.trim()
      : join(dshHome(), 'work-memory')
  return [join(dataDir, 'topics.json'), join(ROOT, 'topics.example.json')]
}

export function loadTopics(file) {
  const candidates = candidatePaths(file)
  const key = candidates.join('|')
  if (cache !== null && cache.key === key) return cache.topics
  let topics = []
  for (const p of candidates) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      if (Array.isArray(j.topics) && j.topics.length > 0) {
        topics = j.topics
        break
      }
    } catch {
      /* 试下一个候选 */
    }
  }
  cache = { key, topics }
  return topics
}

/**
 * 按关键词命中数判主题；命中数相同时取更长的关键词（更具体）。
 * @returns {string|null} topic id，如 't15'；判不出返回 null
 */
export function matchTopic(text, topics = loadTopics()) {
  const raw = String(text || '')
  if (raw.length === 0 || topics.length === 0) return null
  const lower = raw.toLowerCase()
  let best = null
  for (const topic of topics) {
    let hits = 0
    let strength = 0
    for (const kw of topic.keywords || []) {
      const k = String(kw).toLowerCase()
      if (k.length < 2) continue
      if (lower.includes(k)) {
        hits += 1
        strength += k.length
      }
    }
    if (hits === 0) continue
    const score = hits * 100 + strength
    if (best === null || score > best.score) best = { id: topic.id, score, hits }
  }
  return best === null ? null : best.id
}

export function topicName(id, topics = loadTopics()) {
  const t = topics.find((x) => x.id === id)
  return t ? t.name : ''
}
