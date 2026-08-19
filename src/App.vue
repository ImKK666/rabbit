<template>
  <!-- 未登录 -->
  <Auth v-if="!authStore.isLoggedIn" @success="onAuthSuccess" />

  <!-- 设置页 -->
  <Settings v-else-if="showSettings" @back="showSettings = false" />

  <!-- 已登录但未选 deck -->
  <DeckList
    v-else-if="!currentDeckId"
    @select="openDeck"
    @openSettings="showSettings = true"
  />

  <!-- 编辑器 -->
  <template v-else-if="slides.length">
    <Screen v-if="screening" />
    <Editor v-else-if="_isPC" @backToList="closeDeck" @openSettings="showSettings = true" @saveDeck="saveDeck" />
    <Mobile v-else />
  </template>

  <!-- 只在真的还在拉数据时转圈。「加载完了但 0 页」由 repairEmptyDeck 兜底补页 -->
  <FullscreenSpin tip="加载中..." v-else-if="deckLoading" loading :mask="false" />
</template>

<script lang="ts" setup>
import { ref, provide, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { nanoid } from 'nanoid'
import { useScreenStore, useMainStore, useSnapshotStore, useSlidesStore, useAuthStore, useAgentStore } from '@/store'
import { LOCALSTORAGE_KEY_DISCARDED_DB } from '@/configs/storage'
import { deleteDiscardedDB } from '@/utils/database'
import { isPC } from '@/utils/common'
import { deckApi, assetApi } from '@/services'
import { setAssetBaseUrl } from '@/utils/assetUrl'

import Auth from './views/Auth/index.vue'
import DeckList from './views/DeckList/index.vue'
import Settings from './views/Settings/index.vue'
import Editor from './views/Editor/index.vue'
import Screen from './views/Screen/index.vue'
import Mobile from './views/Mobile/index.vue'
import FullscreenSpin from '@/components/FullscreenSpin.vue'

const _isPC = isPC()

const authStore = useAuthStore()
const agentStore = useAgentStore()
const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const snapshotStore = useSnapshotStore()
const screenStore = useScreenStore()
const { databaseId } = storeToRefs(mainStore)
const { slides } = storeToRefs(slidesStore)
const { screening } = storeToRefs(screenStore)

const currentDeckId = ref<number | null>(null)
/**
 * 真的在拉 deck 数据。
 *
 * 原来「加载中」的判据是 `slides.length === 0` —— 它和「加载完了，但确实是 0 页」
 * **是同一个条件**，两者分不开。表现是 0 页的 deck 永久转圈，
 * 而且圈里没有任何出路（回列表的按钮在 Editor 里，而 Editor 没被渲染）。
 */
const deckLoading = ref(false)
const showSettings = ref(false)
provide('currentDeckId', currentDeckId)

const isAudienceMode = new URLSearchParams(window.location.search).get('mode') === 'audience'

if (import.meta.env.MODE !== 'development') {
  window.onbeforeunload = () => false
}

const onAuthSuccess = () => {
  // login/register done, auth store is populated
}

/** 编辑器的不变量：**一份 deck 至少有一页**。0 页是非法状态，见 repairEmptyDeck */
const blankSlide = () => ({ id: nanoid(10), elements: [] })

const openDeck = async (deckId: number) => {
  currentDeckId.value = deckId
  deckLoading.value = true
  try {
    const res = await deckApi.get(deckId) as any
    const deck = res.deck
    const deckSlides = JSON.parse(deck.slidesJson || '[]')
    slidesStore.setTitle(deck.title || '未命名演示文稿')
    if (deckSlides.length) {
      slidesStore.setSlides(deckSlides)
      if (deck.themeJson) {
        const theme = JSON.parse(deck.themeJson)
        slidesStore.setTheme(theme)
      }
    }
    else {
      /**
       * 库里是 0 页（新建的 deck，`slides_json` 默认 `'[]'`）。
       *
       * **补了必须立刻落库。** 原来只在本地补，于是「用户看到 1 页」和
       * 「库里 0 页」长期不一致 —— agent 从**库**读初始状态，跑完收尾那次
       * `commit` 就把 `[]` 原样推回前端，把用户那页抹掉，画布变 0 页。
       * 实测复现过：新建 deck → 打开（1 页）→ 发一句不改画布的指令 →
       * 任务结束瞬间 `slideThumbs: 1 → 0`，界面卡在「加载中」转圈。
       *
       * 落了库之后 agent 读到的就是同一份真相，整条链断掉。
       */
      slidesStore.setSlides([blankSlide()])
      await saveDeck()
    }
    await deleteDiscardedDB()
    snapshotStore.initSnapshotDatabase()
  }
  catch {
    slidesStore.setSlides([blankSlide()])
    await deleteDiscardedDB()
    snapshotStore.initSnapshotDatabase()
  }
  finally {
    deckLoading.value = false
  }
}

const saveDeck = async () => {
  if (!currentDeckId.value) return
  try {
    await deckApi.update(currentDeckId.value, {
      title: slidesStore.title,
      slidesJson: JSON.stringify(slidesStore.slides),
      themeJson: JSON.stringify(slidesStore.theme),
    })
  }
  catch {
    // 静默失败，不阻塞返回操作
  }
}

const closeDeck = async () => {
  await saveDeck()
  currentDeckId.value = null
  slidesStore.setSlides([])
}

/**
 * 登出（或登录态失效）时清干净上一个账号的全部残留。
 *
 * currentDeckId 是本组件的局部 ref，slides / agent 是 pinia 单例，三者原来都不随登出重置。
 * 结果是换个账号登录会**直接跳进上一个人的演示文稿**，AI 面板里还是上一个人的对话
 * —— deckId 没变，AgentPanel 的 watch 也不会触发重载。
 */
/**
 * 0 页兜底。
 *
 * 「一份 deck 至少有一页」是整个编辑器的隐含不变量 —— `slidesStore` 的
 * `currentSlide` 之类到处都在按下标取页。0 页不是「空文稿」，是**非法状态**。
 *
 * 正常路径产生不了它：kernel 守着「不能删除最后一页」（`kernel.ts:816`），
 * 所以只有「deck 从一开始就是空的」这一条路 —— 那条已经在 `openDeck` 里
 * 从源头堵上了。这里是**第二道**：真出现 0 页时补一页并落库，
 * 而不是把用户扔进一个转不完的圈。
 *
 * `currentDeckId` 的判空不能少：`closeDeck` 和登出都会 `setSlides([])`，
 * 但它们**先**把 `currentDeckId` 置空 —— 那是正常清场，不该被"修复"。
 */
watch(slides, (list) => {
  if (!currentDeckId.value || deckLoading.value || list.length) return
  console.warn('[deck] 画布出现 0 页（非法状态），已自动补一页')
  slidesStore.setSlides([blankSlide()])
  saveDeck()
})

watch(() => authStore.isLoggedIn, (loggedIn) => {
  if (loggedIn) {
    syncAssetBaseUrl()
    return
  }
  currentDeckId.value = null
  showSettings.value = false
  slidesStore.setSlides([])
  agentStore.reset()
})

/**
 * 把图片资产的根地址同步到 `utils/assetUrl.ts`。
 *
 * 这就是 `assetUrl.ts:59` 那条 `TODO(R-01)` —— setter 从 R-10 建好之后
 * **全项目零调用**，于是 `asset://<hash>` 一直解析成默认的 `/assets/<hash>`，
 * 一个必然 404 的地址。D1 的图片真正开始进 deck，这条就必须兑现。
 *
 * 失败时**不动默认值**，也不打扰用户：拿不到地址只影响图片显示，
 * 而这条请求失败通常意味着后端刚重启或还没配对象存储 ——
 * 为它弹一个错误提示，只会在每次开发时都跳一次。
 *
 * 登录后调一次、启动时（已有缓存登录态）调一次：两处都要，
 * 因为乐观恢复的登录态不会触发 isLoggedIn 的 watch。
 */
const syncAssetBaseUrl = async () => {
  try {
    // `as any` + 直接读字段是本仓库的既定写法（见 `deckApi.list()` / `authApi.me()` 的调用点）：
    // `services/index.ts` 引的是 `./axios` 那个**会拆包**的实例（拦截器 return response.data），
    // 所以拿到的就是响应体本身。**但类型没跟着改**，仍然写着 AxiosResponse ——
    // 于是 `res.data.baseUrl` 编译得过、运行时永远 undefined。
    // 第一版就是这么写的，浏览器里跑出来才发现，见 docs/04 第十八轮。
    const res = await assetApi.baseUrl() as any
    if (res?.baseUrl) setAssetBaseUrl(res.baseUrl)
  }
  catch {
    console.warn('[assets] 取资产根地址失败，图片将无法显示（对象存储可能尚未配置）')
  }
}

onMounted(async () => {
  if (isAudienceMode) {
    slidesStore.setSlides([{ id: nanoid(10), elements: [] }])
    screenStore.setScreening(true)
    return
  }
  // 任何请求撞上 401 都统一登出，不用各处自己判断
  authStore.installUnauthorizedHandler()
  await authStore.fetchMe()
  if (authStore.isLoggedIn) syncAssetBaseUrl()
})

window.addEventListener('beforeunload', () => {
  const discardedDB = localStorage.getItem(LOCALSTORAGE_KEY_DISCARDED_DB)
  const discardedDBList: string[] = discardedDB ? JSON.parse(discardedDB) : []
  discardedDBList.push(databaseId.value)
  const newDiscardedDB = JSON.stringify(discardedDBList)
  localStorage.setItem(LOCALSTORAGE_KEY_DISCARDED_DB, newDiscardedDB)
})
</script>

<style lang="scss">
#app {
  height: 100%;
}
</style>
