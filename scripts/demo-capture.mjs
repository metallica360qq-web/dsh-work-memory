#!/usr/bin/env node
/**
 * demo-capture.mjs — 用 CDP 打开 DSH 面板，按「总览 → 宽类 → 细线 → 星图」走一遍并截图。
 *
 *   node scripts/demo-capture.mjs
 *
 * 不依赖 playwright：直接连 chrome 的 remote debugging 端口（Node 22 自带 WebSocket）。
 * 产出：demo-frames/01-overview.png … 04-graph.png（1440×900）
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'demo-frames')
mkdirSync(outDir, { recursive: true })

const PORT = Number(process.env.CDP_PORT || 9333)
const URL_TARGET = process.env.DEMO_URL || 'http://127.0.0.1:8282'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

/** 一个极简 CDP 客户端：send(method, params) → Promise<result>。 */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new CDP(ws)
  }

  send(method, params = {}) {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed')
    return result.result ? result.result.value : undefined
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log('  saved ' + file)
  }
}

const targets = await listTargets()
const page = targets.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('没有找到 page target，先启动 chrome（--remote-debugging-port=' + PORT + '）')
  process.exit(1)
}

const cdp = await CDP.connect(page.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

console.log('打开 ' + URL_TARGET)
await cdp.send('Page.navigate', { url: URL_TARGET })
await sleep(6000)

// 1. 总览：如果当前不在会话视图，点侧栏图标
const clicked = await cdp.evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button,[role="button"],a')]
  const hit = nodes.find((n) => (n.getAttribute('aria-label') || n.title || n.textContent || '').includes('会话视图'))
  if (hit) { hit.click(); return hit.getAttribute('aria-label') || hit.title || hit.textContent.slice(0,20) }
  return null
})()`)
console.log('  侧栏点击: ' + (clicked === null ? '未找到（可能已在该面板）' : clicked))
await sleep(2500)
await cdp.shot(join(outDir, '01-overview.png'))

// 2. 点第一个宽类方块 → 细线清单
const topicName = await cdp.evaluate(`(() => {
  const tile = document.querySelector('.svp-tile')
  if (!tile) return null
  tile.click()
  return tile.textContent.replace(/\\s+/g,' ').slice(0, 40)
})()`)
console.log('  宽类点击: ' + topicName)
await sleep(1800)
await cdp.shot(join(outDir, '02-group.png'))

// 3. 点第一条细线 → 星图
const fineName = await cdp.evaluate(`(() => {
  const line = document.querySelector('.svp-line')
  if (!line) return null
  line.click()
  return line.textContent.replace(/\\s+/g,' ').slice(0, 40)
})()`)
console.log('  细线点击: ' + fineName)
await sleep(1800)
await cdp.shot(join(outDir, '03-graph.png'))

// 4. 如果星图里有会话节点，点第一个看会话详情
const nodeText = await cdp.evaluate(`(() => {
  const node = document.querySelector('.svp-graph-node')
  if (!node) return null
  node.click()
  return node.textContent.replace(/\\s+/g,' ').slice(0, 40)
})()`)
console.log('  会话节点点击: ' + nodeText)
await sleep(1800)
await cdp.shot(join(outDir, '04-session.png'))

console.log('完成，帧在 ' + outDir)
if (!existsSync(join(outDir, '01-overview.png'))) process.exit(2)
