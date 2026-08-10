<template>
  <div class="app-automation-dashboard">
    <!-- 统计卡片 -->
    <div class="stats-section">
      <el-row :gutter="12">
        <el-col :span="6">
          <el-card shadow="never" class="stat-card">
            <div class="stat-content">
              <div class="stat-icon bg-blue">
                <el-icon><Cellphone /></el-icon>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ statistics.devices.total }}</div>
                <div class="stat-label">{{ $t('appAutomation.dashboard.totalDevices') }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="never" class="stat-card">
            <div class="stat-content">
              <div class="stat-icon bg-green">
                <el-icon><CircleCheck /></el-icon>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ statistics.devices.online }}</div>
                <div class="stat-label">{{ $t('appAutomation.dashboard.onlineDevices') }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="never" class="stat-card">
            <div class="stat-content">
              <div class="stat-icon bg-orange">
                <el-icon><Lock /></el-icon>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ statistics.devices.locked }}</div>
                <div class="stat-label">{{ $t('appAutomation.dashboard.lockedDevices') }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
        
        <el-col :span="6">
          <el-card shadow="never" class="stat-card">
            <div class="stat-content">
              <div class="stat-icon bg-purple">
                <el-icon><Document /></el-icon>
              </div>
              <div class="stat-info">
                <div class="stat-value">{{ statistics.test_cases.total }}</div>
                <div class="stat-label">{{ $t('appAutomation.dashboard.testCases') }}</div>
              </div>
            </div>
          </el-card>
        </el-col>
      </el-row>
    </div>
    
    <!-- 执行统计和最近执行 -->
    <el-row :gutter="12" class="content-section">
      <!-- 执行统计 -->
      <el-col :span="12">
        <el-card class="stat-chart" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ $t('appAutomation.dashboard.executionStatistics') }}</span>
            </div>
          </template>
          <div class="chart-container">
            <div class="stat-item">
              <div class="stat-label">{{ $t('appAutomation.dashboard.totalExecutions') }}</div>
              <div class="stat-value large">{{ statistics.executions.total }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">{{ $t('appAutomation.dashboard.successCount') }}</div>
              <div class="stat-value success">{{ statistics.executions.success }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">{{ $t('appAutomation.dashboard.failedCount') }}</div>
              <div class="stat-value danger">{{ statistics.executions.failed }}</div>
            </div>
            <div class="stat-item">
              <div class="stat-label">{{ $t('appAutomation.dashboard.passRate') }}</div>
              <div class="stat-value" :class="getPassRateClass(statistics.executions.pass_rate)">
                {{ statistics.executions.pass_rate }}%
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
      
      <!-- 最近执行记录 -->
      <el-col :span="12">
        <el-card class="recent-executions" shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ $t('appAutomation.dashboard.recentExecutions') }}</span>
              <el-button type="primary" size="small" @click="$router.push('/app-automation/executions')">
                {{ $t('appAutomation.dashboard.viewAll') }}
              </el-button>
            </div>
          </template>
          <div v-if="loading" class="loading-container">
            <el-empty :description="$t('appAutomation.common.loading')" />
          </div>
          <div v-else-if="statistics.recent_executions.length === 0" class="empty-container">
            <el-empty :description="$t('appAutomation.dashboard.noExecutionRecords')" />
          </div>
          <div v-else class="executions-list">
            <div v-for="execution in statistics.recent_executions" :key="execution.id" class="execution-item">
              <div class="execution-info">
                <div class="execution-name">{{ execution.case_name }}</div>
                <div class="execution-meta">
                  <el-tag :type="getStatusType(execution.status)" size="small">
                    {{ getStatusText(execution.status) }}
                  </el-tag>
                  <span class="device-name">{{ $t('appAutomation.dashboard.device') }}: {{ execution.device_name }}</span>
                  <span class="execution-time">{{ formatTime(execution.created_at) }}</span>
                </div>
              </div>
              <div class="execution-actions">
                <el-button 
                  type="primary" 
                  size="small" 
                  text
                  @click="viewExecution(execution.id)"
                >
                  {{ $t('appAutomation.common.view') }}
                </el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
    
    <!-- 快速操作 -->
    <el-row :gutter="12" class="quick-actions-section">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>{{ $t('appAutomation.dashboard.quickActions') }}</span>
            </div>
          </template>
          <div class="actions-grid">
            <div class="action-item" @click="$router.push('/app-automation/devices')">
              <div class="action-icon bg-blue">
                <el-icon><Cellphone /></el-icon>
              </div>
              <div class="action-label">{{ $t('appAutomation.dashboard.deviceManagement') }}</div>
            </div>
            <div class="action-item" @click="$router.push('/app-automation/elements')">
              <div class="action-icon bg-green">
                <el-icon><Picture /></el-icon>
              </div>
              <div class="action-label">{{ $t('appAutomation.dashboard.elementManagement') }}</div>
            </div>
            <div class="action-item" @click="$router.push('/app-automation/test-cases')">
              <div class="action-icon bg-purple">
                <el-icon><Document /></el-icon>
              </div>
              <div class="action-label">{{ $t('appAutomation.dashboard.testCases') }}</div>
            </div>
            <div class="action-item" @click="$router.push('/app-automation/executions')">
              <div class="action-icon bg-orange">
                <el-icon><Aim /></el-icon>
              </div>
              <div class="action-label">{{ $t('appAutomation.dashboard.executionRecords') }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { useI18n } from 'vue-i18n'
import { getDashboardStatistics } from '@/api/app-automation'
import { getExecutionStatusType, getExecutionStatusText, formatRelativeTime } from '@/utils/app-automation-helpers'
import {
  Cellphone,
  CircleCheck,
  Lock,
  Document,
  Picture,
  Aim
} from '@element-plus/icons-vue'

const { t } = useI18n()

const loading = ref(false)
const statistics = ref({
  devices: {
    total: 0,
    online: 0,
    locked: 0,
    available: 0
  },
  test_cases: {
    total: 0
  },
  executions: {
    total: 0,
    success: 0,
    failed: 0,
    pass_rate: 0
  },
  recent_executions: []
})

const loadStatistics = async () => {
  loading.value = true
  try {
    const res = await getDashboardStatistics()
    if (res.data.success) {
      statistics.value = res.data.data
    }
  } catch (error) {
    ElMessage.error(t('appAutomation.dashboard.messages.loadFailed') + ': ' + (error.message || t('appAutomation.dashboard.messages.unknownError')))
  } finally {
    loading.value = false
  }
}

const getStatusType = getExecutionStatusType
const getStatusText = getExecutionStatusText
const formatTime = formatRelativeTime

const getPassRateClass = (rate) => {
  if (rate >= 90) return 'success'
  if (rate >= 70) return 'warning'
  return 'danger'
}

const viewExecution = (id) => {
  // 跳转到执行详情页
  // TODO: 后续实现执行详情页
  ElMessage.info(t('appAutomation.dashboard.messages.detailComingSoon'))
}

let refreshTimer = null

onMounted(() => {
  loadStatistics()
  // 每30秒刷新一次统计数据
  refreshTimer = setInterval(loadStatistics, 30000)
})

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})
</script>

<style scoped lang="scss">
.app-automation-dashboard {
  padding: 4px 2px 8px;
}

.stats-section {
  margin-bottom: 12px;
}

.stat-card {
  cursor: default;
  border: 1px solid #dcebe4;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);

  :deep(.el-card__body) {
    padding: 14px 16px;
  }

  .stat-content {
    display: flex;
    align-items: center;
    gap: 12px;

    .stat-icon {
      width: 40px;
      height: 40px;
      border-radius: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      color: white;
      flex-shrink: 0;

      &.bg-blue { background: #409eff; }
      &.bg-green { background: #16a34a; }
      &.bg-orange { background: #d97706; }
      &.bg-purple { background: #337ecc; }
    }

    .stat-info {
      flex: 1;
      min-width: 0;

      .stat-value {
        font-size: 22px;
        font-weight: 700;
        color: #173b2c;
        line-height: 1.1;
        margin-bottom: 4px;
      }

      .stat-label {
        font-size: 12px;
        color: #5f7a6d;
      }
    }
  }
}

.content-section {
  margin-bottom: 12px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 650;
  font-size: 14px;
  color: #173b2c;
}

.stat-chart,
.recent-executions {
  border: 1px solid #dcebe4;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);

  :deep(.el-card__header) {
    padding: 12px 16px;
    border-bottom-color: #e4f0ea;
  }

  :deep(.el-card__body) {
    padding: 14px 16px;
  }
}

.stat-chart {
  .chart-container {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;

    .stat-item {
      text-align: center;
      padding: 12px 10px;
      border-radius: 8px;
      background: #f2f8f5;

      .stat-label {
        font-size: 12px;
        color: #5f7a6d;
        margin-bottom: 6px;
      }

      .stat-value {
        font-size: 20px;
        font-weight: 700;
        color: #173b2c;

        &.large { font-size: 22px; color: #409eff; }
        &.success { color: #16a34a; }
        &.warning { color: #d97706; }
        &.danger { color: #dc4c4c; }
      }
    }
  }
}

.recent-executions {
  .executions-list {
    .execution-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 8px;
      border-bottom: 1px solid #e4f0ea;

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: #f2f8f5;
      }

      .execution-info {
        flex: 1;
        min-width: 0;

        .execution-name {
          font-size: 13px;
          font-weight: 550;
          color: #173b2c;
          margin-bottom: 6px;
        }

        .execution-meta {
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 12px;
          color: #87a296;

          .device-name {
            display: flex;
            align-items: center;
            gap: 4px;
          }
        }
      }
    }
  }
}

.quick-actions-section {
  :deep(.el-card) {
    border: 1px solid #dcebe4;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);
  }

  :deep(.el-card__header) {
    padding: 12px 16px;
    border-bottom-color: #e4f0ea;
  }

  :deep(.el-card__body) {
    padding: 12px 16px;
  }

  .actions-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;

    .action-item {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid #dcebe4;
      cursor: pointer;
      transition: background .13s, border-color .13s;
      background: #fff;

      &:hover {
        background: #e0f5f2;
        border-color: #409eff;
      }

      .action-icon {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        color: white;
        flex-shrink: 0;

        &.bg-blue { background: #409eff; }
        &.bg-green { background: #16a34a; }
        &.bg-orange { background: #d97706; }
        &.bg-purple { background: #337ecc; }
      }

      .action-label {
        font-size: 13px;
        font-weight: 550;
        color: #173b2c;
      }
    }
  }
}

.loading-container,
.empty-container {
  padding: 24px 0;
}
</style>
