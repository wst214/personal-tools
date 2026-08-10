# 闪电定位接入（大小网/小小网）— 功能测试用例设计清单

> 一级能力：闪电定位接入（`lightning-ingest`）
> **验收目标**：雷电三网（大网 CMB / 小网 LOCATOR / 小小网 RADAR）接入 → monitor 合表 → 原文 MinIO + 映射表；分页/recent 查询可验证；重复投递幂等；拒收/低质可观测。
>
> **设计**：下方用例是**通用套件** + **按网络展开**（`expandByNetwork`）。标记了「按网络展开」的用例，会对三网（CMB/LOCATOR/RADAR）各跑一遍。

## 网络（开跑参数）

对齐 `monitor_lightning_strike.strike_type` 共 3 类：

| 网络 | strike_type | Kafka topic | biz 分页路径 |
|------|-------------|-------------|--------------|
| 大网 | CMB | `lightning-strike-cmb` | `/monitor/lightning/cmb/lightnings` |
| 小网 | LOCATOR | `lightning-strike-locator` | `/monitor/lightning/locator/lightnings` |
| 小小网 | RADAR | `lightning-strike-radar` | `/monitor/lightning/radar/lightnings` |

## 通用用例

| 模块 | 用例 | 展开？ | 状态 |
|------|------|--------|------|
| 烟测 | 接入统计含雷电三网计数 | 否 | 可跑 |
| 烟测 | 三网混合最近雷电可查 | 否 | 可跑 |
| Monitor | 三网分页列表可查 | **是** | 可跑 |
| Monitor | 三网最近记录可查 | **是** | 可跑 |
| Monitor | 非法分页参数 | **是** | 可跑 |
| Monitor | 三网互不串扰 | **是** | 可跑 |
| 附件 | 按 monitor 查映射 | 否 | 可跑 |
| 附件 | presign 原文下载 | 否 | 可跑 |
| 全链路 | Kafka → monitor → 附件 | **是** | 可跑 |
| 全链路 | 重复投递幂等 | **是** | 可跑 |
| 全链路 | 重复写 DUPLICATE clean_log | **是** | 可跑 |
| 全链路 | CMB 未来时间拒收 | 否 | 可跑 |
| 全链路 | 低质入库 + clean_log | **是** | 可跑 |

## 执行

1. 环境配置网关 + `kafkaBrokers`；data-service 开 ingest + MinIO
2. 选网络（默认三网全选）→ 勾选用例 → 开始执行
3. e2e 用例依赖 Kafka 投递雷电 JSON 到对应 topic；低质/去重断言依赖 `/ingest/clean-logs/recent`

## 后端接口

- `GET /api/biz/monitor/lightning/{cmb|locator|radar}/lightnings`（分页）
- `GET /api/data/ingest/standard/{cmb|locator|radar}/recent`（最近摘要）
- `GET /api/data/ingest/monitor/lightning/recent`（三网混合）
- `GET /api/data/ingest/attachment/refs?monitorId=` / `attachmentId=`
- `GET /api/data/ingest/attachment/presign?attachmentId=`
- `GET /api/data/ingest/errors/recent?exceptionType=`
- `GET /api/data/ingest/clean-logs/recent?monitorId=` / `cleanRuleCode=`
