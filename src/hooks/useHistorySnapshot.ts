import { debounce, throttle} from 'lodash'
import { useSnapshotStore } from '@/store'

export default () => {
  const snapshotStore = useSnapshotStore()

  // 添加历史快照(历史记录)
  const addHistorySnapshot = debounce(function() {
    snapshotStore.addSnapshot()
  }, 300, { trailing: true })

  // R-12: agent 整份替换 deck 后调此方法 —— 不走防抖，一次 agent 动作 = 一个快照
  const addAgentSnapshot = (actionLabel?: string) => {
    snapshotStore.addAgentSnapshot(actionLabel)
  }

  // 重做
  const redo = throttle(function() {
    snapshotStore.reDo()
  }, 100, { leading: true, trailing: false })

  // 撤销
  const undo = throttle(function() {
    snapshotStore.unDo()
  }, 100, { leading: true, trailing: false })

  return {
    addHistorySnapshot,
    addAgentSnapshot,
    redo,
    undo,
  }
}
