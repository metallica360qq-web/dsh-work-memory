/**
 * Host 半的离线自检：不启 DSH，直接调 lib/index.js 注册的两条路由。
 *
 * 用法：node scripts/host-test.mjs
 * 做法：用假 ctx 抓 webServer.register 的 handler，喂假 req/res，读真实账本验证
 * 整形结果；再用一个空目录验证「账本不存在」的降级路径。只读，不改账本。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const routes = new Map()
const ctx = {
  get(name) {
    if (name !== 'webServer') return undefined
    return {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    }
  },
  effect(fn) {
    fn()
    return () => {}
  },
}

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'session-view-plugin')
assert.deepEqual(mod.inject, ['webServer'])
mod.apply(ctx)

assert.ok(routes.has('/session-view/api/memory/snapshot'), '注册了账本快照路由')
assert.ok(routes.has('/session-view/api/memory/hook'), '注册了单条钩子路由')

/** 造一个最小的 Node 响应对象，收集写出的 JSON。 */
function fakeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(text) {
      res.body = text
    },
  }
  return res
}

// ── 1. 真实账本 ─────────────────────────────────────────────────────────────
const res = fakeRes()
await routes.get('/session-view/api/memory/snapshot')({ url: '/session-view/api/memory/snapshot' }, res)
assert.equal(res.status, 200)
assert.match(res.headers['content-type'], /application\/json/)
const snapshot = JSON.parse(res.body)
assert.equal(snapshot.ok, true)
assert.ok(snapshot.source.file.endsWith('hooks.jsonl'), '来源是 hooks.jsonl')
assert.ok(Array.isArray(snapshot.hooks) && snapshot.hooks.length >= 500, '账本至少 500 条')
const fineTable = Array.isArray(snapshot.fine) ? snapshot.fine : []
assert.ok(fineTable.length >= 10, '细类表要有 i01… 这一层，实际 ' + fineTable.length)
assert.ok(fineTable.every((item) => typeof item.group === 'string' && item.group !== ''), '每条细类都要挂到宽类上')
assert.ok(snapshot.hooks.some((hook) => typeof hook.topicFine === 'string' && hook.topicFine !== ''), '账本行要带 topicFine')
assert.ok(snapshot.topics.length >= 10, '主题定义读到了')
assert.ok(snapshot.hooks.every((hook) => typeof hook.id === 'string' && typeof hook.session === 'string'))
assert.ok(snapshot.hooks.every((hook) => Array.isArray(hook.artifacts)), '每条钩子的产物都是数组')
assert.ok(snapshot.hooks.every((hook) => hook.ask.length <= 120), '列表里提问截到 120 字')
assert.ok(snapshot.hooks.some((hook) => hook.topic !== ''), '有打标的钩子')
assert.ok(snapshot.hooks.some((hook) => hook.agent === 'hermes' || hook.agent === 'zcode'), '跨来源钩子也在')
const sample = snapshot.hooks.find((hook) => hook.artifacts.length > 0)
assert.ok(sample !== undefined, '存在带产物的钩子')

console.log('host-test: 快照', snapshot.hooks.length, '条 /', snapshot.topics.length, '个主题 /', Math.round(Buffer.byteLength(res.body) / 1024), 'KB')

// ── 2. 单条钩子（完整提问） ─────────────────────────────────────────────────
const detailRes = fakeRes()
await routes.get('/session-view/api/memory/hook')({ url: '/session-view/api/memory/hook?id=' + encodeURIComponent(sample.id) }, detailRes)
assert.equal(detailRes.status, 200)
const detail = JSON.parse(detailRes.body)
assert.equal(detail.ok, true)
assert.equal(detail.hook.id, sample.id)
assert.ok(detail.hook.ask.length >= sample.ask.length, '完整提问不比预览短')
assert.deepEqual(detail.hook.artifacts, sample.artifacts, '产物一致')

const missingRes = fakeRes()
await routes.get('/session-view/api/memory/hook')({ url: '/session-view/api/memory/hook?id=nope' }, missingRes)
assert.equal(missingRes.status, 404)
assert.equal(JSON.parse(missingRes.body).ok, false)

const noIdRes = fakeRes()
await routes.get('/session-view/api/memory/hook')({ url: '/session-view/api/memory/hook' }, noIdRes)
assert.equal(noIdRes.status, 400)

// ── 3. 账本不存在时的降级 ───────────────────────────────────────────────────
const emptyDir = mkdtempSync(path.join(tmpdir(), 'svp-empty-'))
const previous = process.env.DSH_WORK_MEMORY_DIR
process.env.DSH_WORK_MEMORY_DIR = emptyDir
try {
  const emptyRes = fakeRes()
  await routes.get('/session-view/api/memory/snapshot')({ url: '/session-view/api/memory/snapshot' }, emptyRes)
  assert.equal(emptyRes.status, 200)
  const empty = JSON.parse(emptyRes.body)
  assert.equal(empty.ok, true)
  assert.equal(empty.source.missing, true, '缺文件时把 missing 标出来')
  assert.deepEqual(empty.hooks, [])
  assert.deepEqual(empty.topics, [])
} finally {
  if (previous === undefined) delete process.env.DSH_WORK_MEMORY_DIR
  else process.env.DSH_WORK_MEMORY_DIR = previous
  rmSync(emptyDir, { recursive: true, force: true })
}

console.log('host-test: 全部通过')
