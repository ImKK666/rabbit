import { Database } from 'bun:sqlite'
import { streamText } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'

const db = new Database('data/rabbit.db', { readonly: true })
const p = db.query('SELECT base_url, api_key FROM model_providers WHERE id=1').get() as any

for (const [label, make] of [
  ['@ai-sdk/openai（现状）', () => createOpenAI({ baseURL: p.base_url, apiKey: p.api_key })('deepseek-v4-flash')],
  ['@ai-sdk/deepseek（改后）', () => createDeepSeek({ baseURL: p.base_url, apiKey: p.api_key })('deepseek-v4-flash')],
] as const) {
  let reasoningChars = 0, textChars = 0, chunks = 0
  const stream = streamText({
    model: make(),
    messages: [{ role: 'user', content: '3 个苹果分给 2 个人，怎么分最公平？一句话。' }],
    maxTokens: 120,
    onChunk: ({ chunk }) => {
      chunks++
      if (chunk.type === 'reasoning') reasoningChars += chunk.textDelta.length
      if (chunk.type === 'text-delta') textChars += chunk.textDelta.length
    },
  })
  await stream.text
  console.log(`${label}\n   reasoning ${reasoningChars} 字 · text ${textChars} 字 · chunk ${chunks} 个`)
}
