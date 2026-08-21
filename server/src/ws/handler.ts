import type { ServerWebSocket } from 'bun'
import { verifyToken, type JwtPayload } from '@server/auth/jwt'
import { runAgentTask, cancelAgentTask, releaseWsResources, settleRenderResult } from '@server/agent/orchestrator'

export interface WsUserData {
  userId: number
  username: string
  role: 'admin' | 'user'
}

export type ClientMessage =
  | {
    type: 'agent.task'
    deckId: number
    prompt: string
    selectedElementIds?: string[]
    /** 续哪条会话；不传则新开一条（记忆从零开始） */
    conversationId?: number
  }
  /**
   * 取消任务。**必须带 deckId** —— 活动任务按工作区（`deck:<id>`）登记，
   * 一个用户可以同时在多份演示文稿上跑任务，所以取消要点名取消哪一个。
   */
  | { type: 'agent.cancel', deckId: number }
  | { type: 'agent.confirm', value: boolean }
  /**
   * 渲染后反思的回答（前端 → 后端）。
   *
   * `requestId` 必须原样带回来 —— 后端按它找回是哪一次在等
   * （`runtime/pendingRequests.ts`）。对不上的一律丢掉：
   * 超时之后才回来的那条如果被接受，agent 会拿到一份属于上一次测量的数据，
   * 而那份数据看起来完全正常。
   */
  | {
    type: 'agent.render.result'
    requestId: string
    measurements: { slideId: string, elementId: string, actualHeight: number }[]
    /** 截图，`data:image/png;base64,...`。只有请求里要了才有 */
    shots?: { slideId: string, dataUrl: string }[]
    /**
     * 每块文字实际的颜色 + 它底下（**去掉文字层之后**）实际的颜色。
     * 只有请求里要了才有。判定在 `domains/deck/renderContrast.ts`
     */
    contrast?: {
      slideId: string, elementId: string, textColor: string,
      backdrop: [string, string], sampled: number,
    }[]
    /** 前端这边出错了（渲染失败 / 页面找不到），后端据此回一句「没量到」而不是干等 */
    error?: string
  }

export type ServerMessage =
  | { type: 'agent.status', status: 'thinking' | 'tool_call' | 'done' | 'error', message?: string }
  | { type: 'agent.tool', tool: string, args: Record<string, unknown>, result?: string }
  | { type: 'agent.text', role: string, content: string }
  /**
   * 模型的思考过程，**逐段流式推送**。
   * 只有开了 reasoning 的模型会产出；没有就一条都不发，前端也就不显示思考块。
   */
  | { type: 'agent.reasoning', role: string, delta: string }
  /** 这一步的思考结束了 —— 前端据此把思考块收起来，腾地方给接下来的工具调用 */
  | { type: 'agent.reasoning.done', role: string }
  /** 告诉前端本次任务落在哪条会话上（新建时前端据此挂进列表） */
  | { type: 'agent.conversation', id: number, title: string }
  | { type: 'agent.ask', question: string }
  /**
   * 这一句用户输入的去向。**三种状态一条消息**，不是三种消息。
   *
   * 有它之前，busy 时后端回的是一条 `{type:'error'}`，而前端在**发出请求时**
   * 就已经把用户那句 push 进日志了 —— 于是那句话留在面板上，
   * 看起来像是被受理了，后面跟一条红字。这条消息就是为了让面板不再撒谎。
   *
   * | state | 什么时候发 | 面板该显示 |
   * |---|---|---|
   * | `queued` | 工作区忙，排进队列 | 「排队中（前面还有 N 条）」 |
   * | `started` | 轮到它了，开始跑 | 摘掉排队标记 |
   * | `rejected` | 队列已满，没收下 | 「未送达」+ 原因 |
   *
   * **不带 prompt 做匹配**：同一句话可以连发两次（「继续」「继续」），
   * 按文本配对会配错。三种状态都按 FIFO 作用在「最早那条未确认的」上，
   * 而 WebSocket 保序，所以顺序天然对得上。
   */
  | {
    type: 'agent.input'
    deckId: number
    state: 'queued' | 'started' | 'rejected'
    /** `queued` 时排在第几位，1 表示下一个就是它 */
    position?: number
    /** `rejected` 时的原因 */
    reason?: string
  }
  /**
   * 要前端量一次真实渲染（后端 → 前端）。
   *
   * 这是**唯一一条后端会挂起等回答的下行消息**。理由和判据见
   * `runtime/pendingRequests.ts` 与 docs/13 §三：
   * `estimateTextHeight` 是估的，而估小了下一个元素就会被压上来 ——
   * 现有的几何检查一条都看不见这件事（框永远在画布内、重叠比的是声明的框）。
   *
   * `wantShots` 为真时还要截图，交给视觉复核那个**独立配置的**模型看。
   * 没配视觉模型时这一位一定是 false，前端也就不用白截一次图。
   *
   * `wantBackdrop` 为真时还要采「每块文字底下实际是什么颜色」。
   * 它比截图便宜（不出 base64，只回几十个色值），但要多渲一份不含文字层的同一页 ——
   * 判定在 `domains/deck/renderContrast.ts`，判据见 docs/14 的 O6。
   */
  | {
    type: 'agent.render.request'
    requestId: string
    /** 要量哪几页。空表示全部 */
    slideIds: string[]
    wantShots: boolean
    wantBackdrop?: boolean
  }
  | { type: 'agent.deck', slidesJson: string, version: number }
  /**
   * 图片资产的进度叙事。**这三条不改 deck** ——
   * 工具是同步等图的，图拿到之后由 agent 自己调 `addElement` 写进去，
   * 所以权威状态仍然只经 `agent.deck` 一条路（见 `domains/deck/assetTools.ts`）。
   *
   * 它们存在只为填上生图那 14~15 秒的沉默：那段时间里 `agent.tool` 还没发
   * （`onStepFinish` 在工具**返回之后**才触发），面板上什么都没有，看起来像卡死了。
   *
   * 字段和 R-32 当初设计的不一样：原来是 `{elementId, taskId}`，
   * 假设的是「先建元素占位、后台回填」。同步形状下发消息时元素**还不存在**，
   * 所以改成按票据走。
   */
  | { type: 'agent.asset.pending', ticket: string, kind: 'search' | 'generate', prompt: string }
  | { type: 'agent.asset.ready', ticket: string, src: string, width: number, height: number }
  /** 没有这条的话，面板上那个「生成中」会一直转下去 —— 用户看到的是「卡死了」 */
  | { type: 'agent.asset.failed', ticket: string, reason: string }
  | { type: 'error', message: string }

export const authenticateWs = async (url: URL): Promise<JwtPayload | null> => {
  const token = url.searchParams.get('token')
  if (!token) return null
  try {
    return await verifyToken(token)
  }
  catch {
    return null
  }
}

export const handleWsMessage = async (
  ws: ServerWebSocket<WsUserData>,
  raw: string,
) => {
  try {
    const msg: ClientMessage = JSON.parse(raw)

    switch (msg.type) {
      case 'agent.task':
        /**
         * **故意不 await**：任务要跑几分钟，等它结束就没法处理这条连接上的
         * 其它消息了（首先就是 `agent.cancel` —— 取消按钮会彻底失灵）。
         *
         * 但不 await 就必须自己接住 rejection。少了这个 `.catch`，
         * 任务里任何逃出来的异常都是**未捕获的 Promise 拒绝**，
         * Bun 会直接把整个后端进程杀掉 —— 所有用户的所有任务一起死。
         * 实测撞到过：任务跑着时演示文稿被删，`pipeline` 的 catch 分支里
         * 那句落库撞了外键约束，进程当场退出（exit code 1）。
         *
         * 剧本内部已经把收尾动作都包了（`pipeline.ts` 的 `settle`），
         * 这里是**最后一道**：只要还有一条没想到的路径，它兜住。
         */
        runAgentTask(ws, msg.deckId, msg.prompt, msg.selectedElementIds, msg.conversationId)
          .catch((err) => {
            console.error('[ws] agent 任务异常退出:', err)
            ws.send(JSON.stringify({
              type: 'agent.status',
              status: 'error',
              message: err instanceof Error ? err.message : '任务异常退出',
            } satisfies ServerMessage))
          })
        break

      case 'agent.cancel': {
        // 取消 = 全停：在跑的那一轮 + 排着的全部。
        // 被丢掉的排队条数要说出来 —— 用户发过的话静默消失是不可接受的
        const { cancelled, dropped } = cancelAgentTask(msg.deckId)
        const suffix = dropped > 0 ? `，另有 ${dropped} 条排队输入已丢弃` : ''
        ws.send(JSON.stringify({
          type: 'agent.status',
          status: cancelled ? 'error' : 'done',
          message: cancelled
            ? `任务已取消${suffix}`
            : (dropped > 0 ? `没有正在执行的任务${suffix}` : '没有正在执行的任务'),
        } satisfies ServerMessage))
        break
      }

      case 'agent.confirm':
        // TODO: 用户确认 agent 提问。**等待机制本身已经有了**
        // （`runtime/pendingRequests.ts`，渲染后反思用的就是它），
        // 缺的只是把提问也接上去 —— 见 docs/13 §三
        break

      case 'agent.render.result': {
        // 交给在等它的那次测量。对不上就只打一行日志 ——
        // 超时之后才回来的那条如果被接受，agent 会拿到一份属于上一次测量的数据，
        // 而那份数据看起来完全正常
        const accepted = settleRenderResult(msg.requestId, {
          measurements: msg.measurements,
          shots: msg.shots,
          contrast: msg.contrast,
          error: msg.error,
        })
        if (!accepted) {
          console.log(`[ws] 渲染测量结果 ${msg.requestId} 没有对应的等待者（多半是已经超时了），丢弃`)
        }
        break
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: '未知消息类型' } satisfies ServerMessage))
    }
  }
  catch {
    ws.send(JSON.stringify({ type: 'error', message: '消息格式错误' } satisfies ServerMessage))
  }
}

/**
 * 连接关掉时的清理。
 *
 * 在这条路之前 `websocket.close` 只打一行日志，排队项会一直留着 ——
 * 而它持有的 ws 已经没了，跑出来没有任何人看得到，却还占着工作区
 * 把后面排着的挡住。**正在跑的任务刻意不取消**，理由见
 * `orchestrator.releaseWsResources` 的注释。
 */
export const handleWsClose = (ws: ServerWebSocket<WsUserData>) => {
  const dropped = releaseWsResources(ws)
  if (dropped > 0) {
    console.log(`[ws] ${ws.data.username} 断开，丢弃 ${dropped} 条排队输入`)
  }
}
