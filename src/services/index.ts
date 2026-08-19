import axios from './axios'
import fetchRequest from './fetch'

// R-01: 改指自建后端。开发模式走 vite proxy，生产模式需配环境变量。
export const SERVER_URL = import.meta.env.VITE_API_URL || '/api'

const TOKEN_KEY = 'rabbit_token'
const USER_KEY = 'rabbit_user'

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

/**
 * 缓存身份，刷新页面时先按上次的身份把界面渲染出来，再后台跟服务端核对。
 *
 * 没有它的话，启动必须等 /auth/me 回来才知道自己是谁 ——
 * 后端慢一点或者暂时连不上，用户看到的就是登录页。
 */
export const getCachedUser = <T>(): T | null => {
  const raw = localStorage.getItem(USER_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  }
  catch {
    localStorage.removeItem(USER_KEY)
    return null
  }
}
export const setCachedUser = (user: unknown) => localStorage.setItem(USER_KEY, JSON.stringify(user))
export const clearCachedUser = () => localStorage.removeItem(USER_KEY)

/** 请求是否因为登录态失效而失败（真 401），区别于网络错误 / 5xx */
export const isUnauthorized = (err: unknown): boolean =>
  (err as { response?: { status?: number } })?.response?.status === 401

// ---------------------------------------------------------------------------
// 带 JWT 的 axios 实例
// ---------------------------------------------------------------------------

const api = axios
api.interceptors.request.use(config => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

/**
 * 登录态失效时的统一出口。
 *
 * 用回调注册而不是直接 import store，避免 services ←→ store 循环依赖。
 */
let unauthorizedHandler: (() => void) | null = null
export const setUnauthorizedHandler = (fn: () => void) => { unauthorizedHandler = fn }

api.interceptors.response.use(
  res => res,
  (err) => {
    // 登录 / 注册接口的 401 是「密码错了」，不是登录态失效，别把人踢出去
    const url: string = err?.config?.url || ''
    const isAuthEntry = url.includes('/auth/login') || url.includes('/auth/register')
    if (isUnauthorized(err) && !isAuthEntry) unauthorizedHandler?.()
    return Promise.reject(err)
  },
)

// ---------------------------------------------------------------------------
// Auth（公开，不需要 JWT）
// ---------------------------------------------------------------------------

export const authApi = {
  register(username: string, password: string) {
    return axios.post(`${SERVER_URL}/auth/register`, { username, password })
  },
  login(username: string, password: string) {
    return axios.post(`${SERVER_URL}/auth/login`, { username, password })
  },
  me() {
    return api.get(`${SERVER_URL}/auth/me`)
  },
}

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

export const deckApi = {
  list() {
    return api.get(`${SERVER_URL}/decks`)
  },
  get(id: number) {
    return api.get(`${SERVER_URL}/decks/${id}`)
  },
  create(data: { title?: string, slidesJson?: string, themeJson?: string }) {
    return api.post(`${SERVER_URL}/decks`, data)
  },
  update(id: number, data: { title?: string, slidesJson?: string, themeJson?: string, version?: number }) {
    return api.put(`${SERVER_URL}/decks/${id}`, data)
  },
  delete(id: number) {
    return api.delete(`${SERVER_URL}/decks/${id}`)
  },
}

// ---------------------------------------------------------------------------
// User（普通用户）
// ---------------------------------------------------------------------------

export const userApi = {
  models() {
    return api.get(`${SERVER_URL}/user/models`)
  },
  preferences() {
    return api.get(`${SERVER_URL}/user/preferences`)
  },
  setPreference(role: string, modelConfigId: number) {
    return api.put(`${SERVER_URL}/user/preferences`, { role, modelConfigId })
  },
  changePassword(oldPassword: string, newPassword: string) {
    return api.put(`${SERVER_URL}/user/password`, { oldPassword, newPassword })
  },
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminApi = {
  // providers
  listProviders() {
    return api.get(`${SERVER_URL}/admin/providers`)
  },
  createProvider(data: { name: string, providerType: string, baseUrl: string, apiKey: string, remark?: string }) {
    return api.post(`${SERVER_URL}/admin/providers`, data)
  },
  updateProvider(id: number, data: { name: string, providerType: string, baseUrl: string, apiKey: string, remark?: string }) {
    return api.put(`${SERVER_URL}/admin/providers/${id}`, data)
  },
  deleteProvider(id: number) {
    return api.delete(`${SERVER_URL}/admin/providers/${id}`)
  },
  fetchModels(providerId: number) {
    return api.post(`${SERVER_URL}/admin/providers/${providerId}/fetch-models`)
  },

  // models
  listModels() {
    return api.get(`${SERVER_URL}/admin/models`)
  },
  createModel(data: { providerId: number, modelName: string, displayName: string, supportsImages?: boolean, enabled?: boolean }) {
    return api.post(`${SERVER_URL}/admin/models`, data)
  },
  updateModel(id: number, data: Record<string, unknown>) {
    return api.patch(`${SERVER_URL}/admin/models/${id}`, data)
  },
  deleteModel(id: number) {
    return api.delete(`${SERVER_URL}/admin/models/${id}`)
  },

  // role defaults
  listRoleDefaults() {
    return api.get(`${SERVER_URL}/admin/role-defaults`)
  },
  setRoleDefault(role: string, modelConfigId: number) {
    return api.put(`${SERVER_URL}/admin/role-defaults`, { role, modelConfigId })
  },

  // users
  listUsers() {
    return api.get(`${SERVER_URL}/admin/users`)
  },
  updateUserRole(id: number, role: 'admin' | 'user') {
    return api.patch(`${SERVER_URL}/admin/users/${id}`, { role })
  },
  deleteUser(id: number) {
    return api.delete(`${SERVER_URL}/admin/users/${id}`)
  },
  resetPassword(userId: number, newPassword: string) {
    return api.post(`${SERVER_URL}/admin/users/${userId}/reset-password`, { newPassword })
  },

  // 对象存储。**响应里永远没有 secretKey**，只有 hasSecretKey: boolean；
  // 提交时 secretKey 留空表示「不改动已存的那把」
  getStorage() {
    return api.get(`${SERVER_URL}/admin/storage`)
  },
  saveStorage(data: Record<string, unknown>) {
    return api.put(`${SERVER_URL}/admin/storage`, data)
  },
  testStorage() {
    return api.post(`${SERVER_URL}/admin/storage/test`)
  },

  // 素材来源（搜图 / 生图）
  getAssetSource() {
    return api.get(`${SERVER_URL}/admin/asset-source`)
  },
  saveAssetSource(data: Record<string, unknown>) {
    return api.put(`${SERVER_URL}/admin/asset-source`, data)
  },
  testAssetSource() {
    return api.post(`${SERVER_URL}/admin/asset-source/test`)
  },
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const conversationApi = {
  list(deckId?: number) {
    const params = deckId ? `?deckId=${deckId}` : ''
    return api.get(`${SERVER_URL}/conversations${params}`)
  },
  get(id: number) {
    return api.get(`${SERVER_URL}/conversations/${id}`)
  },
  delete(id: number) {
    return api.delete(`${SERVER_URL}/conversations/${id}`)
  },
  /** 打开演示文稿：一次拿到会话列表 + 最近活动那条的全部消息 */
  byDeck(deckId: number) {
    return api.get(`${SERVER_URL}/conversations/by-deck/${deckId}`)
  },
  /** 清空某份演示文稿的全部会话（agent 记忆一并归零） */
  clearDeck(deckId: number) {
    return api.delete(`${SERVER_URL}/conversations/by-deck/${deckId}`)
  },
  create(deckId: number, title?: string) {
    return api.post(`${SERVER_URL}/conversations`, { deckId, title })
  },
  rename(id: number, title: string) {
    return api.patch(`${SERVER_URL}/conversations/${id}`, { title })
  },
  /** 从某条消息分叉出新会话（复制该点之前的消息，deck 不动） */
  fork(id: number, fromMessageId?: number) {
    return api.post(`${SERVER_URL}/conversations/${id}/fork`, { fromMessageId })
  },
}

// ---------------------------------------------------------------------------
// 兼容旧代码
// getMockData 保留（模板列表等仍从 mocks/ 加载）。
// 旧 PPTist 端点保留签名但标记废弃，后续 R-09 将由 agent 通道替代。
// ---------------------------------------------------------------------------

export default {
  getMockData(filename: string): Promise<any> {
    return axios.get(`./mocks/${filename}.json`)
  },

  /** @deprecated R-09 后由 agent 通道替代 */
  searchImage(body: Record<string, unknown>): Promise<any> {
    return api.post(`${SERVER_URL}/tools/img_search`, body)
  },

  /** @deprecated R-09 后由 agent 通道替代 */
  AIPPT_Outline(body: Record<string, unknown>): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/aippt_outline`, {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
    })
  },

  /** @deprecated R-09 后由 agent 通道替代 */
  AIPPT(body: Record<string, unknown>): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/aippt`, {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
    })
  },

  /** @deprecated R-09 后由 agent 通道替代 */
  AI_Writing(body: Record<string, unknown>): Promise<any> {
    return fetchRequest(`${SERVER_URL}/tools/ai_writing`, {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
    })
  },
}
