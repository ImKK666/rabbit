/**
 * R-68 · 待发送图片的响应式状态机
 *
 * 这里守的是一个**在浏览器里才会现形、类型检查和普通单测都抓不到**的坑：
 *
 *   `pendingImages.value.push(obj)` 存进去的是**原始对象**，
 *   从数组读出来的才是响应式代理。持着原始引用改 `state`，
 *   值确实变了（两者共享同一个 target），但**一个依赖都不会被触发**。
 *
 * 后果是 `uploadingCount` 永远停在 1：转圈不停、发送按钮永远禁用、
 * 图永远进不了 `readyImages` —— 表现就是「上传成功了但发不出去」。
 * R-68 实测栽过一次，所以这条必须有判据。
 *
 * 这个文件只测响应式行为本身，用和 AgentPanel 一样的数据形状。
 */

import { describe, it, expect } from 'vitest'
import { ref, computed, nextTick } from 'vue'

interface PendingImage {
  id: string
  preview: string
  state: 'uploading' | 'done' | 'failed'
  src?: string
  error?: string
}

const setup = () => {
  const pendingImages = ref<PendingImage[]>([])
  const uploadingCount = computed(() =>
    pendingImages.value.filter(i => i.state === 'uploading').length)
  const readyImages = computed(() =>
    pendingImages.value.filter(i => i.state === 'done' && i.src))

  const add = (id: string) => {
    pendingImages.value.push({ id, preview: `blob:${id}`, state: 'uploading' })
  }
  /** 生产代码的写法：按 id 找回代理再改 */
  const finish = (id: string, src: string) => {
    const img = pendingImages.value.find(i => i.id === id)
    if (!img) return
    img.src = src
    img.state = 'done'
  }

  return { pendingImages, uploadingCount, readyImages, add, finish }
}

describe('上传完成要能被 computed 看见', () => {
  it('按 id 找回代理再改 —— 计数与就绪列表都跟着走', async () => {
    const { uploadingCount, readyImages, add, finish } = setup()

    add('a')
    expect(uploadingCount.value).toBe(1)
    expect(readyImages.value).toHaveLength(0)

    finish('a', 'asset://x')
    await nextTick()

    expect(uploadingCount.value).toBe(0)
    expect(readyImages.value).toHaveLength(1)
  })

  /**
   * 负对照：**持原始引用改**。这条固定住那个坏行为 ——
   * 它红了说明有人把生产代码改回了原始引用写法。
   */
  it('持原始引用改，computed 看不见（这正是 R-68 的 bug）', () => {
    const pendingImages = ref<PendingImage[]>([])
    const uploadingCount = computed(() =>
      pendingImages.value.filter(i => i.state === 'uploading').length)

    const raw: PendingImage = { id: 'a', preview: 'blob:a', state: 'uploading' }
    pendingImages.value.push(raw)
    expect(uploadingCount.value).toBe(1)

    raw.state = 'done'

    // 值变了，但依赖没被触发 —— 计数停在 1，发送按钮就此永远禁用
    expect(pendingImages.value[0].state).toBe('done')
    expect(uploadingCount.value).toBe(1)
  })

  it('多张图各自完成，计数逐张递减', async () => {
    const { uploadingCount, readyImages, add, finish } = setup()

    add('a'); add('b'); add('c')
    expect(uploadingCount.value).toBe(3)

    finish('a', 'asset://a')
    await nextTick()
    expect(uploadingCount.value).toBe(2)

    finish('b', 'asset://b')
    finish('c', 'asset://c')
    await nextTick()
    expect(uploadingCount.value).toBe(0)
    expect(readyImages.value.map(i => i.src)).toEqual(['asset://a', 'asset://b', 'asset://c'])
  })

  // await 期间用户可能已经把它删掉了，回来时不能凭空把它加回去
  it('上传途中被删掉的图，完成时不复活', async () => {
    const { pendingImages, readyImages, add, finish } = setup()

    add('a')
    pendingImages.value.splice(0, 1)
    finish('a', 'asset://x')
    await nextTick()

    expect(pendingImages.value).toHaveLength(0)
    expect(readyImages.value).toHaveLength(0)
  })

  it('没有 src 的不算就绪 —— 空 src 发出去等于丢图', () => {
    const { pendingImages, readyImages } = setup()
    pendingImages.value.push({ id: 'a', preview: 'blob:a', state: 'done' })
    expect(readyImages.value).toHaveLength(0)
  })
})
