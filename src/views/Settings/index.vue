<template>
  <div class="settings-page">
    <div class="settings-sidebar">
      <div class="sidebar-header">
        <span class="logo">Rabbit</span>
        <span class="sub">设置</span>
      </div>

      <div class="sidebar-nav">
        <template v-if="authStore.isAdmin">
          <div
            class="nav-item"
            :class="{ active: currentTab === 'providers' }"
            @click="currentTab = 'providers'"
          >模型服务</div>
          <div
            class="nav-item"
            :class="{ active: currentTab === 'models' }"
            @click="currentTab = 'models'"
          >模型管理</div>
          <div
            class="nav-item"
            :class="{ active: currentTab === 'roles' }"
            @click="currentTab = 'roles'"
          >角色配置</div>
          <div
            class="nav-item"
            :class="{ active: currentTab === 'users' }"
            @click="currentTab = 'users'"
          >用户管理</div>
        </template>
        <div
          class="nav-item"
          :class="{ active: currentTab === 'personal' }"
          @click="currentTab = 'personal'"
        >个人设置</div>
      </div>

      <div class="sidebar-footer">
        <div class="nav-item back" @click="emit('back')">
          <i-icon-park-outline:left /> 返回
        </div>
      </div>
    </div>

    <div class="settings-content">
      <ProviderSettings v-if="currentTab === 'providers'" />
      <ModelSettings v-else-if="currentTab === 'models'" />
      <RoleSettings v-else-if="currentTab === 'roles'" />
      <UserManagement v-else-if="currentTab === 'users'" />
      <PersonalSettings v-else-if="currentTab === 'personal'" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref } from 'vue'
import { useAuthStore } from '@/store'

import ProviderSettings from './ProviderSettings.vue'
import ModelSettings from './ModelSettings.vue'
import RoleSettings from './RoleSettings.vue'
import UserManagement from './UserManagement.vue'
import PersonalSettings from './PersonalSettings.vue'

const authStore = useAuthStore()

const currentTab = ref(authStore.isAdmin ? 'providers' : 'personal')

const emit = defineEmits<{
  (event: 'back'): void
}>()
</script>

<style lang="scss" scoped>
.settings-page {
  height: 100%;
  display: flex;
  background: #fff;
}
.settings-sidebar {
  width: 200px;
  background: #f8f9fa;
  border-right: 1px solid $borderColor;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}
.sidebar-header {
  padding: 20px 16px 16px;
  border-bottom: 1px solid $borderColor;
}
.logo {
  font-size: 18px;
  font-weight: 700;
  background: linear-gradient(270deg, #d897fd, #33bcfc);
  background-clip: text;
  color: transparent;
}
.sub {
  font-size: 14px;
  color: #999;
  margin-left: 8px;
}
.sidebar-nav {
  flex: 1;
  padding: 8px 0;
}
.nav-item {
  padding: 10px 16px;
  font-size: 14px;
  color: #666;
  cursor: pointer;
  border-left: 3px solid transparent;
  transition: all $transitionDelay;

  &:hover {
    color: $textColor;
    background: #f0f0f0;
  }
  &.active {
    color: $themeColor;
    border-left-color: $themeColor;
    background: #fff;
    font-weight: 500;
  }
  &.back {
    display: flex;
    align-items: center;
    gap: 6px;
  }
}
.sidebar-footer {
  border-top: 1px solid $borderColor;
  padding: 8px 0;
}
.settings-content {
  flex: 1;
  min-width: 0;
  padding: 24px 32px;
  @include overflow-overlay();
}
</style>
