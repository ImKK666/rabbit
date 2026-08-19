<template>
  <div class="asset-settings">
    <div class="section-header">
      <h3>素材来源</h3>
      <span class="hint">图从哪来。生图和搜图是两个独立的 agent 工具，生图被限流时它会自己改用搜图</span>
    </div>

    <!-- 搜图 -->
    <div class="form-card">
      <div class="card-title">
        搜图 <span class="sub">快（~1 秒）、配额松，适合人物 / 实物 / 场景</span>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>图库</label>
          <Select v-model:value="form.searchProvider" :options="searchOptions" />
        </div>
        <div class="form-group" v-if="needsKey">
          <label>
            API Key
            <span class="saved-tag" v-if="hasSearchApiKey">已保存，留空则不修改</span>
          </label>
          <Input v-model:value="form.searchApiKey" :placeholder="hasSearchApiKey ? '••••••••（留空不改）' : '填入 key'" />
        </div>
      </div>

      <div class="note" v-if="form.searchProvider === 'wikimedia'">
        Wikimedia Commons <strong>不需要注册</strong>，是「什么都没配也能用」的兜底 ——
        但实测有两个硬伤，能拿到别家的 key 就别用它：<br>
        ① 它是百科档案库不是策展图库，具体物件和中文查询还行，
        抽象商业概念（如「团队协作」）常常不对题；<br>
        ② <strong>从部分网络出去是时通时不通的</strong>（同一台机器先 4.9 秒返回、
        十分钟后完全连不上），所以搜图设了 8 秒硬超时，失败会直接回报而不是干等。
      </div>

      <div class="form-group switch-row">
        <Switch v-model:value="form.searchEnabled" />
        <span>启用搜图工具</span>
      </div>
    </div>

    <!-- 生图 -->
    <div class="form-card">
      <div class="card-title">
        生图 <span class="sub">慢（15~50 秒）、配额紧、要钱，但能精确匹配版面需求</span>
      </div>

      <div class="form-group">
        <label>模型</label>
        <Select v-model:value="imageModelValue" :options="imageModelOptions" />
        <div class="note" v-if="imageModelOptions.length <= 1">
          还没有可用的生图模型 —— 去「模型管理」把支持出图的模型勾上「支持图片」并启用。
        </div>
      </div>

      <div class="form-group">
        <label>图片长边上限（像素）</label>
        <NumberInput v-model:value="form.maxEdgePx" :min="320" :max="4096" :step="80" style="width: 160px;" />
        <div class="note">
          实测单张生图 1~2 MB，一份 12 页的 deck 配 8 张就是 16 MB，导出的 PPTX 会大得离谱。
          落库前按这个上限压一道。
        </div>
      </div>

      <div class="form-group switch-row">
        <Switch v-model:value="form.generateEnabled" />
        <span>启用生图工具</span>
      </div>

      <div class="note rate-hint">
        生图的每分钟调用上限在「<strong>模型管理</strong>」里按模型配置。
        实测 <code>gemini-3.1-flash-image</code> 连发第 4 张就会被上游 429，建议填 3。
      </div>
    </div>

    <div class="test-result" v-if="testResult">
      <div :class="testResult.search?.ok ? 'success' : 'fail'">
        搜图：{{ testResult.search?.ok
          ? `${testResult.search.count} 条结果（${testResult.search.elapsed}ms）`
          : testResult.search?.error }}
      </div>
      <div class="samples" v-if="testResult.search?.sample?.length">
        <img v-for="s in testResult.search.sample" :key="s.url" :src="s.url" :title="`${s.width}×${s.height}`" />
      </div>
      <div :class="testResult.generate?.ok ? 'success' : 'fail'">
        生图：{{ testResult.generate?.ok ? `模型可用（${testResult.generate.model}）` : testResult.generate?.error }}
      </div>
    </div>

    <div class="form-actions">
      <Button size="small" @click="handleTest" :disabled="testing || saving">
        {{ testing ? '测试中...' : '测试' }}
      </Button>
      <Button size="small" type="primary" @click="handleSave" :disabled="saving">
        {{ saving ? '保存中...' : '保存' }}
      </Button>
    </div>
    <!-- 测试只搜一次图，不生图：生图一次 15~50 秒还要花钱，不该挂在测试按钮上 -->
    <div class="tip">测试用<strong>已保存</strong>的配置真实搜一次图；生图只校验模型是否可用，不会真的出图（那要花钱）。</div>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { adminApi } from '@/services'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'
import NumberInput from '@/components/NumberInput.vue'

const searchOptions = [
  { label: 'Wikimedia Commons（免注册）', value: 'wikimedia' },
  { label: 'Pexels', value: 'pexels' },
  { label: 'Unsplash', value: 'unsplash' },
  { label: 'Pixabay', value: 'pixabay' },
]
const KEYLESS = ['wikimedia']

interface ModelRow { id: number, displayName: string, supportsImages: boolean, enabled: boolean }

const form = reactive({
  searchProvider: 'wikimedia' as string | number,
  searchApiKey: '',
  searchEnabled: false,
  imageModelConfigId: null as number | null,
  generateEnabled: false,
  maxEdgePx: 1600,
})
const hasSearchApiKey = ref(false)
const models = ref<ModelRow[]>([])
const saving = ref(false)
const testing = ref(false)
const testResult = ref<any>(null)

const needsKey = computed(() => !KEYLESS.includes(String(form.searchProvider)))

/**
 * 只列「支持图片」且已启用的模型 —— 列全部只会让人选错。
 *
 * 第一项是 value=0 的「未选择」：Select 不接受 null，用 0 当哨兵值，
 * 而**哨兵值必须在选项里有对应项**，否则界面上会直接显示一个裸的 `0`
 * （第一版就是这样，截图里一眼看到）。
 */
const imageModelOptions = computed(() => [
  { label: '未选择', value: 0 },
  ...models.value.filter(m => m.supportsImages && m.enabled).map(m => ({ label: m.displayName, value: m.id })),
])

// Select 组件的 value 不接受 null，用 0 当「未选择」的哨兵值在边界上转换
const imageModelValue = computed({
  get: () => form.imageModelConfigId ?? 0,
  set: (v: string | number) => {
    form.imageModelConfigId = Number(v) || null
  },
})

const apply = (a: any) => {
  form.searchProvider = a.searchProvider
  form.searchApiKey = '' // 永远不回显 key
  form.searchEnabled = a.searchEnabled
  form.imageModelConfigId = a.imageModelConfigId
  form.generateEnabled = a.generateEnabled
  form.maxEdgePx = a.maxEdgePx
  hasSearchApiKey.value = a.hasSearchApiKey
}

const load = async () => {
  try {
    const [a, m] = await Promise.all([adminApi.getAssetSource(), adminApi.listModels()])
    apply((a as any).assetSource)
    models.value = (m as any).models || []
  }
  catch { /* 首次进入是空的，正常 */ }
}

const handleSave = async () => {
  saving.value = true
  testResult.value = null
  try {
    const payload: Record<string, unknown> = {
      searchProvider: String(form.searchProvider),
      searchEnabled: form.searchEnabled,
      imageModelConfigId: form.imageModelConfigId,
      generateEnabled: form.generateEnabled,
      maxEdgePx: form.maxEdgePx,
    }
    if (form.searchApiKey) payload.searchApiKey = form.searchApiKey
    const res = await adminApi.saveAssetSource(payload) as any
    apply(res.assetSource)
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '保存失败')
  }
  finally {
    saving.value = false
  }
}

const handleTest = async () => {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await adminApi.testAssetSource()
  }
  catch (err: any) {
    testResult.value = { search: { ok: false, error: err?.response?.data?.error || '测试请求失败' } }
  }
  finally {
    testing.value = false
  }
}

onMounted(load)
</script>

<style lang="scss" scoped>
.section-header {
  margin-bottom: 20px;

  h3 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  .hint { font-size: 12px; color: #999; }
}
.form-card {
  border: 1px solid $borderColor;
  border-radius: 8px;
  padding: 20px;
  max-width: 720px;
  margin-bottom: 16px;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 14px;

  .sub { font-size: 12px; font-weight: normal; color: #999; margin-left: 8px; }
}
.form-row {
  display: flex;
  gap: 12px;

  .form-group { flex: 1; min-width: 0; }
}
.form-group {
  margin-bottom: 12px;

  label {
    display: block;
    font-size: 13px;
    color: #666;
    margin-bottom: 4px;
  }
}
.saved-tag {
  margin-left: 6px;
  font-size: 11px;
  color: #27ae60;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #666;
}
.note {
  font-size: 12px;
  color: #999;
  line-height: 1.6;
  margin-top: 6px;

  code { color: $themeColor; }
}
.rate-hint {
  border-top: 1px dashed $borderColor;
  padding-top: 10px;
  margin-top: 4px;
}
.test-result {
  max-width: 720px;
  margin-bottom: 12px;
  font-size: 13px;

  .success { color: #27ae60; }
  .fail { color: #e74c3c; }
}
.samples {
  display: flex;
  gap: 8px;
  margin: 8px 0;

  img {
    width: 96px;
    height: 64px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid $borderColor;
  }
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  max-width: 720px;
}
.tip {
  max-width: 720px;
  margin-top: 10px;
  font-size: 12px;
  color: #999;
  text-align: right;
}
</style>
