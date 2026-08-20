/**
 * 面板不许对「这句话到底发出去没有」撒谎
 *
 * 对应 docs/13-queue-reflect-ingest.md §一② 和 §二 的 Q1/Q4。
 *
 * 这是一个**现存 bug 的复现脚本**，不只是新功能的判据：
 * `submitTask` 在**发出请求那一刻**就把用户那句 push 进日志了，
 * 而工作区忙的时候后端只回一条泛泛的 error —— 那句话就留在面板上，
 * 看起来像是被受理了。而且那条路径**不还画布所有权**。
 *
 * 配对规则是 FIFO（不是按文本），因为同一句话可以连发两次。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from '@/store/agent'
import { useSlidesStore } from '@/store/slides'
import type { ServerMessage } from '@/services/websocket'

vi.mock('@/services/websocket', () => ({
  send: vi.fn(),
  onMessage: vi.fn(),
}))

const feed = (store: ReturnType<typeof useAgentStore>, ...msgs: ServerMessage[]) => {
  for (const m of msgs) store.handleMessage(m)
}

const userEntries = (store: ReturnType<typeof useAgentStore>) =>
  store.log.filter((e): e is Extract<typeof e, { type: 'text' }> =>
    e.type === 'text' && e.role === 'user')

const queued = (deckId = 1, position = 1): ServerMessage =>
  ({ type: 'agent.input', deckId, state: 'queued', position })
const started = (deckId = 1): ServerMessage =>
  ({ type: 'agent.input', deckId, state: 'started' })
const rejected = (deckId = 1, reason = '排队已满'): ServerMessage =>
  ({ type: 'agent.input', deckId, state: 'rejected', reason })

describe('输入去向标记', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('刚发出去的那条是 pending —— 还不知道去向', () => {
    const store = useAgentStore()
    store.submitTask(1, '加一个矩形')
    expect(userEntries(store)[0].delivery).toEqual({ state: 'pending' })
  })

  it('收到 started 就摘掉标记 —— 它已经在跑了', () => {
    const store = useAgentStore()
    store.submitTask(1, '加一个矩形')
    feed(store, started())
    expect(userEntries(store)[0].delivery).toBeUndefined()
  })

  it('收到 queued 标成排队中，带位置', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.submitTask(1, '第二句')
    feed(store, queued(1, 2))

    expect(userEntries(store)[1].delivery).toEqual({ state: 'queued', position: 2 })
    expect(store.statusMessage).toBe('已排队，前面还有 1 条')
  })

  it('**这是那个 bug**：被拒的那句必须标成未送达，不能留在面板上像是被受理了', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.submitTask(1, '被拒的那句')
    feed(store, rejected(1, '排队已满（最多 3 条）'))

    expect(userEntries(store)[1].delivery).toEqual({
      state: 'rejected',
      reason: '排队已满（最多 3 条）',
    })
  })

  it('排队的那条后来开跑了，标记要摘掉', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.submitTask(1, '第二句')
    feed(store, queued(1, 1))
    expect(userEntries(store)[1].delivery).toMatchObject({ state: 'queued' })

    // 第一轮跑完，第二句接力
    feed(store, { type: 'agent.status', status: 'done', message: '任务完成' }, started())
    expect(userEntries(store)[1].delivery).toBeUndefined()
  })
})

describe('FIFO 配对 —— 同一句话连发两次也要配对', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('两条一模一样的输入，回执按顺序落在各自那条上', () => {
    // 按文本配对在这里会配错：两条内容完全一样，
    // 而 WebSocket 保序，按顺序配天然是对的
    const store = useAgentStore()
    store.submitTask(1, '继续')
    feed(store, started())
    store.submitTask(1, '继续')
    feed(store, queued(1, 1))
    store.submitTask(1, '继续')
    feed(store, queued(1, 2))

    const entries = userEntries(store)
    expect(entries.map(e => e.delivery?.state)).toEqual([undefined, 'queued', 'queued'])
    expect((entries[1].delivery as { position: number }).position).toBe(1)
    expect((entries[2].delivery as { position: number }).position).toBe(2)
  })

  it('已经确认过的条目不会被后来的回执再动一次', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.submitTask(1, '第二句')
    feed(store, rejected())

    // 第一条已经 started（delivery 摘掉了），不该被这条 rejected 改写
    expect(userEntries(store)[0].delivery).toBeUndefined()
    expect(userEntries(store)[1].delivery).toMatchObject({ state: 'rejected' })
  })

  it('没有待确认的条目时收到回执，什么都不做，不抛错', () => {
    const store = useAgentStore()
    feed(store, started(), queued(), rejected())
    expect(store.log).toEqual([])
  })
})

describe('被拒之后要收手 —— 画布不能锁着没人解', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('没有别的任务在跑时，被拒 → 状态回 idle 且画布所有权还给用户', () => {
    // submitTask 在**发出请求那一刻**就把所有权交给 agent 了。
    // 队列满可能是另一个标签页占着这份 deck —— 那时我们收不到任何
    // agent.status，不主动还的话画布会永远锁着，且用鼠标解不开
    const store = useAgentStore()
    const slides = useSlidesStore()
    store.submitTask(1, '被拒的那句')
    expect(slides.deckOwner).toBe('agent')

    feed(store, rejected())
    expect(store.status).toBe('idle')
    expect(store.statusMessage).toBe('')
    expect(slides.deckOwner).toBe('user')
  })

  it('**但有任务在跑时不许收手** —— 那会把正在跑的那轮的状态一起抹掉', () => {
    const store = useAgentStore()
    const slides = useSlidesStore()
    store.submitTask(1, '第一句')
    feed(store, started(), { type: 'agent.status', status: 'thinking', message: '正在思考...' })
    store.submitTask(1, '被拒的那句')
    feed(store, rejected())

    expect(store.status).toBe('thinking')
    expect(slides.deckOwner).toBe('agent')
  })

  it('还有排队的时候也不许收手', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.submitTask(1, '排着的')
    feed(store, queued(1, 1))
    store.submitTask(1, '被拒的')
    feed(store, rejected())

    // 前面那条还排着，任务终究会跑到它 —— 此刻收手就是提前熄灯
    expect(store.status).not.toBe('idle')
  })

  it('任务跑完之后计数减回去，下一次被拒才收得了手', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started(), { type: 'agent.status', status: 'done', message: '任务完成' })

    store.submitTask(1, '被拒的')
    feed(store, rejected())
    expect(store.status).toBe('idle')
  })

  it('reset 之后计数归零 —— 否则下一份文稿会带着一笔减不回 0 的账', () => {
    const store = useAgentStore()
    store.submitTask(1, '第一句')
    feed(store, started())
    store.reset()
    expect(store.runningTasks).toBe(0)
  })
})
