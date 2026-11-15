#!/usr/bin/env node
/**
 * cluster-topics.mjs — 用聚类重新看「主题」该怎么长出来（实验，只读不写账本）。
 *
 *   node cli/cluster-topics.mjs [--k 8,10,12,14,16,18,20] [--rows 600]
 *
 * 现在的主题是「GLM 把每条记录分进一个固定 16 类目录」，问题是对不上数据本身：
 * 分类器（关键词）和标注器（GLM）只有 52% 一致，t16 成了垃圾筐。
 * 这里换一个方向：先让记录自己聚成堆，再给堆起名。
 *
 * 做法：TF-IDF（复用 store 的中文 bigram 分词）→ 球面 k-means（余弦）→
 * 对每个 k 算轮廓系数与堆大小分布；最后把新堆和现有主题做 ARI 对照。
 * 纯本地、不调模型、不写盘。
 */
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks, tokens } from '../lib/store.js'
import { isHumanRow } from '../lib/origin.js'
import { loadTopics } from '../lib/topics.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const KS = String(argOf('--k', '8,10,12,14,16,18,20')).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 1)
const MAX_ROWS = Number(argOf('--rows', 600))

const rows = loadHooks().filter((row) => isHumanRow(row) && row.status === 'active').slice(0, MAX_ROWS)
const topics = loadTopics()
const topicName = new Map(topics.map((topic) => [topic.id, topic.name]))

// ── 文档向量 ────────────────────────────────────────────────────────────────
const docs = rows.map((row) => {
  const text = [row.title, row.ask, (row.artifacts || []).map((p) => String(p).split(/[\\/]/).pop()).join(' '), (row.kw || []).join(' ')].join(' ')
  return new Set(tokens(text))
})
const df = new Map()
for (const doc of docs) for (const term of doc) df.set(term, (df.get(term) || 0) + 1)
const N = docs.length
const vectors = docs.map((doc) => {
  const vec = new Map()
  let norm = 0
  for (const term of doc) {
    const weight = Math.log((N + 1) / ((df.get(term) || 1) + 1)) + 1
    vec.set(term, weight)
    norm += weight * weight
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0
  for (const [term, weight] of vec) vec.set(term, weight * scale)
  return vec
})

const cosine = (left, right) => {
  let dot = 0
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  for (const [term, weight] of small) {
    const other = large.get(term)
    if (other !== undefined) dot += weight * other
  }
  return dot
}

/** 确定性伪随机，保证同一批数据每次跑出一样的结果。 */
const makeRandom = (seed) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

/** 球面 k-means：余弦相似度当作内积，中心取簇内归一化均值。 */
function sphericalKMeans(k, iterations = 40, seed = 20261115) {
  const random = makeRandom(seed)
  const centroids = []
  // k-means++ 初始化（按 1 - cos 最大的点补心）
  const firstIndex = Math.floor(random() * N)
  centroids.push(new Map(vectors[firstIndex]))
  while (centroids.length < k) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let i = 0; i < N; i += 1) {
      let maxSim = -1
      for (const centroid of centroids) maxSim = Math.max(maxSim, cosine(vectors[i], centroid))
      const score = (1 - maxSim) * (0.5 + random() * 0.5)
      if (score > bestScore) {
        bestScore = score
        bestIndex = i
      }
    }
    centroids.push(new Map(vectors[bestIndex]))
  }

  let assignment = new Array(N).fill(-1)
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = 0
    for (let i = 0; i < N; i += 1) {
      let best = 0
      let bestSim = -Infinity
      for (let c = 0; c < centroids.length; c += 1) {
        const sim = cosine(vectors[i], centroids[c])
        if (sim > bestSim) {
          bestSim = sim
          best = c
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best
        moved += 1
      }
    }
    // 重算中心
    const sums = Array.from({ length: centroids.length }, () => new Map())
    for (let i = 0; i < N; i += 1) {
      const bucket = sums[assignment[i]]
      for (const [term, weight] of vectors[i]) bucket.set(term, (bucket.get(term) || 0) + weight)
    }
    for (let c = 0; c < centroids.length; c += 1) {
      let norm = 0
      for (const weight of sums[c].values()) norm += weight * weight
      const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0
      for (const [term, weight] of sums[c]) sums[c].set(term, weight * scale)
      centroids[c] = sums[c]
    }
    if (moved === 0) break
  }
  return assignment
}

/** 轮廓系数（余弦距离），O(n²)，n≤600 可以接受。 */
function silhouette(assignment, k) {
  const clusters = Array.from({ length: k }, () => [])
  for (let i = 0; i < N; i += 1) clusters[assignment[i]].push(i)
  const sums = new Array(N).fill(0)
  const counts = new Array(N).fill(0)
  let total = 0
  for (let i = 0; i < N; i += 1) {
    const own = clusters[assignment[i]]
    if (own.length <= 1) {
      continue
    }
    let ownSum = 0
    const otherSum = new Array(k).fill(0)
    const otherCount = new Array(k).fill(0)
    for (let j = 0; j < N; j += 1) {
      if (i === j) continue
      const sim = cosine(vectors[i], vectors[j])
      const distance = 1 - sim
      if (assignment[j] === assignment[i]) ownSum += distance
      else {
        otherSum[assignment[j]] += distance
        otherCount[assignment[j]] += 1
      }
    }
    const a = ownSum / (own.length - 1)
    let b = Infinity
    for (let c = 0; c < k; c += 1) {
      if (c === assignment[i] || otherCount[c] === 0) continue
      b = Math.min(b, otherSum[c] / otherCount[c])
    }
    if (Number.isFinite(b)) total += (b - a) / Math.max(a, b)
  }
  return total / N
}

/** 调整兰德指数：新簇 vs 现有主题的一致性（1=完全一致，0=随机）。 */
function adjustedRand(leftLabels, rightLabels) {
  const n = leftLabels.length
  const pairs = (x) => (x * (x - 1)) / 2
  const table = new Map()
  const leftCounts = new Map()
  const rightCounts = new Map()
  for (let i = 0; i < n; i += 1) {
    leftCounts.set(leftLabels[i], (leftCounts.get(leftLabels[i]) || 0) + 1)
    rightCounts.set(rightLabels[i], (rightCounts.get(rightLabels[i]) || 0) + 1)
    const key = leftLabels[i] + '|' + rightLabels[i]
    table.set(key, (table.get(key) || 0) + 1)
  }
  let sumTable = 0
  for (const value of table.values()) sumTable += pairs(value)
  let sumLeft = 0
  for (const value of leftCounts.values()) sumLeft += pairs(value)
  let sumRight = 0
  for (const value of rightCounts.values()) sumRight += pairs(value)
  const expected = (sumLeft * sumRight) / pairs(n)
  const maximum = (sumLeft + sumRight) / 2
  return maximum === expected ? 0 : (sumTable - expected) / (maximum - expected)
}

// ── 跑一遍 ──────────────────────────────────────────────────────────────────
console.log('人类需求记录 ' + N + ' 条（TF-IDF 维度 ' + df.size + '）')
console.log('k | 轮廓系数 | 簇大小 min/median/max | 与现有主题的 ARI')

const overview = []
for (const k of KS) {
  const assignment = sphericalKMeans(k)
  const sizes = Array.from({ length: k }, (_, c) => assignment.filter((value) => value === c).length).sort((a, b) => a - b)
  const score = silhouette(assignment, k)
  const current = rows.map((row) => row.topic || '(未打标)')
  const ari = adjustedRand(assignment.map(String), current)
  overview.push({ k, score, sizes, assignment, ari })
  console.log(k + ' | ' + score.toFixed(3) + ' | ' + sizes[0] + ' / ' + sizes[Math.floor(sizes.length / 2)] + ' / ' + sizes[sizes.length - 1] + ' | ' + ari.toFixed(3))
}

const best = overview.slice().sort((left, right) => right.score - left.score)[0]
console.log('\n选轮廓系数最高的 k=' + best.k + '，簇的样子：')
const buckets = Array.from({ length: best.k }, () => [])
for (let i = 0; i < N; i += 1) buckets[best.assignment[i]].push(i)
const centroidsTerms = new Map()
for (const index of rows.map((_, i) => i)) {
  const cluster = best.assignment[index]
  const bucket = centroidsTerms.get(cluster) || new Map()
  for (const term of docs[index]) bucket.set(term, (bucket.get(term) || 0) + 1)
  centroidsTerms.set(cluster, bucket)
}
const ordered = buckets.map((members, cluster) => ({ cluster, members })).sort((left, right) => right.members.length - left.members.length)
for (const entry of ordered) {
  const terms = [...(centroidsTerms.get(entry.cluster) || new Map()).entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([term]) => term)
  const samples = entry.members.slice(0, 3).map((index) => String(rows[index].title || rows[index].ask).slice(0, 26))
  const currentTopics = {}
  for (const index of entry.members) currentTopics[rows[index].topic || '(未打标)'] = (currentTopics[rows[index].topic || '(未打标)'] || 0) + 1
  const dominant = Object.entries(currentTopics).sort((left, right) => right[1] - left[1]).slice(0, 3)
    .map(([topic, count]) => (topicName.get(topic) || topic) + ' ' + count).join('、')
  console.log('\n簇 ' + entry.cluster + '（' + entry.members.length + ' 条） 词：' + terms.join(' / '))
  console.log('  样例：' + samples.join(' ‖ '))
  console.log('  现有主题：' + dominant)
}
