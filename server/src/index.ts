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
import assetRoutes from '@server/routes/assets'
import { sweepStalePendingAssets } from '@server/domains/deck/assetTools'
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
authed.route('/assets', assetRoutes)
app.route('/api', authed)

app.get('/health', (c) => c.json({ ok: true }))

/**
 * 上一次进程死掉时留在库里的 `pending` 票据扫成 failed。
 *
 * 图片工具是同步等图的，所以进程一死任务也死了，没有「在飞的图」需要恢复 ——
 * 但那些 pending 行会永远挂着，让审计和状态查询读到一个假状态。
 * 不 await：清扫失败不该挡住服务起来。
 */
sweepStalePendingAssets()
  .then(n => n > 0 && console.log(`[assets] 清扫了 ${n} 条上次残留的 pending 票据`))
  .catch(err => console.warn('[assets] 清扫残留票据失败:', err))

const PORT = parseInt(process.env.PORT || '3000')

const server = Bun.serve<WsUserData>({
  port: PORT,
  /**
   * **`Bun.serve` 默认只给 10 秒**，超了它自己把请求掐掉，日志里只留一句
   * `request timed out after 10 seconds`，客户端看到的是一个没有响应体的失败。
   *
   * 这个默认值对本项目是致命的：
   *   - 图库搜索实测 5~9.5 秒（Wikimedia，跨境）
   *   - **生图实测 15~50 秒** —— 每一次都会被掐死
   *
   * 而且它失败得毫无线索：前端只会显示「请求失败」，看不出是被自家服务器掐的。
   * 实测就是这么发现的 —— 搜图测试在浏览器里失败、用 curl 却成功，
   * 差别只是那一次快了几秒。
   *
   * 255 是 Bun 允许的上限。
   */
  idleTimeout: 255,
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
