# 预警抑制管理 — 功能测试用例清单（按二级功能拆分）

> 一级能力：预警抑制管理  
> 被测：`biz` → `/api/biz/warning/suppress`  
> P0：`submit` 直接 ACTIVE；仅 DRAFT 可改；ACTIVE 只能 terminate；删 ACTIVE 拒绝。

## 二级功能模块

| 二级模块 ID | 界面名称 | 用例数 | 说明 |
|-------------|----------|--------|------|
| `warn-suppress-draft` | 抑制管理 / 草稿配置 | 6 | 新建、编辑、校验、纯 DEVICE |
| `warn-suppress-publish` | 抑制管理 / 提交生效 | 3 | submit / 不可改 |
| `warn-suppress-lifecycle` | 抑制管理 / 终止删除 | 5 | terminate / delete / 缺原因 |
| `warn-suppress-query` | 抑制管理 / 查询筛选 | 3 | 列表、详情 |
| `warn-suppress-e2e` | 抑制管理 / 端到端 | 1 | 黄金路径 |

## 用例分册

### 1) 草稿配置
| ID | 名称 | 可执行 |
|----|------|--------|
| ws-01-create-draft | 新建抑制草稿 | 是 |
| ws-02-create-name-required | 缺名称失败 | 是 |
| ws-03-create-dup-target-fail | 目标重复失败 | 是 |
| ws-04-create-expired-fail | ONCE 已过期失败（动态 now-） | 是 |
| ws-05-update-draft | 编辑草稿 | 是 |
| ws-17-create-device-only | 纯 DEVICE 目标 | 是 |

### 2) 提交生效
| ID | 名称 | 可执行 |
|----|------|--------|
| ws-06-submit-active | 提交即生效 | 是 |
| ws-07-update-active-fail | 生效后不可编辑 | 是 |
| ws-08-submit-twice-fail | 重复提交失败 | 是 |

### 3) 终止删除
| ID | 名称 | 可执行 |
|----|------|--------|
| ws-09-terminate | 终止 ACTIVE | 是 |
| ws-10-terminate-draft-fail | 终止草稿失败 | 是 |
| ws-11-delete-draft | 删除草稿 | 是 |
| ws-12-delete-active-fail | 删除 ACTIVE 失败 | 是 |
| ws-18-terminate-reason-required | 终止缺原因失败 | 是 |

### 4) 查询筛选
| ID | 名称 | 可执行 |
|----|------|--------|
| ws-13-page-filter | 分页关键词（含 list.0.id） | 是 |
| ws-14-detail | 详情 | 是 |
| ws-15-detail-not-found | 详情不存在 | 是 |

### 5) 端到端
| ID | 名称 | 可执行 |
|----|------|--------|
| ws-16-golden-path | 创建→提交→终止→删除 | 是 |

## 设计 S-01～S-05 落点（配置侧）

| 设计 | 本清单覆盖 | 说明 |
|------|------------|------|
| S-01/S-02 FULL/NOTIFY_ONLY | draft/publish 用 scope 字段 | 匹配引擎不在本包 |
| S-03 仅设备目标 | ws-17 纯 DEVICE；ws-05 含 DEVICE+LEVEL | 运行时匹配另测 |
| S-05 终止/到期 | ws-09 terminate；ws-18 缺原因；EXPIRED 靠定时任务 | 到期扫描不在 HTTP 用例里强断言 |
