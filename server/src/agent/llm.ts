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
import type { LanguageModel } from 'ai'
import { db } from '@server/db'
import {
  modelProviders,
  modelConfigs,
  roleDefaults,
  userRolePreferences,
  type AgentRole,
} from '@server/db/schema'
import { normalizeBaseUrl } from './baseUrl'

export const resolveModelForRole = async (
  role: AgentRole,
  userId: number,
): Promise<LanguageModel> => {
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

  const model = createModel(provider.providerType, baseUrl, provider.apiKey, config.modelName)
  return Object.assign(model, {
    /** 出错时拼进异常信息，省得只看到一句 "Not Found" 无从下手 */
    __rabbitDescribe: `provider="${provider.name}" type=${provider.providerType} model="${config.modelName}" baseUrl="${baseUrl}"`,
  })
}

const createModel = (
  providerType: string,
  baseUrl: string,
  apiKey: string,
  modelName: string,
): LanguageModel => {
  switch (providerType) {
    case 'openai': {
      const provider = createOpenAI({ baseURL: baseUrl, apiKey })
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
