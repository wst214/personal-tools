# 隧道面板工作台风格重设计 Context Pack

## 1. 变更意图

- 用户原话：隧道控制面板风格重新改成和个人开发工作台风格一样，可以重新设计。
- 当前假设：仅重设计展示层，保留现有隧道接口、状态机、配置和启停行为。
- 已识别技术栈：Python Flask + 原生 HTML/CSS/JavaScript + Docker。
- 已加载技术栈规则：`impact-pro/profiles/generic.md`。
- 任务规模：中，涉及单页面完整视觉重构，但不跨 API 或后端模块。
- 成功标准：功能入口零丢失；14 个前端依赖 ID 全部保留；桌面和手机无横向溢出；移动端输入框高度正常；视觉与个人开发工作台一致。

## 2. 分层上下文

| 层级 | 内容 | 结论 |
|------|------|------|
| L1 项目地图 | Flask 入口、模板、静态资源、Dockerfile、README | 单页 Flask 工具，无前端构建步骤 |
| L2 变更邻域 | `templates/index.html`、`static/css/style.css`、`static/js/app.js`、`app.py` | UI 可独立重构，API 契约保持不变 |
| L3 精准证据 | 页面 DOM、JS 查询器和状态渲染、Flask 四个路由 | 14 个 ID 是兼容边界；状态值沿用后端定义 |

## 3. 相关文件和对象

| 文件/对象 | 类型 | 相关性 | 为什么相关 |
|-----------|------|--------|------------|
| `templates/index.html` | UI | 3 | 页面信息架构和全部交互控件 |
| `static/css/style.css` | UI | 3 | 视觉体系与响应式布局 |
| `static/js/app.js` | UI logic | 2 | 依赖 14 个 DOM ID，原则上不改逻辑 |
| `app.py` | API | 2 | 定义页面和 `/api/info`、status/start/stop 路由 |
| `tunnel_manager.py` | service | 1 | 隧道状态和进程逻辑，明确排除修改 |

## 4. 关键上下文

- 入口：`GET /` 渲染 `templates/index.html`。
- API：`GET /api/info`、`GET /api/tunnel/status`、`POST /api/tunnel/start`、`POST /api/tunnel/stop`。
- 状态：`idle`、`starting`、`running`、`error`、`stopped`，由现有 JS 映射中文标签。
- 配置：cpolar Token 和 Docker 宿主机地址转换均不在本次范围。
- 测试：项目无现成测试；新增只读 Playwright UI 检查脚本。

## 5. 已确认事实

- `/api/info` 返回 HTTP 200，Cloudflare 与 cpolar 均就绪。
- 桌面端 1280px 无横向溢出，全部关键控件存在。
- 现有 375px 手机布局中，目标地址输入框被拉高到约 280px。
- 项目不是 Git 仓库，回滚必须依靠实施前文件备份。
- JavaScript 与 Python 基线语法检查通过。

## 6. 待确认问题

- 无阻塞项。实际启动公网隧道具有外部副作用，UI 验收不自动执行该动作。

## 7. 暂不纳入范围

| 文件/对象 | 排除原因 |
|-----------|----------|
| `app.py` | API 契约稳定，无需修改 |
| `tunnel_manager.py` | 隧道进程与状态逻辑不属于视觉重设计 |
| `.env`、Dockerfile、Compose | 不涉及配置或部署结构变更 |

## 8. 上下文预算

- L1：查看 6 个文件或命令摘要。
- L2：保留 5 个候选文件/对象。
- L3：深入阅读 4 个文件。
