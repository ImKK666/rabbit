import { defineStore } from 'pinia'
import { authApi, setToken, clearToken, getToken } from '@/services'
import { connect, disconnect } from '@/services/websocket'

export interface AuthUser {
  id: number
  username: string
  role: 'admin' | 'user'
}

export interface AuthState {
  token: string | null
  user: AuthUser | null
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    token: getToken(),
    user: null,
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
    async login(username: string, password: string) {
      const res = await authApi.login(username, password) as any
      this.token = res.token
      this.user = res.user
      setToken(res.token)
      connect()
    },

    async register(username: string, password: string) {
      const res = await authApi.register(username, password) as any
      this.token = res.token
      this.user = res.user
      setToken(res.token)
      connect()
    },

    logout() {
      this.token = null
      this.user = null
      clearToken()
      disconnect()
    },

    async fetchMe() {
      if (!this.token) return
      try {
        const res = await authApi.me() as any
        this.user = res.user
        connect()
      }
      catch {
        this.logout()
      }
    },
  },
})
