/**
 * origin.js — 每条记忆「是谁产生的」。
 *
 * 来由（2026-11-15）：跨 agent 导入时把源系统的来源字段丢了，于是 hermes 的 cron
 * 投递模板、zcode 的子代理任务书，到了账本这一层全都变成了「用户提的需求」。
 * 实测：zcode 328 条里 292 条是子会话（t11 命理App安卓化 115 条全是），
 * hermes 199 条样板全部 source=cron。
 *
 * 约定：origin 是一个字符串，形如 `<源>:<源的分类>`：
 *   dsh:user                     DSH 里 source.kind === 'user' 的消息（自动捕获已经过滤过）
 *   zcode:interactive            人开的会话
 *   zcode:subagent_child         编排器派给子代理的会话（不是人提的）
 *   zcode:workflow_child         工作流子会话
 *   zcode:selection_side_chat    划词侧边对话
 *   hermes:cron / hermes:subagent / hermes:desktop / hermes:tui / hermes:cli / hermes:acp
 *   workbuddy:title              只有标题的导入
 *
 * 没有 origin 的老记录：DSH 的按人算（捕获层本来就过滤了 source.kind），
 * 其它源的按「不确定」处理——沿用当前行为（当人看），等 backfill-origin 补上。
 */

/** 明确属于「人」的来源分类。 */
const HUMAN = new Set([
  'dsh:user',
  'zcode:interactive',
  'hermes:desktop',
  'hermes:tui',
  'hermes:cli',
  'hermes:acp',
  'hermes:app',
  'hermes:web',
  'workbuddy:title',
  'workbuddy:session',
])

/** 分类的中文说明，给工具输出和界面用。 */
const LABELS = {
  'dsh:user': 'DSH 对话',
  'zcode:interactive': 'ZCode 人开的会话',
  'zcode:subagent_child': 'ZCode 子代理任务',
  'zcode:workflow_child': 'ZCode 工作流子会话',
  'zcode:selection_side_chat': 'ZCode 划词侧聊',
  'hermes:cron': 'Hermes 定时任务',
  'hermes:subagent': 'Hermes 子代理',
  'hermes:desktop': 'Hermes 桌面',
  'hermes:tui': 'Hermes 终端',
  'hermes:cli': 'Hermes 命令行',
  'hermes:acp': 'Hermes ACP',
  'workbuddy:title': 'WorkBuddy 标题',
}

/**
 * 一条记录的产生来源（缺失时按既有行为推断）。
 * @param {object} row 账本行。
 * @returns {string} origin 字符串。
 */
export function originOf(row) {
  if (typeof row.origin === 'string' && row.origin.length > 0) return row.origin
  const agent = String(row.agent || 'dsh')
  if (agent === 'dsh') return 'dsh:user'
  if (agent === 'workbuddy') return 'workbuddy:title'
  // 老的外来记录：cron 的照旧算自动化，其余沿用「当人看」
  if (row.kind === 'cron') return agent + ':cron'
  return agent + ':unknown'
}

/**
 * 这条记录是不是「用户提的需求」（而不是代理自己产生的任务/样板）。
 * 未知来源（老数据、没见过的新分类）按人算，避免把真实历史藏起来。
 * @param {object} row 账本行。
 * @returns {boolean} true 表示算人类需求。
 */
export function isHumanRow(row) {
  const origin = originOf(row)
  if (HUMAN.has(origin)) return true
  if (origin.endsWith(':unknown')) return true
  return false
}

/**
 * 来源的中文标签。
 * @param {object} row 账本行。
 * @returns {string} 如「ZCode 子代理任务」。
 */
export function originLabel(row) {
  const origin = originOf(row)
  return LABELS[origin] || origin
}

/**
 * 按来源归类统计。
 * @param {object[]} rows 账本行。
 * @returns {Record<string, {total: number, human: boolean, label: string}>} 每个 origin 的条数与说明。
 */
export function originBreakdown(rows) {
  const out = {}
  for (const row of rows) {
    const origin = originOf(row)
    if (out[origin] === undefined) out[origin] = { total: 0, human: HUMAN.has(origin), label: LABELS[origin] || origin }
    out[origin].total += 1
  }
  return out
}
