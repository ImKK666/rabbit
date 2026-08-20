/**
 * 把思考回传给 OpenAI 兼容端点 —— 让「思考中调用工具」真的成立
 *
 * 纯函数 + 一个小状态对象，不 import `ai`、不碰库，能在 vitest 里裸跑。
 *
 * ## 要治的是什么
 *
 * DeepSeek 的思考模式**支持多轮思考与工具调用**：模型可以想一下 → 调工具 →
 * 拿到结果之后**接着刚才那段想** → 再调工具，直到给出最终答案。
 * 前提是每次请求都要把上一步的 `reasoning_content` 完整回传。
 * 官方文档的原话是：带了 `tools` 的请求，后续所有请求必须完整回传，
 * 否则 API 返回 400。
 *
 * 而 `@ai-sdk/openai-compatible` 的 assistant 转换分支只有两支：
 *
 * ```js
 * switch (part.type) {
 *   case "text":      { text += part.text; break }
 *   case "tool-call": { toolCalls.push(...); break }
 * }
 * ```
 *
 * **没有 `case "reasoning"`** —— 思考块在转成 wire 格式时被静默丢掉。
 * 实测（2026-08-20，截下四家 provider 真正发出去的请求体）：
 * anthropic 会带上，deepseek / openai / google 全都丢。
 *
 * 后果不是报错，是**模型每一步都在重新推导**。实测对照组第二步的思考
 * 是从工具结果重新算出来的，而不是接着第一步想的 —— 前一步的推理白费。
 *
 * ## 为什么补在 fetch 这一层
 *
 * 单轮内的多步消息是 **SDK 自己拼的**（`toResponseMessages` → `responseMessages`），
 * 我们的代码碰不到那个数组，所以在 `providerOptions` 上做手脚只能覆盖
 * 「我们自己从库里还原的那些消息」，覆盖不了单轮内的第 2、3、4 步 ——
 * 而那正是「思考中调用工具」的主场。
 *
 * fetch 是这条链路上**唯一一个能同时看到两种消息的地方**。
 *
 * ## 用 toolCallId 当键
 *
 * 每一步的思考和它那一步发出的工具调用是绑在一起的，而 `toolCallId`
 * 在请求体里原样保留（converter 有 `case "tool-call"`）。
 * 所以「这条 assistant 消息该配哪段思考」有一个稳定、无歧义的键。
 *
 * **已知覆盖不到的一处**：一轮的**最终回答**那条 assistant 消息没有工具调用，
 * 也就没有键，跨轮时它的思考带不回去。这是刻意接受的 ——
 * 最终回答的正文本身就是那段思考的结论，重复带回去价值最低，
 * 而为它另造一套按位置匹配的键会在历史被裁剪时错位。
 */

/** 请求体里一条 assistant 消息的形状（只列我们要碰的字段） */
interface WireMessage {
  role?: string
  reasoning_content?: string
  tool_calls?: { id?: string }[]
}

/** 我们自己构造的消息里，一条 assistant 的内容块（与 `turnMemory.ts` 同形） */
interface ReasoningLike { type: string, text?: string }
interface ToolCallLike { type: string, toolCallId?: string }
interface MessageLike { role: string, content: unknown }

/**
 * 哪些 provider 需要这层补丁。
 *
 * - `anthropic` **不在里面**：它的 converter 本来就会把思考转成
 *   `{type:'thinking', thinking, signature}` 带回去，再补一次是错的
 * - `google` 也不在：它的 wire 格式根本不是 OpenAI 那套（contents/parts），
 *   往里塞 `reasoning_content` 不会有任何作用。它要单独做，**没做**
 */
const OPENAI_WIRE_PROVIDERS = new Set(['deepseek', 'openai'])

export const needsReasoningRelay = (providerType: string): boolean =>
  OPENAI_WIRE_PROVIDERS.has(providerType)

/**
 * 从一条 assistant 消息里抽出「思考文本」和「它发起的工具调用 id」。
 *
 * 思考可能被拆成多块（流式来的），拼起来 —— 回传的是完整的一段，
 * 半段思考比没有更容易把模型带偏。
 */
const extractPairs = (message: MessageLike): { ids: string[], reasoning: string } | null => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return null
  const blocks = message.content as (ReasoningLike & ToolCallLike)[]

  const reasoning = blocks
    .filter(b => b.type === 'reasoning')
    .map(b => b.text ?? '')
    .join('')
  if (!reasoning) return null

  const ids = blocks
    .filter(b => b.type === 'tool-call')
    .map(b => b.toolCallId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return null

  return { ids, reasoning }
}

export interface ReasoningRelay {
  /**
   * 从一批消息里学。可以反复调 —— 单轮内每步学一次，
   * 跨轮时开头把还原出来的历史整个喂一遍。
   */
  learn: (messages: readonly MessageLike[]) => void
  /**
   * 改写将要发出去的请求体。**不认识的东西一律原样返回** ——
   * 这层补丁只该做加法，任何解析不了的情况都必须让请求照原样发出去，
   * 而不是让它失败。
   */
  patch: (body: string) => string
  /** 已经记住多少条。只给日志和判据用 */
  size: () => number
}

export const createReasoningRelay = (): ReasoningRelay => {
  /** toolCallId → 发起它的那一步的完整思考 */
  const byToolCallId = new Map<string, string>()

  return {
    learn(messages) {
      for (const m of messages) {
        const pair = extractPairs(m)
        if (!pair) continue
        for (const id of pair.ids) byToolCallId.set(id, pair.reasoning)
      }
    },

    patch(body) {
      if (byToolCallId.size === 0) return body

      let parsed: { messages?: WireMessage[] }
      try {
        parsed = JSON.parse(body)
      }
      catch {
        return body
      }
      if (!Array.isArray(parsed.messages)) return body

      let touched = false
      for (const m of parsed.messages) {
        if (m.role !== 'assistant') continue
        // 已经有了就不动 —— provider 自己带上的那份永远优先
        if (typeof m.reasoning_content === 'string' && m.reasoning_content !== '') continue
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue

        const hit = m.tool_calls
          .map(tc => (tc?.id ? byToolCallId.get(tc.id) : undefined))
          .find(r => r !== undefined)
        if (hit === undefined) continue

        m.reasoning_content = hit
        touched = true
      }

      return touched ? JSON.stringify(parsed) : body
    },

    size: () => byToolCallId.size,
  }
}

/**
 * 把 relay 接到 provider 的 `fetch` 上。
 *
 * 失败时**原样放行**：这层是「让模型想得更连贯」的增强，
 * 不该有能力把一次请求搞挂。补丁抛异常时宁可退回没打补丁的请求体。
 */
export const relayFetch = (
  relay: ReasoningRelay,
  base: typeof fetch = fetch,
): typeof fetch =>
  ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!init || typeof init.body !== 'string') return base(input, init)
    let body = init.body
    try {
      body = relay.patch(init.body)
    }
    catch (err) {
      console.error('[relay] 回传思考失败（已忽略，请求照原样发出）:', err)
      return base(input, init)
    }
    return base(input, { ...init, body })
  }) as typeof fetch
