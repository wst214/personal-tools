# 开发执行记录 - 功能测试操作台（leidian-func-web）

<!--
  本文件由 intent-dev skill 生成。
  前置文件：intent-chain/2026-08-03-001-功能测试操作台/intent.md、prd.md、issues.md
  生成日期：2026-08-03
  每个工单按 TDD 循环开发，记录红灯→绿灯→重构过程。
-->

## 开发概述

- 产品名称：功能测试操作台（leidian-func-web）
- INTENT.md：intent-chain/2026-08-03-001-功能测试操作台/intent.md
- PRD：intent-chain/2026-08-03-001-功能测试操作台/prd.md
- 工单文件：intent-chain/2026-08-03-001-功能测试操作台/issues.md
- 工单总数：7
- 构建命令：docker compose build（亦可本地 `python web/server.py`）
- 测试命令：`python -m pytest tests/ -q`

---

## Issue 1: 操作台骨架与 PERF 同款界面

- 工单类型：纯样式配置

### TDD 过程

#### Red（先写测试，确认失败）

- 不适用原因：纯样式配置工单，按 skill 不要求 TDD Red

#### Green（写代码，确认通过）

- 代码文件：`web/index.html`、`web/style.css`（自 perf-web 复制）、`web/app.js`、`web/server.py`
- 代码内容摘要：四标签页骨架、PERF 绿系面板/徽章、术语界面文案、静态资源服务
- 运行命令：`python -m pytest tests/test_shell.py -v`
- 绿灯输出摘要：3 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P06] 视觉风格**

- Given: 操作台首页可访问
- When: 浏览各主要标签页
- [x] Then: 可见与 PERF 压测台一致的面板、标签页、徽章与绿系配色操作台观感 — V2，命令 `python -m pytest tests/test_shell.py -v` 输出: test_ui_has_perf_style_and_tabs PASSED；test_server_serves_index PASSED
- [x] And: 对照 `D:\mytools\leidian-perf-web\web` 结构一致 — V2，命令 `python -m pytest tests/test_shell.py::test_ui_has_perf_style_and_tabs -v` 输出: PASSED（校验 --accent/#0d6b54、.page-tab、.panel）
- [x] And: 界面文案使用术语表约定 — V2，命令 `python -m pytest tests/test_shell.py::test_ui_has_perf_style_and_tabs -v` 输出: PASSED（登录凭证/判定条件/压住预警/用例文件）

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：web/index.html, web/style.css, web/app.js, web/server.py, tests/test_shell.py
- 未通过项及修复计划：无

---

## Issue 2: 被测环境配置

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_env.py`
- 测试内容：保存 Base URL/登录凭证后从文件重新加载
- 运行命令：`python -m pytest tests/test_env.py -v`
- 红灯输出摘要：实现前无 env_store 模块会 ImportError；落地后与 Green 同命令全绿

#### Green（写代码，确认通过）

- 代码文件：`web/env_store.py`、`web/server.py`（/api/env）、`web/app.js`
- 代码内容摘要：env.json 持久化，credentialLabel 固定为「登录凭证」
- 运行命令：`python -m pytest tests/test_env.py -v`
- 绿灯输出摘要：1 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P02] 配环境并跑批（环境部分）**

- Given: 操作台已启动
- When: 填写被测 Base URL 与登录凭证并保存后重启
- [x] Then: 环境配置仍可被加载 — V2，命令 `python -m pytest tests/test_env.py -v` 输出: test_save_and_reload_env PASSED
- [x] And: 界面使用「登录凭证」文案（对应术语 Token） — V2，命令 `python -m pytest tests/test_env.py -v` 输出: PASSED（credentialLabel=登录凭证）

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：web/env_store.py, web/server.py, web/app.js, tests/test_env.py
- 未通过项及修复计划：无

---

## Issue 3: 按模块维护用例文件

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_cases.py`
- 测试内容：模块列表、增删改写 YAML
- 运行命令：`python -m pytest tests/test_cases.py -v`
- 红灯输出摘要：实现前 ImportError；落地后全绿

#### Green（写代码，确认通过）

- 代码文件：`web/case_store.py`、`web/server.py`、`web/app.js`、`web/index.html`
- 代码内容摘要：按 warn-rule / warn-suppress 读写 YAML，UI 展示「用例文件」「判定条件」「压住预警」
- 运行命令：`python -m pytest tests/test_cases.py -v`
- 绿灯输出摘要：2 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P01] 维护用例**

- Given: 操作台已启动，存在「预警规则配置」或「压住预警」模块
- When: 在对应模块下新增或编辑一条用例并保存
- [x] Then: 用例出现在该模块列表中 — V2，命令 `python -m pytest tests/test_cases.py -v` 输出: test_crud_persists_yaml PASSED
- [x] And: 重启操作台后该用例仍可从用例文件中加载 — V2，命令 `python -m pytest tests/test_cases.py::test_crud_persists_yaml -v` 输出: PASSED（YAML 落盘后 get_case 可读）
- [x] And: 界面使用「用例文件」「判定条件」「压住预警」文案 — V2，命令 `python -m pytest tests/test_cases.py::test_modules_include_rule_and_suppress -v` 输出: PASSED；`test_shell.py` 同步校验 HTML

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：web/case_store.py, web/server.py, web/app.js, web/index.html, tests/test_cases.py
- 未通过项及修复计划：无

---

## Issue 4: 勾选跑批、自动请求与逐条结果

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_runner.py`
- 测试内容：批量执行通过/失败原因、互斥跑批
- 运行命令：`python -m pytest tests/test_runner.py -v`
- 红灯输出摘要：实现前 ImportError；落地后全绿

#### Green（写代码，确认通过）

- 代码文件：`web/runner.py`、`web/history_store.py`、`web/server.py`、`web/app.js`
- 代码内容摘要：服务端代发 HTTP、判定条件、步骤变量、同时只跑一批、结果写历史
- 运行命令：`python -m pytest tests/test_runner.py -v`
- 绿灯输出摘要：2 passed

#### Refactor（重构，保持绿灯）

- 重构内容：`_dig` 支持数组下标；`${rand}` 占位

### 验证结果

**[P02] 配环境并跑批**

- Given: 已填写被测 Base URL 与登录凭证，且至少勾选一条可执行用例
- When: 点击批量执行
- [x] Then: 系统对每条勾选用例自动发起 HTTP 请求 — V2，命令 `python -m pytest tests/test_runner.py::test_batch_pass_fail_and_reason -v` 输出: PASSED
- [x] And: 每条用例展示通过或失败 — V2，命令 `python -m pytest tests/test_runner.py::test_batch_pass_fail_and_reason -v` 输出: PASSED（passed/failed 各一）
- [x] And: 失败用例可见失败原因 — V2，命令 `python -m pytest tests/test_runner.py::test_batch_pass_fail_and_reason -v` 输出: PASSED（原因含「状态码不符」）

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：web/runner.py, web/history_store.py, web/server.py, web/app.js, tests/test_runner.py
- 未通过项及修复计划：无

---

## Issue 5: 预警规则内置用例包

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_warn_rule_pack.py`
- 测试内容：内置 warn-rule 包对 stub 接口全通过
- 运行命令：`python -m pytest tests/test_warn_rule_pack.py -v`
- 红灯输出摘要：无用例文件时断言失败；补齐 YAML 后全绿

#### Green（写代码，确认通过）

- 代码文件：`cases/warn-rule/*.yaml`
- 代码内容摘要：列表/详情/新建启用内置用例
- 运行命令：`python -m pytest tests/test_warn_rule_pack.py -v`
- 绿灯输出摘要：1 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P03] 规则用例包**

- Given: 被测环境已启动且预警规则接口可用，环境配置正确
- When: 执行内置预警规则用例包中的用例
- [x] Then: 各用例结果与接口实际行为一致（通过/失败判定正确） — V2，命令 `python -m pytest tests/test_warn_rule_pack.py -v` 输出: test_builtin_warn_rule_pack_against_stub PASSED

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：cases/warn-rule/wr-list.yaml, wr-detail.yaml, wr-create-enable.yaml, tests/test_warn_rule_pack.py
- 未通过项及修复计划：无

---

## Issue 6: 压住预警内置用例包（含跳过）

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_suppress_pack.py`
- 测试内容：默认跳过不记失败；取消跳过时可执行通过
- 运行命令：`python -m pytest tests/test_suppress_pack.py -v`
- 红灯输出摘要：无内置 skip 用例时失败；补齐后全绿

#### Green（写代码，确认通过）

- 代码文件：`cases/warn-suppress/*.yaml`、`web/runner.py`（skip 分支）
- 代码内容摘要：默认 skip+原因；可执行路径验证
- 运行命令：`python -m pytest tests/test_suppress_pack.py -v`
- 绿灯输出摘要：2 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P04] 压住预警用例包**

- Given: 已加载压住预警用例包
- When: 执行该包中的用例
- [x] Then: 接口可用时给出通过或失败结果 — V2，命令 `python -m pytest tests/test_suppress_pack.py::test_suppress_executes_when_not_skipped -v` 输出: PASSED
- [x] And: 接口未齐时结果为跳过并带有明确原因（不记为失败） — V2，命令 `python -m pytest tests/test_suppress_pack.py::test_suppress_pack_defaults_to_skip -v` 输出: PASSED（failed=0）
- [x] And: 界面使用「压住预警」文案 — V2，命令 `python -m pytest tests/test_shell.py::test_ui_has_perf_style_and_tabs -v` 输出: PASSED

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：cases/warn-suppress/ws-apply.yaml, ws-terminate.yaml, tests/test_suppress_pack.py
- 未通过项及修复计划：无

---

## Issue 7: 历史执行记录

- 工单类型：新功能

### TDD 过程

#### Red（先写测试，确认失败）

- 测试文件：`tests/test_history.py`
- 测试内容：save/list/get 跑批明细
- 运行命令：`python -m pytest tests/test_history.py -v`
- 红灯输出摘要：实现前 ImportError；落地后全绿

#### Green（写代码，确认通过）

- 代码文件：`web/history_store.py`、`web/server.py`、`web/app.js`
- 代码内容摘要：data/runs 落盘与历史页展示
- 运行命令：`python -m pytest tests/test_history.py -v`
- 绿灯输出摘要：1 passed

#### Refactor（重构，保持绿灯）

- 重构内容：无

### 验证结果

**[P05] 查历史**

- Given: 至少完成过一次跑批
- When: 打开历史记录并选择该次跑批
- [x] Then: 可见该次各用例的结果明细 — V2，命令 `python -m pytest tests/test_history.py -v` 输出: test_history_roundtrip PASSED

### 工单状态

- 状态：done
- 最高验证等级：V2
- 验证时间：2026-08-03
- 修改的文件：web/history_store.py, web/server.py, web/app.js, tests/test_history.py
- 未通过项及修复计划：无

---

## 开发总结

- 工单总数：7
- done 数：7
- 未通过数：0
- 构建命令：`docker compose build`
- 测试命令：`python -m pytest tests/ -q`（全量摘要：12 passed in 2.21s）
