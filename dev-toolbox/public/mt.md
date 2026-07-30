# 全部 mermaid 测试

## 块1 [00-项目导览-新人上手路径.md]

```mermaid
flowchart LR
    A["01-架构与数据流<br/>先看数据流总览那张时序图"]
    A --> B["10 · 一 · Topic 速查表<br/>7 个 topic + KafkaIngestConsumer"]
    B --> C["10 · 二 · 可靠性与 ack<br/>失败默认吞掉的反直觉"]
    C --> D1["10 · 三 · task 事件链路<br/>leidian.task.event 生产端缺口"]
    C --> D2["10 · 四 · 外部 Topic<br/>接入现状与目标态"]
    C --> D3["10 · 五 · device-raw-data<br/>设备 HEX 解析入库链路"]
    D1 --> E[回到 01 验证理解]
    D2 --> E
    D3 --> E
```

## 块2 [01-架构与数据流.md]

```mermaid
flowchart LR
    EXT([外部客户端 / 前端]):::ext
    UPS([上游设备 Kafka]):::ext
    EXT -->|HTTP/WS| GW
    GW -->|路由| SYS & DATA & BIZ & TASK
    UPS -->|Kafka 直连<br/>仅 data 可订阅| DATA
    DATA -->|Kafka 内部 topic| BIZ
    BIZ -->|WebSocket| EXT
    TASK -.->|Feign| DATA & BIZ
    BIZ -.->|Feign| DATA

    subgraph G[Gateway 层 唯一外部入口]
      GW[gateway-service<br/>:8080<br/>WebFlux]
    end
    subgraph S[业务层]
      SYS[system-service<br/>:8081<br/>登录/RBAC]
      DATA[data-service<br/>:8082<br/>接入/生产]
      BIZ[biz-service<br/>:8083<br/>消费/推送]
      TASK[task-service<br/>:8084<br/>异步任务]
    end

    classDef ext fill:#fffbe6,stroke:#e69500
```

## 块3 [01-架构与数据流.md]

```mermaid
flowchart TD
    api[common-api<br/>Feign 契约]
    cache[common-cache<br/>Redis Helper]
    mq[common-mq<br/>Kafka Producer/Consumer]
    db[common-db<br/>MyBatis-Plus + Flyway]
    log[common-log<br/>TraceId / 请求日志]
    sec[common-security<br/>JWT + 国密 SM2/SM3/SM4]
    web[common-web<br/>统一响应 / 异常 / OpenAPI]
    core[common-core<br/>错误码 / 分页 / 异常基类]

    web --> core
    sec --> core
    db --> core
    mq --> core
    cache --> core
    log --> core
    api --> core
```

## 块4 [01-架构与数据流.md]

```mermaid
flowchart LR
    A[外部请求] -->|生成或透传| F1[Gateway TraceIdFilter]
    F1 -->|HTTP Header X-Trace-Id<br/>+ MDC| F2[业务服务 RequestLogFilter]
    F2 -->|Feign Interceptor| FE[跨服务 RPC]
    F2 -->|Producer 注入 Kafka Header| KH[Kafka Header X-Trace-Id]
    KH -->|Consumer 读 Header -> MDC| KC[Kafka Consumer]
    KC -->|消息体 traceId 透传| WS[WebSocket 推送]
```

## 块5 [01-架构与数据流.md]

```mermaid
sequenceDiagram
    autonumber
    participant FE as 前端
    participant GW as Gateway<br/>(WebFlux)
    participant DS as data-service<br/>(MVC + MDC)
    participant K as Kafka
    participant BS as biz-service<br/>(MVC + MDC)

    FE->>GW: HTTP（无 X-Trace-Id）
    Note over GW: 生成 traceId<br/>写 Reactor Context<br/>（不是 MDC，见下方坑 3）
    GW->>DS: HTTP，X-Trace-Id: abc
    activate DS
    Note over DS: TraceIdFilter<br/>MDC.put("traceId", "abc")
    Note over DS: 业务代码所有 log.*<br/>自动带 [abc]
    DS->>K: Produce<br/>Kafka Header X-Trace-Id: abc
    Note over DS: MDC.clear()<br/>(防线程池串味)
    deactivate DS
    K->>BS: Consume
    activate BS
    Note over BS: 读 Header -> MDC.put
    Note over BS: 业务代码所有 log.*<br/>自动带 [abc]
    BS->>FE: WebSocket 推送
    Note over BS: MDC.clear()
    deactivate BS
```

## 块6 [01-架构与数据流.md]

```mermaid
flowchart LR
    UPS([外部上游<br/>Kafka + HTTP]):::ext
    DATA[data-service<br/>:8082]:::svc
    K[("Kafka<br/>leidian.realtime.standard")]:::mq
    BIZ[biz-service<br/>:8083]:::svc
    SYS[system-service<br/>:8081]:::svc
    TASK[task-service<br/>:8084]:::svc
    GW[gateway<br/>:8080]:::gw
    CLI([WebSocket 客户端<br/>3D 前端]):::ext

    UPS ==>|① 外部 Kafka 入库| DATA
    DATA ==>|② 雷达帧入库后发 realtime| K
    K ==>|③ 消费| BIZ
    BIZ ==>|④ 推送 WS| CLI

    CLI -.HTTP.-> GW
    GW -.路由.-> SYS & DATA & BIZ & TASK

    BIZ -.Feign.-> DATA
    TASK -.Feign.-> DATA & BIZ

    classDef ext fill:#fff5e6,stroke:#e69500,color:#333
    classDef gw fill:#e6f4ea,stroke:#3a8c4f,color:#333
    classDef svc fill:#e6f0fb,stroke:#3878c6,color:#333
    classDef mq fill:#fff4e6,stroke:#c97200,color:#333
```

## 块7 [01-架构与数据流.md]

```mermaid
flowchart LR
  subgraph EXT["外部上游"]
    EXT_K["Kafka 外部 Topic<br/>cmb / locator / device-raw-data / radar-frame-upstream"]
  end

  subgraph DATA["data-service (8082)"]
    direction TB
    D_KCONS["KafkaIngestConsumer<br/>4 × @KafkaListener"]
    D_PROC["IngestProcessService"]
    D_RADAR["RadarFrameIngestService<br/>(radar-frame-upstream)"]
    D_PIPE["*StandardService<br/>Cmb / Locator / DeviceRaw"]
    D_STORE[("PostgreSQL<br/>data_raw_message / data_standard_message<br/>monitor_* / file_*")]
    D_PROD["RadarFrameInternalKafkaPublisher.publish"]
    D_RPCC["DataServiceRpcController<br/>/rpc/data/**"]
  end

  K_INT["Kafka<br/>leidian.realtime.standard"]

  subgraph BIZ["biz-service (8083)"]
    direction TB
    B_KCONS["RealtimeStandardConsumer"]
    B_HND["RealtimeMessageHandler"]
    B_PUSH["RadarFramePushService / RealtimePushService"]
    B_WS["WebSocket /realtime/ws"]
    B_RPCC["BizServiceRpcController"]
  end

  WS_CLI["WebSocket 客户端"]

  EXT_K --> D_KCONS
  D_KCONS -->|cmb/locator/device-raw| D_PROC --> D_PIPE --> D_STORE
  D_KCONS -->|radar-frame-upstream| D_RADAR --> D_STORE
  D_RADAR --> D_PROD --> K_INT --> B_KCONS --> B_HND --> B_PUSH --> B_WS --> WS_CLI
  D_STORE -.->|cmb/locator/device-raw 未发| D_PROD
```

## 块8 [01-架构与数据流.md]

```mermaid
sequenceDiagram
  autonumber
  participant K as 上游 Kafka
  participant KC as data: KafkaIngestConsumer
  participant PS as data: IngestProcessService
  participant RAW as data: RawIngestMessageService
  participant SS as data: LightningStrikeCmbStandardService<br/>(或 Locator / DeviceRaw)
  participant DB as PostgreSQL<br/>data_raw_message + data_standard_message + monitor_*

  K->>KC: poll record (String value)
  KC->>PS: process(ctx)
  PS->>RAW: saveRaw(ctx)
  RAW->>DB: INSERT data_raw_message
  RAW-->>PS: rawMessageId
  PS->>SS: processAndSave(ctx)
  SS->>DB: INSERT data_standard_message + monitor_*
  SS-->>PS: PARSED_SUCCESS / FAILED
  PS->>RAW: updateStatus(ctx)
  KC->>K: ack.acknowledge() (finally)
```

## 块9 [01-架构与数据流.md]

```mermaid
sequenceDiagram
  autonumber
  participant MINIO as MinIO<br/>(notify_kafka)
  participant KU as Kafka<br/>radar-frame-upstream
  participant KC as data: KafkaIngestConsumer
  participant RF as data: RadarFrameIngestService
  participant DB as PostgreSQL<br/>file_metadata / file_radar_echo / file_frame_index
  participant PUB as data: RadarFrameInternalKafkaPublisher
  participant KI as Kafka<br/>leidian.realtime.standard
  participant RC as biz: RealtimeStandardConsumer
  participant RH as biz: RealtimeMessageHandler
  participant RP as biz: RadarFramePushService
  participant RD as biz: DataServiceClient<br/>(presign RPC)
  participant WM as biz: WebSocketSessionManager
  participant WS as WebSocket 客户端

  MINIO->>KU: 雷达帧上传完成事件
  KU->>KC: poll record
  KC->>RF: consume(record, ack)
  RF->>DB: upsert file_metadata / file_radar_echo / file_frame_index
  RF->>PUB: publish(traceId, parsed, bucket, objectKey)
  PUB->>KI: send(StandardKafkaMessage, bizType=RADAR_FRAME)
  KI->>RC: poll
  RC->>RH: handle(stdMsg, traceId, dedupKey)
  RH->>RP: handle（bizType=RADAR_FRAME 分流）
  RP->>RD: presignRadarFrame(bucket, objectKey)（缺 downloadUrl 时）
  RP->>RP: 缓存 RadarFrameCacheEntry 至 Redis
  RP->>WM: broadcast(RadarFrameWsMessage JSON)
  WM->>WS: TextMessage
  RC->>KI: ack.acknowledge() (finally)
```

## 块10 [01-架构与数据流.md]

```mermaid
sequenceDiagram
  autonumber
  participant C as 调用方/Swagger
  participant BF as biz: FeignTestController<br/>GET /feign/test/data-latest
  participant FC as common-api: DataServiceClient<br/>@FeignClient(name=data-service)
  participant N as Nacos<br/>服务发现
  participant DC as data: DataServiceRpcController<br/>/rpc/data/**
  participant DF as data: DataServiceRpcFacade
  participant DB as PostgreSQL<br/>data_raw_message / data_standard_message

  C->>BF: GET /api/biz/feign/test/data-latest?limit=5
  BF->>FC: latestRawMessages(5)<br/>latestStandardMessages(5)
  FC->>N: 解析 data-service 实例
  N-->>FC: lb://data-service:8082
  FC->>DC: GET /rpc/data/raw/latest?limit=5<br/>GET /rpc/data/standard/latest?limit=5<br/>Header: X-Trace-Id (FeignTraceConfig)
  DC->>DF: latestRawMessages(5)<br/>latestStandardMessages(5)
  DF->>DB: SELECT ... ORDER BY create_time DESC LIMIT 5
  DB-->>DF: List<Entity>
  DF-->>DC: List<RawMessageRpcDTO><br/>List<StandardMessageRpcDTO><br/>(payload 截断脱敏)
  DC-->>FC: JSON 列表
  FC-->>BF: List<...RpcDTO>
  BF-->>C: { traceId, rawMessages, standardMessages, rawCount, standardCount }
```

## 块11 [10-Kafka全链路.md]

```mermaid
flowchart TB
  subgraph PROD["生产侧：发送失败"]
    P1["业务方调用<br/>KafkaMessageProducer.send"]
    P2["kafkaTemplate.send 异步"]
    P3{"sendFuture.whenComplete<br/>ex == null ?"}
    P4["log.info 发送成功<br/>return KafkaSendResult.success=true"]
    P5["log.error 发送失败<br/>return KafkaSendResult.success=false"]
    P6["调用方（如测试 Controller）:<br/>捕获异常 -> 仅日志<br/>不回滚"]
    P1 --> P2 --> P3
    P3 -- success --> P4
    P3 -- fail --> P5 --> P6
  end

  subgraph CONS["消费侧：3 个 consumer 行为完全一致"]
    C1["@KafkaListener 拉取记录<br/>(AckMode.MANUAL)"]
    C2{"try { handle(record) }"}
    C3["业务成功<br/>ack.acknowledge()"]
    C4["catch (Exception e)<br/>log.error"]
    C5["ack.acknowledge() ← 仍然 ack"]
    C6"效果:<br/>• 消息不会重投<br/>• 不进 DLT<br/>• 不调用 RetryService"
    C1 --> C2
    C2 -- ok --> C3
    C2 -- 抛错 --> C4 --> C5 --> C6
  end

  subgraph RETRY["重试服务（占位）"]
    R1["RetryService.retry()"]
    R2["仅记 RETRY_PLACEHOLDER<br/>返回 'not implemented in P0'"]
    R1 --> R2
    R3"注意:<br/>• 没有任何调用方真正调用 retry()<br/>• 没有延迟队列<br/>• 没有 Kafka 重投"
  end

  subgraph FEIGN["Feign 调用容错（占位）"]
    F1["FeignClient 调用 (data/biz)"]
    F2{"feign.circuitbreaker.enabled?"}
    F3["true -> fallbackFactory 生效"]
    F4["false (当前默认) -><br/>直接抛 RetryableException / FeignException"]
    F1 --> F2
    F2 -- false --> F4
    F2 -- true --> F3
  end
```

## 块12 [10-Kafka全链路.md]

```mermaid
flowchart LR
  subgraph EXT_TRIG["事件来源（仓库内未实现生产端）"]
    X1["leidian.task.event<br/>生产方:（kafka-topic-spec.md<br/>标注后续阶段补充）"]
    X2["AKHQ 直连<br/>leidian.task.event"]
  end

  KT["Kafka Topic<br/>leidian.task.event"]

  subgraph TASK["task-service (8084)"]
    direction TB
    TC["TaskEventConsumer<br/>@KafkaListener<br/>group=leidian-task-event-consumer-local<br/>containerFactory=kafkaListenerContainerFactory"]
    TLOG["TaskLogService<br/>ConcurrentLinkedDeque<br/>上限 200 条 内存"]
    TLC["TaskLogController<br/>GET /logs"]

    SCH["ScheduleTestJob<br/>@Scheduled fixedDelay 60s"]
    MAN["ManualTaskController<br/>POST /manual/run"]
    REP["ReplayTaskController<br/>POST /replay/start"]
    REPS["ReplayTaskService"]
    COMP["CompensationTaskController<br/>POST /compensation/test"]
    RPT["ReportTaskController<br/>POST /report/test"]

    TC -- ack.acknowledge() --> KT
    TC --> TLOG
    SCH --> TLOG
    MAN --> TLOG
    REP --> REPS --> TLOG
    COMP --> TLOG
    RPT --> TLOG
    TLOG --> TLC
  end

  X1 -. 暂无 .-> KT
  X2 -- 本地手工灌入 --> KT
  KT --> TC

  REPS -- "OpenFeign<br/>DataServiceClient<br/>/rpc/data/replay/source" --> DS["data-service<br/>DataServiceRpcController<br/>LambdaQueryWrapper<br/>-> standard_message"]
  DS --> REPS
```

## 块13 [10-Kafka全链路.md]

```mermaid
flowchart TB
  EXT["上游 Kafka<br/>cmb / locator / device-raw-data / radar-frame-upstream"]
  CONS["KafkaIngestConsumer<br/>4 × @KafkaListener"]
  PROC["IngestProcessService.process"]
  RAW["RawIngestMessageService<br/>-> data_raw_message"]
  DISPATCH{"按 Topic 分支"}
  CMB["LightningStrikeCmbStandardService"]
  LOC["LightningStrikeLocatorStandardService"]
  DEV["DeviceRawStandardService<br/>拼帧 -> Parser -> Handler"]
  STORE[("data_standard_message + monitor_* / 设备 biz 表<br/>cmb/locator 雷击 / V5+V6 设备")]
  STATUS["RawIngestMessageService.updateStatus<br/>(finally 块内联)"]
  GAP["❌ cmb/locator/device-raw<br/>未发 internal Kafka"]
  RADAR["RadarFrameIngestService<br/>stat + 预签名 -> file 表"]
  PUB["✅ RadarFrameInternalKafkaPublisher<br/>-> leidian.realtime.standard"]
  BIZ["biz RealtimeMessageHandler<br/>RADAR_FRAME -> RadarFramePushService<br/>Redis + WebSocket 广播"]

  EXT --> CONS
  CONS -- "cmb/locator/device-raw" --> PROC --> RAW --> DISPATCH
  DISPATCH --> CMB --> STORE
  DISPATCH --> LOC --> STORE
  DISPATCH --> DEV --> STORE
  PROC --> STATUS
  STORE -.-> GAP
  CONS -- "radar-frame-upstream" --> RADAR --> PUB --> BIZ
```

## 块14 [10-Kafka全链路.md]

```mermaid
flowchart LR
  IN["外部 Topic 入库成功"]
  PROD["KafkaMessageProducer.send<br/>leidian.realtime.standard"]
  BIZ["biz RealtimeStandardConsumer"]
  WS["WebSocket"]
  IN --> PROD --> BIZ --> WS
```

## 块15 [10-Kafka全链路.md]

```mermaid
flowchart TB
  K["Kafka device-raw-data"]
  C["KafkaIngestConsumer"]
  P["IngestProcessService"]
  R["RawIngestMessageService -> data_raw_message"]
  T["TCP/Netty ingest/tcp"]
  TI["TcpInboundHandler + TcpSessionManager"]
  S["DeviceRawStandardService"]
  DEC["DeviceRawFragmentDecoder"]
  BUF["DeviceStreamBuffer 内存拼帧"]
  SPL["DeviceFrameSplitter"]
  DIS["DeviceProtocolDispatcher + DeviceXxxParser"]
  VAL["DeviceFrameValidator"]
  HND["DeviceStandardDispatchService -> *StandardHandler -> data_standard_message + monitor_*"]
  K --> C --> P --> R --> S
  T --> TI --> S
  S --> DEC --> BUF --> SPL --> DIS --> VAL --> HND
```

## 块16 [20-运维与部署.md]

```mermaid
sequenceDiagram
    autonumber
    participant Dev as "开发者"
    participant Docker as "Docker Desktop / Compose"
    participant K3d as "k3d 集群"
    participant Helm as "Helm"
    participant K8s as "Kubernetes API"
    participant Pod as "5个服务Pod"
    participant Nacos as "Nacos(local-k3s)"
    participant Infra as "PostgreSQL / Redis / Kafka"
    participant Ingress as "Ingress + gateway-service"

    Dev->>Docker: 启动基础设施
    Note over Dev,Docker: docker compose up -d<br/>启动 Nacos / PostgreSQL / Redis / Kafka

    Dev->>K3d: 启动 k3d 集群
    Note over Dev,K3d: k3d cluster start leidian

    Dev->>Docker: 构建 5 个服务镜像
    Note over Dev,Docker: docker build gateway/system/data/biz/task :dev

    Dev->>K3d: 导入镜像到集群
    Note over Dev,K3d: k3d image import ... -c leidian

    Dev->>Helm: 执行 Helm 部署
    Note over Dev,Helm: helm upgrade --install leidian-backend ... -f values-dev.yaml

    Helm->>K8s: 提交 Namespace / ConfigMap / Secret
    Helm->>K8s: 提交 5 个 Deployment
    Helm->>K8s: 提交 5 个 Service
    Helm->>K8s: 提交 Ingress

    K8s->>Pod: 创建 5 个 Pod
    Pod->>Pod: 读取环境变量<br/>NACOS_SERVER_ADDR / NACOS_NAMESPACE / Secret
    Pod->>Nacos: 连接 host.docker.internal:8848
    Nacos-->>Pod: 返回 shared-*.yml 和 *-service.yml 配置

    Pod->>Infra: 连接 PostgreSQL / Redis / Kafka
    Infra-->>Pod: 连接成功

    Pod->>K8s: 健康检查通过
    K8s-->>Ingress: 后端 Service 就绪

    Dev->>Ingress: 访问 localhost:18080
    Ingress->>Pod: 请求先到 gateway-service
    Pod->>Pod: gateway 再转发到 system/data/biz/task
```

## 块17 [20-运维与部署.md]

```mermaid
sequenceDiagram
    autonumber
    participant Dev as "开发者"
    participant Docker as "本机 Docker"
    participant K3d as "k3d 集群"
    participant K8s as "Kubernetes"
    participant PodOld as "旧 Pod"
    participant PodNew as "新 Pod"
    participant Nacos as "Nacos"
    participant Infra as "DB / Redis / Kafka"

    Dev->>Docker: 重新 build 某个服务镜像
    Note over Dev,Docker: docker build -t biz-service:dev ...

    Dev->>K3d: 导入新镜像
    Note over Dev,K3d: k3d image import biz-service:dev -c leidian

    Dev->>K8s: 重启对应 Deployment
    Note over Dev,K8s: kubectl rollout restart deployment biz-service -n leidian

    K8s->>PodOld: 终止旧 Pod
    K8s->>PodNew: 创建新 Pod
    PodNew->>Nacos: 重新拉取配置
    Nacos-->>PodNew: 返回配置
    PodNew->>Infra: 重新建立连接
    Infra-->>PodNew: 连接成功
    PodNew->>K8s: readiness probe 通过
    K8s-->>Dev: rollout successful
```

## 块18 [20-运维与部署.md]

```mermaid
flowchart LR
    A[0 cicd.env] --> B[1 ci-build-maven]
    B --> C[2 ci-build-images]
    C --> D{模式}
    D -->|本地 k3s| E[3 k3s ctr import]
    D -->|私有仓库| F[3 ci-push-images]
    E --> G[4 ci-deploy-helm-k3s]
    F --> G
    G --> H[5 ci-check-k3s-rollout]
    H --> I[6 port-forward]
    I --> J[7 ci-smoke-test]
```

## 块19 [20-运维与部署.md]

```mermaid
flowchart TD
    A[docs/06-devops 文档] --> B[scripts 操作脚本]
    B --> C[deployments/docker Dockerfile]
    B --> D[deployments/docker-compose Compose编排]
    B --> E[deployments/helm Helm Chart]
    A --> D
    A --> E
    E --> F[k3s / Kubernetes 集群]
    D --> G[本地 Docker Compose 环境]
    E -. 参考与排查 .-> H[deployments/k8s 原生YAML]
```

## 块20 [30-网关与配置.md]

```mermaid
sequenceDiagram
    autonumber
    participant FE as 前端
    participant GW as Gateway<br/>(Netty / WebFlux)
    participant TGF as TraceIdGlobalFilter<br/>order=-1000
    participant RGF as RequestLogGlobalFilter<br/>order=-900
    participant OSGF as OpenApiSignGlobalFilter<br/>order=-850
    participant AGF as AuthGlobalFilter<br/>order=-800
    participant DS as data-service<br/>(Tomcat / MVC)
    participant TF as TraceIdFilter<br/>order=1
    participant RLF as RequestLogFilter<br/>order=2
    participant CTRL as RealtimeStandardProducerTestController

    FE->>GW: POST /api/data/mq/test/realtime-standard<br/>Authorization: Bearer xxx<br/>(无 X-Trace-Id)

    rect rgb(224, 247, 255)
        Note over TGF,AGF: 网关 WebFlux 过滤器链
        GW->>TGF: filter()
        Note over TGF: 生成 traceId=abc<br/>mutate request header<br/>response.beforeCommit 回写
        TGF->>RGF: chain.filter()
        Note over RGF: 记 start
        RGF->>OSGF: chain.filter()
        Note over OSGF: 非 /api/open/** 路径<br/>直接 pass-through
        OSGF->>AGF: chain.filter()
        Note over AGF: 白名单不命中<br/>JWT 验签 OK<br/>黑名单不命中<br/>注入 X-User-Id
        AGF->>DS: HTTP 转发<br/>X-Trace-Id: abc<br/>X-User-Id: 100
    end

    rect rgb(255, 247, 224)
        Note over TF,CTRL: 业务服务 Servlet 过滤器链
        DS->>TF: doFilterInternal()
        Note over TF: 读 X-Trace-Id=abc<br/>MDC.put("traceId","abc")
        TF->>RLF: chain.doFilter()
        Note over RLF: 记 start
        RLF->>CTRL: chain.doFilter()
        Note over CTRL: 业务代码 log.info(...)<br/>自动带 [abc]
        CTRL-->>RLF: 返回 ApiResponse
        Note over RLF: log [abc] POST /... cost=42ms
        RLF-->>TF: 出栈
        Note over TF: finally MDC.clear()
        TF-->>DS: 响应
    end

    DS-->>AGF: HTTP 响应
    AGF-->>RGF: 出栈
    Note over RGF: log [abc] POST /api/data/... 200 cost=58ms
    RGF-->>TGF: 出栈
    Note over TGF: beforeCommit 触发<br/>响应头写入 X-Trace-Id: abc<br/>doFinally MDC.clear()
    TGF-->>FE: 200 OK<br/>X-Trace-Id: abc
```

## 块21 [30-网关与配置.md]

```mermaid
sequenceDiagram
  autonumber
  participant U as 客户端
  participant GW as Gateway:8080<br/>(WebFlux)
  participant TR as TraceIdGlobalFilter<br/>order=-1000
  participant LG as RequestLogGlobalFilter<br/>order=-900
  participant AU as AuthGlobalFilter<br/>order=-800
  participant SP as StripPrefix=2
  participant SS as system-service:8081<br/>AuthController
  participant AS as AuthService
  participant DB as PostgreSQL<br/>sys_user
  participant RD as Redis

  Note over U,GW: 登录（白名单路径）
  U->>GW: POST /api/system/auth/login<br/>{username, password}
  GW->>TR: X-Trace-Id 透传/生成
  TR->>LG: pass
  LG->>AU: pass
  AU->>AU: WHITE_LIST 命中 /api/system/auth/login<br/>不查 token
  AU->>SP: pass
  SP->>SS: /auth/login
  SS->>AS: login(req)
  AS->>DB: selectOne(username)
  DB-->>AS: SysUser(passwordHash, passwordSalt, status)
  AS->>AS: GmPasswordEncoder.matches<br/>SM3(明文+salt+pepper)
  AS->>AS: JwtUtil.generateToken(userId, username, ["ADMIN"])<br/>HS256, jti=UUID, exp=now+2h
  AS->>RD: SET login:token:{userId} userId EX 7200
  AS-->>SS: token, "Bearer", 7200
  SS-->>U: 200 ApiResponse{ accessToken }

  Note over U,GW: 已鉴权请求
  U->>GW: GET /api/system/auth/userinfo<br/>Authorization: Bearer {token}
  GW->>TR: pass
  TR->>LG: pass
  LG->>AU: 提取 Bearer
  AU->>AU: JwtUtil.parseToken<br/>verifyWith(secretKey) + 解析 claims
  AU->>RD: EXISTS blacklist:token:{jti}
  RD-->>AU: 0 (不在黑名单)
  AU->>SP: pass
  SP->>SS: /auth/userinfo
  SS-->>U: 200 ApiResponse{ userId, username, roles }

  Note over U,GW: 登出 + 黑名单
  U->>GW: POST /api/system/auth/logout
  GW->>SS: /auth/logout
  SS->>AS: logout(authHeader)
  AS->>AS: parseToken -> userId, jti, exp
  AS->>RD: DEL login:token:{userId}
  AS->>RD: SET blacklist:token:{jti} "1" EX (exp-now)
  SS-->>U: 200

  Note over U,GW: 用旧 token 再访问
  U->>GW: GET /api/system/auth/userinfo<br/>Authorization: Bearer {旧token}
  GW->>AU: 验签通过<br/>但 EXISTS blacklist:token:{jti} = 1
  AU-->>U: 401 "token 已失效，请重新登录"
```

## 块22 [50-Common模块速查-8个公共库.md]

```mermaid
flowchart BT
  CORE[common-core]
  LOG[common-log]
  WEB[common-web]
  SEC[common-security]
  DB[common-db]
  MQ[common-mq]
  CACHE[common-cache]
  API[common-api]

  LOG --> CORE
  WEB --> CORE
  WEB --> LOG
  SEC --> CORE
  CACHE --> CORE
  DB --> CORE
  MQ --> CORE
  API --> CORE

  subgraph SVC["业务服务"]
    GW[gateway-service]
    SYS[system-service]
    DAT[data-service]
    BIZ[biz-service]
    TSK[task-service]
    DBMIG[db-migration]
  end

  GW --> SEC
  GW --> CACHE
  GW --> CORE
  SYS --> WEB
  SYS --> SEC
  SYS --> DB
  SYS --> CACHE
  DAT --> WEB
  DAT --> DB
  DAT --> MQ
  DAT --> CACHE
  DAT --> API
  BIZ --> WEB
  BIZ --> MQ
  BIZ --> CACHE
  BIZ --> API
  TSK --> WEB
  TSK --> MQ
  TSK --> API
  DBMIG --> CORE
```

