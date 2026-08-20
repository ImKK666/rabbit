/**
 * LLM Provider 工厂
 *
 * 从 DB 读取管理员配置的 provider 和用户偏好，构建 Vercel AI SDK 的 model 实例。
 * 优先级：用户偏好 > 管理员设的角色默认 > 报错
 */

import { eq, and } from 'drizzle-orm'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { wrapLanguageModel, extractReasoningMiddleware, type LanguageModel } from 'ai'
import { db } from '@server/db'
import {
  modelProviders,
  modelConfigs,
  roleDefaults,
  userRolePreferences,
  type AgentRole,
} from '@server/db/schema'
import { normalizeBaseUrl } from './baseUrl'
import { needsReasoningRelay, relayFetch, type ReasoningRelay } from './reasoningRelay'
import {
  REASONING_TAG,
  needsReasoningTagExtraction,
  reasoningProviderOptions,
  type ReasoningProviderOptions,
} from './reasoning'

/** 模型 + 「怎么让它把思考带回来」的参数，两者由 providerType 一起决定 */
export interface ResolvedModel {
  model: LanguageModel
  providerOptions: ReasoningProviderOptions
  /**
   * 本次用的模型配置 id。
   *
   * 带出来只为一件事：**Anthropic 的 thinking signature 绑在生成它的 API key 上**。
   * 落库时记下是哪个配置产的，读回来时对不上就把思考块剥掉，
   * 否则管理员换一次 provider 或 key，下一次请求就会因为一个失效的 signature 直接 400。
   * 判据与负对照见 `runtime/__tests__/turnMemory.test.ts` 的「判据 3」一组。
   */
  configId: number
}

export const resolveModelForRole = async (
  role: AgentRole,
  userId: number,
  /**
   * 思考回传器。给了的话，OpenAI wire 格式的 provider（deepseek / openai）
   * 会挂一层 fetch，把被 converter 丢掉的 `reasoning_content` 补回请求体 ——
   * 那是「思考中调用工具」在这些 provider 上能不能成立的唯一一环，
   * 见 `reasoningRelay.ts` 的头注释。
   *
   * **不给也能跑**，只是模型每一步都得重新推导。
   */
  relay?: ReasoningRelay,
): Promise<ResolvedModel> => {
  const pref = await db.select()
    .from(userRolePreferences)
    .where(and(
      eq(userRolePreferences.userId, userId),
      eq(userRolePreferences.role, role),
    ))
    .get()

  let configId: number | undefined = pref?.modelConfigId

  if (!configId) {
    const def = await db.select()
      .from(roleDefaults)
      .where(eq(roleDefaults.role, role))
      .get()
    configId = def?.modelConfigId
  }

  if (!configId) {
    throw new Error(`角色 "${role}" 没有配置模型，请管理员先在后台设置`)
  }

  const config = await db.select()
    .from(modelConfigs)
    .where(and(eq(modelConfigs.id, configId), eq(modelConfigs.enabled, true)))
    .get()

  if (!config) {
    throw new Error(`模型配置 #${configId} 不存在或已禁用`)
  }

  const provider = await db.select()
    .from(modelProviders)
    .where(eq(modelProviders.id, config.providerId))
    .get()

  if (!provider) {
    throw new Error(`模型提供商 #${config.providerId} 不存在`)
  }

  const baseUrl = normalizeBaseUrl(provider.providerType, provider.baseUrl)
  if (baseUrl !== provider.baseUrl) {
    console.log(`[llm] baseUrl 规范化: "${provider.baseUrl}" → "${baseUrl}"`)
  }
  console.log(`[llm] ${role} → provider="${provider.name}" type=${provider.providerType} model="${config.modelName}" baseUrl="${baseUrl}"`)

  // 只给需要的那几家挂 —— anthropic 的 converter 本来就带思考，
  // 再补一次是错的；google 的 wire 格式根本不是这套
  const patchedFetch = relay && needsReasoningRelay(provider.providerType)
    ? relayFetch(relay)
    : undefined
  if (patchedFetch) console.log(`[llm] ${provider.providerType} 挂上思考回传`)

  const base = createModel(provider.providerType, baseUrl, provider.apiKey, config.modelName, patchedFetch)

  // `<think>` 提取是纯文本解析，不改请求参数 —— 模型不吐这个标签就什么都不会发生
  const model = needsReasoningTagExtraction(provider.providerType)
    ? wrapLanguageModel({ model: base, middleware: extractReasoningMiddleware({ tagName: REASONING_TAG }) })
    : base

  return {
    model: Object.assign(model, {
      /** 出错时拼进异常信息，省得只看到一句 "Not Found" 无从下手 */
      __rabbitDescribe: `provider="${provider.name}" type=${provider.providerType} model="${config.modelName}" baseUrl="${baseUrl}"`,
    }),
    providerOptions: reasoningProviderOptions(provider.providerType),
    configId: config.id,
  }
}

const createModel = (
  providerType: string,
  baseUrl: string,
  apiKey: string,
  modelName: string,
  patchedFetch?: typeof fetch,
): LanguageModel => {
  switch (providerType) {
    case 'openai': {
      const provider = createOpenAI({ baseURL: baseUrl, apiKey, fetch: patchedFetch })
      return provider(modelName)
    }
    // DeepSeek 的端点是 OpenAI 兼容的，配成 'openai' 也能跑 —— 但思考会丢：
    // reasoning_content 不在 @ai-sdk/openai 的 SSE schema 里，解析时直接被剥掉。
    // 这个 provider 认得它，想看思考过程就必须选这一项
    case 'deepseek': {
      const provider = createDeepSeek({ baseURL: baseUrl, apiKey, fetch: patchedFetch })
      return provider(modelName)
    }
    case 'anthropic': {
      const provider = createAnthropic({ baseURL: baseUrl, apiKey })
      return provider(modelName)
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({ baseURL: baseUrl, apiKey })
      return provider(modelName)
    }
    default:
      throw new Error(`不支持的模型提供商类型: ${providerType}`)
  }
}
