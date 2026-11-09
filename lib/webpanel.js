/**
 * webpanel.js — 工作记忆的 Web 面板（单文件 HTML + JSON API）。
 *
 * 挂载点：GET /work-memory/ 返回页面；/work-memory/api/* 提供检索、展开、改名、归档。
 * 不引入前端框架：一个 HTML 字符串 + fetch，够用。
 */
import { loadHooks, searchHooks, getHook, supersede } from './store.js'
import { renderRange } from './sessionlog.js'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>工作记忆</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#252a34;--fg:#e6e8ec;--dim:#8b93a1;--acc:#4f8cff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}
h1{font-size:16px;margin:0;font-weight:600}
input{flex:1;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:#12151b;color:var(--fg);outline:none}
input:focus{border-color:var(--acc)}
button{padding:9px 14px;border-radius:8px;border:1px solid var(--line);background:#1b1f27;color:var(--fg);cursor:pointer}
button:hover{border-color:var(--acc)}
main{padding:16px 20px;max-width:1000px}
.meta{color:var(--dim);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.card h3{margin:0 0 6px;font-size:14px;font-weight:600}
.ask{color:var(--dim);font-size:13px;margin:4px 0 8px;white-space:pre-wrap}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;background:#222834;color:var(--dim);font-size:11px;margin-right:6px}
pre{white-space:pre-wrap;background:#12151b;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:420px;overflow:auto;font-size:12.5px;margin:8px 0 0}
.hidden{display:none}
.row{display:flex;gap:8px;align-items:center;margin-top:8px}
.badge{font-size:11px;color:var(--dim)}
</style></head>
<body>
<header>
  <h1>工作记忆</h1>
  <input id="q" placeholder="搜任务、文件名、关键词（例：MACD 过滤 / 005 分屏 / 传舍读音）" autofocus>
  <button id="go">搜索</button>
</header>
<main>
  <div id="stat" class="meta"></div>
  <div id="list"></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
async function api(path, opts) {
  const r = await fetch('/work-memory/api/' + path, opts)
  return r.json()
}
async function run() {
  const q = $('q').value.trim()
  const data = await api('search?q=' + encodeURIComponent(q) + '&limit=20')
  $('stat').textContent = '账本 ' + data.total + ' 条 / 命中 ' + data.items.length + ' 条' + (q ? '' : '（空查询显示最近条目）')
  $('list').innerHTML = data.items.map((it) => \`
    <div class="card" data-id="\${esc(it.id)}">
      <h3>\${esc(it.title)}</h3>
      <div class="ask">\${esc(it.ask)}</div>
      <div><span class="tag">\${esc(it.agent)}</span><span class="tag">\${esc(it.level)}</span>
        <span class="meta">\${esc((it.ts || '').slice(0, 10))} · seq \${it.startSeq}-\${it.endSeq} · score \${it.score}</span></div>
      \${it.artifacts && it.artifacts.length ? '<div class="meta">产物：' + it.artifacts.map(esc).join(' · ') + '</div>' : ''}
      <div class="row">
        <button class="open">展开原文</button>
        <button class="edit">改标题</button>
        <button class="hide-btn">归档</button>
      </div>
      <pre class="detail hidden"></pre>
    </div>\`).join('')
  bind()
}
function bind() {
  document.querySelectorAll('.card').forEach((card) => {
    const id = card.dataset.id
    card.querySelector('.open').onclick = async () => {
      const pre = card.querySelector('.detail')
      if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return }
      pre.textContent = '加载中…'; pre.classList.remove('hidden')
      const d = await api('open?id=' + encodeURIComponent(id))
      pre.textContent = d.text || d.error || '(空)'
    }
    card.querySelector('.edit').onclick = async () => {
      const v = prompt('新标题：', card.querySelector('h3').textContent)
      if (!v) return
      const d = await api('update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title: v }) })
      if (d.ok) run(); else alert(d.error || '失败')
    }
    card.querySelector('.hide-btn').onclick = async () => {
      if (!confirm('归档这条？（不删除，检索默认不再出现）')) return
      const d = await api('archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      if (d.ok) run(); else alert(d.error || '失败')
    }
  })
}
$('go').onclick = run
$('q').onkeydown = (e) => { if (e.key === 'Enter') run() }
run()
</script>
</body></html>`

export function registerWebPanel(ctx, webServer) {
  const routes = []
  routes.push(
    webServer.register({
      kind: 'exact',
      path: '/work-memory/',
      handler: async (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(PAGE)
      },
    }),
  )

  const apiHandler = async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const path = url.pathname.replace('/work-memory/api/', '')
        try {
          if (path === 'search') {
            const q = url.searchParams.get('q') || ''
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100)
            const items = searchHooks(q, limit)
            return json(res, 200, { total: loadHooks().length, items })
          }
          if (path === 'open') {
            const id = url.searchParams.get('id') || ''
            const hook = getHook(id)
            if (hook === null) return json(res, 404, { error: '没有这个钩子' })
            const maxChars = Math.min(Math.max(Number(url.searchParams.get('maxChars')) || 4000, 500), 20000)
            const range = renderRange(hook.session, hook.startSeq, hook.endSeq, '', maxChars)
            return json(res, 200, { id, title: hook.title, session: hook.session, text: range.text, file: range.file })
          }
          if (path === 'update' && req.method === 'POST') {
            const body = await readBody(req)
            const id = String(body.id || '')
            const title = String(body.title || '').trim()
            if (!id || !title) return json(res, 400, { error: 'id/title 必填' })
            const hook = getHook(id)
            if (hook === null) return json(res, 404, { error: '没有这个钩子' })
            const { updateHook } = await import('./store.js')
            updateHook(id, { title: title.slice(0, 120) })
            return json(res, 200, { ok: true })
          }
          if (path === 'archive' && req.method === 'POST') {
            const body = await readBody(req)
            const id = String(body.id || '')
            if (!id) return json(res, 400, { error: 'id 必填' })
            const { updateHook } = await import('./store.js')
            updateHook(id, { status: 'archived' })
            return json(res, 200, { ok: true })
          }
          return json(res, 404, { error: 'unknown path ' + path })
        } catch (e) {
          return json(res, 500, { error: String(e && e.message ? e.message : e) })
        }
  }
  // webServer 只支持 exact 路由，按子路径逐个注册
  for (const sub of ['search', 'open', 'update', 'archive']) {
    routes.push(webServer.register({ kind: 'exact', path: '/work-memory/api/' + sub, handler: apiHandler }))
  }
  return routes
}
