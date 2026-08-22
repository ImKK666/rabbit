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
            <!-- 思考过程的组头。**只在一组的第一条前面出一次**，
                 收起时下面那些小块整体藏掉，只剩这一行摘要 -->
            <div
              class="process-header"
              :class="{ open: isGroupOpen(idx), live: isGroupLive(idx) }"
              v-if="groupStartOf[idx] === idx"
              @click="toggleGroup(idx)"
            >
              <span class="process-icon">✦</span>
              <span class="process-summary">{{ groupSummary(idx) }}</span>
              <span class="expand-arrow" :class="{ open: isGroupOpen(idx) }">▸</span>
            </div>

            <!-- 用户输入 -->
            <div
              class="log-entry user-msg"
              :class="{ queued: entry.delivery?.state === 'queued', rejected: entry.delivery?.state === 'rejected' }"
              v-if="entry.type === 'text' && entry.role === 'user'"
            >
              <div class="entry-label">
                你
                <!-- 这句话此刻的去向。没有这个标记的时候面板会撒谎：
                     发出请求那一刻这条就进日志了，排队和被拒都看不出来 -->
                <span class="delivery-tag queued" v-if="entry.delivery?.state === 'queued'">
                  ⏸ 排队中{{ entry.delivery.position > 1 ? `（前面还有 ${entry.delivery.position - 1} 条）` : '' }}
                </span>
                <span
                  class="delivery-tag rejected"
                  v-else-if="entry.delivery?.state === 'rejected'"
                  v-tooltip="entry.delivery.reason"
                >⊘ 未送达</span>
                <span
                  class="fork-btn"
                  v-if="entry.messageId && !isRunning"
                  @click="handleFork(entry.messageId)"
                  v-tooltip="'从这里分叉出新会话（画布不回退）'"
                >⑂ 分叉</span>
              </div>
              <div class="entry-content">{{ entry.content }}</div>
              <!-- R-68：随这句话发的图。历史里由 hydrateLog 从 blocksJson 还原 -->
              <div class="entry-images" v-if="entry.images?.length">
                <img
                  v-for="(src, i) in entry.images"
                  :key="i"
                  :src="assetSrc(src)"
                  alt="附图"
                />
              </div>
              <div class="delivery-reason" v-if="entry.delivery?.state === 'rejected'">
                {{ entry.delivery.reason }}
              </div>
            </div>

            <!-- 角色文本输出 -->
            <div class="log-entry role-msg" v-else-if="entry.type === 'text' && entry.role !== 'user'">
              <div class="entry-label">{{ roleLabel(entry.role) }}</div>
              <div class="entry-content" v-html="formatContent(entry.content)"></div>
            </div>

            <!-- 思考过程：正在想的时候摊开、想完了收起来，点标题可以再翻开。
                 抽成子组件是因为它自己是个滚动容器，要拿到自己那个 DOM 元素 -->
            <AgentReasoningEntry
              v-else-if="entry.type === 'reasoning' && isGroupOpen(groupStartOf[idx])"
              class="in-group"
              :entry="entry"
              :open="isReasoningOpen(entry, idx)"
              @toggle="toggleExpand(idx)"
            />

            <!-- 工具调用 -->
            <div
              class="log-entry tool-entry in-group"
              v-else-if="entry.type === 'tool' && isGroupOpen(groupStartOf[idx])"
            >
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
            <div
              class="log-entry asset-entry in-group"
              :class="entry.state"
              v-else-if="entry.type === 'asset' && isGroupOpen(groupStartOf[idx])"
            >
              <span class="asset-icon">{{ entry.state === 'pending' ? '◌' : entry.state === 'ready' ? '▣' : '⊘' }}</span>
              <span class="asset-label">{{ entry.kind === 'generate' ? '生成图片' : '搜索图片' }}</span>
              <span class="asset-prompt" v-tooltip="entry.prompt">{{ entry.prompt }}</span>
              <span class="asset-detail" v-if="entry.detail">{{ entry.detail }}</span>
            </div>

            <!-- 确认闸门：agent 停下来问用户，点「是 / 否」原样带回 requestId -->
            <div class="log-entry ask-entry" v-else-if="entry.type === 'ask'">
              <div class="ask-question">❓ {{ entry.question }}</div>
              <div class="ask-actions" v-if="entry.answer === undefined">
                <Button size="small" type="primary" @click="handleAnswer(idx, true)">是</Button>
                <Button size="small" @click="handleAnswer(idx, false)">否</Button>
              </div>
              <div class="ask-answered" v-else>已选择：{{ entry.answer ? '是' : '否' }}</div>
            </div>

            <!-- R-63：策划稿方案卡片。默认摊开 —— 闸门提问就在它下面，
                 用户要看着方案才能判断「是 / 否」 -->
            <div class="log-entry plan-entry" v-else-if="entry.type === 'plan'">
              <div class="plan-header" @click="toggleExpand(idx)">
                <span class="plan-icon">📋</span>
                <span class="plan-title">
                  策划稿 · {{ planPageCount(entry.plan) }} 页 {{ entry.plan.sections.length }} 段
                </span>
                <span class="expand-arrow" :class="{ open: !expandedEntries.has(idx) }">▸</span>
              </div>
              <div class="plan-body" v-if="!expandedEntries.has(idx)">
                <div class="plan-line narrative"><b>叙事线</b>{{ entry.plan.narrative }}</div>
                <div class="plan-line style"><b>视觉</b>{{ entry.plan.styleIntent }}</div>
                <div class="plan-section" v-for="sec in entry.plan.sections" :key="sec.id">
                  <div class="plan-sec-title">
                    {{ sec.title }}
                    <span class="plan-sec-purpose" v-if="sec.purpose">{{ sec.purpose }}</span>
                  </div>
                  <div class="plan-pages">
                    <span
                      class="plan-page"
                      v-for="(p, pi) in sec.slides"
                      :key="p.id"
                      v-tooltip="`${p.purpose}${p.keyMessage ? `｜记住：${p.keyMessage}` : ''}`"
                    >
                      {{ pi + 1 }}.{{ p.title }}
                      <em>{{ p.pattern }}{{ p.variant === 'B' ? '·B' : '' }}</em>
                    </span>
                  </div>
                </div>
              </div>
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
        <!-- R-68：待发送的图。上传中转圈、失败标红可重试，都能单独删掉 -->
        <div class="pending-images" v-if="pendingImages.length">
          <div
            class="pending-image"
            :class="{ uploading: img.state === 'uploading', failed: img.state === 'failed' }"
            v-for="img in pendingImages"
            :key="img.id"
            v-tooltip="img.state === 'failed' ? img.error : undefined"
          >
            <img :src="img.preview" alt="待发送图片" />
            <div class="mask" v-if="img.state === 'uploading'"><span class="spin"></span></div>
            <div class="mask retry" v-else-if="img.state === 'failed'" @click="retryImage(img.id)">重试</div>
            <span class="remove" @click="removeImage(img.id)">×</span>
          </div>
        </div>

        <div class="input-row">
          <TextArea
            v-model:value="promptText"
            :placeholder="imageInputAllowed
              ? '输入指令，可粘贴或上传图片（最多 9 张）'
              : '输入指令，如「生成一份关于人工智能的 PPT」'"
            :rows="2"
            @keydown="handleKeydown"
            @paste="handlePaste"
          />
        </div>
        <div class="action-row">
          <div class="context-hint" v-if="selectedCount">
            已选 {{ selectedCount }} 个元素
          </div>
          <div class="action-buttons">
            <!-- 不支持识图时置灰并说明原因 —— 让人传完九张再说不行是最差的做法 -->
            <span
              class="upload-btn"
              :class="{ disabled: !imageInputAllowed || isRunning }"
              @click="triggerPick"
              v-tooltip="imageInputAllowed ? '添加图片（最多 9 张）' : imageInputReason"
            >
              <i-icon-park-outline:picture />
            </span>
            <input
              class="file-input"
              ref="fileInputRef"
              type="file"
              accept="image/png,image/jpeg"
              multiple
              @change="handlePick"
            />
            <Button size="small" v-if="isRunning" @click="agentStore.cancelTask()">取消</Button>
            <Button size="small" type="primary" @click="handleSend" :disabled="!canSend">发送</Button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { groupStartOf as groupStarts, groupStats, summarizeGroup } from '@/utils/agentLogGroups'
import { useMainStore, useAgentStore } from '@/store'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { userApi, assetApi } from '@/services'
import { resolveAssetUrl } from '@/utils/assetUrl'
import { nanoid } from 'nanoid'
import message from '@/utils/message'
import type { DeckPlanMessage } from '@/services/websocket'
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
/**
 * 思考组的手动开关。**必须和 expandedEntries 声明在一起、且在下面那个
 * `immediate: true` 的 watch 之前** —— 那个 watch 在 setup 期间就会跑，
 * 声明晚一步就是暂时性死区，组件直接挂掉、整页白屏。
 * 实测撞过一次；`vue-tsc` 查不出来，单测也覆盖不到。
 */
const expandedGroups = reactive(new Set<number>())
const convListOpen = ref(false)

const activeTitle = computed(() => {
  if (activeConversationId.value === null) return '新会话'
  return conversations.value.find(cv => cv.id === activeConversationId.value)?.title || '新会话'
})

// 会话按演示文稿隔离：切 deck 必须换掉整条日志。
// 少了这个 watch，agent store 是全局单例，新建的项目会显示上一个项目的对话。
watch(() => props.deckId, (deckId) => {
  expandedEntries.clear()
  expandedGroups.clear()
  convListOpen.value = false
  if (deckId === null) agentStore.reset()
  else agentStore.openDeck(deckId)
}, { immediate: true })

const handleSwitch = async (id: number) => {
  convListOpen.value = false
  expandedEntries.clear()
  expandedGroups.clear()
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
  expandedGroups.clear()
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
    expandedGroups.clear()
  }
  catch {
    alert('删除失败')
  }
}

const handleAnswer = (_idx: number, value: boolean) => {
  // 按钮只出现在还在等的那条上（后端同一时刻最多一条在等）；
  // 双保险：store 里按 pendingAskIndex 认领，点错了也只是 no-op
  agentStore.answerAsk(value)
}

const handleFork = async (messageId: number) => {
  if (!confirm('从这条消息分叉出一条新会话？\n\n只复制到这里为止的对话，演示文稿内容不会回退。')) return
  try {
    await agentStore.forkFrom(messageId)
    expandedEntries.clear()
    expandedGroups.clear()
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
    expandedGroups.clear()
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

// ---------------------------------------------------------------------------
// R-68 · 粘贴 / 上传图片
// ---------------------------------------------------------------------------

/** 一次最多九张。后端也挡一道，那道才是约束 —— 这里挡的是体验 */
const MAX_IMAGES = 9

interface PendingImage {
  id: string
  /** 本地预览用的 object URL。**必须手动 revoke**，见 releasePreview */
  preview: string
  file: File
  state: 'uploading' | 'done' | 'failed'
  /** 上传成功后的 `asset://<hash>` */
  src?: string
  error?: string
}

const pendingImages = ref<PendingImage[]>([])
const fileInputRef = ref<HTMLInputElement>()
const imageInputAllowed = ref(false)
const imageInputReason = ref('正在检查模型能力…')

/** `asset://` → 可显示的地址。历史气泡里的缩略图用 */
const assetSrc = (src: string) => resolveAssetUrl(src)

/**
 * 能不能传图。两个条件：模型能读图 + 对象存储配好，后端一次算清。
 *
 * 不在前端拿 models + preferences 自己推 —— 那要复算「用户偏好 → 角色默认」
 * 的解析规则，而后端的 `inspectRoleModel` 才是那条规则的权威。
 */
const refreshCapabilities = async () => {
  try {
    const res = await userApi.capabilities()
    imageInputAllowed.value = !!res.data.imageInput
    imageInputReason.value = res.data.reason || ''
  }
  catch {
    // 问不到就当不支持：给一个点了没反应的按钮比置灰更让人困惑
    imageInputAllowed.value = false
    imageInputReason.value = '无法确认模型能力，暂时不能传图'
  }
}

onMounted(refreshCapabilities)

/**
 * 换模型之后能力会变。面板重新展开时问一次，够用且便宜 ——
 * 真正的兜底在后端（带图但模型读不了图会被当场挡回来）。
 */
watch(expanded, open => {
  if (open) refreshCapabilities()
})

const releasePreview = (img: PendingImage) => URL.revokeObjectURL(img.preview)

const uploadOne = async (img: PendingImage) => {
  try {
    const res = await assetApi.upload(img.file)
    img.src = res.data.src
    img.state = 'done'
  }
  catch (err) {
    img.state = 'failed'
    const detail = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
    img.error = detail || '上传失败'
  }
}

/**
 * 收下若干文件并开始上传。
 *
 * 超出上限时**只收前面的并说一声** —— 静默丢掉用户选的图，
 * 会让人以为传上去了，直到发出去才发现少了几张。
 */
const acceptFiles = (files: File[]) => {
  if (!imageInputAllowed.value) {
    if (files.length) message.warning(imageInputReason.value || '当前不能上传图片')
    return
  }

  const images = files.filter(f => f.type === 'image/png' || f.type === 'image/jpeg')
  const rejected = files.length - images.length
  if (rejected > 0) message.warning(`有 ${rejected} 个文件不是 PNG / JPEG，已跳过`)
  if (!images.length) return

  const room = MAX_IMAGES - pendingImages.value.length
  if (room <= 0) {
    message.warning(`一次最多 ${MAX_IMAGES} 张图片`)
    return
  }
  if (images.length > room) {
    message.warning(`一次最多 ${MAX_IMAGES} 张图片，只收下了前 ${room} 张`)
  }

  for (const file of images.slice(0, room)) {
    const img: PendingImage = {
      id: nanoid(8),
      preview: URL.createObjectURL(file),
      file,
      state: 'uploading',
    }
    pendingImages.value.push(img)
    uploadOne(img)
  }
}

/**
 * 粘贴。**只有真的收到图片时才 preventDefault** ——
 * 否则粘贴文字会被一起吞掉。
 */
const handlePaste = (e: ClipboardEvent) => {
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((f): f is File => f !== null)

  if (!files.length) return
  e.preventDefault()
  acceptFiles(files)
}

const triggerPick = () => {
  if (!imageInputAllowed.value || isRunning.value) return
  fileInputRef.value?.click()
}

const handlePick = (e: Event) => {
  const input = e.target as HTMLInputElement
  acceptFiles(Array.from(input.files ?? []))
  // 清空，否则连着选同一个文件不会再触发 change
  input.value = ''
}

const removeImage = (id: string) => {
  const idx = pendingImages.value.findIndex(i => i.id === id)
  if (idx === -1) return
  releasePreview(pendingImages.value[idx])
  pendingImages.value.splice(idx, 1)
}

const retryImage = (id: string) => {
  const img = pendingImages.value.find(i => i.id === id)
  if (!img || img.state !== 'failed') return
  img.state = 'uploading'
  img.error = undefined
  uploadOne(img)
}

/** 走人时把没 revoke 的 object URL 收掉，否则这些 blob 会一直占着内存 */
onUnmounted(() => pendingImages.value.forEach(releasePreview))

const uploadingCount = computed(() => pendingImages.value.filter(i => i.state === 'uploading').length)
const readyImages = computed(() => pendingImages.value.filter(i => i.state === 'done' && i.src))

/**
 * 能不能发。
 *
 * **有文字或有图都能发** —— 只发图让模型描述是合理用法。
 * 但还在上传的时候不让发：那会把一张正在传的图悄悄漏掉。
 */
const canSend = computed(() =>
  (!!promptText.value.trim() || readyImages.value.length > 0)
  && uploadingCount.value === 0
  && !isRunning.value
  && !!props.deckId)

const handleSend = () => {
  if (!canSend.value || !props.deckId) return
  expandedEntries.clear()
  expandedGroups.clear()
  const selectedIds = activeElementIdList.value.length ? [...activeElementIdList.value] : undefined
  const images = readyImages.value.map(i => i.src!)

  // 失败的那些不会被发出去，但也不能默默留在输入区假装还在等 ——
  // 说一声再清掉，用户要么重传要么算了
  const failed = pendingImages.value.filter(i => i.state === 'failed').length
  if (failed > 0) message.warning(`有 ${failed} 张图片上传失败，未随本次发送`)

  agentStore.submitTask(props.deckId, promptText.value.trim(), selectedIds, images.length ? images : undefined)

  promptText.value = ''
  pendingImages.value.forEach(releasePreview)
  pendingImages.value = []
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

/* ── 思考过程分组 ────────────────────────────────────────────────
 *
 * 分组规则本身是纯函数，在 `@/utils/agentLogGroups`（那里测得到）。
 * 这里只留**跟界面状态有关**的两件事：这组还在不在长、用户手动开合过没有。
 */
const groupStartOf = computed(() => groupStarts(log.value))
const stats = computed(() => groupStats(log.value))

/** 这一组是不是「还在长」的那一组 —— 正在跑，且它就贴着日志末尾 */
const isGroupLive = (start: number) =>
  isRunning.value && stats.value.get(start)?.end === log.value.length - 1

/**
 * 和思考小块同一套规矩：**正在进行的摊开，结束了收起来**。
 * expandedGroups 当手动开关用，按一下就是把默认翻过来。
 */
const isGroupOpen = (start: number) =>
  isGroupLive(start) ? !expandedGroups.has(start) : expandedGroups.has(start)

const toggleGroup = (start: number) => {
  if (expandedGroups.has(start)) expandedGroups.delete(start)
  else expandedGroups.add(start)
}

const groupSummary = (start: number) => summarizeGroup(stats.value.get(start))

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

/** R-63：策划稿的总页数（方案卡片的摘要行用） */
const planPageCount = (plan: DeckPlanMessage): number =>
  plan.sections.reduce((n, s) => n + s.slides.length, 0)

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

  // 排队中 / 未送达。**整条压暗**，不只是加一个角标 ——
  // 这条消息和上面那些已经被处理掉的长得一样的话，
  // 「它还没被处理」这件事就等于没说
  &.queued {
    background: #f2f4f6;
    .entry-content { color: #7a8894; }
  }
  &.rejected {
    background: #fdf0ef;
    .entry-content {
      color: #99807e;
      text-decoration: line-through;
    }
  }

  .delivery-tag {
    margin-left: 6px;
    font-weight: 500;

    &.queued { color: #7a8894; }
    &.rejected { color: #c0392b; }
  }
  .delivery-reason {
    margin-top: 4px;
    font-size: 11px;
    color: #c0392b;
    line-height: 1.4;
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
// 思考过程的组头。
//
// 一次任务在面板上是「想 → 调工具 → 想 → 调工具 → 说一句话」，
// 前面一长串是过程、最后那句才是结果。回看时想找的几乎总是结果，
// 而过程能占掉整屏 —— 所以过程整体收成这一行，点开才展开。
//
// 视觉上刻意比工具调用更轻（无边框、灰字）：它是**目录**不是内容，
// 抢眼了反而把真正要看的那句话压下去。
.process-header {
  padding: 5px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 11px;
  color: #8a8a8a;
  border-radius: 6px;
  user-select: none;

  &:hover { background: #f2f2f2; }

  // 还在想的时候把标题也点亮一点，和下方摊开的内容呼应
  &.live {
    color: $themeColor;
    .process-icon { opacity: 1; }
  }
}
.process-icon {
  font-size: 11px;
  opacity: .6;
  flex-shrink: 0;
}
.process-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 组内的小块整体缩进，让「这些属于上面那一行」一眼看得出来。
// 左边那条竖线是**唯一**的从属关系提示 —— 只靠缩进的话，
// 滚动到中间时看不出自己在不在组里
.in-group {
  margin-left: 10px;
  border-left: 2px solid #ececec;
  padding-left: 8px;
  border-radius: 0 6px 6px 0;
}

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
  align-items: center;
}

// R-68 · 上传入口与待发送图片
.upload-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
  color: #666;
  cursor: pointer;
  transition: background-color .2s, color .2s;

  &:hover:not(.disabled) {
    background-color: rgba(0, 0, 0, .06);
    color: $themeColor;
  }

  &.disabled {
    color: #ccc;
    cursor: not-allowed;
  }
}
.file-input {
  display: none;
}
.pending-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.pending-image {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid $borderColor;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  &.failed {
    border-color: #d95c5c;
  }

  .mask {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, .45);
    color: #fff;
    font-size: 11px;

    &.retry {
      cursor: pointer;
      background: rgba(217, 92, 92, .65);
    }
  }

  .spin {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, .35);
    border-top-color: #fff;
    border-radius: 50%;
    animation: pending-image-spin .7s linear infinite;
  }

  .remove {
    position: absolute;
    top: 0;
    right: 0;
    width: 16px;
    height: 16px;
    line-height: 14px;
    text-align: center;
    background: rgba(0, 0, 0, .55);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
    border-bottom-left-radius: 4px;
  }
}
@keyframes pending-image-spin {
  to { transform: rotate(360deg); }
}
.entry-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;

  img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid $borderColor;
    display: block;
  }
}
.ask-entry {
  padding: 8px 12px;
  margin: 4px 0;
  border: 1px solid rgba(90, 155, 213, 0.45);
  border-radius: 6px;
  background: rgba(90, 155, 213, 0.08);

  .ask-question {
    font-size: 13px;
    line-height: 1.5;
    margin-bottom: 8px;
  }
  .ask-actions {
    display: flex;
    gap: 8px;
  }
  .ask-answered {
    font-size: 12px;
    color: var(--textColorMuted, #888);
  }
}

// R-63：策划稿方案卡片。比工具条目更显眼 —— 它是闸门要用户确认的**方案**，
// 不是过程日志；默认摊开，点标题行收起
.plan-entry {
  border: 1px solid rgba(125, 105, 205, 0.5);
  border-radius: 6px;
  background: rgba(125, 105, 205, 0.06);
  overflow: hidden;
}
.plan-header {
  padding: 7px 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;

  &:hover { background: rgba(125, 105, 205, 0.08); }
}
.plan-icon { font-size: 13px; }
.plan-title {
  font-weight: 600;
  color: #5b4a9e;
  flex: 1;
}
.plan-body {
  border-top: 1px solid rgba(125, 105, 205, 0.25);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-line {
  font-size: 11px;
  line-height: 1.5;
  color: #555;

  b {
    display: inline-block;
    margin-right: 6px;
    color: #5b4a9e;
    flex-shrink: 0;
  }
}
.plan-section {
  margin-top: 2px;
}
.plan-sec-title {
  font-size: 11px;
  font-weight: 600;
  color: #444;
  margin-bottom: 3px;
}
.plan-sec-purpose {
  font-weight: 400;
  font-size: 10px;
  color: #999;
  margin-left: 4px;
}
.plan-pages {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.plan-page {
  font-size: 10px;
  padding: 2px 6px;
  background: rgba(125, 105, 205, 0.1);
  border-radius: 10px;
  color: #5b4a9e;
  white-space: nowrap;

  em {
    font-style: normal;
    color: #8d7cc9;
  }
}

</style>
