#!/usr/bin/env node
/**
 * Web 面板逻辑自测：mock webServer.register + 假 req/res，验证四条路由。
 *
 *   node cli/test-webpanel.js
 *
 * 说明：真实 HTTP 需要重启 DSH 后才能访问；这里验证 handler 逻辑。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'wm-panel-'))
process.env.DSH_WORK_MEMORY_DIR = sandbox

const { registerWebPanel } = await import('../lib/webpanel.js')
const { appendHook } = await import('../lib/store.js')

// 沙箱账本里放两条样本，供后续 search/open/update/archive 用例
const now = new Date().toISOString()
appendHook({
  schema: 1,
  id: 'p-test-1',
  session: 'session-webpanel-test',
  startSeq: 1,
  endSeq: 3,
  ask: 'MACD 过滤里 long_flow 的绝对值门槛怎么定',
  title: 'MACD 过滤绝对值门槛',
  kind: 'manual',
  level: 'module',
  artifacts: [],
  ts: now,
  agent: 'dsh',
  status: 'active',
})

const routes = []
const webServer = { register: (r) => { routes.push(r); return () => {} } }
registerWebPanel({}, webServer)

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(s, h) { this.status = s; this.headers = h || {} },
    end(b) { this.body = String(b || '') },
  }
  return res
}

function fakeReq(url, method = 'GET', body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
  const req = {
    url,
    method,
    on(ev, fn) {
      if (ev === 'data') for (const c of chunks) fn(c)
      if (ev === 'end') fn()
      return req
    },
  }
  return req
}

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

const pageRoute = routes.find((r) => r.path === '/work-memory/')
const apiRoutes = routes.filter((r) => r.path.startsWith('/work-memory/api/'))
const apiRoute = apiRoutes.find((r) => r.path === '/work-memory/api/search') || apiRoutes[0]
check('注册了页面路由', pageRoute !== undefined)
check('注册了 4 条 API 路由', apiRoutes.length === 4, 'got=' + apiRoutes.length)

const res1 = fakeRes()
await pageRoute.handler(fakeReq('/work-memory/'), res1)
check('页面返回 200 + HTML', res1.status === 200 && res1.body.includes('工作记忆'), 'status=' + res1.status)

const res2 = fakeRes()
await apiRoute.handler(fakeReq('/work-memory/api/search?q=MACD&limit=3'), res2)
const data2 = JSON.parse(res2.body)
check('search 返回 total/items', res2.status === 200 && Number.isFinite(data2.total) && Array.isArray(data2.items),
  'status=' + res2.status + ' body=' + res2.body.slice(0, 120))

const first = data2.items[0]
if (first) {
  const res3 = fakeRes()
  await apiRoute.handler(fakeReq('/work-memory/api/open?id=' + encodeURIComponent(first.id)), res3)
  const data3 = JSON.parse(res3.body)
  check('open 返回原文', res3.status === 200 && typeof data3.text === 'string' && data3.text.length > 0,
    'status=' + res3.status + ' len=' + (data3.text || '').length)

  const res4 = fakeRes()
  await apiRoute.handler(fakeReq('/work-memory/api/update', 'POST', { id: first.id, title: '面板改过的标题' }), res4)
  check('update 成功', res4.status === 200 && JSON.parse(res4.body).ok === true, res4.body.slice(0, 120))

  const res5 = fakeRes()
  await apiRoute.handler(fakeReq('/work-memory/api/search?q=' + encodeURIComponent('面板改过的标题') + '&limit=3'), res5)
  const data5 = JSON.parse(res5.body)
  check('改名后能搜到', data5.items.some((x) => x.title === '面板改过的标题'), JSON.stringify(data5.items.map((x) => x.title)))

  const res6 = fakeRes()
  await apiRoute.handler(fakeReq('/work-memory/api/archive', 'POST', { id: first.id }), res6)
  check('archive 成功', res6.status === 200 && JSON.parse(res6.body).ok === true, res6.body.slice(0, 120))

  const res7 = fakeRes()
  await apiRoute.handler(fakeReq('/work-memory/api/search?q=' + encodeURIComponent('面板改过的标题') + '&limit=3'), res7)
  const data7 = JSON.parse(res7.body)
  check('归档后默认搜不到', !data7.items.some((x) => x.id === first.id), JSON.stringify(data7.items.map((x) => x.id)))
} else {
  check('search 有结果（用于后续用例）', false, 'items 为空')
}

const res8 = fakeRes()
await apiRoute.handler(fakeReq('/work-memory/api/nope'), res8)
check('未知路径返回 404', res8.status === 404, 'status=' + res8.status)

console.log('\nPASS=' + pass + ' FAIL=' + fail)
rmSync(sandbox, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
