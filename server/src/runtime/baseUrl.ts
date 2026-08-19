/**
 * Provider baseURL 规范化
 *
 * 各家 SDK 往 baseURL 后面拼的路径不同，管理员按直觉填往往就 404：
 *   openai    → 拼 `/chat/completions`，所以 baseURL 必须已经到 `/v1` 这一层
 *   anthropic → 拼 `/v1/messages`，所以 baseURL **不能**自己带 `/v1`
 *   google    → 拼 `/models/xxx`，需要 `/v1beta` 这一层
 *
 * 只做能确定无害的修正：去尾斜杠、去掉误填的端点后缀、补明显缺失的版本段。
 * 路径已经有内容的（如智谱的 `/api/paas/v4`）一律不动 ——
 * 宁可不修，也不能把本来能用的配置改坏。
 *
 * 单独成文件是为了能被 vitest 直接 import：llm.ts 依赖 bun:sqlite，测试环境加载不了。
 */
export const normalizeBaseUrl = (providerType: string, raw: string): string => {
  let url = raw.trim().replace(/\/+$/, '')
  if (!url) return url

  // 把完整端点整个填进来是最常见的一种填法
  url = url
    .replace(/\/(chat\/)?completions$/, '')
    .replace(/\/messages$/, '')
    .replace(/\/+$/, '')

  let path: string
  try {
    path = new URL(url).pathname.replace(/\/+$/, '')
  }
  catch {
    return url // 不是合法 URL 就原样返回，让 SDK 自己报错
  }

  switch (providerType) {
    case 'openai':
      // 只在路径为空时补 /v1；已有路径的不碰
      return path === '' ? `${url}/v1` : url
    case 'anthropic':
      // SDK 自己会拼 /v1/messages，用户再填一层 /v1 就成了 /v1/v1/messages
      return path === '/v1' ? url.slice(0, -3) : url
    case 'google':
      return path === '' ? `${url}/v1beta` : url
    default:
      return url
  }
}
