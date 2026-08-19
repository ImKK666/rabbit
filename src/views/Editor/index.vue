<template>
  <div class="rabbit-editor">
    <EditorHeader class="layout-header" @openSettings="emit('openSettings')" @backToList="emit('backToList')" @titleChange="emit('saveDeck')" />
    <div class="layout-content">
      <Thumbnails class="layout-content-left" />
      <div class="layout-content-center">
        <CanvasTool class="center-top" />
        <!--
          所有权横幅。画布锁住时**必须有一个看得见的出口** ——
          写入守卫在 slidesStore 里，用户拖不动元素时如果界面什么都不说，
          表现就是「编辑器坏了」。这条横幅是那把锁唯一的解释和唯一的钥匙。
        -->
        <div class="deck-locked-banner" v-if="isDeckLocked">
          <span class="text">Agent 正在修改这份文稿，画布暂时锁定</span>
          <span class="takeover" @click="agentStore.takeOver()">接管并编辑</span>
        </div>
        <Canvas class="center-body" :style="{ height: `calc(100% - ${remarkHeight + 40}px)` }" />
        <Remark
          class="center-bottom" 
          v-model:height="remarkHeight" 
          :style="{ height: `${remarkHeight}px` }"
        />
      </div>
      <Toolbar class="layout-content-right" />
      <AgentPanel class="layout-content-agent" :deckId="currentDeckId" />
    </div>
  </div>

  <SelectPanel v-if="showSelectPanel" />
  <SearchPanel v-if="showSearchPanel" />
  <NotesPanel v-if="showNotesPanel" />
  <MarkupPanel v-if="showMarkupPanel" />
  <SymbolPanel v-if="showSymbolPanel" />
  <ImageLibPanel v-if="showImageLibPanel" />
  <ChartDataEditorDialog />
  <LatexEditorDialog />

  <Modal
    :visible="!!dialogForExport" 
    :width="680"
    @closed="closeExportDialog()"
  >
    <ExportDialog />
  </Modal>

  <Modal
    :visible="!!showAIPPTDialog"
    :width="720"
    :closeOnClickMask="false"
    :closeOnEsc="false"
    closeButton
    :wrapStyle="{ opacity: showAIPPTDialog === 'running' ? 0 : 1 }"
    @closed="closeAIPPTDialog()"
  >
    <AIPPTDialog />
  </Modal>

</template>

<script lang="ts" setup>
import { ref, inject } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useAgentStore, useSlidesStore } from '@/store'
import useGlobalHotkey from '@/hooks/useGlobalHotkey'
import usePasteEvent from '@/hooks/usePasteEvent'

import EditorHeader from './EditorHeader/index.vue'
import Canvas from './Canvas/index.vue'
import CanvasTool from './CanvasTool/index.vue'
import Thumbnails from './Thumbnails/index.vue'
import Toolbar from './Toolbar/index.vue'
import Remark from './Remark/index.vue'
import AgentPanel from './AgentPanel.vue'
import ChartDataEditorDialog from './ChartDataEditorDialog.vue'
import LatexEditorDialog from './LatexEditorDialog.vue'
import ExportDialog from './ExportDialog/index.vue'
import SelectPanel from './SelectPanel.vue'
import SearchPanel from './SearchPanel.vue'
import NotesPanel from './NotesPanel.vue'
import SymbolPanel from './SymbolPanel.vue'
import MarkupPanel from './MarkupPanel.vue'
import ImageLibPanel from './ImageLibPanel.vue'
import AIPPTDialog from './AIPPTDialog.vue'
import Modal from '@/components/Modal.vue'

const mainStore = useMainStore()
const agentStore = useAgentStore()
const slidesStore = useSlidesStore()
agentStore.init()

// 画布锁定状态。写入守卫在 slidesStore 里，这里只负责让锁**看得见**
const { isDeckLocked } = storeToRefs(slidesStore)

const {
  dialogForExport,
  showSelectPanel,
  showSearchPanel,
  showNotesPanel,
  showSymbolPanel,
  showMarkupPanel,
  showImageLibPanel,
  showAIPPTDialog,
} = storeToRefs(mainStore)

const currentDeckId = inject<number | null>('currentDeckId', null)

const closeExportDialog = () => mainStore.setDialogForExport('')
const closeAIPPTDialog = () => mainStore.setAIPPTDialogState(false)

const remarkHeight = ref(40)

useGlobalHotkey()
usePasteEvent()

const emit = defineEmits<{
  (event: 'backToList'): void
  (event: 'openSettings'): void
  (event: 'saveDeck'): void
}>()
</script>

<style lang="scss" scoped>
.rabbit-editor {
  height: 100%;
}

// 所有权横幅。放在 CanvasTool 和 Canvas 之间，紧贴画布上沿 ——
// 它解释的是「为什么拖不动」，离画布越近越容易被联系起来
.deck-locked-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  font-size: 12px;
  color: #8a6d13;
  background-color: #fdf6e3;
  border-bottom: 1px solid #f0e0b0;

  .text {
    flex: 1;
  }

  .takeover {
    padding: 2px 10px;
    color: #fff;
    background-color: $themeColor;
    border-radius: $borderRadius;
    cursor: pointer;
    user-select: none;

    &:hover {
      opacity: .85;
    }
  }
}
.layout-header {
  height: 40px;
}
.layout-content {
  height: calc(100% - 40px);
  display: flex;
}
.layout-content-left {
  width: 160px;
  height: 100%;
  flex-shrink: 0;
}
.layout-content-agent {
  flex-shrink: 0;
}
.layout-content-center {
  flex: 1;
  min-width: 0;

  .center-top {
    height: 40px;
  }
}
.layout-content-right {
  width: 260px;
  height: 100%;
}
</style>
