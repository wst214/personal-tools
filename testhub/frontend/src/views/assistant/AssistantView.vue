<template>
  <div class="assistant-layout">
    <!-- 左侧侧边栏 -->
    <div class="sidebar">
      <div
        class="back-home"
        role="button"
        tabindex="0"
        @click="router.push('/home')"
        @keydown.enter="router.push('/home')"
      >
        ← {{ $t('nav.home') }}
      </div>
      <div class="new-chat-btn-wrapper">
        <el-button type="primary" class="new-chat-btn" @click="startNewChat" :icon="Plus">
          {{ $t('assistant.newChat') }}
        </el-button>
      </div>
      
      <div class="history-list">
        <div class="history-label">{{ $t('assistant.historyChat') }}</div>
        <div class="session-scroll-area">
          <div 
            v-for="session in historySessionsDescending" 
            :key="session.id"
            :class="['session-item', { active: currentSession?.id === session.id }]"
            @click="switchToSession(session)"
          >
            <div class="session-title-wrapper">
              <el-icon class="chat-icon"><ChatDotRound /></el-icon>
              <span class="session-title" :title="session.title">{{ session.title || $t('assistant.newChat') }}</span>
            </div>
            <div class="session-actions" @click.stop>
              <el-popconfirm :title="$t('assistant.deleteSessionConfirm')" @confirm="deleteSession(session.id)">
                <template #reference>
                  <el-icon class="delete-icon"><Delete /></el-icon>
                </template>
              </el-popconfirm>
            </div>
          </div>
        </div>
      </div>
      
      <div class="user-profile">
        <el-dropdown trigger="click" @command="handleCommand">
          <div class="user-info">
            <el-avatar :size="32" :icon="UserFilled" />
            <span class="username">{{ userStore.user?.username || $t('assistant.user') }}</span>
            <el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="home">{{ $t('assistant.goHome') }}</el-dropdown-item>
              <el-dropdown-item command="logout" divided>{{ $t('assistant.logout') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <!-- 右侧主内容区 -->
    <div class="main-content">
      <!-- 场景1：新会话（居中输入框） -->
      <div v-if="isNewChatMode" class="welcome-screen">
        <div class="welcome-content">
          <div class="logo-area">
            <div class="logo-circle">
              <el-icon><Cpu /></el-icon>
            </div>
            <h1>{{ $t('assistant.title') }}</h1>
            <p>{{ $t('assistant.subtitle') }}</p>
          </div>
          
          <div class="center-input-wrapper">
            <el-input
              v-model="inputMessage"
              type="textarea"
              :rows="3"
              :placeholder="$t('assistant.inputPlaceholder')"
              class="center-input"
              resize="none"
              @keydown.enter.exact.prevent="handleEnter"
            />
            <div class="input-actions">
              <el-button 
                type="primary" 
                circle 
                :icon="Promotion" 
                :disabled="!inputMessage.trim()"
                @click="sendMessage"
              />
            </div>
          </div>
          
          <div class="suggestion-chips">
            <div class="chip" @click="useSuggestion($t('assistant.suggestions.apiTestQuestion'))">{{ $t('assistant.suggestions.apiTest') }}</div>
            <div class="chip" @click="useSuggestion($t('assistant.suggestions.performancePlanQuestion'))">{{ $t('assistant.suggestions.performancePlan') }}</div>
            <div class="chip" @click="useSuggestion($t('assistant.suggestions.testTheoryQuestion'))">{{ $t('assistant.suggestions.testTheory') }}</div>
            <div class="chip" @click="useSuggestion($t('assistant.suggestions.automationDebugQuestion'))">{{ $t('assistant.suggestions.automationDebug') }}</div>
          </div>
        </div>
      </div>

      <!-- 场景2：对话界面 -->
      <div v-else class="chat-screen">
        <div class="chat-header">
          <span class="chat-title">{{ currentSession?.title || $t('assistant.newChat') }}</span>
          <span class="chat-time" v-if="currentSession">{{ formatDate(currentSession.updated_at) }}</span>
        </div>
        
        <div class="messages-container" ref="messagesContainer">
          <div 
            v-for="(message, index) in messages" 
            :key="message.id || index"
            :class="['message-row', message.role]"
          >
            <div class="avatar">
              <el-avatar v-if="message.role === 'user'" :size="36" :icon="User" class="user-avatar" />
              <el-avatar v-else :size="36" :icon="Cpu" class="ai-avatar" />
            </div>
            <div class="message-bubble">
              <div class="message-content" v-html="formatMessageContent(message.content)"></div>
              <div class="message-status" v-if="message.isPending">
                <el-icon class="is-loading"><Loading /></el-icon> {{ $t('assistant.thinking') }}
              </div>
            </div>
          </div>
          
          <!-- 底部占位，确保滚动到底部 -->
          <div style="height: 20px;"></div>
        </div>

        <div class="chat-footer">
          <div class="input-box">
            <el-input
              v-model="inputMessage"
              type="textarea"
              :rows="1"
              :autosize="{ minRows: 1, maxRows: 5 }"
              :placeholder="$t('assistant.chatInputPlaceholder')"
              resize="none"
              @keydown.enter.exact.prevent="handleEnter"
            />
            <el-button 
              type="primary" 
              class="send-btn"
              :disabled="!inputMessage.trim() || sending"
              @click="sendMessage"
            >
              <el-icon><Promotion /></el-icon>
            </el-button>
          </div>
          <div class="footer-tip">{{ $t('assistant.aiDisclaimer') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useUserStore } from '@/stores/user'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Delete, ChatDotRound, User, Cpu, Promotion, Loading, UserFilled, ArrowDown } from '@element-plus/icons-vue'
import api from '@/utils/api'

const router = useRouter()
const userStore = useUserStore()
const { t, locale } = useI18n()

// 状态
const historySessions = ref([])
const currentSession = ref(null)
const messages = ref([])
const inputMessage = ref('')
const sending = ref(false)
const messagesContainer = ref(null)

const handleCommand = (command) => {
  if (command === 'logout') {
    handleLogout()
  } else if (command === 'home') {
    router.push('/home')
  }
}

const handleLogout = () => {
  ElMessageBox.confirm(t('assistant.logoutConfirm'), t('assistant.logoutTitle'), {
    confirmButtonText: t('assistant.confirm'),
    cancelButtonText: t('assistant.cancel'),
    type: 'warning'
  }).then(() => {
    userStore.logout()
    router.push('/login')
    ElMessage.success(t('assistant.loggedOut'))
  }).catch(() => {})
}

// 计算属性
const historySessionsDescending = computed(() => {
  return [...historySessions.value].sort((a, b) => 
    new Date(b.updated_at) - new Date(a.updated_at)
  )
})

const isNewChatMode = computed(() => {
  // 如果没有当前会话，或者当前会话没有消息且没有ID（临时会话），则显示新会话模式
  return !currentSession.value || (!currentSession.value.id && messages.value.length === 0)
})

// 方法
const formatDate = (dateString) => {
  if (!dateString) return ''
  const date = new Date(dateString)
  const now = new Date()
  const localeCode = locale.value === 'zh-cn' ? 'zh-CN' : 'en-US'
  // 如果是今天，只显示时间
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(localeCode, { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString(localeCode, { month: '2-digit', day: '2-digit' })
}

const formatMessageContent = (content) => {
  if (!content) return ''
  // 简单的 markdown 处理，实际项目中建议使用 markdown-it
  return content
    .replace(/\n/g, '<br>')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// 开启新会话
const startNewChat = () => {
  currentSession.value = { title: t('assistant.newChat') } // 临时会话对象
  messages.value = []
  inputMessage.value = ''
}

// 切换会话
const switchToSession = async (session) => {
  if (currentSession.value?.id === session.id) return
  
  try {
    currentSession.value = { ...session }
    const response = await api.get(`/assistant/sessions/${session.id}/messages/`)
    messages.value = response.data
    scrollToBottom()
  } catch (error) {
    console.error('Load messages failed:', error)
    ElMessage.error(t('assistant.messages.loadMessageFailed'))
  }
}

// 删除会话
const deleteSession = async (sessionId) => {
  try {
    await api.delete(`/assistant/sessions/${sessionId}/`)
    historySessions.value = historySessions.value.filter(s => s.id !== sessionId)
    
    if (currentSession.value?.id === sessionId) {
      startNewChat()
    }
    ElMessage.success(t('assistant.messages.sessionDeleted'))
  } catch (error) {
    console.error('Delete session failed:', error)
    ElMessage.error(t('assistant.messages.deleteSessionFailed'))
  }
}

// 使用建议
const useSuggestion = (text) => {
  inputMessage.value = text
  sendMessage()
}

// 处理回车发送
const handleEnter = (e) => {
  if (!e.shiftKey && !sending.value) {
    sendMessage()
  }
}

// 发送消息
const sendMessage = async () => {
  const text = inputMessage.value.trim()
  if (!text || sending.value) return
  
  inputMessage.value = ''
  sending.value = true
  
  // 1. 立即上屏用户消息
  const tempUserMsg = {
    role: 'user',
    content: text,
    created_at: new Date().toISOString()
  }
  messages.value.push(tempUserMsg)
  
  // 2. 添加一个临时的"思考中"消息
  const tempAiMsg = {
    role: 'assistant',
    content: '',
    isPending: true
  }
  messages.value.push(tempAiMsg)
  scrollToBottom()
  
  try {
    // 如果是新会话（没有ID），先创建会话
    let sessionId = currentSession.value?.id
    let isFirstMessage = false
    
    if (!sessionId) {
      isFirstMessage = true
      const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
      // 智能生成标题（取前10个字）
      const title = text.length > 10 ? text.substring(0, 10) + '...' : text
      
      const sessionRes = await api.post('/assistant/sessions/', {
        session_id: newSessionId,
        title: title
      })
      
      currentSession.value = sessionRes.data
      sessionId = currentSession.value.session_id // 注意：后端返回的是对象，这里需要用 session_id 字段
      
      // 立即添加到历史列表
      historySessions.value.unshift(currentSession.value)
    } else {
      // 如果是已有会话，使用 session_id 字段
      sessionId = currentSession.value.session_id
    }
    
    // 3. 发送请求
    const response = await api.post('/assistant/chat/send_message/', {
      session_id: sessionId,
      message: text
    }, {
      timeout: 60000
    })
    
    // 4. 替换临时消息为真实消息
    messages.value.pop() // 移除思考中
    messages.value.pop() // 移除临时用户消息（因为后端返回了完整的用户消息对象）
    
    messages.value.push(response.data.user_message)
    messages.value.push(response.data.assistant_message)
    
    // 更新会话的 conversation_id
    if (response.data.conversation_id && currentSession.value) {
      currentSession.value.conversation_id = response.data.conversation_id
    }
    
    // 如果是第一次对话，更新历史列表中的会话信息（比如 updated_at）
    if (!isFirstMessage) {
      const index = historySessions.value.findIndex(s => s.id === currentSession.value.id)
      if (index !== -1) {
        historySessions.value[index] = { ...currentSession.value, updated_at: new Date().toISOString() }
        // 重新排序（移到最前）
        const updatedSession = historySessions.value.splice(index, 1)[0]
        historySessions.value.unshift(updatedSession)
      }
    }
    
  } catch (error) {
    console.error('Send failed:', error)
    // 移除临时消息，显示错误
    messages.value.pop() // 移除思考中
    ElMessage.error(error.response?.data?.error || t('assistant.messages.sendFailed'))
  } finally {
    sending.value = false
    scrollToBottom()
  }
}

// 加载历史
const loadHistory = async () => {
  try {
    const response = await api.get('/assistant/sessions/')
    historySessions.value = response.data.results || response.data || []
  } catch (error) {
    console.error('Load history failed:', error)
  }
}

onMounted(() => {
  loadHistory()
  startNewChat()
})
</script>

<style scoped lang="scss">
.assistant-layout {
  display: flex;
  height: 100%;
  min-height: 100%;
  background: #eef6f2;
  overflow: hidden;
}

/* 左侧侧边栏 */
.sidebar {
  width: 220px;
  background: #f6faf8;
  border-right: 1px solid #dcebe4;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  color: #173b2c;
  padding: 8px 8px 10px;

  .back-home {
    flex-shrink: 0;
    min-height: 38px;
    margin: 0 0 6px;
    padding: 6px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 9px;
    color: #173b2c;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    transition: background .13s;
    user-select: none;

    &:hover {
      background: #e3f0ea;
      color: #173b2c;
    }
  }

  .new-chat-btn-wrapper {
    padding: 0 2px 12px;

    .new-chat-btn {
      width: 100%;
      height: 34px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      background: #409eff;
      border-color: #409eff;
      color: #fff;

      &:hover {
        background: #337ecc;
        border-color: #337ecc;
      }
    }
  }

  .history-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;

    .history-label {
      padding: 4px 10px 8px;
      font-size: 11px;
      font-weight: 600;
      color: #87a296;
      letter-spacing: .03em;
    }

    .session-scroll-area {
      flex: 1;
      overflow-y: auto;
      padding: 0 2px;
      min-height: 0;

      &::-webkit-scrollbar {
        width: 4px;
      }
      &::-webkit-scrollbar-thumb {
        background: rgba(13, 148, 136, 0.25);
        border-radius: 2px;
      }
    }

    .session-item {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      margin-bottom: 2px;
      border-radius: 9px;
      border: 1px solid transparent;
      cursor: pointer;
      transition: background .13s;
      color: #173b2c;

      &:hover {
        background: #e3f0ea;

        .session-actions {
          opacity: 1;
        }
      }

      &.active {
        background: #fff;
        box-shadow: 0 1px 3px rgba(20, 80, 60, 0.10);
        color: #409eff;
        font-weight: 600;

        &::before {
          content: "";
          position: absolute;
          left: -1px;
          top: 8px;
          bottom: 8px;
          width: 3px;
          border-radius: 3px;
          background: #409eff;
        }
      }

      .session-title-wrapper {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1;
        overflow: hidden;

        .chat-icon {
          font-size: 15px;
          color: inherit;
        }

        .session-title {
          font-size: 13px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      }

      .session-actions {
        opacity: 0;
        transition: opacity 0.2s;

        .delete-icon {
          font-size: 14px;
          color: #87a296;
          &:hover {
            color: #dc4c4c;
          }
        }
      }
    }
  }

  .user-profile {
    padding: 10px 4px 2px;
    border-top: 1px solid #e4f0ea;
    margin-top: 8px;

    .user-info {
      display: flex;
      align-items: center;
      cursor: pointer;
      padding: 6px 8px;
      border-radius: 8px;
      transition: background .13s;

      &:hover {
        background: #e3f0ea;
      }

      .username {
        margin: 0 8px;
        font-size: 13px;
        color: #173b2c;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .el-icon {
        color: #87a296;
      }
    }
  }
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  background: #eef6f2;
  min-width: 0;
  min-height: 0;
}

.welcome-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 20px 48px;
  min-height: 0;

  .welcome-content {
    width: 100%;
    max-width: 680px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .logo-area {
    text-align: center;
    margin-bottom: 28px;

    .logo-circle {
      width: 56px;
      height: 56px;
      background: #409eff;
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 14px;
      box-shadow: 0 1px 3px rgba(20, 80, 60, 0.12);

      .el-icon {
        font-size: 28px;
        color: white;
      }
    }

    h1 {
      font-size: 22px;
      font-weight: 700;
      color: #173b2c;
      margin: 0 0 6px;
    }

    p {
      color: #5f7a6d;
      font-size: 13px;
      margin: 0;
    }
  }

  .center-input-wrapper {
    width: 100%;
    position: relative;
    margin-bottom: 16px;

    .center-input {
      :deep(.el-textarea__inner) {
        border-radius: 12px;
        padding: 12px 48px 12px 14px;
        font-size: 13.5px;
        min-height: 88px !important;
        box-shadow: 0 1px 3px rgba(20, 80, 60, 0.08);
        border: 1px solid #dcebe4;
        background: #fff;
        color: #173b2c;
        transition: border-color .15s, box-shadow .15s;

        &:focus {
          box-shadow: 0 0 0 3px #e0f5f2;
          border-color: #409eff;
        }
      }
    }

    .input-actions {
      position: absolute;
      right: 10px;
      bottom: 10px;

      :deep(.el-button) {
        width: 32px;
        height: 32px;
        background: #409eff;
        border-color: #409eff;

        &:hover:not(:disabled) {
          background: #337ecc;
          border-color: #337ecc;
        }
      }
    }
  }

  .suggestion-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;

    .chip {
      padding: 5px 12px;
      background: #fff;
      border: 1px solid #dcebe4;
      border-radius: 8px;
      font-size: 12.5px;
      color: #5f7a6d;
      cursor: pointer;
      transition: all .13s;

      &:hover {
        background: #e0f5f2;
        border-color: #409eff;
        color: #409eff;
      }
    }
  }
}

.chat-screen {
  flex: 1;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;

  .chat-header {
    height: 48px;
    border-bottom: 1px solid #dcebe4;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 18px;
    flex-shrink: 0;
    background: #f6faf8;

    .chat-title {
      font-size: 14px;
      font-weight: 650;
      color: #173b2c;
    }

    .chat-time {
      font-size: 12px;
      color: #87a296;
    }
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    padding: 18px;
    background: #eef6f2;
    min-height: 0;

    .message-row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;

      &.user {
        flex-direction: row-reverse;

        .message-bubble {
          background: #409eff;
          color: white;
          border-radius: 12px 12px 4px 12px;

          :deep(pre) {
            background: rgba(0, 0, 0, 0.12);
          }

          :deep(code) {
            background: rgba(0, 0, 0, 0.12);
            color: #fff;
          }
        }
      }

      &.assistant {
        .message-bubble {
          background: #fff;
          color: #173b2c;
          border: 1px solid #dcebe4;
          border-radius: 12px 12px 12px 4px;
          box-shadow: 0 1px 2px rgba(20, 80, 60, 0.06);
        }
      }

      .avatar {
        flex-shrink: 0;
        margin-top: 2px;

        .user-avatar {
          background: #87a296;
        }

        .ai-avatar {
          background: #409eff;
        }
      }

      .message-bubble {
        max-width: 72%;
        padding: 10px 14px;
        font-size: 13.5px;
        line-height: 1.6;
        position: relative;

        .message-content {
          word-wrap: break-word;

          :deep(p) {
            margin: 0 0 8px 0;
            &:last-child { margin: 0; }
          }

          :deep(pre) {
            background: #173b2c;
            color: #e0f5f2;
            padding: 10px 12px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 8px 0;
          }

          :deep(code) {
            font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 12.5px;
          }
        }

        .message-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12.5px;
          color: #87a296;

          .is-loading {
            animation: rotating 2s linear infinite;
          }
        }
      }
    }
  }

  .chat-footer {
    padding: 12px 18px 14px;
    border-top: 1px solid #dcebe4;
    background: #f6faf8;

    .input-box {
      position: relative;
      border: 1px solid #dcebe4;
      border-radius: 10px;
      padding: 6px;
      background: #fff;
      transition: border-color .15s, box-shadow .15s;

      &:focus-within {
        border-color: #409eff;
        box-shadow: 0 0 0 3px #e0f5f2;
      }

      :deep(.el-textarea__inner) {
        border: none;
        box-shadow: none;
        padding: 8px 46px 8px 8px;
        background: transparent;
        font-size: 13.5px;
        color: #173b2c;
      }

      .send-btn {
        position: absolute;
        right: 8px;
        bottom: 8px;
        width: 30px;
        height: 30px;
        padding: 0;
        border-radius: 7px;
        background: #409eff;
        border-color: #409eff;
      }
    }

    .footer-tip {
      text-align: center;
      font-size: 11.5px;
      color: #87a296;
      margin-top: 6px;
    }
  }
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>