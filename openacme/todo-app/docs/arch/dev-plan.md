# 个人待办清单（Todo List）MVP — 开发拆解计划（dev-plan）

- **版本**：v1.0
- **作者**：dev-lead（开发代表）
- **状态**：待 developer 执行
- **依赖**：`docs/prd/prd.md` v1.0、`docs/arch/arch.md` v1.0、`docs/design/design.md` v1.0
- **项目根**：`teams/product-delivery/workspace/todo-app`
- **交付流水线**：规划 → 架构 → 设计 → 开发代表 → 开发 → 测试

---

## 1. 设计与架构可落地性结论

审阅 `arch.md` / `design.md` 后确认**可落地**，无阻塞问题，无需回写设计与架构岗：

- 三层职责（`store.js`/`render.js`/`app.js`）边界清晰、依赖单向，与 PRD 功能 F1–F6 / US1–US6 一一对应。
- `store.js` 为纯 JS + 可注入存储适配器（`createStore(storage)`），可在 Node 直接单测，满足可测性要求。
- 存储键 `todo.items`、全量覆盖写、防 XSS（`textContent`）等约定明确，无歧义。
- 行内编辑状态机（`idle ⇄ editing(id)`）设计完整，可在 `app.js` 内用一个 `currentEditId` + 编辑框引用实现。

无需新增架构未覆盖的模块或第三层依赖。

---

## 2. 交付文件清单（本次 MVP 全部文件）

| 文件 | 归属/职责 | 实现顺序 |
|------|-----------|----------|
| `todo-app/store.js` | 数据层（纯 JS，可注入存储）。导出 `createStore(storage)`，返回 `{ list, add, update, toggleDone, remove }` | ① |
| `todo-app/store.test.js` | 数据层单测（Node 直测，注入内存 mock storage） | ①（与 store.js 同批） |
| `todo-app/index.html` | 静态入口：Header、`form#add-form`、`ul#todo-list`；`<script type="module">` 引 app.js | ② |
| `todo-app/style.css` | 视觉层（见设计 §5/§6 class 约定） | ② |
| `todo-app/render.js` | 渲染层：`renderList`、`createEmptyState`、`createTodoItem` | ③ |
| `todo-app/app.js` | 交互层：事件绑定、表单校验、行内编辑状态机、启动加载 | ④ |

> 依赖方向（单向，禁止反向）：`app.js → store.js`、`app.js → render.js`、`render.js → store.js`。`store.js` 不得依赖 DOM / render。

---

## 3. 实现顺序与依赖

按「数据层先行、可独立单测」的思路排程：

1. **store.js + store.test.js**（数据层 + 单测）——纯逻辑，先行完成，可独立运行 `node --test store.test.js` 验证，不依赖其他文件。
2. **index.html + style.css**（静态结构与视觉）——依赖 store 的接口约定（`createStore` 签名），但可并行/随后实现。
3. **render.js**（渲染层）——依赖 `store.list()` 返回状态与 store 的条目结构。
4. **app.js**（交互层）——依赖 store 方法与 render 输出，串起完整数据流。
5. **冒烟自检**：对照 PRD §5 的 US1–US6 全量过一遍。

> 提示：开发时建议先跑通 `node --test store.test.js`（数据层绿灯），再实现 UI 各层，最后手动冒烟。

---

## 4. 单测覆盖点（store.test.js，必须覆盖）

| 分组 | 用例 | 断言 |
|------|------|------|
| `add` 合法 | 传入非空去空白标题 | 追加一条，`done=false`，生成 `id`/`createdAt`/`updatedAt`（US1） |
| `add` 空标题 | 空白/仅空白标题 | 拒绝/抛错，不写入（US1a） |
| `update` | 修改已存在条目标题 | `title` 更新、`updatedAt` 更新，其余字段不变（US2） |
| `update` 空标题 | 传空标题 | 拒绝，维持原值不写 |
| `toggleDone` | 对某条切换 | `done` 反转，`updatedAt` 更新（US4） |
| `remove` | 删除某条 | 该条移除，其余条目顺序与内容不变（US3） |
| 序列化往返 | `add` 后从存储读回 | `JSON.parse(getItem('todo.items'))` 可还原数组，字段完整（US5） |
| 损坏数据 | 存储为非法 JSON | 回退 `[]`，不崩溃（架构 §3.3） |
| 空存储 | 无 `todo.items` 或空 | `list()` 返回 `[]`（US6 空态） |
| 持久化异常 | `setItem` 抛错（mock） | 捕获并向上提示「保存失败」，不静默丢失（架构 §3.3） |

> 测试不依赖真实 DOM / 浏览器：用内存 mock 实现 `{ getItem, setItem }` 注入 `createStore`。

---

## 5. 完成定义（DoD）

- [ ] F1–F6 全部功能可用：新增、编辑、删除、标记完成、本地持久化、清单展示。
- [ ] `store.test.js` 单测全部通过（`node --test store.test.js` 绿灯）。
- [ ] localStorage 生效：刷新/关闭重开浏览器后数据完整恢复（US5）。
- [ ] 隔离可验证：浏览器冒烟对照 PRD §5 的 US1–US6。
- [ ] 防 XSS：标题渲染一律 `textContent`/`createTextNode`，无 `innerHTML` 拼接用户输入。

---

## 6. 下一步

- 由 dev-lead 新建开发子任务（或由 PM 派发）给 `developer`，按其实现。
- 完成后由 tester 对照 PRD §5 验收；测试失败打回 developer 修复后复测。