# 预警域用例补全说明（本次）

新增一级能力：
- `warn-factor-*` 因子库（10，全 skip）
- `warn-notify-*` 通知联动（9，全 skip）
- `warn-backtest-*` 规则回测（5，全 skip）

补进既有包：
- `wr-24` BROADCAST 动作（可跑）
- `wr-25` 生效时间窗（skip，待字段）
- `wr-26` 内置种子列表（skip，待种子）
- `ws-19` ONCE 到期 EXPIRED（skip，待任务入口）
- `ws-20/21` 抑制审核（skip，P0 无 PENDING）

已有且不重复建设：
- 规则/抑制配置主路径
- 预警生成设计包 `warn-gen-*`（25，仅 wg-00 可跑）
