<template>
  <div class="agent-panel" :class="{ 'collapsed': !expanded }">
    <div class="panel-toggle" @click="expanded = !expanded">
      <span class="toggle-label">AI</span>
      <i-icon-park-outline:right v-if="!expanded" />
      <i-icon-park-outline:left v-else />
    </div>

    <template v-if="expanded">
      <div class="panel-header">
        <div class="conv-switcher" @click="convListOpen = !convListOpen">
          <span class="conv-title">{{ activeTitle }}</span>
          <span class="conv-arrow" :class="{ open: convListOpen }">▾</span>
        </div>
        <div class="header-right">
          <div class="status-dot" :class="status" v-tooltip="statusMessage || status"></div>
        </div>
      </div>

      <!-- 会话列表 -->
      <div class="conv-list" v-if="convListOpen">
        <div
          class="conv-item"
          v-for="conv in conversations"
          :key="conv.id"
          :class="{ active: conv.id === activeConversationId }"
          @click="handleSwitch(conv.id)"
        >
          <span class="conv-dot">{{ conv.id === activeConversationId ? '●' : '' }}</span>
          <span class="conv-item-title" :title="conv.title">
            {{ conv.title }}
            <span class="fork-mark" v-if="conv.forkedFromId" v-tooltip="'由分叉而来'">⑂</span>
          </span>
          <span class="conv-time">{{ formatTime(conv.updatedAt) }}</span>
          <span class="conv-actions" @click.stop>
            <span class="conv-act" @click="handleRename(conv)" v-tooltip="'重命名'">✎</span>
            <span class="conv-act danger" @click="handleDeleteConv(conv)" v-tooltip="'删除此会话'">✕</span>
          </span>
        </div>

        <div class="conv-empty" v-if="!conversations.length">还没有会话记录</div>

        <div class="conv-divider"></div>
        <div class="conv-item new" @click="handleNewConv">
          <span class="conv-dot">＋</span>
          <span class="conv-item-title">新建会话<span class="conv-hint">（记忆从零开始）</span></span>
        </div>
        <div class="conv-item danger-row" v-if="conversations.length" @click="handleClear">
          <span class="conv-dot">🗑</span>
          <span class="conv-item-title">清空本演示文稿的全部会话</span>
        </div>
      </div>

      <div class="panel-body" ref="bodyRef">
        <div class="loading-hint" v-if="historyLoading">载入历史...</div>

        <div class="log-entries" v-else-if="log.length">
          <template v-for="(entry, idx) in log" :key="idx">
            <!-- 用户输入 -->
            <div class="log-entry user-msg" v-if="entry.type === 'text' && entry.role === 'user'">
              <div class="entry-label">
                你
                <span
                  class="fork-btn"
                  v-if="entry.messageId && !isRunning"
                  @click="handleFork(entry.messageId)"
                  v-tooltip="'从这里分叉出新会话（画布不回退）'"
                >⑂ 分叉</span>
              </div>
              <div class="entry-content">{{ entry.content }}</div>
            </div>

            <!-- 角色文本输出 -->
            <div class="log-entry role-msg" v-else-if="entry.type === 'text' && entry.role !== 'user'">
              <div class="entry-label">{{ roleLabel(entry.role) }}</div>
              <div class="entry-content" v-html="formatContent(entry.content)"></div>
            </div>

            <!-- 思考过程：正在想的时候摊开、想完了收起来，点标题可以再翻开。
                 抽成子组件是因为它自己是个滚动容器，要拿到自己那个 DOM 元素 -->
            <AgentReasoningEntry
              v-else-if="entry.type === 'reasoning'"
              :entry="entry"
              :open="isReasoningOpen(entry, idx)"
              @toggle="toggleExpand(idx)"
            />

            <!-- 工具调用 -->
            <div class="log-entry tool-entry" v-else-if="entry.type === 'tool'">
              <div class="tool-header" @click="toggleExpand(idx)">
                <span class="tool-icon">⚙</span>
                <span class="tool-name">{{ entry.tool }}</span>
                <span class="tool-args-preview">{{ summarizeArgs(entry.args) }}</span>
                <span class="expand-arrow" :class="{ open: expandedEntries.has(idx) }">▸</span>
              </div>
              <div class="tool-detail" v-if="expandedEntries.has(idx)">
                <div class="detail-section" v-if="Object.keys(entry.args).length">
                  <div class="detail-label">参数</div>
                  <pre class="detail-json">{{ JSON.stringify(entry.args, null, 2) }}</pre>
                </div>
                <div class="detail-section" v-if="entry.result">
                  <div class="detail-label">结果</div>
                  <pre class="detail-json">{{ entry.result }}</pre>
                </div>
              </div>
            </div>

            <!-- 图片资产：生图要 15 秒，这条是那段时间里唯一的动静 -->
            <div class="log-entry asset-entry" :class="entry.state" v-else-if="entry.type === 'asset'">
              <span class="asset-icon">{{ entry.state === 'pending' ? '◌' : entry.state === 'ready' ? '▣' : '⊘' }}</span>
              <span class="asset-label">{{ entry.kind === 'generate' ? '生成图片' : '搜索图片' }}</span>
              <span class="asset-prompt" v-tooltip="entry.prompt">{{ entry.prompt }}</span>
              <span class="asset-detail" v-if="entry.detail">{{ entry.detail }}</span>
            </div>

            <!-- 状态变化 -->
            <div class="log-entry status-entry" v-else-if="entry.type === 'status' && entry.message">
              <span class="status-icon" :class="entry.status">●</span>
              <span class="status-msg">{{ entry.message }}</span>
            </div>
          </template>
        </div>

        <div class="empty-hint" v-else-if="!historyLoading">
          输入指令开始使用 AI 助手
        </div>

        <div class="thinking-bar" v-if="isRunning">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="thinking-text">{{ statusMessage }}</span>
        </div>
      </div>

      <div class="panel-footer">
        <div class="input-row">
          <TextArea
            v-model:value="promptText"
            placeholder="输入指令，如「生成一份关于人工智能的 PPT」"
            :rows="2"
            @keydown="handleKeydown"
          />
        </div>
        <div class="action-row">
          <div class="context-hint" v-if="selectedCount">
            已选 {{ selectedCount }} 个元素
          </div>
          <div class="action-buttons">
            <Button size="small" v-if="isRunning" @click="agentStore.cancelTask()">取消</Button>
            <Button size="small" type="primary" @click="handleSend" :disabled="!canSend">发送</Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useAgentStore } from '@/store'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import Button from '@/components/Button.vue'
import TextArea from '@/components/TextArea.vue'
import AgentReasoningEntry from './AgentReasoningEntry.vue'

const props = defineProps<{
  deckId: number | null
}>()

const mainStore = useMainStore()
const agentStore = useAgentStore()
const { activeElementIdList } = storeToRefs(mainStore)
const {
  status, statusMessage, log, isRunning, historyLoading,
  conversations, activeConversationId,
} = storeToRefs(agentStore)

const expanded = ref(true)
const promptText = ref('')
const bodyRef = ref<HTMLElement>()
const expandedEntries = reactive(new Set<number>())
const convListOpen = ref(false)

const activeTitle = computed(() => {
  if (activeConversationId.value === null) return '新会话'
  return conversations.value.find(cv => cv.id === activeConversationId.value)?.title || '新会话'
})

// 会话按演示文稿隔离：切 deck 必须换掉整条日志。
// 少了这个 watch，agent store 是全局单例，新建的项目会显示上一个项目的对话。
watch(() => props.deckId, (deckId) => {
  expandedEntries.clear()
  convListOpen.value = false
  if (deckId === null) agentStore.reset()
  else agentStore.openDeck(deckId)
}, { immediate: true })

const handleSwitch = async (id: number) => {
  convListOpen.value = false
  expandedEntries.clear()
  try {
    await agentStore.switchConversation(id)
  }
  catch {
    alert('切换会话失败')
  }
}

const handleNewConv = () => {
  convListOpen.value = false
  expandedEntries.clear()
  agentStore.startNewConversation()
}

const handleRename = async (conv: { id: number, title: string }) => {
  const title = prompt('会话名称', conv.title)
  if (title === null || !title.trim() || title.trim() === conv.title) return
  try {
    await agentStore.renameConversation(conv.id, title.trim())
  }
  catch {
    alert('重命名失败')
  }
}

const handleDeleteConv = async (conv: { id: number, title: string }) => {
  if (!confirm(`删除会话「${conv.title}」？此操作不可撤销。`)) return
  try {
    await agentStore.deleteConversation(conv.id)
    expandedEntries.clear()
  }
  catch {
    alert('删除失败')
  }
}

const handleFork = async (messageId: number) => {
  if (!confirm('从这条消息分叉出一条新会话？\n\n只复制到这里为止的对话，演示文稿内容不会回退。')) return
  try {
    await agentStore.forkFrom(messageId)
    expandedEntries.clear()
  }
  catch {
    alert('分叉失败')
  }
}

const handleClear = async () => {
  convListOpen.value = false
  if (!confirm('确定清空这份演示文稿的全部会话吗？AI 将不再记得任何上下文。')) return
  try {
    await agentStore.clearHistory()
    expandedEntries.clear()
  }
  catch {
    alert('清空失败')
  }
}

const formatTime = (t: string | number) => {
  if (!t) return ''
  const d = new Date(t)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`
  return d.toLocaleDateString('zh-CN')
}

const selectedCount = computed(() => activeElementIdList.value.length)
const canSend = computed(() => promptText.value.trim() && !isRunning.value && props.deckId)

const handleSend = () => {
  if (!canSend.value || !props.deckId) return
  expandedEntries.clear()
  const selectedIds = activeElementIdList.value.length ? [...activeElementIdList.value] : undefined
  agentStore.submitTask(props.deckId, promptText.value.trim(), selectedIds)
  promptText.value = ''
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    handleSend()
  }
}

const toggleExpand = (idx: number) => {
  if (expandedEntries.has(idx)) expandedEntries.delete(idx)
  else expandedEntries.add(idx)
}

/**
 * 思考块的默认开合与工具调用相反：**想的时候摊开，想完了收起来**。
 * 思考是过程，实时看着有用；执行阶段还占着半屏就只是噪声了。
 * expandedEntries 仍然当手动开关用 —— 收起后想回看点一下就行。
 */
const isReasoningOpen = (entry: { done: boolean }, idx: number) =>
  entry.done ? expandedEntries.has(idx) : !expandedEntries.has(idx)

/**
 * R-51 之后只有一个 agent，标签固定是「Agent」。
 * 四个旧名字留着**只为老会话** —— 迁移不回填历史消息，
 * 重开一条 R-51 之前的会话时，那些行仍然带着 `[Generator]` 之类的前缀。
 */
const roleLabel = (role: string): string => {
  const labels: Record<string, string> = {
    deck: 'Agent',
    planner: 'Planner',
    generator: 'Generator',
    reviewer: 'Reviewer',
    editor: 'Editor',
  }
  return labels[role] || role
}

const formatContent = (content: string): string => {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
}

const summarizeArgs = (args: Record<string, unknown>): string => {
  const keys = Object.keys(args)
  if (!keys.length) return ''
  const parts = keys.slice(0, 2).map(k => {
    const v = args[k]
    if (typeof v === 'string') return v.length > 20 ? v.slice(0, 20) + '...' : v
    if (typeof v === 'object') return '{...}'
    return String(v)
  })
  if (keys.length > 2) parts.push('...')
  return parts.join(', ')
}

/**
 * 外层面板的贴底跟随。
 *
 * 原来这里是一行**无条件**的 `scrollTop = scrollHeight`，
 * 每条日志变化都执行 —— 而 reasoning 增量是几个字符一条、每秒几十条，
 * 于是用户往上滚会立刻被拽回来，表现是「一滚就回弹」。
 *
 * 换成贴底判断之后：滚上去就不再打扰，滚回底部又自动跟随。
 * 思考块自己那条滚动条由 `AgentReasoningEntry` 各管各的（scroll 事件不冒泡）。
 *
 * `deep` 还是要开：reasoning 是往**已有条目**里追加正文，不是 push 新条目，
 * 不开的话日志长度没变，watch 不会触发。
 */
useStickToBottom(bodyRef, log, { deep: true })
</script>

<style lang="scss" scoped>
.agent-panel {
  width: 320px;
  height: 100%;
  border-left: 1px solid $borderColor;
  background: #fff;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;

  &.collapsed {
    width: 32px;
  }
}
.panel-toggle {
  position: absolute;
  top: 8px;
  left: -1px;
  padding: 4px 6px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
  color: #999;
  z-index: 1;

  .collapsed & {
    position: static;
    width: 100%;
    justify-content: center;
    padding: 8px 0;
    writing-mode: vertical-lr;
    gap: 4px;
  }

  .toggle-label {
    font-weight: 700;
    background: linear-gradient(270deg, #d897fd, #33bcfc);
    background-clip: text;
    color: transparent;
  }
}
.panel-header {
  height: 40px;
  padding: 0 12px 0 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid $borderColor;
  flex-shrink: 0;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

// 会话切换器
.conv-switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  min-width: 0;
  flex: 1;
  padding: 3px 6px;
  margin-left: -6px;
  border-radius: 4px;

  &:hover { background: $lightGray; }
}
.conv-title {
  font-size: 13px;
  font-weight: 500;
  @include ellipsis-oneline();
}
.conv-arrow {
  font-size: 10px;
  color: #999;
  flex-shrink: 0;
  transition: transform .15s;

  &.open { transform: rotate(180deg); }
}
.conv-list {
  border-bottom: 1px solid $borderColor;
  background: #fafbfc;
  max-height: 260px;
  @include overflow-overlay();
  flex-shrink: 0;
}
.conv-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: 12px;

  &:hover {
    background: #eef2f7;

    .conv-actions { opacity: 1; }
  }
  &.active { background: #e8f4fd; }
  &.new { color: $themeColor; }
  &.danger-row {
    color: #b0b0b0;
    font-size: 11px;

    &:hover { color: #e74c3c; }
  }
}
.conv-dot {
  width: 12px;
  font-size: 9px;
  color: $themeColor;
  flex-shrink: 0;
  text-align: center;
}
.conv-item-title {
  flex: 1;
  min-width: 0;
  @include ellipsis-oneline();
}
.conv-hint {
  color: #aaa;
  font-size: 11px;
}
.fork-mark {
  color: #999;
  margin-left: 3px;
}
.conv-time {
  font-size: 10px;
  color: #aaa;
  flex-shrink: 0;
}
.conv-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity .15s;
  flex-shrink: 0;
}
.conv-act {
  font-size: 11px;
  color: #999;
  padding: 0 2px;

  &:hover { color: $themeColor; }
  &.danger:hover { color: #e74c3c; }
}
.conv-empty {
  padding: 12px;
  text-align: center;
  color: #bbb;
  font-size: 12px;
}
.conv-divider {
  height: 1px;
  background: $borderColor;
  margin: 4px 0;
}
.fork-btn {
  float: right;
  font-weight: 400;
  color: #999;
  cursor: pointer;

  &:hover { color: $themeColor; }
}
.loading-hint {
  color: #bbb;
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;

  &.thinking, &.tool_call { background: #f39c12; animation: pulse-dot 1s infinite; }
  &.done { background: #27ae60; }
  &.error { background: #e74c3c; }
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.panel-body {
  flex: 1;
  padding: 12px;
  @include overflow-overlay();
  font-size: 12px;
}
.empty-hint {
  color: #bbb;
  text-align: center;
  padding: 40px 0;
  font-size: 13px;
}
.log-entries {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.log-entry {
  border-radius: 6px;
}

// 用户消息
.user-msg {
  background: #e8f4fd;
  padding: 8px 10px;

  .entry-label {
    font-size: 10px;
    font-weight: 600;
    color: #2980b9;
    margin-bottom: 3px;
  }
  .entry-content {
    font-size: 12px;
    color: #333;
    line-height: 1.5;
  }
}

// 角色输出
.role-msg {
  background: $lightGray;
  padding: 8px 10px;

  .entry-label {
    font-size: 10px;
    font-weight: 600;
    color: $themeColor;
    margin-bottom: 3px;
  }
  .entry-content {
    font-size: 12px;
    color: #333;
    line-height: 1.5;
    word-break: break-word;
  }
}

// 思考过程的样式全部搬去了 `AgentReasoningEntry.vue`。
// 不是留一份在这里更保险 —— scoped CSS 只给子组件的**根元素**打父作用域标记，
// header / body 这些内部节点拿不到，留在这里等于两份样式一份失效、
// 改的时候永远猜不准该改哪份。

// 工具调用
.tool-entry {
  background: #f0f0f0;
  border: 1px solid #e0e0e0;
  overflow: hidden;
}
.tool-header {
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 11px;

  &:hover { background: #e8e8e8; }
}
.tool-icon { font-size: 12px; }
.tool-name {
  font-weight: 600;
  color: #555;
  flex-shrink: 0;
}
.tool-args-preview {
  color: #888;
  flex: 1;
  @include ellipsis-oneline();
}
.expand-arrow {
  font-size: 10px;
  color: #999;
  transition: transform .15s;
  flex-shrink: 0;

  &.open { transform: rotate(90deg); }
}
.tool-detail {
  border-top: 1px solid #e0e0e0;
  padding: 6px 8px;
}
.detail-section {
  margin-bottom: 6px;
  &:last-child { margin-bottom: 0; }
}
.detail-label {
  font-size: 10px;
  font-weight: 600;
  color: #888;
  margin-bottom: 2px;
}
.detail-json {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: #555;
  background: #fff;
  padding: 6px;
  border-radius: 3px;
  margin: 0;
  max-height: 200px;
  @include overflow-overlay();
  white-space: pre-wrap;
  word-break: break-all;
}

// 状态
// 图片资产。刻意长得像工具条目而不是状态条目 ——
// 它代表的是一次实实在在的取图动作，不是一句提示
.asset-entry {
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  background: #f0f0f0;
  border: 1px solid #e0e0e0;

  &.pending .asset-icon { color: #f39c12; }
  &.ready .asset-icon { color: #27ae60; }
  &.failed {
    color: #999;
    .asset-icon { color: #e74c3c; }
  }
}
.asset-icon { font-size: 12px; }
.asset-label {
  font-weight: 600;
  color: #555;
  flex-shrink: 0;
}
.asset-prompt {
  color: #888;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail {
  color: #aaa;
  flex-shrink: 0;
}

.status-entry {
  padding: 4px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #888;
}
.status-icon {
  font-size: 8px;
  &.thinking, &.tool_call { color: #f39c12; }
  &.done { color: #27ae60; }
  &.error { color: #e74c3c; }
}

// 底部思考指示
.thinking-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  color: #f39c12;
  font-size: 12px;

  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #f39c12;
    animation: bounce-dot 1.2s infinite;

    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
  }
  .thinking-text {
    margin-left: 4px;
    color: #999;
  }
}
@keyframes bounce-dot {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-4px); }
}
.panel-footer {
  border-top: 1px solid $borderColor;
  padding: 8px 12px;
  flex-shrink: 0;
}
.input-row {
  margin-bottom: 6px;
}
.action-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.context-hint {
  font-size: 11px;
  color: #999;
}
.action-buttons {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
</style>
