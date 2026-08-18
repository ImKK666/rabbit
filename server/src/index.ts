import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { jwt } from 'hono/jwt'
import { logger } from 'hono/logger'

import { getJwtSecret } from '@server/auth/jwt'
import authRoutes from '@server/routes/auth'
import adminRoutes from '@server/routes/admin'
import deckRoutes from '@server/routes/deck'
import userRoutes from '@server/routes/user'
import conversationRoutes from '@server/routes/conversation'
import { authenticateWs, handleWsMessage, type WsUserData } from '@server/ws/handler'

const app = new Hono()

app.use('*', logger())
app.use('*', cors())

// 公开路由（不需要认证）
app.route('/api/auth', authRoutes)

// 需要认证的路由
const authed = new Hono()
authed.use('*', jwt({ secret: getJwtSecret(), alg: 'HS256' }))
authed.route('/admin', adminRoutes)
authed.route('/decks', deckRoutes)
authed.route('/user', userRoutes)
authed.route('/conversations', conversationRoutes)
app.route('/api', authed)

app.get('/health', (c) => c.json({ ok: true }))

const PORT = parseInt(process.env.PORT || '3000')

const server = Bun.serve<WsUserData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
      const payload = await authenticateWs(url)
      if (!payload) return new Response('Unauthorized', { status: 401 })

      const upgraded = server.upgrade(req, {
        data: {
          userId: payload.userId,
          username: payload.username,
          role: payload.role,
        },
      })
      if (upgraded) return undefined as unknown as Response
      return new Response('WebSocket upgrade failed', { status: 500 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws) {
      console.log(`[ws] connected: ${ws.data.username}`)
    },
    message(ws, raw) {
      handleWsMessage(ws, typeof raw === 'string' ? raw : Buffer.from(raw).toString())
    },
    close(ws) {
      console.log(`[ws] disconnected: ${ws.data.username}`)
    },
  },
})

console.log(`🐇 Rabbit server running on http://localhost:${server.port}`)
