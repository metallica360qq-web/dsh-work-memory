/**
 * _llm.js — 所有离线批处理共用的模型调用入口。
 *
 * 之前 6 个 CLI 各自写死了 endpoint、key 路径和模型名，换 provider 要改 6 个文件。
 * 现在统一在这里，优先读环境变量，其次读 ~/.dsh/.credentials.yaml。
 *
 * 可用环境变量：
 *   DSH_WM_LLM_BASE_URL  默认 https://open.bigmodel.cn/api/coding/paas/v4/chat/completions
 *   DSH_WM_LLM_MODEL     默认 glm-5.3-flash
 *   DSH_WM_LLM_API_KEY   缺省时从 credentials.yaml 的 ZAI_CODING_CN_API_KEY 读
 *   DSH_WM_LLM_THINKING  'off' 时关闭思考（默认 off，省 token）
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
const DEFAULT_MODEL = 'glm-5.3-flash'

function readKeyFromCredentials() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [join(dshHome, '.credentials.yaml'), join(homedir(), '.dsh', '.credentials.yaml')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const yaml = readFileSync(file, 'utf8')
      const m = yaml.match(/ZAI_CODING_CN_API_KEY\s*:\s*["']?([^"'\r\n]+)/)
      if (m !== null && m[1].trim().length > 0) return m[1].trim()
    } catch {
      /* 读不到继续试下一个 */
    }
  }
  return ''
}

export function llmConfig() {
  const baseUrl = process.env.DSH_WM_LLM_BASE_URL || DEFAULT_BASE
  const model = process.env.DSH_WM_LLM_MODEL || DEFAULT_MODEL
  const key = process.env.DSH_WM_LLM_API_KEY || readKeyFromCredentials()
  if (key.length === 0) {
    throw new Error(
      '缺少模型 API key：设环境变量 DSH_WM_LLM_API_KEY，或在 ~/.dsh/.credentials.yaml 里配置 ZAI_CODING_CN_API_KEY',
    )
  }
  return { baseUrl, model, key, thinking: process.env.DSH_WM_LLM_THINKING !== 'on' }
}

/**
 * 调一次模型，返回 { content, usage }。
 * @param {string} prompt
 * @param {{maxTokens?:number, temperature?:number, model?:string}} [options]
 */
export async function callLlm(prompt, options = {}) {
  const cfg = llmConfig()
  const body = {
    model: options.model || cfg.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.2,
    max_tokens: Number(options.maxTokens) || 8192,
    stream: false,
  }
  if (cfg.thinking) body.thinking = { type: 'disabled' }
  const res = await fetch(cfg.baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 200))
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('响应不是 JSON：' + text.slice(0, 200))
  }
  if (json.error) throw new Error('api: ' + JSON.stringify(json.error).slice(0, 200))
  const content =
    json.choices && json.choices[0] && json.choices[0].message ? String(json.choices[0].message.content || '') : ''
  return { content, usage: json.usage || null }
}

/** 反复调直到成功（网络抖动），最多 attempts 次。 */
export async function callLlmWithRetry(prompt, options = {}, attempts = 2) {
  let lastError = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await callLlm(prompt, options)
    } catch (e) {
      lastError = e
      if (i < attempts) await new Promise((r) => setTimeout(r, 1200 * i))
    }
  }
  throw lastError
}
