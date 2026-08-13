# 雷达回波接入 — 功能测试用例设计清单

> 一级能力：雷达回波接入（`radar-frame-ingest`）  
> **验收目标**：MinIO 上传 →（补投）`radar-frame-upstream` → 索引入库 → replay / recent(含 downloadUrl) / WS `RADAR_FRAME_READY`；幂等与命名边界可验。
>
> **勿与** 闪电「小小网 RADAR」混淆。

## 用例一览

| 模块 | id | 状态 |
|------|-----|------|
| 烟测 | `rf-01` status / `rf-02` unpublished 计数 | 可跑 |
| 查询 | `rf-10` replay / `rf-11` recent / `rf-12` minutes 边界 | 可跑 |
| 全链路 | `rf-40` 上传可见+presign / `rf-41` 幂等 / `rf-42` body 忽略 | 可跑 |
| 全链路 | `rf-44` 交替命名 / `rf-45` recent downloadUrl / `rf-46` WS | 可跑 |
| 全链路 | `rf-43` 发布补偿 / `rf-47` 真桶通知 | **skip**（环境依赖） |
| 边界 | `rf-50` 错误前缀 / `rf-51` 非法名 / `rf-52` 小小网隔离 | 可跑 |

## 缺口说明（故意 skip）

- **rf-43**：需注入 `kafkaPublished=false`，操作台不改库；用 `rf-02` 观测计数。
- **rf-47**：依赖 MinIO `notify_kafka`；本地常 off，启用后改 `skip: false`。
- **直连 RPC `/rpc/data/radar/frames/presign`**：不经网关对外；用 `rf-40`/`rf-45` 的 `downloadUrl` 间接验收。

## 环境

- 网关 + JWT；`kafkaBrokers`（容器 `kafka:29092`）
- MinIO：`minioEndpoint` / Key / `leidian-frame`
- 依赖：`minio`、`kafka-python`、`websocket-client`
