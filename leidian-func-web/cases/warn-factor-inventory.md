# 因子库 — 功能测试用例设计清单

> 一级能力：因子库（warn_factor）  
> API：`GET /warning/factors`、`GET /options`、`GET /by-code/{code}`、`GET /{id}`、`PUT /{id}`（仅展示名/就绪状态）  
> 一期不开放 POST 新建 / 自定义删改列映射。

## 二级模块

| 模块 ID | 名称 | 用例数 |
|---------|------|--------|
| warn-factor-query | 因子库 / 查询筛选 | 3 |
| warn-factor-seed | 因子库 / 种子与就绪 | 4 |
| warn-factor-crud | 因子库 / 维护边界 | 3 |

## 用例

### 查询
| ID | 名称 | 可执行 |
|----|------|--------|
| wf-01-page | 因子分页列表 | 可跑 |
| wf-02-filter-category | 按 DEVICE/DERIVED 筛选 | 可跑 |
| wf-03-detail | 因子详情（by-code + id） | 可跑 |

### 种子与就绪
| ID | 名称 | 可执行 |
|----|------|--------|
| wf-10-seed-efield | 电场瞬时值/变化率因子存在 | 可跑 |
| wf-11-seed-derived | 派生因子种子存在 | 可跑 |
| wf-12-not-ready-flag | NOT_READY 因子有标记 | 可跑 |
| wf-13-device-prefix | 同名列带设备前缀 | 可跑 |

### 维护
| ID | 名称 | 可执行 |
|----|------|--------|
| wf-20-create-custom | 一期不开放 POST 新建（期望 405） | 可跑 |
| wf-21-update-rejected-builtin | 关键字段乱改被拒（期望 400） | 可跑 |
| wf-22-update-readiness | 可更新 readiness 并恢复 | 可跑 |
