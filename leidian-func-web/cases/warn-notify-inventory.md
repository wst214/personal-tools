# 通知联动 — 功能测试用例设计清单

> 一级能力：通知联动  
> 设计：§4.6；P2。依赖事件确认/ACTIVE 与通知通道替身。  
> 建议 API：`GET /warning/notify/records`、确认后副作用断言、失败重试查询

## 二级模块

| 模块 ID | 名称 | 用例数 |
|---------|------|--------|
| warn-notify-confirm | 通知 / 确认任务 | 3 |
| warn-notify-dispatch | 通知 / 预警投递 | 4 |
| warn-notify-retry | 通知 / 失败重试 | 2 |

## 用例

| ID | 名称 | 可执行 |
|----|------|--------|
| wn-01-confirm-task-created | 需确认命中产生确认任务 | skip |
| wn-02-confirm-then-notify | 确认后投递预警通知 | skip |
| wn-03-deny-confirm | 否定确认关闭并记原因 | skip |
| wn-10-dispatch-on-active | ACTIVE/UPGRADED 投递通知 | skip |
| wn-11-notify-only-suppress | NOTIFY_ONLY 不发通知 | skip |
| wn-12-channel-payload | 通知内容含等级与矿区 | skip |
| wn-13-audience-resolve | 通知对象按策略解析 | skip |
| wn-20-fail-retry | 发送失败按策略重试 | skip |
| wn-21-fail-fallback-channel | 失败切通道 | skip |
