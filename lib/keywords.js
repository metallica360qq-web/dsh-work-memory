/**
 * keywords.js — 从会话全文抽高频领域词（纯规则，不调模型）。
 *
 * 为什么需要：只索引用户提问会漏掉「内容在助手回复里」的工作——
 * 例如「三层共振」在 Hermes 的消息里出现 956 次，但用户提问里一次都没提。
 * 抽出来的词以低权重参与检索，解决"话题在回复里、提问里找不到"的漏检。
 */

const STOP = new Set([
  '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '可以', '没有', '就是', '这样',
  '那样', '一个', '一些', '如果', '因为', '所以', '但是', '然后', '现在', '还是', '已经',
  '需要', '应该', '可能', '不是', '这些', '那些', '自己', '时候', '问题', '东西', '地方',
  '一下', '来看', '看看', '这里', '那里', '进行', '通过', '以及', '或者', '而且', '不过',
  '的话', '一样', '有点', '比较', '非常', '很多', '很多', '只有', '还有', '第一', '第二',
])

/** 抽 2/3/4 字词，出现次数 ≥2 且不在停用词表。 */
export function topKeywords(texts, limit = 20) {
  const freq = new Map()
  for (const raw of texts) {
    const text = String(raw || '')
    for (const seg of text.match(/[\u4e00-\u9fff]{2,8}/g) || []) {
      for (let n = 2; n <= 4; n += 1) {
        for (let i = 0; i + n <= seg.length; i += 1) {
          const w = seg.slice(i, i + n)
          if (STOP.has(w)) continue
          freq.set(w, (freq.get(w) || 0) + 1)
        }
      }
    }
  }
  const scored = [...freq.entries()]
    .filter(([w, c]) => c >= 2 && w.length >= 2)
    // 长词优先：同频时长词信息量更高
    .map(([w, c]) => [w, c * (1 + (w.length - 2) * 0.3)])
    .sort((a, b) => b[1] - a[1])
  const picked = []
  const seen = new Set()
  for (const [w] of scored) {
    if (picked.length >= limit) break
    // 去重：被更长的词包含则跳过
    if ([...seen].some((s) => s.includes(w))) continue
    picked.push(w)
    seen.add(w)
  }
  return picked
}
