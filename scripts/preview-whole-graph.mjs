#!/usr/bin/env node
/**
 * preview-whole-graph.mjs — 把「全库图谱」导出成静态 SVG（不用打开 DSH 面板）。
 *
 *   node scripts/preview-whole-graph.mjs [--out graph.svg]
 *
 * 布局跟面板里的 renderWholeGraph 一致：宽类成环（每簇一个颜色）、细线围在各自宽类周围、
 * 连接画成跨簇的橙线。大圆的面积随材料条数增长。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../lib/sessionlog.js'
import { loadHooks } from '../lib/store.js'
import { loadLinks, linksFile } from '../lib/links.js'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : join(process.cwd(), 'whole-graph.svg')

const dir = join(dshHome(), 'work-memory')
const table = JSON.parse(readFileSync(join(dir, 'topics.json'), 'utf8'))
const links = loadLinks(linksFile(dir))
const rows = loadHooks()
const count = new Map()
for (const row of rows) {
  if (row.topicFine) count.set(row.topicFine, (count.get(row.topicFine) || 0) + 1)
  if (row.topic) count.set(row.topic, (count.get(row.topic) || 0) + 1)
}

const W = 1000
const H = 900
const CX = 500
const CY = 440
const PALETTE = ['#3d6fd8', '#d8833d', '#4f9d6b', '#b0559b', '#c9a227', '#6b7fd8', '#d85f6b', '#3da3a8', '#8a6fd8', '#7f9d3d', '#d86f9e', '#5f8fd8']
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const groups = table.topics
const pos = {}
groups.forEach((group, index) => {
  const angle = -Math.PI / 2 + (index / groups.length) * Math.PI * 2
  pos[group.id] = {
    id: group.id,
    x: CX + Math.cos(angle) * 350,
    y: CY + Math.sin(angle) * 300,
    kind: 'broad',
    label: group.name,
    size: count.get(group.id) || 0,
    color: PALETTE[index % PALETTE.length],
  }
})

const byGroup = {}
for (const fine of table.fine) {
  if (pos[fine.group] === undefined) continue
  if (byGroup[fine.group] === undefined) byGroup[fine.group] = []
  byGroup[fine.group].push(fine)
}
const spokes = []
for (const [gid, list] of Object.entries(byGroup)) {
  list.forEach((fine, index) => {
    const angle = -Math.PI / 2 + (index / list.length) * Math.PI * 2
    const dist = 48 + (index % 2) * 18
    const center = pos[gid]
    pos[fine.id] = {
      id: fine.id,
      x: center.x + Math.cos(angle) * dist,
      y: center.y + Math.sin(angle) * dist,
      kind: 'fine',
      label: fine.name,
      size: count.get(fine.id) || 0,
      color: center.color,
    }
    spokes.push({ x1: center.x, y1: center.y, x2: pos[fine.id].x, y2: pos[fine.id].y, color: center.color })
  })
}

const radiusOf = (item) => item.kind === 'broad'
  ? 13 + Math.min(14, Math.log2(1 + item.size) * 2.2)
  : 3.5 + Math.min(8, Math.log2(1 + item.size) * 1.6)

const edgeSvg = links
  .filter((link) => pos[link.from] !== undefined && pos[link.to] !== undefined)
  .map((link) => {
    const a = pos[link.from]
    const b = pos[link.to]
    return '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) +
      '" stroke="#e0a24a" stroke-width="' + (1 + link.weight * 0.8).toFixed(2) + '" opacity="0.4"><title>' + esc(link.why) + '</title></line>'
  }).join('\n')

const spokeSvg = spokes.map((line) =>
  '<line x1="' + line.x1.toFixed(1) + '" y1="' + line.y1.toFixed(1) + '" x2="' + line.x2.toFixed(1) + '" y2="' + line.y2.toFixed(1) +
  '" stroke="' + line.color + '" stroke-width="1" opacity="0.22"/>').join('\n')

const nodeSvg = Object.values(pos).sort((left, right) => radiusOf(left) - radiusOf(right)).map((item) =>
  '<circle cx="' + item.x.toFixed(1) + '" cy="' + item.y.toFixed(1) + '" r="' + radiusOf(item).toFixed(1) +
  '" fill="' + item.color + '" opacity="' + (item.kind === 'broad' ? 0.95 : 0.8) + '"><title>' +
  esc(item.label) + '（' + item.size + ' 条）</title></circle>').join('\n')

const labelCandidates = Object.values(pos)
  .filter((item) => item.kind === 'broad' || item.size >= 20)
  .sort((left, right) => ((right.kind === 'broad' ? 1 : 0) - (left.kind === 'broad' ? 1 : 0)) || right.size - left.size)
const labelRects = []
const labelSvg = labelCandidates.map((item) => {
  const text = item.kind === 'broad' ? item.label : item.label.slice(0, 10)
  const labelY = item.y + radiusOf(item) + (item.kind === 'broad' ? 15 : 11)
  const boxW = text.length * 11 + 6
  const boxX = item.x - boxW / 2
  const boxY = labelY - 11
  if (boxX < 6 || boxX + boxW > W - 6) return ''
  for (const r of labelRects) {
    if (boxX < r.x + r.w + 6 && boxX + boxW + 6 > r.x && boxY < r.y + r.h + 4 && boxY + 18 + 4 > r.y) return ''
  }
  labelRects.push({ x: boxX, y: boxY, w: boxW, h: 18 })
  const isBroad = item.kind === 'broad'
  return '<text x="' + item.x.toFixed(1) + '" y="' + labelY.toFixed(1) +
    '" text-anchor="middle" font-size="' + (isBroad ? 12.5 : 11) + '" font-weight="' + (isBroad ? 600 : 400) +
    '" fill="' + (isBroad ? '#1f2328' : item.color) + '">' + esc(text) + '</text>'
}).filter(Boolean).join('\n')

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
  '" font-family="Segoe UI, Microsoft YaHei, sans-serif">\n' +
  '<rect width="' + W + '" height="' + H + '" fill="#fbfbfc"/>\n' +
  '<text x="24" y="34" font-size="16" font-weight="600" fill="#1f2328">全库图谱 · ' + Object.keys(pos).length + ' 个节点 · ' + links.length + ' 条连接</text>\n' +
  '<text x="24" y="56" font-size="12" fill="#6b7280">大圆 = 宽类，小圆 = 细线，颜色 = 所属宽类，橙线 = 跨主题连接</text>\n' +
  spokeSvg + '\n' + edgeSvg + '\n' + nodeSvg + '\n' + labelSvg + '\n</svg>\n'

writeFileSync(out, svg, 'utf8')
console.log('写入 ' + out + '（' + Object.keys(pos).length + ' 节点 / ' + links.length + ' 连接）')
