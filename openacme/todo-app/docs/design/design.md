# 个人待办清单（Todo List）MVP — 概要 / 详细设计

- **版本**：v1.0
- **作者**：designer（产品设计）
- **状态**：待产品经理验收
- **依赖**：`docs/prd/prd.md`（v1.0）、`docs/arch/arch.md`（v1.0）
- **项目根**：`teams/product-delivery/workspace/todo-app`
- **交付流水线**：规划 → 架构 → 设计 → 开发 → 测试

> 本设计在架构（arch.md）的模块边界内产出 UI 结构、交互、视觉与组件约定，供开发代表拆分任务。**不新增架构未覆盖的模块**，所有行为收敛到 `store.js` / `render.js` / `app.js` 三层职责。

---

## 1. 设计目标与约束

- **目标**：单页、纯前端、零后端，MVP 功能完整（F1–F6 / US1–US6），结构清晰可维护。
- **约束（来自架构）**：
  - `store.js` 为纯数据层，**不引用 DOM**，可被 Node 单测。
  - 渲染层只读状态、只写 DOM；交互层做事件编排与表单校验。
  - **禁止 `innerHTML` 拼接用户输入**（防 XSS），一律 `textContent` / `createTextNode`。
  - 单一存储键 `todo.items`，全量覆盖写。
- **视觉基调**：简单、清晰、克制的 MVP 视觉；不追求精致，但布局与层级明确。

---

## 2. 页面结构（单页布局）

### 2.1 布局总览

单页垂直排布，自上而下三段：

```
┌────────────────────────────────────────────┐
│  Header：标题「我的待办」                      │
├────────────────────────────────────────────┤
│  AddBar：输入区（文本框 + 「添加」按钮）        │
├────────────────────────────────────────────┤
│  List：待办列表                              │
│    ├─ 空态（EmptyState）：无待办时显示        │
│    └─ 待办行（TodoItem，可多条）              │
└────────────────────────────────────────────┘
```

### 2.2 区域与角色

| 区域 | 容器/元素 | 内容 | 负责模块 |
|------|-----------|------|----------|
| Header | `header` | 页面标题「我的待办」 | index.html（静态） |
| AddBar | `form#add-form` | 文本框 `input#new-todo` + 提交按钮 `button[type=submit]` | app.js（绑定提交） |
| List | `ul#todo-list` | 空态块 / 若干 `li.todo-item` | render.js |
| 待办行 | `li.todo-item` | 勾选框 + 标题 + 操作按钮 | render.js |

### 2.3 待办行（TodoItem）内部结构

```
<li class="todo-item [is-done]">
  <input type="checkbox" class="todo-toggle" aria-label="标记完成">
  <span class="todo-title">待办标题文本</span>
  <div class="todo-actions">
    <button class="btn-edit">编辑</button>
    <button class="btn-delete">删除</button>
  </div>
</li>
```

- 完成项：`li` 加 `is-done` 类，`todo-title` 加删除线 + 变灰。
- 每行带 `data-id` 属性，交互层据此定位条目。

---

## 3. 交互流程（详细）

统一交互模式（与架构 §4 数据流一致）：**事件 → app.js 编排 → store 方法 → 持久化 → 重渲染**。

### 3.1 新增（US1 / US1a）

```
用户输入标题 → 点击「添加」或按 Enter（add-form submit）
  → app.js 读取 value，trim
     ├─ 空 → 就地提示（输入框红边 + 提示文案「待办内容不能为空」），不进入数据层，流程终止
     └─ 非空 → store.add(title)
                 ├─ 生成 id/createdAt/updatedAt，done=false
                 ├─ 追加数组，setItem 持久化
                 └─ 返回新条目
     → 清空输入框 → render 重渲染全列表
```

- 提交后输入框清空，光标回到输入框（便于连续录入）。
- 校验提示为**就地非阻塞**：不清空用户已输入内容，仅标红 + 文案提醒。

### 3.2 编辑（US2）— 采用「行内编辑」

**决策：行内编辑，非弹窗**（理由：单字段文本，行内修改最直接、无模态打断；MVP 低成本）。

```
点击该行「编辑」
  → 行内进入编辑态：标题 span 替换为 <input class="edit-input">（预填当前 title）
      操作按钮区变为「保存」「取消」
  → 用户输入新标题
     ├─ 点击「保存」或按 Enter
     │    → 读取新值 trim
     │       ├─ 空 → 就地提示（不保存，维持编辑态）
     │       └─ 非空 → store.update(id, { title }) → 持久化 → 退出编辑态 → 重渲染
     └─ 点击「取消」或按 Esc
          → 放弃修改，退出编辑态，不做任何写入
```

- **每行同时仅允许一条处于编辑态**；进入某行编辑时，若其他行正在编辑则先提交/取消其编辑态。
- 编辑态样式：`li` 加 `is-editing` 类。

### 3.3 删除（US3）

**决策：不弹确认框**（遵循 PRD §6.4「删除即最终，MVP 简化」；删除为低代价、可通过重录快速恢复）。

```
点击该行「删除」
  → store.remove(id) → 从数组移除 → setItem 持久化 → 重渲染
  → 其余条目顺序与状态不变
```

> 误删恢复不在 MVP 范围（PRD 非目标：无回收站/撤销）。设计上删除按钮置于行尾、视觉弱化（次级按钮），降低误触概率。

### 3.4 标记完成 / 未完成（US4）

```
点击该行勾选框
  → store.toggleDone(id) → done 反转 → 更新 updatedAt → setItem 持久化 → 重渲染
  → 完成项：标题删除线 + 变灰；勾选框打勾
```

- 勾选框用 `change` 事件（而非 `click`），配合原生 checkbox 状态，避免手动切换样式。

### 3.5 启动加载（US5 / US6）

```
页面 DOMContentLoaded → app.js 调 store.list()（内部 JSON.parse localStorage）
  ├─ 空/非法 → 回退 [] → 渲染空态
  └─ 有数据 → 渲染全部条目（含完成状态）
  → 刷新/重开浏览器数据从 localStorage 恢复
```

- 渲染顺序：**按数组原始顺序**（即创建顺序，先创建在前）。不做排序（PRD 非目标）。

---

## 4. 空态与边界处理

### 4.1 空列表（无任何待办）
- 列表区显示空态块 `EmptyState`：文案「暂无待办，输入上方内容开始记录」。
- 空态块**不渲染任何待办行**；AddBar 始终可用。

### 4.2 全完成
- 不特殊处理页面级状态，仅逐行呈现完成样式（删除线 + 变灰）。
- 可选轻量信息：列表顶部显示「N 项待办 / M 项已完成」统计（低成本，增强状态可见性）。**若开发成本可控则做，否则可省略**（非验收必须）。

### 4.3 撤销 / 误操作
- **删除不提供撤销**（PRD 非目标）。以「删除按钮弱化视觉」为缓解手段。
- 编辑取消（Esc / 取消按钮）= 放弃本次修改，不算写入，天然可「撤销」。

### 4.4 数据异常
| 场景 | 处理 |
|------|------|
| localStorage 为非法 JSON | `store` 读取回退 `[]`，控制台告警，不崩溃 |
| `setItem` 抛错（容量/隐私模式） | 捕获并就地提示「保存失败」，应用降级为不可持久化仍可操作 |
| 空标题提交 | 就地提示，拒绝创建/更新 |

### 4.5 输入边界
- 所有标题写入前 `trim`（去首尾空白）。
- 超长标题：不设硬限制，靠 CSS 在单行内 `text-overflow: ellipsis` 省略显示，完整内容在编辑态可见。

---

## 5. 视觉风格（MVP 简化但有层级）

- **布局**：居中单列，最大宽度约 560px，上下留白；移动/窄屏自适应为全宽。
- **配色**：中性底（白/浅灰），主操作「添加」用强调色（如蓝），危险操作「删除」用警示色（红）但视觉弱化（次级/灰红）。
- **完成态**：标题 `line-through` + 降饱和灰。
- **字体**：系统字体栈 `system-ui`，正文 16px，标题稍大。
- **间距/圆角**：统一小间距（8px 基准）、卡片/列表项圆角 6–8px，分隔线浅灰。
- **交互反馈**：按钮 hover 轻微变色；行 hover 高亮背景，便于定位操作按钮。
- **可访问性**：勾选框带 `aria-label`；按钮有可读文本；输入框有 `label` 或 `aria-label`。

> 视觉以「结构清晰」为第一优先级，不引入外部 UI 库/图标库，全部用原生元素 + 少量 CSS。

---

## 6. 组件 / 结构约定（供开发直接实现）

### 6.1 文件与职责映射

| 文件 | 归属 | 关键导出/结构 |
|------|------|---------------|
| `index.html` | 静态入口 | Header、`form#add-form`、`ul#todo-list`；`<script type="module">` 引 app.js |
| `store.js` | 数据层（纯 JS） | `createStore(storage)` 返回 `{ list, add, update, toggleDone, remove }`；`storage` 可注入（默认 `window.localStorage`） |
| `render.js` | 渲染层 | `renderList(container, items)`；`createEmptyState()`；`createTodoItem(item)` |
| `app.js` | 交互层 | 事件绑定、表单校验、行内编辑状态机、调用 store + render |
| `style.css` | 视觉 | 上述视觉约定的类样式 |
| `store.test.js` | 数据层单测 | Node 直测 store（注入内存 mock storage） |

### 6.2 DOM 结构约定（class 命名）

- 容器：`#app`、`#add-form`、`#new-todo`、`#todo-list`
- 行：`.todo-item`、状态类 `.is-done`、`.is-editing`
- 行内元素：`.todo-toggle`、`.todo-title`、`.edit-input`、`.todo-actions`、`.btn-edit`、`.btn-delete`、`.btn-save`、`.btn-cancel`
- 空态：`.empty-state`
- 反馈：`.field-error`（校验提示）、`.save-error`（持久化失败提示）

### 6.3 行内编辑状态机（app.js 内维护）

状态：`idle`（均非编辑） ⇄ `editing(id)`（第 id 行编辑中）
- `idle → editing(id)`：点击编辑
- `editing(id) → idle`：保存成功 / 取消 / Esc / 切换编辑其他行
- 用一个「当前编辑 id」变量 + 一个「编辑输入框引用」管理，渲染时据 `is-editing` 类切换 DOM。

### 6.4 安全约定（强制）
- 渲染标题一律 `document.createTextNode(title)` 或 `el.textContent = title`。
- **禁止** `innerHTML` 拼接任何用户输入标题。
- 事件绑定用 `addEventListener`，不用内联 `on*` 属性。

---

## 7. 与架构约束一致性检查

| 架构约束 | 本设计落实情况 |
|----------|----------------|
| store.js 纯 JS、不依赖 DOM | ✅ 所有标题值/校验逻辑在 store，DOM 只在 render/app |
| 数据写操作全部走 store | ✅ 交互一律调 `store.add/update/toggleDone/remove`，无二路写入 |
| 存储适配器可注入（可测） | ✅ `createStore(storage)`，测试注入内存 mock |
| 无反向依赖（store 不依赖 render） | ✅ 依赖方向仅 app→store、app→render、render→store |
| 防 XSS（textContent） | ✅ §6.4 强制 |
| 单一键 `todo.items` 全量写 | ✅ 沿用架构 §3 |
| 无后端/构建链/路由 | ✅ 纯静态、无引入 |

---

## 8. 待开发拆分提示（供开发代表）

- 数据层 `store.js` + `store.test.js`（纯逻辑，先行，可独立单测）。
- 静态结构 `index.html` + `style.css`。
- 渲染层 `render.js`（列表/空态/行渲染，含完成态样式）。
- 交互层 `app.js`（新增/编辑状态机/删除/勾选/启动加载）。
- 冒烟验收：F1–F6 / US1–US6 对照 PRD §5。