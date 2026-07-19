# 雷电功能点测试工作台规划

## 1. 工具定位

雷电功能点测试工作台用于把现在需要人工逐步验证的功能链路，沉淀成可配置、可复用、可执行、可追溯的测试用例。

它不是单一的 MinIO 测试脚本，也不是简单接口调试工具，而是面向雷电项目的功能点链路验证平台。

核心目标：

- 在页面上维护本地、开发、测试等环境配置，不要求手动改文件。
- 在页面上切换当前环境，后续所有用例按当前环境执行。
- 按功能点维护测试用例，比如 MinIO 雷达帧上传全链路、设备 HEX 解析入库查询链路。
- 顺序执行用例步骤，自动检查 Kafka、数据库、HTTP API、WebSocket 等证据。
- 给出清晰的通过/失败结果，并定位失败发生在哪一层。
- 后续新增功能点时，只新增用例和对应能力，不改整体框架。

## 2. 关键设计原则

### 2.1 页面配置优先

环境、能力、用例参数、测试数据、断言条件都应支持页面维护。

配置文件只作为本地持久化结果，不要求用户直接打开修改。

### 2.2 环境不写死字段

不同功能点需要的环境配置不同。

例如：

- MinIO 全链路需要 endpoint、accessKey、secretKey、bucket。
- 设备解析链路不需要 MinIO，但需要设备类型、Kafka topic、样例 HEX、相关 DB 表和查询 API。
- 后续远程连接、临时隧道、本地服务，也会有自己的配置项。

因此环境模型必须采用“基础配置 + 能力模块配置”。

### 2.3 用例声明自己需要哪些能力

不是每个环境都强制配置所有字段，而是测试用例声明 requiredCapabilities。

运行前根据当前环境检查这些能力是否完整。

### 2.4 结果必须有证据

报告不能只显示成功/失败，必须展示每一步的证据：请求参数、返回结果、Kafka 消息摘要、DB 查询结果、WebSocket 推送内容、耗时、traceId、失败原因。

## 3. 页面规划

### 3.1 执行中心

用于日常测试。

主要区域：

- 当前环境切换：本地环境、开发环境、测试环境、自定义环境。
- 用例分类：MinIO 链路、设备链路、接口链路、本地服务、临时隧道、远程连接。
- 用例列表：展示用例名称、所需能力、最近执行结果、最近执行时间。
- 执行面板：展示步骤进度、实时日志、失败位置。
- 快捷操作：全链路执行、单步执行、从失败步骤重试、跳过可选步骤。

### 3.2 环境配置

用于维护不同环境。

环境基础信息：

- 环境名称
- 环境标识
- 说明
- 是否默认环境

基础服务配置：

- gatewayUrl
- dataServiceUrl
- bizServiceUrl
- taskServiceUrl
- auth token 或登录方式

能力模块配置：

- Kafka
- Database
- MinIO
- WebSocket
- Device Ingest
- Tunnel
- Remote Connect
- Local Service

每个能力模块支持启用/禁用、表单配置、测试连接、保存、查看最近一次检查结果。

### 3.3 用例库

用于维护功能点测试用例。

用例包含：

- 用例名称
- 功能分类
- 适用环境
- 所需能力 requiredCapabilities
- 测试数据
- 执行步骤
- 断言条件
- 证据采集规则
- 超时和重试策略

支持新建、复制、编辑、禁用、导入导出、调整步骤顺序。

### 3.4 执行报告

用于复盘每一次测试。

报告内容：

- 执行环境
- 执行人或触发来源
- traceId
- 开始时间、结束时间、总耗时
- 总体结果
- 步骤明细
- 每一步证据
- 失败定位
- 建议排查方向

## 4. 环境配置模型

环境由 base 和 capabilities 组成。

```json
{
  "id": "dev",
  "name": "开发环境",
  "base": {
    "gatewayUrl": "http://localhost:8080",
    "dataServiceUrl": "http://localhost:8082",
    "bizServiceUrl": "http://localhost:8083"
  },
  "capabilities": {
    "kafka": {
      "enabled": true,
      "bootstrapServers": "localhost:9092"
    },
    "database": {
      "enabled": true,
      "jdbcUrl": "jdbc:mysql://localhost:3306/leidian",
      "username": "root",
      "passwordRef": "dev.mysql.password"
    },
    "minio": {
      "enabled": true,
      "endpoint": "http://localhost:9000",
      "accessKey": "leidian_upstream",
      "secretKeyRef": "dev.minio.secretKey",
      "bucket": "leidian-frame"
    },
    "websocket": {
      "enabled": true,
      "url": "ws://localhost:8083/realtime/ws"
    },
    "deviceIngest": {
      "enabled": true,
      "rawTopic": "device-raw-data",
      "standardTopic": "leidian.realtime.standard"
    }
  }
}
```

密码字段建议使用 passwordRef，在本地安全存储中保存真实值，页面只显示是否已配置。

## 5. 用例模型

```json
{
  "id": "minio-radar-frame-full-link",
  "name": "MinIO 雷达帧上传全链路",
  "category": "MinIO 链路",
  "requiredCapabilities": ["minio", "kafka", "database", "http", "websocket"],
  "steps": [
    { "id": "precheck", "name": "环境预检查", "type": "precheck" },
    { "id": "upload-minio-object", "name": "上传雷达帧文件到 MinIO", "type": "minio.upload" },
    { "id": "check-upstream-topic", "name": "检查 radar-frame-upstream 消息", "type": "kafka.assertMessage" },
    { "id": "check-db-file-tables", "name": "检查文件元数据和帧索引入库", "type": "database.assertRows" },
    { "id": "check-standard-topic", "name": "检查 leidian.realtime.standard 消息", "type": "kafka.assertMessage" },
    { "id": "check-websocket", "name": "检查 WebSocket 推送", "type": "websocket.assertMessage" },
    { "id": "check-query-api", "name": "检查查询 API 返回", "type": "http.assertResponse" }
  ]
}
```

## 6. 第一批内置用例

### 6.1 MinIO 雷达帧上传全链路

目标：验证雷达帧文件从 MinIO 上传，到 Kafka 通知、data-service 消费、数据库入库、内部 topic、biz-service、WebSocket、查询 API 的完整链路。

涉及配置：

- MinIO endpoint、accessKey、secretKey、bucket。
- Kafka bootstrapServers。
- 外部 topic：radar-frame-upstream。
- 内部 topic：leidian.realtime.standard。
- 数据库连接。
- data-service 地址。
- biz-service WebSocket 地址。

步骤：

1. 生成 traceId。
2. 检查 MinIO 可连接，bucket 存在。
3. 检查 Kafka 可连接，topic 存在或可自动创建。
4. 检查数据库可连接。
5. 检查 data-service /ingest/status 可访问。
6. 上传测试雷达帧 JSON 到 leidian-frame/upstream/radar/realtime/。
7. 检查 radar-frame-upstream 是否出现对应 traceId 或 objectKey 的消息。
8. 检查 file_metadata、file_radar_echo、file_frame_index 是否出现相关数据。
9. 检查 leidian.realtime.standard 是否出现 RADAR_FRAME 标准消息。
10. 检查 WebSocket 是否收到对应推送。
11. 调用 /api/biz/radar/frames/recent?minutes=60 确认可查询。
12. 汇总报告。

### 6.2 设备 HEX 报文解析入库查询链路

目标：验证设备 HEX 报文进入 device-raw-data 后，data-service 能完成 raw 入库、标准消息生成、monitor 表写入、查询 API 可见、biz-service 接口可查。

涉及配置：

- Kafka bootstrapServers。
- 外部 topic：device-raw-data。
- 内部 topic：leidian.realtime.standard。
- 数据库连接。
- data-service 地址。
- biz-service 地址。
- 设备类型和样例 HEX。

步骤：

1. 生成 traceId。
2. 选择设备类型，例如 GROUNDING_RESISTANCE、ATMOSPHERE_ELECTRIC_FIELD、SURGE_CURRENT 等。
3. 选择样例 HEX。
4. 检查 Kafka、数据库、data-service、biz-service 可访问。
5. 发送 HEX 报文到 device-raw-data。
6. 检查 data_raw_message 是否入库。
7. 检查 data_standard_message 是否生成。
8. 检查对应 monitor_* 表是否写入。
9. 检查 /ingest/device/status。
10. 检查 /ingest/standard/device/recent?monitorType=xxx。
11. 检查 /ingest/monitor/device/recent?monitorType=xxx。
12. 检查 biz-service /api/biz/monitor/** 对应接口。
13. 汇总报告。

## 7. 能力模块规划

能力模块是后续扩展的关键。

每个能力模块包含：配置表单 schema、连接检查器、执行动作、断言动作、证据采集器。

第一批能力：

| 能力 | 用途 |
|---|---|
| kafka | 发送消息、消费消息、检查 topic |
| database | 执行查询、断言数据存在 |
| minio | 上传对象、检查 bucket、检查 object |
| http | 调用接口、断言响应 |
| websocket | 建立连接、监听推送、断言消息 |
| deviceIngest | 设备报文样例、设备类型、topic 绑定 |
| localService | 检查当前环境基础服务连通性 |
| tunnel | 临时隧道地址、连通性检查 |
| remoteConnect | 远程环境连接信息、跳板配置 |

## 8. MVP 范围

第一版建议只做这些：

- 环境管理页面。
- 当前环境切换。
- 能力模块配置：Kafka、Database、MinIO、HTTP、WebSocket、Device Ingest。
- 用例库页面。
- 内置两个用例：MinIO 雷达帧上传全链路、设备 HEX 解析入库查询链路。
- 执行中心。
- 步骤级执行状态。
- 报告详情。
- 配置本地持久化。

第一版暂不做：多人权限、云端共享、定时任务、CI/CD 集成、复杂测试编排 DSL、大规模压测。

## 9. 推荐目录结构

```text
D:\mytools\leidian-test-workbench
├─ docs
│  └─ test-workbench-plan.md
├─ app
│  ├─ web
│  └─ server
├─ data
│  ├─ environments.json
│  ├─ test-cases.json
│  └─ runs
└─ README.md
```

## 10. 后续实现顺序

1. 先做静态页面原型：执行中心、环境配置、用例库、报告页。
2. 做本地配置存储：环境、能力、用例。
3. 做环境切换和配置校验。
4. 接入 MinIO 上传能力。
5. 接入 Kafka 消息发送/消费能力。
6. 接入 DB 查询断言能力。
7. 接入 HTTP/WebSocket 校验能力。
8. 完成 MinIO 全链路用例。
9. 完成设备 HEX 链路用例。
10. 接入个人开发工作台入口。
