import { defineStore } from 'pinia'
import {
  authApi,
  setToken, clearToken, getToken,
  getCachedUser, setCachedUser, clearCachedUser,
  isUnauthorized, setUnauthorizedHandler,
} from '@/services'
import { connect, disconnect } from '@/services/websocket'

export interface AuthUser {
  id: number
  username: string
  role: 'admin' | 'user'
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
  /** 后台核对中：身份先按缓存显示，还没跟服务端确认过 */
  verifying: boolean
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    // 乐观恢复：token 和身份都从 localStorage 直接拿，
    // 刷新页面立刻就是已登录状态，不用等 /auth/me
    token: getToken(),
    user: getCachedUser<AuthUser>(),
    verifying: false,
  }),

  getters: {
    isLoggedIn(state) {
      return !!state.token && !!state.user
    },
    isAdmin(state) {
      return state.user?.role === 'admin'
    },
  },

  actions: {
    /** 任何请求撞上 401 都统一走登出，不用各处自己判断 */
    installUnauthorizedHandler() {
      setUnauthorizedHandler(() => {
        if (this.token) this.logout()
      })
    },

    applySession(token: string, user: AuthUser) {
      this.token = token
      this.user = user
      setToken(token)
      setCachedUser(user)
      connect()
    },

    async login(username: string, password: string) {
      const res = await authApi.login(username, password) as any
      this.applySession(res.token, res.user)
    },

    async register(username: string, password: string) {
      const res = await authApi.register(username, password) as any
      this.applySession(res.token, res.user)
    },

    logout() {
      this.token = null
      this.user = null
      clearToken()
      clearCachedUser()
      disconnect()
    },

    /**
     * 跟服务端核对登录态，并接收滑动续期换发的新 token。
     *
     * 只有**真 401** 才算登录失效。网络错误、后端还没起来、5xx 一律保留登录态 ——
     * 原来是 catch 到任何异常就 logout()，开发时 vite 比后端先起来，
     * 刷新一次就被清掉 token 踢回登录页，这正是「登录不持久」的来源。
     */
    async fetchMe() {
      if (!this.token) return

      this.verifying = true
      try {
        const res = await authApi.me() as any
        this.user = res.user
        setCachedUser(res.user)
        // 服务端在 token 过半时会换发新的，收到就换掉
        if (res.token) {
          this.token = res.token
          setToken(res.token)
        }
        connect()
      }
      catch (err) {
        if (isUnauthorized(err)) {
          this.logout()
          return
        }
        // 连不上服务端：身份沿用缓存，WebSocket 自己会退避重连
        console.warn('[auth] 校验登录态失败，暂时沿用本地身份', err)
        connect()
      }
      finally {
        this.verifying = false
      }
    },
  },
})
