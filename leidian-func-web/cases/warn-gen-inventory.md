# 预警生成 — 功能测试用例设计清单（按二级功能拆分）

> 一级能力：预警生成（规则评估 → 抑制匹配 → 事件归并/生命周期 → 查询/通知）  
> 依据：`wst-temp/warning-rule-suppress-design-v2` §4.3～4.7  
> **评估第一刀已落地**：`POST /warning/eval/dry-run` 产出 Candidate（不落 `warn_event`）。  
> `warn-gen-eval` 6 条已按 dry-run 改写并可执行；抑制/生命周期/事件查询仍 skip。

## 二级功能模块

| 二级模块 ID | 界面名称 | 用例数 | 说明 |
|-------------|----------|--------|------|
| `warn-gen-smoke` | 预警生成 / P0 占位烟测 | 1 | 当前可跑 mock 列表 |
| `warn-gen-eval` | 预警生成 / 评估命中 | 6 | **可跑**：dry-run Candidate |
| `warn-gen-suppress-rt` | 预警生成 / 运行时抑制 | 5 | skip：运行时抑制未接 |
| `warn-gen-lifecycle` | 预警生成 / 事件生命周期 | 7 | skip：事件落库未接 |
| `warn-gen-query` | 预警生成 / 事件查询 | 4 | skip：事件查询未接 |
| `warn-gen-e2e` | 预警生成 / 端到端 | 2 | skip：依赖事件链路 |

**前置假设：**

1. 评估入口：`POST /warning/eval/dry-run`（`siteId` + 可选 `ruleId` / `factorOverrides`）。  
2. 条件 DSL：`{"logic":"AND","children":[{"factorCode":"...","op":"GTE","value":10}]}`（与引擎锁定一致）。  
3. 断言看 `data.candidates` / `data.skippedRules` / `data.contextSnapshot`；**不**查 `/warning/events`（未上线）。

**调试 API：**

| 用途 | path | 状态 |
|------|------|------|
| 评估试跑 | `POST /warning/eval/dry-run` | **已实现** |
| 事件分页/详情 | `GET /warning/events` | 未实现 |
| P0 占位列表 | `GET /warnings` | mock |

---

## 用例分册

### 0) P0 占位烟测 `warn-gen-smoke`（可执行）

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-00-mock-list | 占位预警列表可返回 | **是** | `GET /warnings` → code=0 |

### 1) 评估命中 `warn-gen-eval`（可执行 / dry-run）

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-01-hit-warning | 条件满足产出 Candidate | **是** | overrides 超阈 → candidates[0].BLUE + 版本钉扎 |
| wg-02-miss-below-threshold | 条件不满足无 Candidate | **是** | candidates=[] + skipped=condition_not_matched |
| wg-03-disabled-rule-ignored | DISABLED 不参与 | **是** | 停用后 dry-run 无候选 |
| wg-04-none-action-recorded | NONE 仍出 Candidate | **是** | 命中但 warningLevel=null；事件 RECORDED 另案 |
| wg-05-factor-not-ready | NOT_READY 不误报 | **是** | RISK_INDEX missing/not_ready |
| wg-06-version-pinned | Candidate 钉版本 | **是** | ruleVersionId = currentVersionId |

### 2) 运行时抑制 `warn-gen-suppress-rt`

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-10 ~ wg-14 | FULL / NOTIFY_ONLY / 目标匹配 | skip | 依赖运行时抑制过滤 |

### 3) 事件生命周期 `warn-gen-lifecycle`

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-20 ~ wg-26 | 生成/归并/升降级/解除/确认 | skip | 依赖 `warn_event` 落库 |

### 4) 事件查询 `warn-gen-query`

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-30 ~ wg-33 | 列表/详情/时间线/可见性 | skip | 依赖事件查询 API |

### 5) 端到端 `warn-gen-e2e`

| ID | 名称 | 可执行 | 要点 |
|----|------|--------|------|
| wg-40 / wg-41 | 命中→事件；FULL 抑制 | skip | 依赖完整运行链路 |

---

## 落地顺序建议

1. **现在**：跑通 `wg-00` + `warn-gen-eval`（dry-run）。需已部署带 `/warning/eval/dry-run` 的 biz-service，并执行 `V1_015`（因子种子，wg-05 依赖 RISK_INDEX）。  
2. **下一刀**：运行时抑制 → 再开 `wg-10/11/14`。  
3. **事件落库后**：开 `wg-20/30/40`，并把 eval 断言从 Candidate 延伸到 event。

## 与配置用例的边界

| 包 | 测什么 | 不测什么 |
|----|--------|----------|
| warn-rule / warn-suppress / warn-factor | 配置 CRUD / 审核 / 种子 | 运行时求值 |
| warn-gen-* | 评估 dry-run /（后续）事件与抑制运行时 | 配置治理细节 |
