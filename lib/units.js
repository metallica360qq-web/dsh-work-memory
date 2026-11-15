/**
 * 注入单元：把命中按「段」聚合成一行一段。
 *
 * 钩子级注入是一行一条（`· [h-xxx] 日期 标题`），同一次工作的几条会各占一行；
 * 段级注入把同一段的多条合成一行，并且**整段展开**：命中段里任何一条，就把这段的
 * 标签、seq 跨度、条数都带出来——记忆单元本来就是这段，不是单条。
 *
 * 生产路径（lib/index.js 的 systemPrompt.context）和离线对账（cli/recall-ab-units.mjs）
 * 都用这里的实现，避免两套代码各说各话。
 */
import { readFileSync, statSync } from 'node:fs'

/**
 * 读段表（segments.jsonl）成 Map。文件不存在就返回空 Map，注入退化成钩子级。
 * @param {string} file segments.jsonl 路径。
 * @returns {Map<string, {label: string, fromSeq: number, toSeq: number, hooks: number}>} 段 id → 段信息。
 */
export function loadSegmentMap(file) {
  const map = new Map()
  try {
    const stat = statSync(file)
    if (stat.size === 0) return map
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line)
        if (typeof row.id !== 'string') continue
        map.set(row.id, {
          label: String(row.label || ''),
          fromSeq: Number(row.fromSeq) || 0,
          toSeq: Number(row.toSeq) || 0,
          hooks: Number(row.hooks) || (Array.isArray(row.hookIds) ? row.hookIds.length : 0),
        })
      } catch {
        /* 坏行跳过 */
      }
    }
  } catch {
    /* 没有段表就用钩子级 */
  }
  return map
}

/**
 * 按段聚合命中。
 * @param {Array<{id: string, segment?: string, segLabel?: string, startSeq: number, endSeq: number}>} hits 已按分数排序的命中。
 * @param {Map<string, {label: string, fromSeq: number, toSeq: number, hooks: number}>} [segments] 段表。
 * @returns {Array<{key: string, top: object, hits: Array, label: string, fromSeq: number, toSeq: number, hookCount: number}>} 单元列表。
 */
export function recallUnits(hits, segments) {
  const order = []
  const map = new Map()
  for (const hit of hits) {
    const segmented = typeof hit.segment === 'string' && hit.segment !== ''
    const key = segmented ? hit.segment : 'h:' + hit.id
    if (!map.has(key)) {
      const info = segmented && segments !== undefined ? segments.get(hit.segment) : undefined
      map.set(key, {
        key,
        top: hit,
        hits: [],
        label: info !== undefined && info.label !== '' ? info.label : (typeof hit.segLabel === 'string' ? hit.segLabel : ''),
        fromSeq: info !== undefined && info.fromSeq > 0 ? info.fromSeq : Number(hit.startSeq) || 0,
        toSeq: info !== undefined && info.toSeq > 0 ? info.toSeq : Number(hit.endSeq) || 0,
        hookCount: info !== undefined && info.hooks > 0 ? info.hooks : 1,
      })
      order.push(key)
    }
    map.get(key).hits.push(hit)
  }
  return order.map((key) => map.get(key))
}

/**
 * 一段一行的注入文本：段标签（这段在做什么）+ 段内条数 + 最相关那条的标题 + seq 跨度。
 * @param {{top: object, label: string, fromSeq: number, toSeq: number, hookCount: number}} unit 段单元。
 * @returns {string} 一行文本。
 */
export function formatUnitLine(unit) {
  const top = unit.top
  const label = unit.label !== '' ? unit.label : (top.title || top.ask)
  const count = unit.hookCount > 1 ? '（' + unit.hookCount + ' 条）' : ''
  return '· [段] ' + String(label).slice(0, 46) + count + ' ｜ ' + String(top.title || top.ask).slice(0, 40) +
    ' ｜ seq ' + unit.fromSeq + '–' + unit.toSeq
}
