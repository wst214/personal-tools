# 业务监测查询 — 功能测试用例设计清单

> 一级能力：业务监测查询（`device-monitor`）  
> **验收目标**：biz-service 设备监测列表/详情可查；分类筛选与时间跨度边界符合约定。  
> Gateway：`/api/biz`。不覆盖 Feign `/rpc/data/monitor/**`、ingest recent、SPD 心跳。

## 设备类型（开跑参数）

执行页可按物理设备多选；标记「按所选类型展开」的用例仅对有 BFF 的类型/变体展开（SPD 心跳无 BFF，自动跳过）。

| 类型 | typeId | 列表 | 详情 | 默认天数 |
|------|--------|------|------|----------|
| 大气电场 | 01/19 | `/monitor/atmosphere/atmospheres` | `/devices/{deviceId}` | 详情默认近 1 分钟；最大跨度 1 天 |
| 接地电阻 | 03 | `/monitor/grounding/groundings` | 同上 | 30 |
| 雷击电流 | 05/15 | `/monitor/surge-current/surge-currents` | 同上 | 90 |
| iSPD/PDU | 0F | `/monitor/ispd-pdu/ispd-pdus` | 同上 | 7 |
| 断接卡 | 09 | `/monitor/disconnect-card/disconnect-cards` | 同上 | 7 |
| 远程终端 | 10 | `/monitor/remote-terminal/remote-terminals` | 同上 | 7 |
| 避雷器在线监测 | 14 | `/monitor/surge-monitor/surge-monitors` | 同上 | 7 |
| 电源控制板 | 17 | `/monitor/power-board/power-boards` | 同上 | 7 |
| SPD 波形摘要 | 18 | `/monitor/spd-waveform/spd-waveforms` | 同上 | 30 |
| SPD 波形心跳 | 18 | **不做** | **不做** | — |

## 用例（二级：`device-monitor-query` 列表与详情）

| 用例 | 展开？ | 状态 |
|------|--------|------|
| `di-30` 列表可分页 | **是**（有 BFF） | 可跑 |
| `di-31` 详情可查 | **是**（列表空则跳过详情） | 可跑 |
| `di-32` 大气 01/19 分类 | 否 | 可跑 |
| `di-33` 雷击 05/15 分类 | 否 | 可跑 |
| `di-34` 大气详情超跨度拒 | 否 | 可跑（HTTP 200 + code=400） |
| `di-35` 九类列表烟测矩阵 | 否 | 可跑 |
| `di-36` 详情设备不存在 | 否 | 可跑（HTTP 200 + code=404） |
| `di-37` 列表响应结构 | 否 | 可跑（依赖演示种子） |
| `di-38` 详情响应结构 | 否 | 可跑（依赖演示种子） |
| `di-39` 合法时间窗可查 | 否 | 可跑 |
| `di-40` keyword 筛选 | 否 | 可跑（依赖演示种子） |
| `di-41` 新增类 deviceType 筛选 | 否 | 可跑（依赖 V1_010/V1_012） |
| `di-42` 行政区域筛选 | 否 | 可跑（依赖演示种子） |
| `di-43` 分页边界 | 否 | 可跑 |
| `di-44` 列表空结果仍成功 | 否 | 可跑 |
| `di-45` 详情无监测点仍成功 | 否 | 可跑（依赖演示设备 `DJK001`） |

## 执行

1. 左侧选「业务监测查询」
2. 执行页勾选用例；`di-30`/`di-31` 按上方设备类型多选展开
3. 环境需网关 + biz JWT
4. `di-37`～`di-42`、`di-45` 中标注「依赖演示种子」的步骤，需库已执行 V1_010（及 SPD 相关的 V1_012）演示数据
5. 契约对照：`di-36` 详情资源不存在 → HTTP 200 / 业务 404；`di-44` 列表无命中 → HTTP 200 / 业务 0；`di-45` 设备在但无点 → HTTP 200 / 业务 0 + `points=[]`
6. `di-34`/`di-36` 依赖已部署的 `GlobalExceptionHandler`（业务异常对外 HTTP 200）；若仍见 HTTP 400/404，需重新编译并重启 biz/data（含 `common-web`）

## 相关但不在本能力

- 设备解析接入：Kafka → monitor 入库 / 附件
- 闪电定位接入：三网列表 + 大网点位 `li-14`（开放签名 `li-15` skip）
- SPD 波形采样点 `samples` / `waveformHex` 拉取（产品暂不开放）
