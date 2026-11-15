/**
 * 自测：新钩子的主题归属是否跟随面板上选定的「当前方向」。
 *
 *   node cli/test-pin-topic.mjs
 *
 * 覆盖：有 pin（带细类）→ 直接用 pin；pin 过期 → 回到自动判定；清除 pin → 回到自动判定。
 * 用临时目录，不碰真实账本。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wm-pin-topic-'))
process.env.DSH_WORK_MEMORY_DIR = dir
// 临时主题表：让「自动判定」这条路也有东西可判
writeFileSync(join(dir, 'topics.json'), JSON.stringify({
  topics: [
    { id: 'g05', name: 'DSH插件', desc: '', keywords: ['dsh', '插件'], members: ['i20'] },
    { id: 'g09', name: '命理', desc: '', keywords: ['八字', '命理'], members: ['i34'] },
  ],
  fine: [
    { id: 'i20', name: 'DSH 会话视图插件开发', desc: '', group: 'g05' },
    { id: 'i34', name: '八字命理 skill', desc: '', group: 'g09' },
  ],
}, null, 2) + '\n', 'utf8')

const { topicForNewHook } = await import('../lib/index.js')

// 1. 没有 pin：走关键词判定
let result = topicForNewHook('帮我做一个 dsh 插件')
assert.equal(result.topic, 'g05', '关键词应该判到 g05')
assert.equal(result.topicFine, undefined, '自动判定只给宽类')

// 2. 有 pin（带细类）：直接用 pin，覆盖关键词判定
writeFileSync(join(dir, 'pins.json'), JSON.stringify({
  pin: { topic: 'g09', fine: 'i34', label: '八字命理 skill', createdAt: new Date().toISOString(), ttlHours: 8 },
}) + '\n', 'utf8')
result = topicForNewHook('帮我做一个 dsh 插件')
assert.equal(result.topic, 'g09', 'pin 优先')
assert.equal(result.topicFine, 'i34', '细类也跟 pin')

// 3. pin 过期：回到自动判定
writeFileSync(join(dir, 'pins.json'), JSON.stringify({
  pin: { topic: 'g09', fine: 'i34', label: '旧方向', createdAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(), ttlHours: 8 },
}) + '\n', 'utf8')
result = topicForNewHook('帮我做一个 dsh 插件')
assert.equal(result.topic, 'g05', '过期后不再跟 pin')

// 4. 清除 pin：回到自动判定
writeFileSync(join(dir, 'pins.json'), JSON.stringify({ pin: null }) + '\n', 'utf8')
result = topicForNewHook('帮我做一个 dsh 插件')
assert.equal(result.topic, 'g05')

// 5. 只选了宽类（没细类）：写入只带宽类
writeFileSync(join(dir, 'pins.json'), JSON.stringify({
  pin: { topic: 'g05', fine: '', label: 'DSH插件', createdAt: new Date().toISOString(), ttlHours: 8 },
}) + '\n', 'utf8')
result = topicForNewHook('帮我看看八字命理')
assert.equal(result.topic, 'g05', '只选宽类时也跟 pin')
assert.equal(result.topicFine, undefined)

rmSync(dir, { recursive: true, force: true })
console.log('test-pin-topic: 写入跟随方向（含细类 / 仅宽类 / 过期 / 清除）全部通过')
