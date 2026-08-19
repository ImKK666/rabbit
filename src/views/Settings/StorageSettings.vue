<template>
  <div class="storage-settings">
    <div class="section-header">
      <h3>对象存储</h3>
      <span class="hint">agent 生成 / 搜到的图片存在这里，画布和导出都从这里读</span>
    </div>

    <div class="form-card">
      <div class="form-group">
        <label>服务商</label>
        <Select v-model:value="form.provider" :options="providerOptions" />
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>SecretId</label>
          <Input v-model:value="form.secretId" placeholder="AKID..." />
        </div>
        <div class="form-group">
          <label>
            SecretKey
            <span class="saved-tag" v-if="hasSecretKey">已保存，留空则不修改</span>
          </label>
          <Input v-model:value="form.secretKey" :placeholder="hasSecretKey ? '••••••••（留空不改）' : '填入密钥'" />
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>存储桶</label>
          <Input v-model:value="form.bucket" placeholder="rabbit-1300000000" />
        </div>
        <div class="form-group">
          <label>地域</label>
          <Input v-model:value="form.region" placeholder="ap-guangzhou" />
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label>key 前缀</label>
          <Input v-model:value="form.prefix" placeholder="rabbit/" />
        </div>
        <div class="form-group">
          <label>自定义访问域名<span class="opt">（挂了 CDN 才填）</span></label>
          <Input v-model:value="form.publicBaseUrl" placeholder="留空用默认域名" />
        </div>
      </div>

      <div class="effective" v-if="effectiveBaseUrl">
        实际地址：<code>{{ effectiveBaseUrl }}/{{ form.prefix }}&lt;sha256&gt;</code>
      </div>

      <div class="form-group switch-row">
        <Switch v-model:value="form.enabled" />
        <span>启用（关闭后 agent 不会尝试写图片）</span>
      </div>

      <div class="test-result" v-if="testResult">
        <div :class="testResult.ok ? 'success' : 'fail'">
          <template v-if="testResult.error">{{ testResult.error }}</template>
          <template v-else>
            {{ testResult.ok ? '连通' : '有问题' }}（{{ testResult.elapsed }}ms）·
            公有读 {{ testResult.publicReadable ? '✓' : '✗' }} ·
            CORS {{ testResult.corsAllowOrigin || '未配置' }}
          </template>
        </div>
        <div class="warn" v-for="w in testResult.warnings || []" :key="w">⚠ {{ w }}</div>
      </div>

      <div class="form-actions">
        <Button size="small" @click="handleTest" :disabled="testing || saving">
          {{ testing ? '测试中...' : '连接测试' }}
        </Button>
        <Button size="small" type="primary" @click="handleSave" :disabled="saving">
          {{ saving ? '保存中...' : '保存' }}
        </Button>
      </div>

      <!--
        测试要跑真实往返（上传 → 匿名读 → 删除），用的是**已保存的**配置。
        不这么说明的话，改了框没保存就点测试，会得到一个看不懂的旧结果
      -->
      <div class="tip">连接测试会用<strong>已保存</strong>的配置真实上传一个小文件再删掉，请先保存。</div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, reactive, onMounted } from 'vue'
import { adminApi } from '@/services'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'

const providerOptions = [{ label: '腾讯云 COS', value: 'cos' }]

interface TestResult {
  ok: boolean
  elapsed?: number
  error?: string
  publicReadable?: boolean
  corsAllowOrigin?: string | null
  warnings?: string[]
}

const form = reactive({
  provider: 'cos' as string | number,
  secretId: '',
  secretKey: '',
  bucket: '',
  region: '',
  prefix: 'rabbit/',
  publicBaseUrl: '',
  enabled: false,
})
const hasSecretKey = ref(false)
const effectiveBaseUrl = ref('')
const saving = ref(false)
const testing = ref(false)
const testResult = ref<TestResult | null>(null)

const apply = (s: any) => {
  form.provider = s.provider
  form.secretId = s.secretId
  form.secretKey = '' // 永远不回显密钥
  form.bucket = s.bucket
  form.region = s.region
  form.prefix = s.prefix
  form.publicBaseUrl = s.publicBaseUrl
  form.enabled = s.enabled
  hasSecretKey.value = s.hasSecretKey
  effectiveBaseUrl.value = s.effectiveBaseUrl
}

const load = async () => {
  try {
    const res = await adminApi.getStorage() as any
    apply(res.storage)
  }
  catch { /* 首次进入没有配置是正常的 */ }
}

const handleSave = async () => {
  saving.value = true
  testResult.value = null
  try {
    const payload: Record<string, unknown> = {
      provider: String(form.provider),
      secretId: form.secretId,
      bucket: form.bucket,
      region: form.region,
      prefix: form.prefix,
      publicBaseUrl: form.publicBaseUrl,
      enabled: form.enabled,
    }
    // 空字符串会被后端当成「没动这个框」，这里索性不发
    if (form.secretKey) payload.secretKey = form.secretKey
    const res = await adminApi.saveStorage(payload) as any
    apply(res.storage)
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
    testResult.value = await adminApi.testStorage() as any
  }
  catch (err: any) {
    testResult.value = { ok: false, error: err?.response?.data?.error || '测试请求失败' }
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
  .opt { color: #bbb; }
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
.effective {
  font-size: 12px;
  color: #666;
  background: #f7f7f7;
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 12px;
  word-break: break-all;

  code { color: $themeColor; }
}
.test-result {
  margin: 12px 0;
  font-size: 13px;

  .success { color: #27ae60; }
  .fail { color: #e74c3c; }
  .warn { color: #b8860b; margin-top: 4px; font-size: 12px; }
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.tip {
  margin-top: 10px;
  font-size: 12px;
  color: #999;
}
</style>
