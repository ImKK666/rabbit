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
import { deckApi } from '@/services'

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
  if (loggedIn) return
  currentDeckId.value = null
  showSettings.value = false
  slidesStore.setSlides([])
  agentStore.reset()
})

onMounted(async () => {
  if (isAudienceMode) {
    slidesStore.setSlides([{ id: nanoid(10), elements: [] }])
    screenStore.setScreening(true)
    return
  }
  // 任何请求撞上 401 都统一登出，不用各处自己判断
  authStore.installUnauthorizedHandler()
  await authStore.fetchMe()
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
