<template>
  <div class="provider-settings">
    <div class="section-header">
      <h3>模型服务商管理</h3>
      <Button type="primary" @click="openForm()">+ 添加服务商</Button>
    </div>

    <div class="provider-list">
      <div class="provider-card" v-for="p in providers" :key="p.id">
        <div class="card-header">
          <span class="provider-name">{{ p.name }}</span>
          <span class="provider-type">{{ typeLabels[p.providerType] || p.providerType }}</span>
        </div>
        <div class="card-body">
          <div class="card-field">{{ p.baseUrl }}</div>
          <div class="card-remark" v-if="p.remark">{{ p.remark }}</div>
        </div>
        <div class="card-actions">
          <Button size="small" @click="openForm(p)">编辑</Button>
          <Button size="small" @click="handleDelete(p.id)">删除</Button>
        </div>
      </div>
      <div class="empty-tip" v-if="!providers.length">暂无服务商，点击右上角添加</div>
    </div>

    <Modal :visible="formVisible" :width="480" @closed="formVisible = false">
      <div class="form-title">{{ editingId ? '编辑服务商' : '添加服务商' }}</div>
      <div class="form-group">
        <label>名称</label>
        <Input v-model:value="form.name" placeholder="如：我的 OpenAI 代理" />
      </div>
      <div class="form-group">
        <label>类型</label>
        <Select v-model:value="form.providerType" :options="typeOptions" />
      </div>
      <div class="form-group">
        <label>BaseURL</label>
        <Input v-model:value="form.baseUrl" placeholder="https://api.openai.com" />
      </div>
      <div class="form-group">
        <label>API Key</label>
        <Input v-model:value="form.apiKey" placeholder="sk-..." />
      </div>
      <div class="form-group">
        <label>备注</label>
        <TextArea v-model:value="form.remark" placeholder="可选" :rows="2" />
      </div>

      <div class="test-result" v-if="testResult">
        <span :class="testResult.ok ? 'success' : 'fail'">
          {{ testResult.ok ? `已连接 (${testResult.elapsed}ms)` : testResult.error }}
        </span>
      </div>

      <div class="form-actions">
        <Button size="small" @click="handleTest" :disabled="testing">
          {{ testing ? '测试中...' : '连接测试' }}
        </Button>
        <Button size="small" type="primary" @click="handleSave" :disabled="saving">保存</Button>
      </div>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, onMounted } from 'vue'
import { adminApi } from '@/services'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import TextArea from '@/components/TextArea.vue'
import Select from '@/components/Select.vue'
import Modal from '@/components/Modal.vue'

const typeLabels: Record<string, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  google: 'Google',
  deepseek: 'DeepSeek',
}
// DeepSeek 的端点是 OpenAI 兼容的，选 'OpenAI 兼容' 也能跑，
// 但思考过程会丢 —— reasoning_content 不在 @ai-sdk/openai 的解析范围内。
// 想看思考过程就得选这一项
const typeOptions = [
  { label: 'OpenAI 兼容', value: 'openai' },
  { label: 'DeepSeek（带思考过程）', value: 'deepseek' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
]

interface Provider {
  id: number
  name: string
  providerType: string
  baseUrl: string
  remark?: string
}

const providers = ref<Provider[]>([])
const formVisible = ref(false)
const editingId = ref<number | null>(null)
const form = reactive({ name: '', providerType: 'openai' as string | number, baseUrl: '', apiKey: '', remark: '' })
const testing = ref(false)
const saving = ref(false)
const testResult = ref<{ ok: boolean, elapsed?: number, error?: string } | null>(null)

const loadProviders = async () => {
  try {
    const res = await adminApi.listProviders() as any
    providers.value = res.providers || []
  }
  catch {
    providers.value = []
  }
}

const openForm = (p?: Provider) => {
  testResult.value = null
  if (p) {
    editingId.value = p.id
    form.name = p.name
    form.providerType = p.providerType
    form.baseUrl = p.baseUrl
    form.apiKey = ''
    form.remark = p.remark || ''
  }
  else {
    editingId.value = null
    form.name = ''
    form.providerType = 'openai'
    form.baseUrl = ''
    form.apiKey = ''
    form.remark = ''
  }
  formVisible.value = true
}

const handleTest = async () => {
  if (!editingId.value) {
    testResult.value = { ok: false, error: '请先保存服务商再测试连接' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const res = await adminApi.fetchModels(editingId.value) as any
    if (res.error) testResult.value = { ok: false, error: res.error }
    else testResult.value = { ok: true, elapsed: res.elapsed }
  }
  catch (err: any) {
    testResult.value = { ok: false, error: err?.response?.data?.error || '请求失败' }
  }
  finally {
    testing.value = false
  }
}

const handleSave = async () => {
  if (!form.name || !form.baseUrl) return
  saving.value = true
  try {
    const data = {
      name: form.name,
      providerType: String(form.providerType),
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      remark: form.remark,
    }
    if (editingId.value) {
      if (!form.apiKey) delete (data as any).apiKey
      await adminApi.updateProvider(editingId.value, data as any)
    }
    else {
      if (!form.apiKey) {
        saving.value = false; return
      }
      const res = await adminApi.createProvider(data as any) as any
      editingId.value = res.provider?.id || null
    }
    await loadProviders()
    if (!editingId.value) formVisible.value = false
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '保存失败')
  }
  finally {
    saving.value = false
  }
}

const handleDelete = async (id: number) => {
  if (!confirm('确定删除该服务商？关联的模型配置也会失效。')) return
  try {
    await adminApi.deleteProvider(id)
    await loadProviders()
  }
  catch (err: any) {
    alert(err?.response?.data?.error || '删除失败')
  }
}

onMounted(loadProviders)
</script>

<style lang="scss" scoped>
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;

  h3 { font-size: 18px; font-weight: 600; margin: 0; }
}
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.provider-card {
  border: 1px solid $borderColor;
  border-radius: 8px;
  padding: 16px;
}
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.provider-name {
  font-weight: 500;
  font-size: 15px;
}
.provider-type {
  font-size: 12px;
  color: #fff;
  background: $themeColor;
  padding: 1px 8px;
  border-radius: 10px;
}
.card-body {
  margin-bottom: 12px;
}
.card-field {
  font-size: 13px;
  color: #666;
  word-break: break-all;
}
.card-remark {
  font-size: 12px;
  color: #999;
  margin-top: 4px;
}
.card-actions {
  display: flex;
  gap: 8px;
}
.empty-tip {
  color: #999;
  text-align: center;
  padding: 40px 0;
}
.form-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
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
.test-result {
  margin: 12px 0;
  font-size: 13px;

  .success { color: #27ae60; }
  .fail { color: #e74c3c; }
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
