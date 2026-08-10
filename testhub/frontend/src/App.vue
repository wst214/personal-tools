<template>
  <el-config-provider :locale="elementLocale">
    <div id="app">
      <router-view />
    </div>
  </el-config-provider>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { ElConfigProvider } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { useAppStore } from '@/stores/app'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'

const userStore = useUserStore()
const appStore = useAppStore()

const elementLocale = computed(() => {
  return appStore.language === 'zh-cn' ? zhCn : en
})

onMounted(() => {
  userStore.initAuth()
  try {
    if (window.self !== window.top) {
      document.documentElement.classList.add('is-embedded')
      document.body.classList.add('is-embedded')
    }
  } catch {
    document.documentElement.classList.add('is-embedded')
    document.body.classList.add('is-embedded')
  }
})
</script>

<style>
#app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  height: 100vh;
  width: 100vw;
}

/* DevToolbox iframe：锁死视口高度，避免整页再出一条竖滚动条 */
html.is-embedded,
html.is-embedded body,
html.is-embedded #app {
  height: 100%;
  max-height: 100%;
  width: 100%;
  overflow: hidden;
}
</style>
