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

/** 会话标题取首条用户输入的前 N 字 */
export const TITLE_LIMIT = 20

/**
 * 工具调用参数的存储上限。
 * addSlide 带整页 JSON 是常态（2~4KB），给足余量以免常见调用被截断。
 */
export const TOOL_ARGS_LIMIT = 8192
/** 工具返回值上限 —— 多数是 {ok,version}，只有 getSlide / getDeck 会大 */
export const TOOL_RESULT_LIMIT = 4096

export const makeConversationTitle = (prompt: string): string => {
  const cleaned = prompt.trim().replace(/\s+/g, ' ')
  if (!cleaned) return '新会话'
  return cleaned.length > TITLE_LIMIT ? `${cleaned.slice(0, TITLE_LIMIT)}…` : cleaned
}

export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
  result?: string
}

/**
 * 工具调用 → messages 表的一行（role='tool'）。
 *
 * 参数超限时整体换成 __truncated 标记而不是切成半截 JSON ——
 * 面板是按对象渲染的，留个残缺 JSON 只会显示成乱码。
 */
export const serializeToolCall = (record: ToolCallRecord): string => {
  const argsJson = JSON.stringify(record.args ?? {})
  const args = argsJson.length <= TOOL_ARGS_LIMIT
    ? record.args
    : { __truncated: `${argsJson.slice(0, TOOL_ARGS_LIMIT)}…（参数过长，已截断）` }

  const result = record.result && record.result.length > TOOL_RESULT_LIMIT
    ? `${record.result.slice(0, TOOL_RESULT_LIMIT)}…（结果过长，已截断）`
    : record.result

  return JSON.stringify({ tool: record.tool, args, result })
}

/** messages 里 role='tool' 的一行 → 工具调用记录；解析失败返回 null，不让脏数据炸掉整个面板 */
export const parseToolCall = (content: string): ToolCallRecord | null => {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed.tool !== 'string') return null
    return {
      tool: parsed.tool,
      args: (parsed.args && typeof parsed.args === 'object') ? parsed.args : {},
      result: typeof parsed.result === 'string' ? parsed.result : undefined,
    }
  }
  catch {
    return null
  }
}

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
