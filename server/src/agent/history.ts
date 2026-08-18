/**
 * 对话历史 → LLM 消息序列
 *
 * 纯函数，单独成文件是为了能被 vitest 直接 import
 * （orchestrator.ts 依赖 bun:sqlite，测试环境加载不了）。
 */

export type HistoryTurn = { role: 'user' | 'assistant', content: string }

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
}

/** 单条历史截断长度 —— Generator 的产出汇报可能很长，喂全了挤占上下文 */
export const HISTORY_CONTENT_LIMIT = 600

/**
 * 只留「用户说了什么」和「Generator / Editor 做了什么」。
 *
 * Planner 的计划和 Reviewer 的审查是一轮任务内部的中间过程，
 * 对下一轮没有参考价值，喂进去只是噪音还占上下文。
 * system 行（错误记录）同理丢弃。
 */
export const toHistoryTurns = (rows: StoredMessage[]): HistoryTurn[] => {
  const picked = rows
    .filter(m => m.role === 'user'
      || (m.role === 'assistant'
        && !m.content.startsWith('[Planner]')
        && !m.content.startsWith('[Reviewer]')))
    .map((m): HistoryTurn => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.length > HISTORY_CONTENT_LIMIT
        ? `${m.content.slice(0, HISTORY_CONTENT_LIMIT)}…（已截断）`
        : m.content,
    }))

  // Anthropic 等要求 user/assistant 严格交替、且首条必须是 user。
  // 一轮任务可能连着落下 Generator + Generator 修正两条 assistant，
  // 过滤掉 Planner 之后也可能出现开头就是 assistant 的情况。
  const merged: HistoryTurn[] = []
  for (const turn of picked) {
    const last = merged[merged.length - 1]
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`
    else merged.push({ ...turn })
  }
  while (merged.length && merged[0].role !== 'user') merged.shift()

  return merged
}
