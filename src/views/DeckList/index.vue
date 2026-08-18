<template>
  <div class="deck-list-page">
    <div class="deck-list-header">
      <div class="header-left">
        <span class="logo">Rabbit</span>
        <span class="greeting">{{ authStore.user?.username }}</span>
      </div>
      <div class="header-right">
        <Button size="small" @click="emit('openSettings')">
          <i-icon-park-outline:setting-two class="btn-icon" /> 设置
        </Button>
        <Button size="small" @click="authStore.logout()">退出</Button>
      </div>
    </div>

    <div class="deck-list-body">
      <div class="deck-list-title">
        <span>我的演示文稿</span>
        <Button type="primary" @click="handleCreate">
          <i-icon-park-outline:plus class="btn-icon" /> 新建
        </Button>
      </div>

      <div class="loading-tip" v-if="loading">加载中...</div>
      <div class="empty-tip" v-else-if="!deckList.length">还没有演示文稿，点击上方"新建"开始</div>

      <div class="deck-grid" v-else>
        <div
          class="deck-card"
          v-for="deck in deckList"
          :key="deck.id"
          @click="emit('select', deck.id)"
        >
          <div class="deck-card-title">{{ deck.title || '未命名演示文稿' }}</div>
          <div class="deck-card-meta">
            <span>{{ formatTime(deck.updatedAt) }}</span>
          </div>
          <div class="deck-card-actions" @click.stop>
            <span class="action-btn delete" @click="handleDelete(deck.id)">
              <i-icon-park-outline:delete />
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/store'
import { deckApi } from '@/services'
import Button from '@/components/Button.vue'

const emit = defineEmits<{
  (event: 'select', deckId: number): void
  (event: 'openSettings'): void
}>()

const authStore = useAuthStore()

interface DeckItem {
  id: number
  title: string
  updatedAt: string | number
}

const deckList = ref<DeckItem[]>([])
const loading = ref(true)

const loadDecks = async () => {
  loading.value = true
  try {
    const res = await deckApi.list() as any
    deckList.value = res.decks || []
  }
  catch {
    deckList.value = []
  }
  finally {
    loading.value = false
  }
}

const handleCreate = async () => {
  try {
    const res = await deckApi.create({ title: '未命名演示文稿' }) as any
    emit('select', res.deck.id)
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '创建失败')
  }
}

const handleDelete = async (id: number) => {
  if (!confirm('确定删除这个演示文稿吗？')) return
  try {
    await deckApi.delete(id)
    deckList.value = deckList.value.filter(d => d.id !== id)
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '删除失败')
  }
}

const formatTime = (t: string | number) => {
  if (!t) return ''
  const d = new Date(typeof t === 'number' ? t * 1000 : t)
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(loadDecks)
</script>

<style lang="scss" scoped>
.deck-list-page {
  height: 100%;
  background: #f5f7fa;
  display: flex;
  flex-direction: column;
}
.deck-list-header {
  height: 50px;
  background: #fff;
  border-bottom: 1px solid $borderColor;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  flex-shrink: 0;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-right {
  display: flex;
  gap: 8px;
}
.logo {
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(270deg, #d897fd, #33bcfc);
  background-clip: text;
  color: transparent;
}
.greeting {
  font-size: 13px;
  color: #666;
}
.btn-icon {
  margin-right: 4px;
}
.deck-list-body {
  flex: 1;
  padding: 24px 48px;
  @include overflow-overlay();
}
.deck-list-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  font-size: 18px;
  font-weight: 600;
}
.loading-tip, .empty-tip {
  text-align: center;
  color: #999;
  padding: 60px 0;
  font-size: 14px;
}
.deck-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.deck-card {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  border: 1px solid $borderColor;
  cursor: pointer;
  transition: box-shadow .2s, border-color .2s;
  position: relative;

  &:hover {
    border-color: $themeColor;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
  }
}
.deck-card-title {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
  @include ellipsis-oneline();
}
.deck-card-meta {
  font-size: 12px;
  color: #999;
}
.deck-card-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  opacity: 0;
  transition: opacity .2s;

  .deck-card:hover & {
    opacity: 1;
  }
}
.action-btn {
  font-size: 16px;
  color: #999;
  cursor: pointer;
  padding: 4px;

  &.delete:hover {
    color: #e74c3c;
  }
}
</style>
