/**
 * R-38 · 让模型的思考过程真的流出来（纯函数，无依赖）
 *
 * ## 背景
 *
 * R-37 把编排器换成了 `streamText` + `onChunk`，前端也有了思考块 ——
 * 但实测下来一条 reasoning 都没有。原因不在那条链上，在**模型那一端根本没开**，
 * 或者**开了但被 SDK 丢了**。三家的情况各不相同：
 *
 * | provider | 思考在哪 | 我们要做什么 |
 * |---|---|---|
 * | deepseek | SSE delta 的 `reasoning_content` 字段 | 用 `@ai-sdk/deepseek`，它认这个字段 |
 * | google   | 默认思考但不回传 | `thinkingConfig.includeThoughts = true` |
 * | openai   | o 系列只在 Responses API 给摘要 | 不动；但兼容端点常用 `<think>` 标签，挂中间件兜住 |
 * | anthropic| 需要显式开 extended thinking | **默认不开**，见下 |
 *
 * ## 为什么 openai 类型接不住 DeepSeek
 *
 * DeepSeek 的官方端点是 OpenAI 兼容的，所以自然会被配成 `providerType: 'openai'`。
 * 但 `@ai-sdk/openai` 用 zod schema 解析 SSE，`reasoning_content` 不在 schema 里，
 * **在到达任何中间件之前就被剥掉了**。实测 deepseek-v4-flash / -pro 的 delta 确实
 * 带 `reasoning_content` 且不带 `<think>` 标签 —— 所以只能换 provider，
 * 靠中间件救不回来。
 *
 * ## 为什么 anthropic 默认不开
 *
 * extended thinking 一旦开启就**改变 API 约束**（temperature 被锁、必须给
 * budgetTokens、老模型直接报错），还会改变计费。给一个没人配过的 provider
 * 默认打开这些，属于替用户做主。需要时用环境变量：
 *
 *   AGENT_ANTHROPIC_THINKING_BUDGET=4096
 */

/**
 * providerOptions 最终要塞进 SDK 的 `LanguageModelV1ProviderMetadata`，
 * 那边要求值必须是纯 JSON。这里自己写一份等价的类型，
 * 是为了这个模块不依赖 `ai` 包 —— 它得能在 vitest 里裸跑。
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ReasoningProviderOptions = Record<string, Record<string, JsonValue>>

/** 这些 provider 类型的思考内容混在正文里，靠 `<think>` 标签分隔 */
const TAG_BASED_PROVIDERS = new Set(['openai'])

/** `extractReasoningMiddleware` 要找的标签名 */
export const REASONING_TAG = 'think'

/**
 * 该不该给这个 provider 挂 `<think>` 提取中间件。
 *
 * 纯客户端的文本解析，不改任何请求参数 —— 模型不吐这个标签就什么都不会发生，
 * 所以对所有 OpenAI 兼容端点一律挂上是安全的。
 */
export const needsReasoningTagExtraction = (providerType: string): boolean =>
  TAG_BASED_PROVIDERS.has(providerType)

/**
 * 传给 `streamText` 的 providerOptions —— 用来**请求**模型回传思考。
 *
 * 键名是 SDK 约定的 provider 标识，传错了会被忽略而不是报错，
 * 所以这里只为当前 provider 生成对应的那一份，不做无谓的广播。
 */
export const reasoningProviderOptions = (
  providerType: string,
  env: Record<string, string | undefined> = process.env,
): ReasoningProviderOptions => {
  switch (providerType) {
    case 'google':
      // Gemini 2.5+ 默认就会思考，但不带回思考内容，includeThoughts 才会附上
      return { google: { thinkingConfig: { includeThoughts: true } } }

    case 'anthropic': {
      const budget = Number(env.AGENT_ANTHROPIC_THINKING_BUDGET)
      if (!Number.isFinite(budget) || budget < 1024) return {}
      // 1024 是 Anthropic 侧 budgetTokens 的下限，低于它请求直接被拒
      return { anthropic: { thinking: { type: 'enabled', budgetTokens: Math.floor(budget) } } }
    }

    // deepseek 不需要任何参数，provider 认得 reasoning_content 就够了
    default:
      return {}
  }
}
