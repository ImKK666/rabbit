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

  <FullscreenSpin tip="加载中..." v-else-if="currentDeckId" loading :mask="false" />
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
const showSettings = ref(false)
provide('currentDeckId', currentDeckId)

const isAudienceMode = new URLSearchParams(window.location.search).get('mode') === 'audience'

if (import.meta.env.MODE !== 'development') {
  window.onbeforeunload = () => false
}

const onAuthSuccess = () => {
  // login/register done, auth store is populated
}

const openDeck = async (deckId: number) => {
  currentDeckId.value = deckId
  try {
    const res = await deckApi.get(deckId) as any
    const deck = res.deck
    const deckSlides = JSON.parse(deck.slidesJson || '[]')
    if (deckSlides.length) {
      slidesStore.setSlides(deckSlides)
      if (deck.themeJson) {
        const theme = JSON.parse(deck.themeJson)
        slidesStore.setTheme(theme)
      }
    }
    else {
      slidesStore.setSlides([{ id: nanoid(10), elements: [] }])
    }
    slidesStore.setTitle(deck.title || '未命名演示文稿')
    await deleteDiscardedDB()
    snapshotStore.initSnapshotDatabase()
  }
  catch {
    slidesStore.setSlides([{ id: nanoid(10), elements: [] }])
    await deleteDiscardedDB()
    snapshotStore.initSnapshotDatabase()
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
