import axios from './axios'
import fetchRequest from './fetch'

// R-01: 改指自建后端。开发模式走 vite proxy，生产模式需配环境变量。
export const SERVER_URL = import.meta.env.VITE_API_URL || '/api'

const TOKEN_KEY = 'rabbit_token'

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY)
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// ---------------------------------------------------------------------------
// 带 JWT 的 axios 实例
// ---------------------------------------------------------------------------

const api = axios
api.interceptors.request.use(config => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

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
