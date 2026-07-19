# 隧道面板工作台风格重设计 影响摘要

## 变更概述

把现有隧道控制面板重设计为与个人开发工作台一致的安静、实用型界面，并修复移动端输入框异常拉高问题。

## 判档证据

- 建议档位：light，用户已确认。
- 允许 light：仅改单页面模板和样式，不改 DB、API、权限、状态机、配置或外部服务逻辑。
- 触发 full：无。
- 未确认项：无阻塞项；不自动启动真实公网隧道。

## 精准修改边界

- 修改：`templates/index.html`、`static/css/style.css`。
- 保持：`static/js/app.js` 的查询器、事件和状态渲染逻辑。
- 不改：Flask 路由、TunnelManager、环境变量与 Docker 配置。
- 语义约定：沿用既有状态值和 API 响应字段。

## 实施步骤

1. 备份当前模板与样式文件。
2. 重构页面信息架构和 CSS 视觉系统，保留全部依赖 ID。
3. 重建 `mytools-tunnel-panel` 容器。
4. 验证 API、空值错误、Provider 切换、桌面和手机布局。

## 回滚方案

用实施前备份覆盖 `templates/index.html` 和 `static/css/style.css`，随后重新构建容器。

## 验证

- JavaScript 与 Python 语法检查。
- 14 个关键 DOM ID 完整性检查。
- `/api/info` 与 `/api/tunnel/status` 返回正常。
- Playwright 正向用例：页面加载、Provider 选择、控件状态。
- Playwright 错误用例：空地址提交显示错误。
- 375px 与 1280px 视口无横向溢出，手机输入框高度小于 80px。
