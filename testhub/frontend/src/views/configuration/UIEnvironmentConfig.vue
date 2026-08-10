<template>
  <div class="ui-env-config">
    <div class="page-header">
      <h1>{{ $t('configuration.uiEnv.title') }}</h1>
      <p>{{ $t('configuration.uiEnv.description') }}</p>
    </div>

    <div class="main-content">
      <div class="check-section">
        <el-button type="primary" @click="checkEnvironment" :loading="checking">
          <el-icon><Refresh /></el-icon>
          {{ $t('configuration.uiEnv.checkEnvironment') }}
        </el-button>
        <div v-if="lastCheckTime" class="last-check">
          {{ $t('configuration.uiEnv.lastCheckTime') }}: {{ lastCheckTime }}
        </div>
      </div>

      <div v-if="environmentData" class="env-status-grid">
        <div class="os-info-card">
          <h3>{{ $t('configuration.uiEnv.operatingSystem') }}</h3>
          <div class="os-name">{{ environmentData.os }}</div>
        </div>

        <!-- 系统浏览器 (Selenium) -->
        <div class="section-title">
          <h3>{{ $t('configuration.uiEnv.systemBrowsers') }}</h3>
        </div>
        <div class="browser-cards">
          <div v-for="browser in environmentData.system_browsers" :key="browser.name" class="browser-card">
              <div class="browser-content">
                <div class="browser-icon">
                  <img :src="getBrowserIcon(browser.name)" :alt="browser.name" />
                </div>
                <div class="browser-info">
                  <h3>{{ formatBrowserName(browser.name) }}</h3>
                  <div class="status-row">
                    <el-tag :type="browser.installed ? 'success' : 'info'" effect="dark">
                      {{ browser.installed ? (browser.version || $t('configuration.uiEnv.installed')) : $t('configuration.uiEnv.notInstalled') }}
                    </el-tag>
                  </div>
                </div>
              </div>
          </div>
        </div>

        <!-- Playwright 浏览器 -->
        <div class="section-title">
          <h3>{{ $t('configuration.uiEnv.playwrightBrowsers') }}</h3>
        </div>
        <div class="browser-cards">
          <div v-for="browser in environmentData.playwright_browsers" :key="browser.name" class="browser-card">
              <div class="browser-content">
                <div class="browser-icon">
                  <img :src="getBrowserIcon(browser.name)" :alt="browser.name" />
                </div>
                <div class="browser-info">
                  <h3>{{ formatBrowserName(browser.name) }}</h3>
                  <div class="status-row">
                    <el-tag :type="browser.installed ? 'success' : 'warning'" effect="dark">
                      {{ browser.installed ? (browser.version || $t('configuration.uiEnv.installed')) : $t('configuration.uiEnv.notInstalled') }}
                    </el-tag>
                  </div>
                </div>
              </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '@/utils/api'

const { t } = useI18n()

const checking = ref(false)
const installing = ref(null)
const lastCheckTime = ref('')
const environmentData = ref(null)

const getBrowserIcon = (name) => {
  const iconMap = {
    'chrome': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/chrome/chrome_48x48.png',
    'firefox': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/firefox/firefox_48x48.png',
    'safari': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/safari/safari_48x48.png',
    'edge': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/edge/edge_48x48.png',
    'chromium': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/chromium/chromium_48x48.png',
    'webkit': 'https://raw.githubusercontent.com/alrra/browser-logos/main/src/webkit/webkit_48x48.png'
  }
  return iconMap[name] || ''
}

const formatBrowserName = (name) => {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const checkEnvironment = async () => {
  checking.value = true
  try {
    const response = await api.get('/ui-automation/config/environment/check_environment/')
    environmentData.value = response.data
    lastCheckTime.value = new Date().toLocaleString()
    ElMessage.success(t('configuration.uiEnv.messages.checkSuccess'))
  } catch (error) {
    console.error('Environment check failed:', error)
    ElMessage.error(t('configuration.uiEnv.messages.checkFailed'))
  } finally {
    checking.value = false
  }
}

const installDriver = async (browserName) => {
  installing.value = browserName
  try {
    await api.post('/ui-automation/config/environment/install_driver/', { browser: browserName })
    ElMessage.success(t('configuration.uiEnv.messages.installSuccess', { browser: formatBrowserName(browserName) }))
    // Re-check environment
    await checkEnvironment()
  } catch (error) {
    console.error('Driver installation failed:', error)
    ElMessage.error(`${t('configuration.uiEnv.messages.installFailed')}: ${error.response?.data?.error || error.message}`)
  } finally {
    installing.value = null
  }
}

onMounted(() => {
  checkEnvironment()
})
</script>

<style scoped>
.ui-env-config {
  padding: 4px 2px 8px;
  max-width: 1100px;
  margin: 0 auto;
}

.page-header {
  text-align: left;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 20px;
  font-weight: 700;
  color: #173b2c;
  margin: 0 0 6px;
}

.page-header p {
  color: #5f7a6d;
  font-size: 13px;
  margin: 0;
}

.check-section {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-bottom: 16px;
  gap: 12px;
}

.last-check {
  font-size: 12px;
  color: #87a296;
}

.env-status-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.os-info-card {
  background: white;
  padding: 14px 16px;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);
  border: 1px solid #dcebe4;
  text-align: left;
}

.os-name {
  font-size: 18px;
  font-weight: 700;
  color: #409eff;
  margin-top: 6px;
}

.section-title {
  margin: 8px 0 4px;
  border-left: 3px solid #409eff;
  padding-left: 10px;
}

.section-title h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: #173b2c;
}

.browser-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.browser-card {
  background: white;
  border-radius: 10px;
  padding: 14px;
  box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);
  border: 1px solid #dcebe4;
  transition: box-shadow 0.15s;
  cursor: default;
}

.browser-card:hover {
  box-shadow: 0 2px 8px rgba(20, 80, 60, 0.12);
}

.browser-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}

.browser-icon {
  width: 40px;
  height: 40px;
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.browser-icon img {
  width: 36px;
  height: 36px;
  object-fit: contain;
}

.browser-info {
  width: 100%;
  text-align: center;
  margin-bottom: 0;
}

.browser-info h3 {
  margin: 0 0 8px;
  color: #173b2c;
  font-size: 14px;
  font-weight: 650;
}

.status-row {
  display: flex;
  justify-content: center;
  margin-bottom: 5px;
}

.browser-actions {
  margin-top: 10px;
  width: 100%;
  display: flex;
  justify-content: center;
}
</style>
