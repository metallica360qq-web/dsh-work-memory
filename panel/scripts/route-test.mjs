/**
 * 工作记忆两条写接口的自测（在临时目录里跑，不碰真实账本）。
 *
 *   node scripts/route-test.mjs
 *
 * 覆盖：pin 的 GET/POST/clear、topic-new 追加细类并挂到宽类下、备份文件生成。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'svp-route-'))
const topicsFile = join(dir, 'topics.json')
writeFileSync(topicsFile, JSON.stringify({
  schema: 2,
  topics: [{ id: 'g01', name: '测试宽类', desc: '', annotation: '测试用', keywords: [], members: ['i01'] }],
  fine: [{ id: 'i01', name: '测试细类', desc: '', annotation: '测试用', group: 'g01' }],
}, null, 2) + '\n', 'utf8')

// 让插件的 dataDir() 指向临时目录
process.env.DSH_WORK_MEMORY_DIR = dir

const routes = new Map()
const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined
    return { register(route) { routes.set(route.path, route.handler); return () => {} } }
  },
  effect(fn) { fn(); return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx)

assert.ok(routes.has('/session-view/api/memory/pin'), '注册了 pin 路由')
assert.ok(routes.has('/session-view/api/memory/topic-new'), '注册了 topic-new 路由')

function fakeRes() {
  const res = { status: 0, body: '', writeHead(status) { res.status = status }, end(text) { res.body = text } }
  return res
}

/** 造一个能喂 JSON body 的假请求。 */
function fakeReq(method, payload) {
  const handlers = {}
  const req = {
    method,
    url: '/',
    on(event, fn) { handlers[event] = fn; return req },
  }
  setTimeout(() => {
    if (payload !== undefined && handlers.data !== undefined) handlers.data(JSON.stringify(payload))
    if (handlers.end !== undefined) handlers.end()
  }, 0)
  return req
}

// 1. pin：先读（空）→ 写 → 再读 → 清除
let res = fakeRes()
await routes.get('/session-view/api/memory/pin')(fakeReq('GET'), res)
assert.equal(JSON.parse(res.body).pin, null, '初始没有方向')

res = fakeRes()
await routes.get('/session-view/api/memory/pin')(fakeReq('POST', { topic: 'g01', fine: 'i01', label: '测试方向' }), res)
const setPayload = JSON.parse(res.body)
assert.equal(setPayload.ok, true)
assert.equal(setPayload.pin.label, '测试方向')
assert.equal(setPayload.pin.ttlHours, 8, '默认 8 小时')

res = fakeRes()
await routes.get('/session-view/api/memory/pin')(fakeReq('GET'), res)
assert.equal(JSON.parse(res.body).pin.label, '测试方向', '读回来是刚写的那条')

res = fakeRes()
await routes.get('/session-view/api/memory/pin')(fakeReq('POST', { clear: true }), res)
assert.equal(JSON.parse(res.body).pin, null, '清除后为空')

// 2. 参数校验
res = fakeRes()
await routes.get('/session-view/api/memory/pin')(fakeReq('POST', {}), res)
assert.equal(res.status, 400, '空参数要报错')

// 3. topic-new：追加 i02 并挂到 g01
res = fakeRes()
await routes.get('/session-view/api/memory/topic-new')(fakeReq('POST', { group: 'g01', name: '新模块', annotation: '这个模块收新东西' }), res)
const created = JSON.parse(res.body)
assert.equal(created.ok, true)
assert.equal(created.topic.id, 'i02', '新 id 顺延')
assert.equal(created.topic.group, 'g01')

const saved = JSON.parse(readFileSync(topicsFile, 'utf8'))
assert.ok(saved.fine.some((item) => item.id === 'i02' && item.name === '新模块'))
assert.ok(saved.topics[0].members.includes('i02'), '宽类的 members 里要带上新细类')
assert.ok(readdirSync(dir).some((name) => name.startsWith('topics.json.bak-topicnew-')), '写前有备份')

// 4. 缺宽类要拒绝
res = fakeRes()
await routes.get('/session-view/api/memory/topic-new')(fakeReq('POST', { group: 'g99', name: 'x' }), res)
assert.equal(res.status, 400, '宽类不存在要拒绝')

// 5. topic-link：手工连一条边，再断开
const linksFile = join(dir, 'links.jsonl')
res = fakeRes()
await routes.get('/session-view/api/memory/topic-link')(fakeReq('POST', { from: 'g01', to: 'i01', why: '手工测试' }), res)
assert.equal(JSON.parse(res.body).ok, true)
let edges = readFileSync(linksFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
assert.equal(edges.length, 1, '连上后有一条边')
assert.equal(edges[0].source, 'manual')
assert.equal(edges[0].weight, 1)

res = fakeRes()
await routes.get('/session-view/api/memory/topic-link')(fakeReq('POST', { from: 'i01', to: 'g01', remove: true }), res)
edges = readFileSync(linksFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
assert.equal(edges.length, 0, '反向参数也能断开（按无序对匹配）')

res = fakeRes()
await routes.get('/session-view/api/memory/topic-link')(fakeReq('POST', { from: 'g99', to: 'i01' }), res)
assert.equal(res.status, 400, '节点不存在要拒绝')

res = fakeRes()
await routes.get('/session-view/api/memory/topic-link')(fakeReq('POST', { from: 'g01', to: 'g01' }), res)
assert.equal(res.status, 400, '不能自己连自己')

console.log('route-test: pin 读写清除 + topic-new 追加/挂载/备份 + topic-link 连/断/校验 全部通过')
