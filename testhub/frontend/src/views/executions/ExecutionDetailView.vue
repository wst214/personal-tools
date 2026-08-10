<template>
  <div class="execution-detail">
    <header class="plan-header">
      <div class="plan-header__title-row">
        <h1 class="plan-header__title">{{ testPlan.name }}</h1>
        <span v-if="testPlan.version" class="version-chip">
          <el-icon class="version-chip__icon"><Stamp /></el-icon>
          {{ testPlan.version }}
        </span>
      </div>
      <div class="plan-header__meta">
        <span class="meta-item">
          <el-icon class="meta-item__icon"><FolderOpened /></el-icon>
          <template v-if="testPlan.projects && testPlan.projects.length > 0">
            {{ testPlan.projects.join(', ') }}
          </template>
          <template v-else>{{ $t('execution.noProject') }}</template>
        </span>
        <span v-if="testPlan.created_at" class="meta-item meta-dim">
          {{ $t('execution.createdAt') }} · {{ formatDate(testPlan.created_at) }}
        </span>
      </div>
    </header>

    <template v-if="testPlan.test_runs && testPlan.test_runs.length > 0">
      <section v-for="run in testPlan.test_runs" :key="run.id" class="run-card">
        <div class="run-card__toolbar">
          <div class="run-card__title-group">
            <h2 class="run-card__title">{{ run.name }}</h2>
            <span class="status-chip" :class="runStatusClass(run.progress)">
              <span class="status-chip__dot"></span>
              {{ getRunStatusText(run.progress) }}
            </span>
            <div class="run-progress">
              <span class="run-progress__pct">{{ run.progress.progress }}%</span>
              <div class="run-progress__track">
                <div
                  class="run-progress__fill"
                  :class="progressFillClass(run.progress.progress)"
                  :style="{ width: run.progress.progress + '%' }">
                </div>
              </div>
            </div>
          </div>
          <div class="stats-inline">
            <span class="stat-pill stat-pill--total"><b>{{ run.progress.total }}</b>{{ $t('execution.total') }}</span>
            <span class="stat-pill stat-pill--passed"><b>{{ run.progress.passed }}</b>{{ $t('execution.passed') }}</span>
            <span class="stat-pill stat-pill--failed"><b>{{ run.progress.failed }}</b>{{ $t('execution.failed') }}</span>
            <span class="stat-pill stat-pill--blocked"><b>{{ run.progress.blocked }}</b>{{ $t('execution.blocked') }}</span>
            <span class="stat-pill stat-pill--untested"><b>{{ run.progress.untested }}</b>{{ $t('execution.untested') }}</span>
          </div>
          <el-button
            v-if="dirtyCount(run) > 0"
            size="small"
            type="primary"
            :loading="batchRunId === run.id"
            @click="saveAllInRun(run)">
            {{ $t('execution.batchSaveAll') }} ({{ dirtyCount(run) }})
          </el-button>
          <el-button
            v-if="selectedCases.length > 0"
            size="small"
            type="danger"
            :icon="Delete"
            @click="batchDeleteCases"
            :disabled="isDeleting">
            {{ $t('execution.batchDelete') }} ({{ selectedCases.length }})
          </el-button>
        </div>

        <div v-if="moduleTabs(run).length > 1" class="module-filter">
          <div class="module-filter-label">{{ $t('execution.moduleFilter') }}</div>
          <div class="module-tabs">
            <button
              v-for="tab in moduleTabs(run)"
              :key="tab.key"
              type="button"
              class="module-tab"
              :class="{ active: selectedModule === tab.key }"
              @click="selectModule(tab.key)"
            >
              <span class="module-tab-name">{{ tab.label }}</span>
              <span class="module-tab-count">{{ tab.count }}</span>
            </button>
          </div>
        </div>

        <div class="table-panel">
          <el-table
            ref="tableRef"
            :data="paginatedCases(run.run_cases)"
            height="100%"
            style="width: 100%"
            class="execution-table"
            :row-class-name="rowClassName"
            @selection-change="handleSelectionChange"
            :row-key="(row) => row.id">
            <el-table-column type="selection" width="42" :reserve-selection="true" />
            <el-table-column
              type="index"
              :label="$t('execution.serialNumber')"
              width="52"
              :index="getSerialNumber" />
            <el-table-column prop="testcase" :label="$t('execution.testCase')" min-width="280" show-overflow-tooltip />
            <el-table-column :label="$t('execution.executionStatus')" width="120">
              <template #default="scope">
                <el-select
                  v-model="scope.row.status"
                  size="small"
                  class="status-select">
                  <el-option :label="$t('execution.untested')" value="untested" />
                  <el-option :label="$t('execution.passed')" value="passed" />
                  <el-option :label="$t('execution.failed')" value="failed" />
                  <el-option :label="$t('execution.blocked')" value="blocked" />
                  <el-option :label="$t('execution.retest')" value="retest" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column :label="$t('execution.comments')" width="160" show-overflow-tooltip>
              <template #default="scope">
                <el-input
                  v-model="scope.row.comments"
                  :placeholder="$t('execution.commentsPlaceholder')"
                  size="small"
                  clearable>
                </el-input>
              </template>
            </el-table-column>
            <el-table-column :label="$t('execution.actions')" width="110" align="center" class-name="action-col">
              <template #default="scope">
                <div class="action-buttons">
                  <el-button
                    link
                    type="primary"
                    :loading="savingId === scope.row.id"
                    :disabled="!isRowDirty(scope.row)"
                    @click="saveRunCase(scope.row, run)">
                    {{ $t('common.save') }}
                  </el-button>
                  <el-button
                    link
                    @click="viewCaseHistory(scope.row)">
                    {{ $t('execution.viewHistory') }}
                  </el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="filteredCases(run.run_cases).length > 0" class="pagination-container">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[15, 20, 30, 50, 100]"
              :total="filteredCases(run.run_cases).length"
              layout="total, sizes, prev, pager, next"
              @current-change="handlePageChange"
              @size-change="handleSizeChange">
            </el-pagination>
          </div>
        </div>
      </section>
    </template>

    <div v-else-if="loaded" class="empty-state">
      {{ $t('execution.noRuns') }}
    </div>

    <!-- 历史记录对话框 -->
    <el-dialog
      :title="$t('execution.executionHistory')"
      v-model="historyDialogVisible"
      width="80%">
      <el-table :data="currentCaseHistory" style="width: 100%">
        <el-table-column prop="status" :label="$t('execution.status')" width="100">
          <template #default="scope">
            <el-tag :type="getStatusType(scope.row.status)">
              {{ getStatusText(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="comments" :label="$t('execution.comments')" show-overflow-tooltip />
        <el-table-column prop="executed_by.username" :label="$t('execution.executedBy')" width="120" />
        <el-table-column prop="executed_at" :label="$t('execution.executedAt')" width="180">
          <template #default="scope">
            {{ formatDate(scope.row.executed_at) }}
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Stamp, FolderOpened } from '@element-plus/icons-vue'
import api from '@/utils/api'

const { t } = useI18n()

const MODULE_LABELS = {
  LOGIN: '登录模块',
  V3D: '3D可视化',
  MONITOR: '监测模块',
  WARN: '预警信息查询',
  WRULE: '预警规则',
  WSUP: '预警抑制与通知',
  ANALYSIS: '综合分析与报表',
  MAINT: '设备维护',
  ALERT: '设备告警',
  ARULE: '设备告警规则',
  SCENE_A: '场景防护(变电站数据中心)',
  SCENE_B: '场景防护(井口瓦斯油库)',
  SCENE_C: '场景防护(输送通风)',
  BASE: '基础资料与配置',
  SYS: '系统管理',
  OTHER: '其他'
}

const route = useRoute()
const testPlan = ref({})
const historyDialogVisible = ref(false)
const currentCaseHistory = ref([])
const selectedCases = ref([])
const currentPage = ref(1)
const pageSize = ref(20)
const selectedModule = ref('all')
const isDeleting = ref(false)
const tableRef = ref(null)
const loaded = ref(false)

const getModuleKey = (title) => {
  const m = String(title || '').match(/^\[([^\]]+)\]/)
  if (!m) return 'OTHER'
  return m[1].replace(/_\d+$/, '') || 'OTHER'
}

const getModuleLabel = (key) => MODULE_LABELS[key] || key

const moduleTabs = (run) => {
  const cases = run?.run_cases || []
  const counts = {}
  for (const rc of cases) {
    const key = getModuleKey(rc.testcase)
    counts[key] = (counts[key] || 0) + 1
  }
  const tabs = Object.keys(counts)
    .sort((a, b) => {
      if (a === 'OTHER') return 1
      if (b === 'OTHER') return -1
      return getModuleLabel(a).localeCompare(getModuleLabel(b), 'zh-CN')
    })
    .map((key) => ({ key, label: getModuleLabel(key), count: counts[key] }))
  return [
    { key: 'all', label: t('execution.moduleAll'), count: cases.length },
    ...tabs
  ]
}

const filteredCases = (cases) => {
  if (!cases) return []
  if (selectedModule.value === 'all') return cases
  return cases.filter((rc) => getModuleKey(rc.testcase) === selectedModule.value)
}


// 已保存快照：row.id -> { status, comments }，用于判断某行是否有未提交的改动
const savedState = ref({})
// 单行保存中的用例 id；批量保存中的 run.id
const savingId = ref(null)
const batchRunId = ref(null)

const fetchTestPlan = async () => {
  try {
    const planId = route.params.id
    const response = await api.get(`/executions/plans/${planId}/`)
    testPlan.value = response.data
    buildSavedState()
  } catch (error) {
    ElMessage.error(t('execution.fetchDetailFailed'))
  } finally {
    loaded.value = true
  }
}

// 依据当前已持久化的数据构建"已保存快照"
const buildSavedState = () => {
  const map = {}
  const runs = testPlan.value.test_runs
  if (runs) {
    for (const run of runs) {
      if (run.run_cases) {
        for (const rc of run.run_cases) {
          map[rc.id] = { status: rc.status, comments: rc.comments || '' }
        }
      }
    }
  }
  savedState.value = map
}

// 行是否有未提交改动（状态或备注与快照不一致）
const isRowDirty = (runCase) => {
  const saved = savedState.value[runCase.id]
  if (!saved) return false
  return runCase.status !== saved.status || (runCase.comments || '') !== saved.comments
}

// 某 run 内未提交的用例数
const dirtyCount = (run) => {
  if (!run.run_cases) return 0
  return run.run_cases.filter(rc => isRowDirty(rc)).length
}

// 表格行样式：未提交行加 row-dirty 类
const rowClassName = ({ row }) => (isRowDirty(row) ? 'row-dirty' : '')

// 本地重算 run 进度（与后端 progress_stats 公式一致），
// 避免整页 fetchTestPlan 刷新替换行对象、从而丢失其他行的未提交草稿
const recomputeProgress = (run) => {
  const cases = run.run_cases || []
  const p = run.progress || (run.progress = {})
  p.total = cases.length
  p.untested = 0
  p.passed = 0
  p.failed = 0
  p.blocked = 0
  p.retest = 0
  for (const c of cases) {
    if (c.status && p[c.status] !== undefined) p[c.status]++
  }
  p.tested = p.passed + p.failed + p.blocked + p.retest
  p.progress = p.total > 0 ? Math.round((p.tested / p.total) * 100 * 10) / 10 : 0
}

// 保存单个用例：状态 + 备注一次提交，只产生一条历史记录
const saveRunCase = async (runCase, run) => {
  if (!isRowDirty(runCase)) return
  savingId.value = runCase.id
  try {
    await api.patch(`/executions/run_cases/${runCase.id}/update_status/`, {
      status: runCase.status,
      comments: runCase.comments || ''
    })
    // 本地同步快照 -> 行变为"已保存"
    savedState.value[runCase.id] = { status: runCase.status, comments: runCase.comments || '' }
    if (run) recomputeProgress(run)
    ElMessage.success(t('execution.statusUpdateSuccess'))
  } catch (error) {
    ElMessage.error(t('execution.statusUpdateFailed'))
  } finally {
    savingId.value = null
  }
}

// 批量保存某 run 内所有未提交用例
const saveAllInRun = async (run) => {
  const dirty = (run.run_cases || []).filter(rc => isRowDirty(rc))
  if (!dirty.length) return
  batchRunId.value = run.id
  let ok = 0
  let fail = 0
  for (const rc of dirty) {
    try {
      await api.patch(`/executions/run_cases/${rc.id}/update_status/`, {
        status: rc.status,
        comments: rc.comments || ''
      })
      savedState.value[rc.id] = { status: rc.status, comments: rc.comments || '' }
      ok++
    } catch (error) {
      fail++
    }
  }
  recomputeProgress(run)
  batchRunId.value = null
  if (fail > 0) {
    ElMessage.success(t('execution.batchSavePartialSuccess', { successCount: ok, failCount: fail }))
  } else {
    ElMessage.success(t('execution.batchSaveSuccess', { count: ok }))
  }
}

const viewCaseHistory = async (runCase) => {
  try {
    const response = await api.get(`/executions/run_cases/${runCase.id}/history/`)
    currentCaseHistory.value = response.data
    historyDialogVisible.value = true
  } catch (error) {
    ElMessage.error(t('execution.fetchHistoryFailed'))
  }
}

// 处理选择变化
const handleSelectionChange = (selection) => {
  selectedCases.value = selection
}

// 清空所有表格选择（tableRef 在 v-for 下可能是数组）
const clearAllSelections = () => {
  if (!tableRef.value) return
  const tables = Array.isArray(tableRef.value) ? tableRef.value : [tableRef.value]
  tables.forEach(tbl => tbl && tbl.clearSelection && tbl.clearSelection())
}

const selectModule = (key) => {
  selectedModule.value = key
  currentPage.value = 1
  selectedCases.value = []
  clearAllSelections()
}

// 批量删除：本地移除 + 重算进度（不整页刷新，保留其他行未提交草稿）
const batchDeleteCases = async () => {
  if (selectedCases.value.length === 0) {
    ElMessage.warning(t('execution.selectCasesFirst'))
    return
  }

  try {
    await ElMessageBox.confirm(
      t('execution.batchDeleteCasesConfirm', { count: selectedCases.value.length }),
      t('common.warning'),
      {
        confirmButtonText: t('common.confirm'),
        cancelButtonText: t('common.cancel'),
        type: 'warning'
      }
    )

    isDeleting.value = true
    let successCount = 0
    let failCount = 0
    const deletedIds = new Set()

    for (const runCase of selectedCases.value) {
      try {
        await api.delete(`/executions/run_cases/${runCase.id}/`)
        successCount++
        deletedIds.add(runCase.id)
      } catch (error) {
        console.error(`删除用例 ${runCase.id} 失败:`, error)
        failCount++
      }
    }

    // 本地移除已删除用例并重算进度
    if (deletedIds.size > 0 && testPlan.value.test_runs) {
      for (const run of testPlan.value.test_runs) {
        if (run.run_cases) {
          run.run_cases = run.run_cases.filter(rc => !deletedIds.has(rc.id))
          recomputeProgress(run)
        }
      }
      for (const id of deletedIds) delete savedState.value[id]
    }

    selectedCases.value = []
    clearAllSelections()

    if (successCount > 0) {
      if (failCount > 0) {
        ElMessage.success(t('execution.batchDeleteCasesPartialSuccess', { successCount, failCount }))
      } else {
        ElMessage.success(t('execution.batchDeleteCasesSuccess', { successCount }))
      }
    } else {
      ElMessage.error(t('execution.batchDeleteFailed'))
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('批量删除失败:', error)
      ElMessage.error(t('execution.batchDeleteFailed'))
    }
  } finally {
    isDeleting.value = false
  }
}

// 分页相关（先按模块过滤）
const paginatedCases = (cases) => {
  const list = filteredCases(cases)
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return list.slice(start, end)
}

const getSerialNumber = (index) => {
  return (currentPage.value - 1) * pageSize.value + index + 1
}

const handlePageChange = () => {
  selectedCases.value = []
  clearAllSelections()
}

const handleSizeChange = () => {
  currentPage.value = 1
  selectedCases.value = []
  clearAllSelections()
}

const formatDate = (dateString) => {
  if (!dateString) return '-'
  return new Date(dateString).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 运行状态 -> chip 样式修饰符（颜色由 CSS 变量驱动，语义化而非装饰）
const runStatusClass = (progress) => {
  if (progress.progress === 100) return 'is-completed'
  if (progress.untested === progress.total) return 'is-pending'
  if (progress.failed > 0) return 'is-failed'
  if (progress.blocked > 0) return 'is-blocked'
  return 'is-progress'
}

// 进度条填充色阶（健康度语义：<30 红 / <70 琥珀 / ≥70 绿）
const progressFillClass = (percentage) => {
  if (percentage < 30) return 'fill--low'
  if (percentage < 70) return 'fill--mid'
  return 'fill--high'
}

const getRunStatusText = (progress) => {
  if (progress.progress === 100) return t('execution.completed')
  if (progress.untested === progress.total) return t('execution.notStarted')
  return t('execution.inProgress')
}

const getStatusType = (status) => {
  const typeMap = {
    'untested': 'info',
    'passed': 'success',
    'failed': 'danger',
    'blocked': 'warning',
    'retest': 'primary'
  }
  return typeMap[status] || 'info'
}

const getStatusText = (status) => {
  const textMap = {
    'untested': t('execution.untested'),
    'passed': t('execution.passed'),
    'failed': t('execution.failed'),
    'blocked': t('execution.blocked'),
    'retest': t('execution.retest')
  }
  return textMap[status] || status
}

onMounted(() => {
  fetchTestPlan()
})
</script>

<style scoped>
.execution-detail {
  --g-bg: #ffffff;
  --g-bg-soft: #f2f8f5;
  --g-bg-quiet: #f6faf8;
  --g-ink: #173b2c;
  --g-ink-soft: #5f7a6d;
  --g-accent: #3d9b6e;
  --g-line: #dcebe4;
  --g-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);
  --st-total: #3d9b6e;
  --st-passed: #67c23a;
  --st-failed: #f56c6c;
  --st-blocked: #e6a23c;
  --st-untested: #909399;

  height: 100%;
  max-height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 6px;
  overflow: hidden;
  background: transparent;
  color: var(--g-ink);
  box-sizing: border-box;
}

.plan-header {
  flex-shrink: 0;
  background: var(--g-bg);
  border: 1px solid var(--g-line);
  border-radius: 10px;
  box-shadow: var(--g-shadow);
  padding: 14px 18px 12px;
}

.plan-header__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.plan-header__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--g-ink);
}

.plan-header__meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.version-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 550;
  color: #1f6b48;
  background: #eef8f2;
  border: 1px solid #b7dfc8;
  border-radius: 999px;
  line-height: 1.5;
}

.version-chip__icon {
  font-size: 12px;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--g-ink-soft);
}

.meta-item__icon {
  font-size: 15px;
}

.meta-dim {
  color: #87a296;
}

.run-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--g-bg);
  border: 1px solid var(--g-line);
  border-radius: 10px;
  box-shadow: var(--g-shadow);
  padding: 8px 12px 6px;
  margin: 0;
  overflow: hidden;
}

.run-card__toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  min-width: 0;
}

.run-card__title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 280px;
  min-width: 0;
}

.run-card__title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  color: var(--g-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 280px;
}

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  font-size: 12px;
  font-weight: 550;
  border-radius: 999px;
  border: 1px solid var(--g-line);
  background: var(--g-bg-quiet);
  color: var(--g-ink);
  line-height: 1.5;
  flex-shrink: 0;
}

.status-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--g-ink-soft);
}

.status-chip.is-completed { color: #1f6b48; }
.status-chip.is-completed .status-chip__dot { background: var(--st-passed); }
.status-chip.is-failed { color: #b32334; }
.status-chip.is-failed .status-chip__dot { background: var(--st-failed); }
.status-chip.is-blocked { color: #9a6a16; }
.status-chip.is-blocked .status-chip__dot { background: var(--st-blocked); }
.status-chip.is-pending .status-chip__dot { background: var(--st-untested); }
.status-chip.is-progress { color: #1f6b48; }
.status-chip.is-progress .status-chip__dot { background: var(--g-accent); }

.run-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 100px;
  max-width: 220px;
}

.run-progress__pct {
  font-size: 12px;
  font-weight: 650;
  color: var(--g-ink);
  min-width: 34px;
}

.run-progress__track {
  flex: 1;
  height: 6px;
  background: var(--g-bg-soft);
  border-radius: 4px;
  overflow: hidden;
}

.run-progress__fill {
  height: 100%;
  border-radius: 4px;
  transition: width 300ms ease;
}

.run-progress__fill.fill--low { background: var(--st-failed); }
.run-progress__fill.fill--mid { background: var(--st-blocked); }
.run-progress__fill.fill--high { background: var(--st-passed); }

.stats-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--g-line);
  background: var(--g-bg-quiet);
  font-size: 12px;
  color: var(--g-ink-soft);
  line-height: 1.5;
}

.stat-pill b {
  font-size: 13px;
  font-weight: 700;
  color: var(--g-ink);
}

.stat-pill--total { border-color: #b7dfc8; }
.stat-pill--passed { border-color: #c2e7b0; }
.stat-pill--failed { border-color: #fbc4c4; }
.stat-pill--blocked { border-color: #f3d19e; }
.stat-pill--untested { border-color: #d3d4d6; }

.module-filter {
  flex-shrink: 0;
  margin-bottom: 8px;
}

.module-filter-label {
  font-size: 12px;
  color: var(--g-ink-soft);
  margin-bottom: 6px;
}

.module-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.module-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid #d5e8de;
  background: #fff;
  color: #3d5c4d;
  border-radius: 14px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  line-height: 1.4;
}

.module-tab:hover,
.module-tab.active {
  border-color: #3d9b6e;
  color: #1f6b48;
  background: #eef8f2;
}

.module-tab-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 10px;
  background: #f0f2f5;
  color: #909399;
  font-size: 11px;
  text-align: center;
}

.module-tab.active .module-tab-count {
  background: #3d9b6e;
  color: #fff;
}

.table-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.execution-table {
  --el-table-border-color: var(--g-line);
  --el-table-header-bg-color: var(--g-bg-soft);
  --el-table-header-text-color: var(--g-ink-soft);
  --el-table-row-hover-bg-color: var(--g-bg-quiet);
  flex: 1;
  width: 100% !important;
  border: 1px solid var(--g-line);
  border-radius: 8px;
  overflow: hidden;
}

:deep(.execution-table .el-table__header th) {
  font-size: 12px;
  font-weight: 650;
  color: var(--g-ink-soft);
  background: var(--g-bg-soft) !important;
  padding: 6px 0 !important;
}

:deep(.execution-table .el-table__body td) {
  font-size: 13px;
  color: var(--g-ink);
  padding: 4px 0 !important;
}

:deep(.execution-table .el-table__body-wrapper) {
  overflow-x: hidden !important;
}

:deep(.execution-table .row-dirty td) {
  background: #fff8ef !important;
}

:deep(.execution-table .row-dirty:hover td) {
  background: #fff1df !important;
}

:deep(.execution-table .status-select) {
  width: 100%;
}

.action-buttons {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  white-space: nowrap;
}

.action-buttons :deep(.el-button) {
  margin: 0;
  padding: 0 4px;
}

.pagination-container {
  flex-shrink: 0;
  margin-top: 6px;
  display: flex;
  justify-content: flex-end;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--g-bg);
  border: 1px solid var(--g-line);
  border-radius: 10px;
  color: var(--g-ink-soft);
  font-size: 13px;
}
</style>
