# 新增 skip 用例质量债（对照 V2 评审）

> 覆盖面已齐；本文件跟踪「假绿 / 接口口径 / 缺验收断言」。

## 已修

| 项 | 状态 |
|----|------|
| wf-21 / wf-22 / wb-02 / wb-03 失败类改 `status:400` | 已改 |
| warn-gen-inventory 标明 `/warning/eval/trigger` 非 V2 §6.4 正式接口 | 已改 |

## 待定：评估触发口径

二选一（产品/架构拍板后再统一改 YAML）：

1. **补设计**：§6.4 增加 `POST /warning/eval/trigger`（调试/造数专用）  
2. **改用例**：评估类改 Kafka 造数，或仅用 `POST /warning/rules/{id}/test`

## 待补：skip 用例验收断言（范本 ws-19 / wb-03）

优先：`wg-10~14`、`wg-20~26`、`wn-02/03` — 多步造数 + capture + 状态/字段/副作用，勿只断 `code:0`。

## 后补缺口

NONE 限频、确认超时、TREND_UP 缺帧、并发锁、SUPERSEDED 历史解释、因子前缀冲突等（评审中/低项）。
