<template>
  <div class="page-container">
    <div class="page-header">
      <h1 class="page-title">{{ $t('testcase.title') }}</h1>
      <div class="header-actions">
        <el-button
          v-if="selectedTestCases.length > 0"
          type="danger"
          @click="batchDeleteTestCases"
          :disabled="isDeleting">
          <el-icon><Delete /></el-icon>
          {{ $t('testcase.batchDelete') }} ({{ selectedTestCases.length }})
        </el-button>
        <el-button type="success" @click="exportToExcel">
          <el-icon><Download /></el-icon>
          {{ $t('testcase.exportExcel') }}
        </el-button>
        <el-button @click="downloadImportTemplate">
          <el-icon><Download /></el-icon>
          {{ $t('testcase.downloadImportTemplate') }}
        </el-button>
        <el-button type="warning" @click="openImportDialog">
          <el-icon><Upload /></el-icon>
          {{ $t('testcase.importCases') }}
        </el-button>
        <el-button @click="goToImportRecords">
          {{ $t('testcase.importRecords') }}
        </el-button>
        <el-button type="primary" @click="$router.push('/ai-generation/testcases/create')">
          <el-icon><Plus /></el-icon>
          {{ $t('testcase.newCase') }}
        </el-button>
      </div>
    </div>
    
    <div class="card-container">
      <div class="filter-bar">
        <el-input
          v-model="searchText"
          class="filter-search"
          :placeholder="$t('testcase.searchPlaceholder')"
          clearable
          @input="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="projectFilter"
          class="filter-select filter-project"
          :placeholder="$t('testcase.relatedProject')"
          clearable
          @change="handleFilter"
        >
          <el-option
            v-for="project in projects"
            :key="project.id"
            :label="project.name"
            :value="project.id"
          />
        </el-select>
        <el-select
          v-model="priorityFilter"
          class="filter-select filter-priority"
          :placeholder="$t('testcase.priorityFilter')"
          clearable
          @change="handleFilter"
        >
          <el-option :label="$t('testcase.low')" value="low" />
          <el-option :label="$t('testcase.medium')" value="medium" />
          <el-option :label="$t('testcase.high')" value="high" />
          <el-option :label="$t('testcase.critical')" value="critical" />
        </el-select>
        <el-select
          v-model="statusFilter"
          class="filter-select filter-status"
          :placeholder="$t('testcase.statusFilter')"
          clearable
          @change="handleFilter"
        >
          <el-option :label="$t('testcase.draft')" value="draft" />
          <el-option :label="$t('testcase.active')" value="active" />
          <el-option :label="$t('testcase.deprecated')" value="deprecated" />
        </el-select>
      </div>

      <div v-if="moduleTabs.length > 1" class="module-filter">
        <div class="module-filter-label">{{ $t('testcase.moduleFilter') }}</div>
        <div class="module-tabs">
          <button
            v-for="tab in moduleTabs"
            :key="tab.name"
            type="button"
            class="module-tab"
            :class="{ active: moduleFilter === tab.name }"
            @click="selectModule(tab.name)"
          >
            <span class="module-tab-name">{{ tab.label }}</span>
            <span class="module-tab-count">{{ tab.count }}</span>
          </button>
        </div>
      </div>
      
      <div class="table-container">
        <el-table 
          :data="testcases" 
          v-loading="loading" 
          class="testcase-table"
          style="width: 100%"
          height="100%"
          @selection-change="handleSelectionChange">
          <el-table-column type="selection" width="42" />
          <el-table-column type="index" :label="$t('testcase.serialNumber')" width="52" :index="getSerialNumber" />
          <el-table-column prop="title" :label="$t('testcase.caseTitle')" min-width="360" show-overflow-tooltip>
            <template #default="{ row }">
              <el-link class="title-link" @click="goToTestCase(row.id)" type="primary">
                {{ row.title }}
              </el-link>
            </template>
          </el-table-column>
          <el-table-column prop="project.name" :label="$t('testcase.relatedProject')" width="100" show-overflow-tooltip>
            <template #default="{ row }">
              {{ row.project?.name || '-' }}
            </template>
          </el-table-column>
          <el-table-column prop="versions" :label="$t('testcase.relatedVersions')" width="110" show-overflow-tooltip>
            <template #default="{ row }">
              <div v-if="row.versions && row.versions.length > 0" class="version-tags">
                <el-tag
                  v-for="version in row.versions.slice(0, 1)"
                  :key="version.id"
                  size="small"
                  :type="version.is_baseline ? 'warning' : 'info'"
                  class="version-tag"
                >
                  {{ version.name }}
                </el-tag>
                <el-tag v-if="row.versions.length > 1" size="small" type="info" class="version-tag">
                  +{{ row.versions.length - 1 }}
                </el-tag>
              </div>
              <span v-else class="no-version">{{ $t('testcase.noVersion') }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="priority" :label="$t('testcase.priority')" width="70" align="center">
            <template #default="{ row }">
              <el-tag size="small" :class="`priority-tag ${row.priority}`">{{ getPriorityText(row.priority) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="status" :label="$t('testcase.status')" width="72" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="getStatusTagType(row.status)">{{ getStatusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="test_type" :label="$t('testcase.testType')" width="88" show-overflow-tooltip>
            <template #default="{ row }">
              {{ getTypeText(row.test_type) }}
            </template>
          </el-table-column>
          <el-table-column v-if="!isEmbedded" prop="author.username" :label="$t('testcase.author')" width="80" show-overflow-tooltip />
          <el-table-column v-if="!isEmbedded" prop="created_at" :label="$t('testcase.createdAt')" width="150">
            <template #default="{ row }">
              {{ formatDate(row.created_at) }}
            </template>
          </el-table-column>
          <el-table-column :label="$t('project.actions')" width="112" align="center">
            <template #default="{ row }">
              <div class="action-btns">
                <el-button link type="primary" @click="editTestCase(row)">{{ $t('common.edit') }}</el-button>
                <el-button link type="danger" @click="deleteTestCase(row)">{{ $t('common.delete') }}</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      
      <div class="pagination-container">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[15, 25, 35, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </div>

    <el-dialog
      v-model="importDialogVisible"
      :title="$t('testcase.importDialogTitle')"
      width="560px"
    >
      <el-alert
        :title="$t('testcase.uploadTip')"
        type="info"
        :closable="false"
        show-icon
        class="import-alert"
      />

      <el-form label-width="100px">
        <el-form-item :label="$t('testcase.importProject')">
          <el-select
            v-model="importForm.projectId"
            style="width: 100%"
            :placeholder="$t('testcase.selectImportProject')"
            filterable
          >
            <el-option
              v-for="project in projects"
              :key="project.id"
              :label="project.name"
              :value="project.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('testcase.selectImportFile')">
          <el-upload
            class="import-upload"
            drag
            action="#"
            :auto-upload="false"
            :limit="1"
            accept=".xlsx"
            :show-file-list="false"
            :before-upload="beforeImportUpload"
            :on-change="handleImportFileChange"
          >
            <el-icon class="el-icon--upload"><Upload /></el-icon>
            <div class="el-upload__text">
              {{ $t('testcase.chooseFile') }}
            </div>
            <template #tip>
              <div class="el-upload__tip">
                {{ $t('testcase.selectedFile') }}: {{ selectedImportFile?.name || '-' }}
              </div>
            </template>
          </el-upload>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="importDialogVisible = false">{{ $t('common.cancel') }}</el-button>
        <el-button @click="downloadImportTemplate">
          {{ $t('testcase.downloadImportTemplate') }}
        </el-button>
        <el-button type="primary" :loading="isCreatingImport" @click="submitImport">
          {{ isCreatingImport ? $t('testcase.uploading') : $t('common.confirm') }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search, Download, Delete, Upload } from '@element-plus/icons-vue'
import api from '@/utils/api'
import dayjs from 'dayjs'
import * as XLSX from 'xlsx'

const { t } = useI18n()
const router = useRouter()
const isEmbedded = (() => {
  try { return window.self !== window.top } catch { return true }
})()
const loading = ref(false)
const testcases = ref([])
const projects = ref([])
const currentPage = ref(1)
const pageSize = ref(15)
const total = ref(0)
const searchText = ref('')
const projectFilter = ref('')
const priorityFilter = ref('')
const statusFilter = ref('')
const moduleFilter = ref('all')
const moduleStats = ref({ total: 0, modules: [] })
const selectedTestCases = ref([])
const isDeleting = ref(false)

const moduleTabs = computed(() => {
  const modules = moduleStats.value.modules || []
  if (!modules.length) return []
  return [
    { name: 'all', label: t('testcase.moduleAll'), count: moduleStats.value.total || 0 },
    ...modules.map((m) => ({ name: m.name, label: m.name, count: m.count }))
  ]
})
const importDialogVisible = ref(false)
const isCreatingImport = ref(false)
const selectedImportFile = ref(null)
const importForm = ref({
  projectId: ''
})

const fetchModuleStats = async () => {
  try {
    const params = {}
    if (projectFilter.value) params.project = projectFilter.value
    const response = await api.get('/testcases/modules/', { params })
    moduleStats.value = {
      total: response.data.total || 0,
      modules: response.data.modules || []
    }
    if (
      moduleFilter.value !== 'all' &&
      !moduleStats.value.modules.some((m) => m.name === moduleFilter.value)
    ) {
      moduleFilter.value = 'all'
    }
  } catch (error) {
    console.error('fetch modules failed', error)
    moduleStats.value = { total: 0, modules: [] }
  }
}

const fetchTestCases = async () => {
  loading.value = true
  try {
    const params = {
      page: currentPage.value,
      page_size: pageSize.value,
      search: searchText.value,
      project: projectFilter.value,
      priority: priorityFilter.value,
      status: statusFilter.value
    }
    if (moduleFilter.value && moduleFilter.value !== 'all') {
      params.module = moduleFilter.value
    }
    const response = await api.get('/testcases/', { params })
    testcases.value = response.data.results || []
    total.value = response.data.count || 0
  } catch (error) {
    ElMessage.error(t('testcase.fetchListFailed'))
  } finally {
    loading.value = false
  }
}

const selectModule = (name) => {
  moduleFilter.value = name
  currentPage.value = 1
  fetchTestCases()
}

const handleSearch = () => {
  currentPage.value = 1
  fetchTestCases()
}

const handleFilter = async () => {
  currentPage.value = 1
  await fetchModuleStats()
  await fetchTestCases()
}

const handlePageChange = () => {
  fetchTestCases()
}

const handleSizeChange = () => {
  currentPage.value = 1
  fetchTestCases()
}

const goToTestCase = (id) => {
  router.push(`/ai-generation/testcases/${id}`)
}

const editTestCase = (testcase) => {
  router.push(`/ai-generation/testcases/${testcase.id}/edit`)
}

const deleteTestCase = async (testcase) => {
  try {
    await ElMessageBox.confirm(t('testcase.deleteConfirm'), t('common.warning'), {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning'
    })
    
    await api.delete(`/testcases/${testcase.id}/`)
    ElMessage.success(t('testcase.deleteSuccess'))
    fetchTestCases()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error(t('testcase.deleteFailed'))
    }
  }
}

// 处理选择变化
const handleSelectionChange = (selection) => {
  selectedTestCases.value = selection
}

// 获取序号
const getSerialNumber = (index) => {
  return (currentPage.value - 1) * pageSize.value + index + 1
}

// 批量删除
const batchDeleteTestCases = async () => {
  if (selectedTestCases.value.length === 0) {
    ElMessage.warning(t('testcase.selectFirst'))
    return
  }

  try {
    await ElMessageBox.confirm(
      t('testcase.batchDeleteConfirm', { count: selectedTestCases.value.length }),
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

    // 逐个删除选中的测试用例
    for (const testcase of selectedTestCases.value) {
      try {
        await api.delete(`/testcases/${testcase.id}/`)
        successCount++
      } catch (error) {
        console.error(`Delete test case ${testcase.id} failed:`, error)
        failCount++
      }
    }

    // 显示删除结果
    if (successCount > 0) {
      if (failCount > 0) {
        ElMessage.success(t('testcase.batchDeletePartialSuccess', { successCount, failCount }))
      } else {
        ElMessage.success(t('testcase.batchDeleteSuccess', { successCount }))
      }
    } else {
      ElMessage.error(t('testcase.batchDeleteFailed'))
    }

    // 清空选择并重新加载列表
    selectedTestCases.value = []
    fetchTestCases()

  } catch (error) {
    if (error !== 'cancel') {
      console.error('Batch delete failed:', error)
      ElMessage.error(t('testcase.batchDeleteError') + ': ' + (error.message || t('common.error')))
    }
  } finally {
    isDeleting.value = false
  }
}

const getPriorityText = (priority) => {
  const textMap = {
    low: t('testcase.low'),
    medium: t('testcase.medium'),
    high: t('testcase.high'),
    critical: t('testcase.critical')
  }
  return textMap[priority] || priority
}

const getTypeText = (type) => {
  const textMap = {
    functional: t('testcase.functional'),
    integration: t('testcase.integration'),
    api: t('testcase.api'),
    ui: t('testcase.ui'),
    performance: t('testcase.performance'),
    security: t('testcase.security')
  }
  return textMap[type] || '-'
}

const getStatusText = (status) => {
  const textMap = {
    draft: t('testcase.draft'),
    active: t('testcase.active'),
    deprecated: t('testcase.deprecated')
  }
  return textMap[status] || status || '-'
}

const getStatusTagType = (status) => {
  const typeMap = {
    draft: 'info',
    active: 'success',
    deprecated: 'warning'
  }
  return typeMap[status] || 'info'
}

const formatDate = (dateString) => {
  return dayjs(dateString).format('YYYY-MM-DD HH:mm')
}

// 将HTML的<br>标签转换为换行符（用于Excel导出）
const convertBrToNewline = (text) => {
  if (!text) return ''
  return text.replace(/<br\s*\/?>/gi, '\n')
}

const exportToExcel = async () => {
  try {
    loading.value = true

    // 确定要导出的数据
    let testCasesToExport = []

    if (selectedTestCases.value.length > 0) {
      // 如果有勾选，导出勾选的数据
      testCasesToExport = selectedTestCases.value
    } else {
      // 如果没有勾选，分页获取所有数据
      const pageSize = 100  // 使用后端允许的最大值
      let page = 1
      let hasMore = true
      let allData = []

      while (hasMore) {
        const response = await api.get('/testcases/', {
          params: {
            page: page,
            page_size: pageSize,
            search: searchText.value,
            project: projectFilter.value,
            priority: priorityFilter.value
          }
        })

        const results = response.data.results || []
        allData.push(...results)

        // 检查是否还有更多数据
        // 如果返回的数据少于pageSize，说明已经是最后一页
        if (results.length < pageSize) {
          hasMore = false
        } else {
          page++
        }
      }

      testCasesToExport = allData
    }

    if (testCasesToExport.length === 0) {
      ElMessage.warning(t('testcase.noDataToExport'))
      loading.value = false
      return
    }

    // 创建工作簿
    const workbook = XLSX.utils.book_new()

    // 准备Excel数据
    const worksheetData = [
      [t('testcase.excelNumber'), t('testcase.excelTitle'), t('testcase.excelProject'), t('testcase.excelVersions'), t('testcase.excelPreconditions'), t('testcase.excelSteps'), t('testcase.excelExpectedResult'), t('testcase.excelPriority'), t('testcase.excelTestType'), t('testcase.excelAuthor'), t('testcase.excelCreatedAt')]
    ]

    testCasesToExport.forEach((testcase, index) => {
      const versions = testcase.versions && testcase.versions.length > 0
        ? testcase.versions.map(v => v.name + (v.is_baseline ? '(' + t('testcase.baseline') + ')' : '')).join('、')
        : t('testcase.noVersion')

      worksheetData.push([
        `TC${String(index + 1).padStart(3, '0')}`,
        testcase.title || '',
        testcase.project?.name || '',
        versions,
        convertBrToNewline(testcase.preconditions || ''),
        convertBrToNewline(testcase.steps || ''),
        convertBrToNewline(testcase.expected_result || ''),
        getPriorityText(testcase.priority),
        getTypeText(testcase.test_type),
        testcase.author?.username || '',
        formatDate(testcase.created_at)
      ])
    })
    
    // 创建工作表
    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData)
    
    // 设置列宽
    const colWidths = [
      { wch: 15 }, // Test case number
      { wch: 30 }, // Case title
      { wch: 20 }, // Related project
      { wch: 25 }, // Related versions
      { wch: 30 }, // Preconditions
      { wch: 40 }, // Steps
      { wch: 30 }, // Expected result
      { wch: 10 }, // Priority
      { wch: 15 }, // Test type
      { wch: 15 }, // Author
      { wch: 20 }  // Created at
    ]
    worksheet['!cols'] = colWidths
    
    // 设置表头样式
    for (let col = 0; col < worksheetData[0].length; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col })
      if (!worksheet[cellAddress]) continue
      worksheet[cellAddress].s = {
        font: { bold: true },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true }
      }
    }
    
    // 设置其他行的样式
    for (let row = 1; row < worksheetData.length; row++) {
      for (let col = 0; col < worksheetData[row].length; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col })
        if (worksheet[cellAddress]) {
          worksheet[cellAddress].s = {
            alignment: { vertical: 'top', wrapText: true }
          }
        }
      }
    }

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, t('testcase.excelSheetName'))

    // Generate filename
    const fileName = t('testcase.excelFileName', { date: new Date().toISOString().slice(0, 10) })

    // Export file
    XLSX.writeFile(workbook, fileName)

    ElMessage.success(t('testcase.exportSuccess'))
  } catch (error) {
    console.error('Export test cases failed:', error)
    ElMessage.error(t('testcase.exportFailed') + ': ' + (error.message || t('common.error')))
  } finally {
    loading.value = false
  }
}

const downloadBlob = (blob, fileName) => {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

const downloadImportTemplate = async () => {
  try {
    const response = await api.get('/testcases/import/template/', {
      responseType: 'blob'
    })
    downloadBlob(response.data, 'testcase_import_template_v1.xlsx')
    ElMessage.success(t('testcase.downloadTemplateSuccess'))
  } catch (error) {
    console.error('Download import template failed:', error)
    ElMessage.error(t('testcase.downloadTemplateFailed'))
  }
}

const openImportDialog = () => {
  importForm.value.projectId = projectFilter.value || ''
  selectedImportFile.value = null
  importDialogVisible.value = true
}

const beforeImportUpload = (file) => {
  const isXlsx = file.name.toLowerCase().endsWith('.xlsx')
  if (!isXlsx) {
    ElMessage.error(t('testcase.invalidImportFile'))
  }
  return isXlsx
}

const handleImportFileChange = (uploadFile) => {
  if (uploadFile?.raw) {
    selectedImportFile.value = uploadFile.raw
  }
}

const submitImport = async () => {
  if (!importForm.value.projectId) {
    ElMessage.warning(t('testcase.importProjectRequired'))
    return
  }
  if (!selectedImportFile.value) {
    ElMessage.warning(t('testcase.importFileRequired'))
    return
  }

  const formData = new FormData()
  formData.append('project_id', importForm.value.projectId)
  formData.append('file', selectedImportFile.value)

  isCreatingImport.value = true
  try {
    await api.post('/testcases/import-records/', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    })
    ElMessage.success(t('testcase.importCreated'))
    importDialogVisible.value = false
    goToImportRecords()
  } catch (error) {
    console.error('Create import record failed:', error)
    ElMessage.error(error.response?.data?.error || t('testcase.importCreateFailed'))
  } finally {
    isCreatingImport.value = false
  }
}

const goToImportRecords = () => {
  router.push('/ai-generation/testcases/import-records')
}

const fetchProjects = async () => {
  try {
    const response = await api.get('/projects/')
    projects.value = response.data.results || response.data || []
  } catch (error) {
    ElMessage.error(t('testcase.fetchProjectsFailed'))
  }
}

onMounted(async () => {
  await fetchProjects()
  await fetchModuleStats()
  await fetchTestCases()
})
</script>

<style lang="scss" scoped>
.page-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 20px;
  box-sizing: border-box;
  overflow: hidden;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  flex-shrink: 0;
}

.page-title {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
}

.header-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.card-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;

  .filter-search {
    width: 260px;
    max-width: 100%;
  }

  .filter-select {
    width: 160px;
  }

  .filter-project {
    width: 180px;
  }

  .filter-priority {
    width: 140px;
  }

  .filter-status {
    width: 120px;
  }
}

.module-filter {
  padding: 0 20px 14px;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}

.module-filter-label {
  font-size: 13px;
  color: #606266;
  margin-bottom: 8px;
}

.module-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.module-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #dcdfe6;
  background: #fff;
  color: #606266;
  border-radius: 16px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  line-height: 1.4;
}

.module-tab:hover {
  border-color: #409eff;
  color: #409eff;
}

.module-tab.active {
  border-color: #409eff;
  background: #ecf5ff;
  color: #409eff;
}

.module-tab-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 10px;
  background: #f0f2f5;
  color: #909399;
  font-size: 11px;
  text-align: center;
}

.module-tab.active .module-tab-count {
  background: #409eff;
  color: #fff;
}

.table-container {
  flex: 1;
  overflow: hidden;
  padding: 0 20px;
  min-width: 0;
  
  :deep(.el-table) {
    height: 100% !important;
    width: 100% !important;
  }
  
  :deep(.el-table__body-wrapper),
  :deep(.el-table__header-wrapper) {
    overflow-x: hidden !important;
  }

  :deep(.el-table__body-wrapper) {
    overflow-y: auto !important;
  }

  :deep(.title-link) {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }

  :deep(.action-btns) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    white-space: nowrap;
  }

  :deep(.action-btns .el-button) {
    margin: 0;
    padding: 0 4px;
  }
}

.pagination-container {
  padding: 20px;
  border-top: 1px solid #ebeef5;
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}

.import-alert {
  margin-bottom: 20px;
}

.import-upload {
  width: 100%;

  :deep(.el-upload),
  :deep(.el-upload-dragger) {
    width: 100%;
  }
}

.priority-tag {
  &.low { color: #67c23a; }
  &.medium { color: #e6a23c; }
  &.high { color: #f56c6c; }
  &.critical { color: #f56c6c; font-weight: bold; }
}

.version-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  
  .version-tag {
    margin: 0;
  }
}

.no-version {
  color: #909399;
  font-size: 12px;
  font-style: italic;
}

@media (max-width: 1200px) {
  .page-container {
    height: auto;
    min-height: 100vh;
    overflow-y: auto;
  }
  
  .card-container {
    min-height: 600px;
  }
  
  .table-container {
    min-height: 400px;
  }
}

@media (max-width: 768px) {
  .page-container {
    padding: 10px;
  }
  
  .page-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 15px;
  }
  
  .header-actions {
    width: 100%;
  }
  
  .filter-bar {
    padding: 15px;
  }
  
  .pagination-container {
    padding: 15px;
  }
}

.step-content {
  min-height: 200px;
}

.preview-info {
  padding: 15px;
  background-color: #f5f7fa;
  border-radius: 4px;

  p {
    margin: 5px 0;
  }
}
</style>
