import { Database } from 'bun:sqlite'
import { streamText } from 'ai'
import { createDeepSeek } from '@ai-sdk/deepseek'

const db = new Database('data/rabbit.db', { readonly: true })
const p = db.query('SELECT base_url, api_key FROM model_providers WHERE id=1').get() as any
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a)

log('构造 model')
const model = createDeepSeek({ baseURL: p.base_url, apiKey: p.api_key })('deepseek-v4-flash')

log('调用 streamText')
let r = 0, t = 0
const stream = streamText({
  model,
  messages: [{ role: 'user', content: '1+1=?' }],
  maxTokens: 40,
  abortSignal: AbortSignal.timeout(60000),
  onChunk: ({ chunk }) => {
    if (chunk.type === 'reasoning') { if (r === 0) log('首个 reasoning chunk'); r += chunk.textDelta.length }
    if (chunk.type === 'text-delta') { if (t === 0) log('首个 text chunk'); t += chunk.textDelta.length }
  },
  onFinish: () => log('onFinish 触发'),
  onError: (e) => log('onError', String(e).slice(0, 200)),
})

log('await stream.text ...')
try {
  const text = await stream.text
  log('拿到 text:', JSON.stringify(text.slice(0, 40)))
}
catch (e) { log('await 抛错:', String(e).slice(0, 200)) }
log(`reasoning ${r} 字 · text ${t} 字`)
process.exit(0)
