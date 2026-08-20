/**
 * 面板日志里该留什么、不该留什么
 *
 * 「Agent 正在思考...」是**进度**，不是**记录**。跑的时候由底部那条
 * 带动画的进度条显示，跑完还留在日志里就是噪声 —— 一条「正在思考」
 * 挂在已经写完的回答上面，只会让人以为它还在转。
 *
 * 这条规则很容易在改 handleMessage 时被顺手改回去（「所有消息都记一条」
 * 看起来更规整），所以钉在这里。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from '@/store/agent'
import type { ServerMessage } from '@/services/websocket'

const feed = (store: ReturnType<typeof useAgentStore>, ...msgs: ServerMessage[]) => {
  for (const m of msgs) store.handleMessage(m)
}

const statusEntries = (store: ReturnType<typeof useAgentStore>) =>
  store.log.filter(e => e.type === 'status') as { status: string, message: string }[]

describe('实时状态：只有终止态进日志', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('thinking 不进日志 —— 它由底部的进度条负责显示', () => {
    const store = useAgentStore()
    feed(store, { type: 'agent.status', status: 'thinking', message: 'Agent 正在思考...' })
    expect(statusEntries(store)).toEqual([])
  })

  it('但 statusMessage 要更新 —— 进度条读的就是它', () => {
    const store = useAgentStore()
    feed(store, { type: 'agent.status', status: 'thinking', message: 'Agent 正在思考...' })
    expect(store.statusMessage).toBe('Agent 正在思考...')
    expect(store.isRunning).toBe(true)
  })

  it('done 进日志 —— 它是这一轮的收尾记号', () => {
    const store = useAgentStore()
    feed(store, { type: 'agent.status', status: 'done', message: '任务完成' })
    expect(statusEntries(store)).toEqual([{ type: 'status', status: 'done', message: '任务完成' }])
  })

  it('error 必须进日志 —— 那是失败记录，丢了就查不出出过什么事', () => {
    const store = useAgentStore()
    feed(store, { type: 'agent.status', status: 'error', message: '模型调用失败' })
    expect(statusEntries(store)[0]).toMatchObject({ status: 'error', message: '模型调用失败' })
  })

  it('一整轮下来，日志里只剩用户输入、思考、工具、回答和一条完成', () => {
    const store = useAgentStore()
    feed(store,
      { type: 'agent.status', status: 'thinking', message: 'Agent 正在思考...' },
      { type: 'agent.reasoning', role: 'deck', delta: '先查规范' },
      { type: 'agent.reasoning.done', role: 'deck' },
      { type: 'agent.tool', tool: 'getDeck', args: {} },
      { type: 'agent.status', status: 'thinking', message: 'Agent 正在思考...' },
      { type: 'agent.text', role: 'deck', content: '已添加。' },
      { type: 'agent.status', status: 'done', message: '任务完成' },
    )
    expect(store.log.map(e => e.type)).toEqual(['reasoning', 'tool', 'text', 'status'])
  })
})
