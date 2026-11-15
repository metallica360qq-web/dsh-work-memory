/**
 * 记忆连接（links）：在主题树之外维护一层「边」。
 *
 * 树只能回答「这个单元属于哪条线」，回答不了「这条线和那条线有关系」。
 * 一个单元仍然只有一个主主题，但主题之间可以连边——细类↔细类、细类↔宽类、宽类↔宽类。
 * 召回走到某条线时可以顺着边走一跳；面板里可以点着跳过去。
 *
 * 文件：<DSH_HOME>/work-memory/links.jsonl，一行一条边。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读连接表。
 * @param {string} file links.jsonl 路径。
 * @returns {Array<{from: string, to: string, kind: string, why: string, weight: number, source: string, ts: string}>} 边列表。
 */
export function loadLinks(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (typeof row.from !== 'string' || typeof row.to !== 'string') continue
      if (row.from === row.to) continue
      out.push({
        from: row.from,
        to: row.to,
        kind: String(row.kind || 'fine-fine'),
        why: String(row.why || ''),
        weight: Number.isFinite(Number(row.weight)) ? Math.max(0, Math.min(1, Number(row.weight))) : 0.5,
        source: String(row.source || 'model'),
        ts: String(row.ts || ''),
      })
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
}

/** 无序对键：i20↔i65 与 i65↔i20 视为同一条边。 */
export function pairKey(left, right) {
  return [left, right].sort().join('|')
}

/**
 * 写连接表：先按无序对去重，再按权重降序输出；手工边优先保留。
 * @param {string} file links.jsonl 路径。
 * @param {Array} links 边列表。
 * @returns {{written: number, merged: number}} 去重结果。
 */
export function saveLinks(file, links) {
  const byPair = new Map()
  let merged = 0
  for (const link of links) {
    const key = pairKey(link.from, link.to)
    const previous = byPair.get(key)
    if (previous === undefined) {
      byPair.set(key, link)
      continue
    }
    merged += 1
    // 手工边优先；否则留权重高的
    const keep = previous.source === 'manual' ? previous : (link.source === 'manual' ? link : (link.weight > previous.weight ? link : previous))
    byPair.set(key, keep)
  }
  const ordered = [...byPair.values()].sort((left, right) => right.weight - left.weight)
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    copyFileSync(file, file + '.bak-links-' + stamp)
  }
  writeFileSync(file, ordered.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  return { written: ordered.length, merged }
}

/**
 * 一跳邻居：给定节点，返回与它相连的节点和边。
 * @param {Array} links 边列表。
 * @param {string} node 节点 id（细类 i01… 或宽类 g01…）。
 * @returns {Array<{node: string, why: string, weight: number, kind: string}>} 邻居列表。
 */
export function neighbors(links, node) {
  const out = []
  for (const link of links) {
    if (link.from === node) out.push({ node: link.to, why: link.why, weight: link.weight, kind: link.kind })
    else if (link.to === node) out.push({ node: link.from, why: link.why, weight: link.weight, kind: link.kind })
  }
  return out.sort((left, right) => right.weight - left.weight)
}

/** 连接表路径。 */
export function linksFile(dir) {
  return join(dir, 'links.jsonl')
}
