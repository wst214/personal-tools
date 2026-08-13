# 设备解析接入 — 功能测试用例设计清单

> 一级能力：设备解析接入（`device-ingest`）  
> **验收目标（终态）**：不写设备 raw/standard；解析 → monitor → MinIO + 映射表。  
> **业务监测列表/详情**已拆到一级能力「业务监测查询」（`device-monitor`），见 `device-monitor-inventory.md`。
>
> **设计**：下方用例是**通用套件**，与选哪种设备无关。  
> 上方「设备类型」多选（默认全选）只作为开跑参数：标记了「按所选类型展开」的用例，会对每个勾选类型各跑一遍。

## 设备类型（开跑参数）

按**物理设备**勾选共 9 项（展示名带协议 typeId，如 `接地电阻 (03)`）。  
`SPD波形 (18)` 合并心跳/摘要：勾选一次，展开时各跑一遍。  
全链路注入 `deviceHex` 已备齐；缺失夹具会显式 skip 而非静默丢掉。

## 通用用例

| 模块 | 用例 | 展开？ | 状态 |
|------|------|--------|------|
| 烟测 | 设备统计 / 接入统计 | 否 | 可跑 |
| Monitor | 最近记录可查 | **是** `${deviceType}` | 可跑 |
| Monitor | 非法类型被拒 | 否 | 可跑 |
| 附件 | 按 monitor 查映射 | **是** | 可跑 |
| 附件 | presign / 按 attachment 查 | 否 | 可跑 |
| 全链路 | 入库可见（Kafka 注入） | **是**（勾选类型均需 deviceHex） | 可跑 |
| 全链路 | 接地电阻拒收（超上限） | 否 | 可跑 |
| 全链路 | 接地电阻低质（pH）+ clean_log | 否 | 可跑 |
| 全链路 | CRC 坏帧不落库 | 否 | 可跑 |
| 全链路 | 粘包半包拼帧 | 否 | 可跑 |
| 全链路 | 设备幂等 | 否 | **skip**（后端无 dedup） |

## 执行

1. 环境配置网关 + `kafkaBrokers`；data-service 开 ingest + MinIO `leidian-device`
2. `pip install -r requirements.txt`（含 `kafka-python`）
3. 选设备类型 → 勾选用例 → 开始执行

## 后端接口

- `GET /api/data/ingest/attachment/refs?monitorId=` / `attachmentId=`
- `GET /api/data/ingest/attachment/presign?attachmentId=`
- `GET /api/data/ingest/errors/recent?exceptionType=`
- `GET /api/data/ingest/clean-logs/recent?monitorId=` / `cleanRuleCode=`
