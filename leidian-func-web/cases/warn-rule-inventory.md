# 预警规则管理 — 功能测试用例清单（按二级功能拆分）

> 一级能力：预警规则管理  
> 被测：`biz` → `/api/biz/warning/rules`  
> P0：`submit` 直接按审核通过；审核类用例在「审核流转」模块且默认 skip。

## 二级功能模块

| 二级模块 ID | 界面名称 | 用例数 | 说明 |
|-------------|----------|--------|------|
| `warn-rule-draft` | 规则管理 / 草稿配置 | 6 | 新建、编辑、入参校验、无草稿挂接 |
| `warn-rule-publish` | 规则管理 / 提交生效 | 4 | submit 首发/升版/失败 |
| `warn-rule-lifecycle` | 规则管理 / 启停删除 | 6 | disable/enable/delete |
| `warn-rule-query` | 规则管理 / 查询筛选 | 5 | 列表、详情 |
| `warn-rule-audit` | 规则管理 / 审核流转 | 4 | approve/reject/withdraw（P0 多 skip） |
| `warn-rule-e2e` | 规则管理 / 端到端 | 1 | 黄金路径串联 |

操作台左侧按**二级模块**选，避免「规则管理」下一坨 20+ 条难勾选。

## 用例分册

### 1) 草稿配置 `warn-rule-draft`

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-01-create-draft | 新建规则草稿 | 是 |
| wr-02-create-name-required | 新建缺规则名失败 | 是 |
| wr-03-create-bad-json | 新建非法 JSON 失败 | 是 |
| wr-04-update-draft | 编辑草稿内容 | 是 |
| wr-21-bad-schedule-type | 非法 scheduleType | 是 |
| wr-23-update-attach-draft | 已发布无草稿时更新挂接新草稿 | 是 |

### 2) 提交生效 `warn-rule-publish`

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-05-submit-first-publish | 提交即生效（首发） | 是 |
| wr-06-submit-supersede | 已启用改内容再提交（升版） | 是 |
| wr-07-submit-without-draft | 无草稿时二次提交失败 | 是 |
| wr-create-submit | 新建并提交（兼容旧用例） | 是 |

### 3) 启停删除 `warn-rule-lifecycle`

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-08-disable | 停用已启用规则 | 是 |
| wr-09-enable-from-disabled | 再启用已停用规则 | 是 |
| wr-10-disable-draft-fail | 停用非 ENABLED 失败 | 是 |
| wr-11-enable-draft-fail | 未发布再启用失败 | 是 |
| wr-15-delete-custom | 删除自定义规则 | 是 |
| wr-16-delete-builtin-fail | 删除内置失败 | 条件 skip |

### 4) 查询筛选 `warn-rule-query`

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-12-page-filter | 分页列表与关键词（含 list.0.id） | 是 |
| wr-13-detail | 规则详情（带前置创建） | 是 |
| wr-14-detail-not-found | 详情不存在 | 是 |
| wr-list | 规则分页列表（烟测） | 是 |
| wr-detail | 规则详情（烟测） | 是 |

### 5) 审核流转 `warn-rule-audit`（需 PENDING 造数）

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-17-approve-pending | 审核通过 | skip |
| wr-18-reject-pending | 审核驳回 | skip |
| wr-19-withdraw-pending | 撤回审核 | skip |
| wr-20-update-pending-fail | 待审不可编辑 | skip |

### 6) 端到端 `warn-rule-e2e`

| ID | 名称 | 可执行 |
|----|------|--------|
| wr-22-golden-path | 创建→提交→停用→启用→删除 | 是 |

## 设计 R-01～R-05 落点

| 设计 | 二级模块 | 用例 |
|------|----------|------|
| R-01 提交生效 | publish / e2e | wr-05, wr-22；全量审核 → audit/wr-17 |
| R-02 驳回 | audit | wr-18 |
| R-03 改内容 | publish | wr-06；待审角标未实现 |
| R-04 启停 | lifecycle | wr-08, wr-09（P0 直接启停） |
| R-05 内置 | lifecycle | wr-16 |
