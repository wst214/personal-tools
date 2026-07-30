(function () {
  const envs = {
    local: {
      name: "本地环境",
      desc: "localhost 服务栈",
      base: { gatewayUrl: "http://localhost:8080", gatewayHealthPath: "/actuator/health", dataServiceUrl: "http://localhost:8082", dataServiceHealthPath: "/actuator/health", bizServiceUrl: "http://localhost:8083", bizServiceHealthPath: "/actuator/health", taskServiceUrl: "http://localhost:8084", taskServiceHealthPath: "/actuator/health" },
      capabilities: {
        kafka: { enabled: true, bootstrapServers: "kafka:29092", upstreamTopic: "radar-frame-upstream", standardTopic: "leidian.realtime.standard" },
        database: { enabled: true, jdbcUrl: "jdbc:mysql://localhost:3306/leidian", username: "root", passwordRef: "local.mysql.password" },
        minio: { enabled: true, endpoint: "http://localhost:9000", accessKey: "leidian_upstream", secretKeyRef: "local.minio.secretKey", bucket: "leidian-frame" },
        websocket: { enabled: true, url: "ws://localhost:8083/realtime/ws" },
        deviceIngest: { enabled: true, rawTopic: "device-raw-data", standardTopic: "leidian.realtime.standard", defaultMonitorType: "GROUNDING_RESISTANCE" },
        tunnel: { enabled: false, publicUrl: "", provider: "cloudflare" },
      },
    },
    dev: {
      name: "开发环境",
      desc: "联调环境配置",
      base: { gatewayUrl: "http://dev-gateway:8080", gatewayHealthPath: "/actuator/health", dataServiceUrl: "http://dev-data:8082", dataServiceHealthPath: "/actuator/health", bizServiceUrl: "http://dev-biz:8083", bizServiceHealthPath: "/actuator/health", taskServiceUrl: "http://dev-task:8084", taskServiceHealthPath: "/actuator/health" },
      capabilities: {
        kafka: { enabled: true, bootstrapServers: "dev-kafka:9092", upstreamTopic: "radar-frame-upstream", standardTopic: "leidian.realtime.standard" },
        database: { enabled: true, jdbcUrl: "jdbc:mysql://dev-mysql:3306/leidian", username: "leidian", passwordRef: "dev.mysql.password" },
        minio: { enabled: true, endpoint: "http://dev-minio:9000", accessKey: "leidian_upstream", secretKeyRef: "dev.minio.secretKey", bucket: "leidian-frame" },
        websocket: { enabled: true, url: "ws://dev-biz:8083/realtime/ws" },
        deviceIngest: { enabled: true, rawTopic: "device-raw-data", standardTopic: "leidian.realtime.standard", defaultMonitorType: "GROUNDING_RESISTANCE" },
        tunnel: { enabled: true, publicUrl: "https://dev-tunnel.example.com", provider: "cloudflare" },
      },
    },
    test: {
      name: "测试环境",
      desc: "验收环境配置",
      base: { gatewayUrl: "http://test-gateway:8080", gatewayHealthPath: "/actuator/health", dataServiceUrl: "http://test-data:8082", dataServiceHealthPath: "/actuator/health", bizServiceUrl: "http://test-biz:8083", bizServiceHealthPath: "/actuator/health", taskServiceUrl: "http://test-task:8084", taskServiceHealthPath: "/actuator/health" },
      capabilities: {
        kafka: { enabled: true, bootstrapServers: "test-kafka:9092", upstreamTopic: "radar-frame-upstream", standardTopic: "leidian.realtime.standard" },
        database: { enabled: true, jdbcUrl: "jdbc:mysql://test-mysql:3306/leidian", username: "tester", passwordRef: "test.mysql.password" },
        minio: { enabled: false, endpoint: "", accessKey: "", secretKeyRef: "", bucket: "leidian-frame" },
        websocket: { enabled: true, url: "ws://test-biz:8083/realtime/ws" },
        deviceIngest: { enabled: true, rawTopic: "device-raw-data", standardTopic: "leidian.realtime.standard", defaultMonitorType: "GROUNDING_RESISTANCE" },
        tunnel: { enabled: false, publicUrl: "", provider: "" },
      },
    },
  };

  const ENV_STORAGE_KEY = "leidian-test-workbench.environments.v1";
  const ACTIVE_ENV_STORAGE_KEY = "leidian-test-workbench.activeEnv.v1";
  const defaultEnvs = JSON.parse(JSON.stringify(envs));

  function mergeEnvShape(value, fallback) {
    const merged = { ...fallback, ...(value || {}) };
    merged.base = { ...(fallback?.base || {}), ...((value && value.base) || {}) };
    merged.capabilities = { ...(fallback?.capabilities || {}), ...((value && value.capabilities) || {}) };
    Object.keys(merged.capabilities).forEach((key) => {
      merged.capabilities[key] = { ...(fallback?.capabilities?.[key] || {}), ...merged.capabilities[key] };
    });
    return merged;
  }

  function readStoredJson(key) {
    try {
      const value = window.localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (_error) {
      return null;
    }
  }

  function loadStoredEnvs() {
    const stored = readStoredJson(ENV_STORAGE_KEY);
    if (!stored || typeof stored !== "object") return;
    Object.entries(stored).forEach(([key, value]) => {
      if (value && typeof value === "object") {
        envs[key] = mergeEnvShape(value, defaultEnvs[key] || value);
        if (defaultEnvs[key]?.name) envs[key].name = defaultEnvs[key].name;
      }
    });
  }

  function persistEnvs() {
    window.localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(envs));
    if (HAS_SERVER_API) {
      return fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environments: envs, activeEnv }),
      }).catch(() => {
        showToast("已保存到浏览器，本地服务暂不可用");
      });
    }
    return Promise.resolve();
  }

  function persistActiveEnv() {
    window.localStorage.setItem(ACTIVE_ENV_STORAGE_KEY, activeEnv);
  }

  loadStoredEnvs();

  async function loadServerState() {
    if (!HAS_SERVER_API) return false;
    try {
      const response = await fetch("/api/environments", { cache: "no-store" });
      if (!response.ok) return false;
      const payload = await response.json();
      if (payload.environments) {
        Object.entries(payload.environments).forEach(([key, value]) => {
          envs[key] = mergeEnvShape(value, defaultEnvs[key] || value);
          if (defaultEnvs[key]?.name) envs[key].name = defaultEnvs[key].name;
        });
      }
      if (payload.activeEnv && envs[payload.activeEnv]) {
        activeEnv = payload.activeEnv;
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  const scenes = [
    { id: "minio-upload", name: "MinIO 上传", summary: "雷达帧文件上传、事件通知、入库、推送与查询。" },
    { id: "device-parse", name: "设备解析", summary: "设备原始报文接入、协议解析、标准化、入库与查询。" },
  ];
  const cases = [
    {
      id: "minio-radar-frame-full-link",
      sceneId: "minio-upload",
      name: "正常情况 · 雷达帧全链路成功",
      caseType: "正常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "上传合法雷达帧 JSON 后，MinIO 通知、Kafka、DB、WebSocket 和查询 API 均可观察。",
      objective: "验证正确输入下的主业务链路是否闭环。",
      expected: "文件可上传，事件可消费，索引入库，实时推送和查询接口均有对应记录。",
      capabilities: ["minio", "kafka", "database", "http", "websocket"],
      last: "未执行",
      steps: [
        ["环境预检查", "检查 MinIO / Kafka / DB / HTTP / WebSocket 配置"],
        ["上传雷达帧文件", "写入 leidian-frame/upstream/radar/realtime/"],
        ["检查上游 Topic", "等待 radar-frame-upstream 出现对象事件"],
        ["检查文件入库", "查询 file_frame_index"],
        ["检查 WebSocket", "监听 realtime/ws 推送"],
        ["检查查询接口", "调用 /radar/frames/recent?minutes=60 验证可查询"],
      ],
    },
    {
      id: "minio-radar-invalid-json",
      sceneId: "minio-upload",
      name: "异常情况 · 文件内容不是合法 JSON",
      caseType: "异常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "上传扩展名或路径正确但内容不可解析的文件。",
      objective: "验证解析失败不会进入正常业务链路。",
      expected: "系统应给出可定位的错误证据，不写入正常雷达帧索引，不产生误导性实时推送。",
      capabilities: ["minio", "kafka", "database", "http"],
      last: "未执行",
      steps: [["环境预检查", "检查 MinIO / Kafka / DB / HTTP 配置"], ["准备异常文件", "构造不可解析 JSON"], ["上传到 MinIO", "写入同一业务目录"], ["等待下游处理", "给异步消费留出处理窗口"], ["检查正常索引", "确认 file_frame_index 未写入异常文件"], ["检查查询接口", "确认查询结果不暴露异常数据"]],
    },
    {
      id: "minio-radar-missing-required-fields",
      sceneId: "minio-upload",
      name: "异常情况 · 雷达帧关键字段缺失",
      caseType: "异常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "上传结构合法但缺少 trace、时间、帧数据等关键字段的 JSON。",
      objective: "验证字段校验和错误定位是否清晰。",
      expected: "系统应拒绝或隔离该数据，并保留缺失字段的诊断信息。",
      capabilities: ["minio", "kafka", "database", "http"],
      last: "未执行",
      steps: [["环境预检查", "检查 MinIO / Kafka / DB / HTTP 配置"], ["准备缺字段样例", "保留 JSON 结构但移除关键业务字段"], ["上传文件", "保持路径和 bucket 正常"], ["等待下游处理", "给异步消费留出处理窗口"], ["检查正常索引", "确认 file_frame_index 未写入缺字段文件"], ["检查查询接口", "确认查询结果不暴露缺字段数据"]],
    },
    {
      id: "minio-radar-duplicate-object",
      sceneId: "minio-upload",
      name: "边界情况 · 重复 objectKey 幂等覆盖",
      caseType: "边界",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "同一个 objectKey 连续上传两次，验证后端按 frameId/fileCode upsert，而不是插入重复索引。",
      objective: "验证重复对象上传时的幂等覆盖策略，澄清 objectKey 与 traceId 的处理边界。",
      expected: "MinIO 对象被覆盖，下游重新消费；file_frame_index 中同一 objectKey 保持 1 条记录，trace_id 更新为第二次上传值。",
      capabilities: ["minio", "kafka", "database", "http"],
      last: "未执行",
      steps: [["环境预检查", "检查 MinIO / Kafka / DB / HTTP 配置"], ["上传首个对象", "生成可解析 objectKey 与 traceId-1"], ["检查首次入库", "确认 file_frame_index 产生 1 条索引"], ["重复上传同一 objectKey", "使用 traceId-2 覆盖同一路径对象"], ["检查幂等覆盖", "确认索引仍为 1 条且 trace_id 更新"], ["检查查询接口", "确认用户侧查询接口仍可正常返回"]],
    },
    {
      id: "minio-radar-large-payload",
      sceneId: "minio-upload",
      name: "边界情况 · 10MB 大文件上传",
      caseType: "边界",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "上传约 10MB 的雷达帧 JSON 文件，验证大 payload 下的上传、消费、入库和查询表现。",
      objective: "验证 10MB 数据量下链路是否仍能在可接受时间内闭环。",
      expected: "10MB 文件可上传，MinIO 事件可被消费，file_frame_index 能写入对应索引，查询接口可正常返回。",
      capabilities: ["minio", "kafka", "database", "http", "websocket"],
      last: "未执行",
      steps: [["环境预检查", "检查 MinIO / Kafka / DB / HTTP / WebSocket 配置"], ["生成 10MB 文件", "构造约 10 * 1024 * 1024 字节 JSON payload"], ["上传文件", "写入同一雷达帧对象目录并记录耗时"], ["检查异步消费", "确认 file_frame_index 写入对应索引"], ["检查 WebSocket", "监听实时推送是否可观察"], ["检查查询接口", "确认用户侧查询接口仍可正常返回"], ["汇总时延", "展示上传耗时、消费耗时和实际 payload 字节数"]],
    },
    {
      id: "device-hex-full-link",
      sceneId: "device-parse",
      name: "正常情况 · 合法 HEX 解析入库",
      caseType: "正常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "发送协议样例 HEX 到 device-raw-data，检查 raw、standard、monitor 与查询接口。",
      objective: "验证合法设备报文的主解析链路。",
      expected: "原始报文入库，标准消息生成，对应监测数据可查询。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [
        ["环境预检查", "检查 Kafka / DB / data-service / biz-service"],
        ["选择样例 HEX", "按设备类型加载测试报文"],
        ["发送设备报文", "写入 device-raw-data Topic"],
        ["检查 raw 入库", "查询 data_raw_message"],
        ["检查标准层", "查询 data_standard_message"],
        ["检查 monitor 表", "查询对应 monitor_* 表"],
        ["检查接口返回", "调用 data-service 与 biz-service 查询接口"],
      ],
    },
    {
      id: "device-hex-invalid-format",
      sceneId: "device-parse",
      name: "异常情况 · 非法 HEX 格式",
      caseType: "异常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "发送非 HEX 字符、奇数字节或缺少头尾标识的报文。",
      objective: "验证输入格式校验是否能拦截无效报文。",
      expected: "系统应记录解析失败原因，不写入正常标准层和 monitor 表。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [["构造非法报文", "覆盖非 HEX、长度不合法、头尾缺失"], ["发送到原始 Topic", "保留 traceId"], ["检查失败记录", "确认错误原因可定位"], ["检查正常表", "确认无污染数据"]],
    },
    {
      id: "device-hex-checksum-error",
      sceneId: "device-parse",
      name: "异常情况 · 校验码错误",
      caseType: "异常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "基于合法样例篡改校验位或正文内容。",
      objective: "验证协议校验失败时的处理路径。",
      expected: "系统应拒绝标准化，保留原始报文和校验失败证据。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [["篡改样例 HEX", "只改变校验相关字段"], ["发送报文", "写入 device-raw-data"], ["检查校验失败", "确认错误类型准确"], ["检查下游", "确认未生成正常监测数据"]],
    },
    {
      id: "device-hex-unknown-device-type",
      sceneId: "device-parse",
      name: "异常情况 · 未知设备类型",
      caseType: "异常",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "设备类型不在当前协议支持集合内。",
      objective: "验证未知类型不会被误解析成其它设备。",
      expected: "系统应进入未知类型处理或失败记录，不产生错误 monitor 数据。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [["构造未知类型报文", "保持帧结构尽量合法"], ["发送报文", "写入原始 Topic"], ["检查分类结果", "确认未知类型被明确标识"], ["检查查询结果", "确认不会混入已知设备类型"]],
    },
    {
      id: "device-hex-length-boundary",
      sceneId: "device-parse",
      name: "边界情况 · 报文长度边界",
      caseType: "边界",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "覆盖最短合法报文、字段长度临界值和超长报文。",
      objective: "验证长度字段、截断和越界处理。",
      expected: "合法边界可解析，越界报文被拒绝且不污染标准层。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [["准备边界样例", "最短、临界、超长三类"], ["逐条发送", "分别记录 traceId"], ["检查解析结果", "按输入类型验证成功或失败"], ["检查数据一致性", "确认各类结果可追踪"]],
    },
    {
      id: "device-hex-duplicate-message",
      sceneId: "device-parse",
      name: "边界情况 · 重复报文处理",
      caseType: "边界",
      automation: "automated",
      automationLabel: "已自动化",
      summary: "重复发送同一设备、同一采集时间、同一去重键的报文。",
      objective: "验证幂等写入和重复消息消费策略。",
      expected: "系统不应产生非预期重复监测记录；若保留多条，应能按规则解释。",
      capabilities: ["kafka", "database", "http", "deviceIngest"],
      last: "未执行",
      steps: [["发送首条报文", "记录设备、时间和去重键"], ["重复发送", "保持关键字段相同"], ["检查入库数量", "确认重复处理策略"], ["检查查询接口", "确认用户侧展示符合预期"]],
    },
  ];

  const reports = [];
  const lastRunByCase = {};
  let selectedReportTrace = null;
  let envCheckRunning = false;
  let envCheckResult = null;

  const capabilityNames = { kafka: "Kafka", database: "数据库", minio: "MinIO", http: "HTTP", websocket: "WebSocket", deviceIngest: "设备接入", tunnel: "临时隧道", localService: "连通性" };
  const envCheckNames = { gatewayUrl: "gateway", dataServiceUrl: "data-service", bizServiceUrl: "biz-service", taskServiceUrl: "task-service" };
  const baseFieldLabels = {
    gatewayUrl: "网关地址",
    gatewayHealthPath: "网关健康路径",
    dataServiceUrl: "数据服务地址",
    dataServiceHealthPath: "数据服务健康路径",
    bizServiceUrl: "业务服务地址",
    bizServiceHealthPath: "业务服务健康路径",
    taskServiceUrl: "任务服务地址",
    taskServiceHealthPath: "任务服务健康路径",
  };
  const stepNameMap = {
    "Environment precheck": "环境预检查",
    "Upload MinIO object": "上传雷达帧文件",
    "Check radar-frame-upstream": "检查上游 Topic",
    "Check file_frame_index": "检查文件入库",
    "Check file_metadata": "检查文件入库",
    "WebSocket push": "检查 WebSocket",
    "Query radar frames recent API": "检查查询接口",
    "Query radar replay API": "检查查询接口",
    "Send HEX to Kafka": "发送设备报文",
    "Check data_raw_message": "检查 raw 入库",
    "Check data_standard_message": "检查标准层",
    "Query device recent API": "检查接口返回",
    "Unsupported case": "不支持的用例",
    gateway: "网关",
    "data-service": "data-service",
    "biz-service": "biz-service",
    kafka: "Kafka",
    database: "数据库",
    minio: "MinIO",
    websocket: "WebSocket",
  };
  const stepDetailMap = {
    "all dependencies reachable": "依赖均可连通",
    "some dependencies failed": "部分依赖不可达",
    "message found": "已观察到上游消息",
    "not observed directly; downstream checks will confirm": "未直接观察到消息，由下游检查确认",
    "message received": "已收到推送消息",
    timeout: "等待推送超时",
    "missing websocket url": "未配置 WebSocket 地址",
    "missing base url": "缺少服务地址",
    "no checks configured": "未配置检查项",
  };
  function localizeStepName(name) {
    return stepNameMap[name] || name;
  }
  function localizeStepDetail(detail) {
    if (!detail) return "";
    if (stepDetailMap[detail]) return stepDetailMap[detail];
    const rowsMatch = String(detail).match(/^rows=(\d+)$/);
    if (rowsMatch) return `命中 ${rowsMatch[1]} 条`;
    return detail;
  }
  function localizeStep(step) {
    return {
      ...step,
      name: localizeStepName(step.name),
      detail: localizeStepDetail(step.detail),
    };
  }
  function getVerificationMeta(step) {
    const title = Array.isArray(step) ? step[0] : localizeStepName(step.name);
    const detail = Array.isArray(step) ? step[1] : localizeStepDetail(step.detail || "");
    const text = `${title} ${detail}`;
    let stage = "验收";
    if (/环境预检查/.test(text)) stage = "前置检查";
    else if (/上传|发送|准备|生成|构造|篡改|选择/.test(title)) stage = "测试动作";

    let target = "业务结果";
    if (/环境预检查/.test(text)) target = "运行环境";
    else if (/WebSocket|推送/.test(text)) target = "WebSocket";
    else if (/查询|接口|API/.test(text)) target = "HTTP API";
    else if (/入库|索引|file_frame_index|file_metadata|标准层|monitor|正常表|下游/.test(text)) target = "数据库";
    else if (/Topic|Kafka|报文/.test(text)) target = "Kafka";
    else if (/MinIO|对象|文件/.test(text)) target = "MinIO";

    const ruleByTitle = {
      "环境预检查": "本用例所需依赖均可连接",
      "上传雷达帧文件": "对象上传成功，并生成本次 Trace ID",
      "上传到 MinIO": "对象上传成功，并生成本次 Trace ID",
      "上传文件": "对象上传成功，并生成本次 Trace ID",
      "上传首个对象": "首个对象成功写入并可关联 Trace ID",
      "重复上传同一 objectKey": "同一路径对象覆盖成功，并产生第二次 Trace ID",
      "检查上游 Topic": "本次对象事件可被下游消费",
      "检查异步消费": "本次对象事件可被下游消费",
      "检查文件入库": "存在与本次 Trace ID 对应的索引记录",
      "检查首次入库": "file_frame_index 产生 1 条对应索引",
      "检查正常索引": "不产生不符合预期的正常索引",
      "检查幂等覆盖": "同一 objectKey 仅保留 1 条索引且 Trace ID 更新",
      "检查 WebSocket": "实时推送可关联到本次 Trace ID",
      "检查查询接口": "查询结果符合本用例预期",
      "检查 raw 入库": "原始报文可按 Trace ID 查询",
      "检查标准层": "标准化消息可按 Trace ID 查询",
      "检查 monitor 表": "对应监测数据已生成",
      "检查接口返回": "接口返回包含本次测试数据",
      "检查失败记录": "失败原因可定位且保留 Trace ID",
      "检查下游": "未生成不应出现的正常数据",
      "检查数据一致性": "各类输入的结果均可追踪",
      "检查入库数量": "重复消息处理结果符合去重规则",
      "汇总时延": "上传、消费耗时和实际大小均可记录",
    };
    return { stage, target, rule: ruleByTitle[title] || detail || "结果符合用例预期" };
  }
  function renderVerificationRows(sourceSteps, statuses, details = []) {
    return sourceSteps.map((step, index) => {
      const status = statuses && statuses[index] ? statuses[index] : "ready";
      const meta = getVerificationMeta(step);
      const detail = details[index]?.detail;
      const resultLabel = status === "pass" ? "已通过" : status === "running" ? "检查中" : status === "fail" ? "不符合预期" : "待验证";
      const evidence = detail || (status === "pass" ? "已采集运行证据" : status === "running" ? "正在等待结果" : status === "fail" ? "请查看失败证据" : "执行后显示实际结果");
      return `<div class="step-item ${status}"><span class="check-stage">${meta.stage}</span><div class="check-target"><strong>${meta.target}</strong></div><div class="check-rule"><strong>${meta.rule}</strong></div><div class="step-evidence"><strong>${resultLabel}</strong><span title="${evidence}">${evidence}</span></div></div>`;
    }).join("");
  }
  const moduleFields = { kafka: ["bootstrapServers", "upstreamTopic", "standardTopic"], database: ["jdbcUrl", "username", "passwordRef"], minio: ["endpoint", "accessKey", "secretKeyRef", "bucket"], websocket: ["url"], deviceIngest: ["rawTopic", "standardTopic", "defaultMonitorType"], tunnel: ["publicUrl", "provider"] };
  const moduleFieldLabels = {
    bootstrapServers: "Kafka 地址", upstreamTopic: "上游 Topic", standardTopic: "标准消息 Topic",
    jdbcUrl: "数据库连接地址", username: "用户名", passwordRef: "密码 / 密钥引用",
    endpoint: "服务地址", accessKey: "Access Key", secretKeyRef: "Secret Key / 密钥引用",
    bucket: "Bucket", url: "连接地址", rawTopic: "原始报文 Topic",
    defaultMonitorType: "默认监测类型", publicUrl: "公网地址", provider: "隧道服务商",
  };
  const capabilityRequiredFields = {
    kafka: ["bootstrapServers", "upstreamTopic"],
    database: ["jdbcUrl", "username", "passwordRef"],
    minio: ["endpoint", "accessKey", "secretKeyRef", "bucket"],
    websocket: ["url"],
    deviceIngest: ["rawTopic", "standardTopic", "defaultMonitorType"],
    tunnel: ["publicUrl", "provider"],
  };
  const capabilityShortNames = { kafka: "K", database: "DB", minio: "M", websocket: "WS", deviceIngest: "DI", tunnel: "T" };
  const HAS_SERVER_API = window.location.protocol === "http:" || window.location.protocol === "https:";
  let activeEnv = window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY) || "local";
  if (!envs[activeEnv]) activeEnv = "local";
  let activeScene = scenes[0].id;
  let activeCase = cases.find((item) => item.sceneId === activeScene)?.id || cases[0].id;
  let selectedRunCaseIds = new Set([activeCase]);
  let running = false;
  let batchProgress = null;
  let batchRun = null;
  let folderFiles = [];
  let folderSelection = null;
  let folderUploadRunning = false;
  let folderUploadStats = null;
  let latestStepDetails = [];
  const reportFilters = { status: "all", env: "all", caseId: "all", trace: "" };
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
  }
  function formatByteSize(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function getFolderRelativePath(file) {
    const rawPath = String(file.webkitRelativePath || file.name || "").replace(/\\/g, "/");
    const segments = rawPath.split("/").filter(Boolean);
    return segments.length > 1 ? segments.slice(1).join("/") : (segments[0] || file.name);
  }
  function getFolderFileName(relativePath) {
    const segments = String(relativePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return segments[segments.length - 1] || "";
  }
  function getFolderUploadHourPrefix(now = new Date()) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd}/${hh}`;
  }
  function getFolderObjectKey(relativePath, hourPrefix) {
    return `upstream/radar/realtime/${hourPrefix}/${getFolderFileName(relativePath)}`;
  }
  function normalizeBrowserWebSocketUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const parsed = new URL(text);
      if (parsed.protocol === "http:") parsed.protocol = "ws:";
      if (parsed.protocol === "https:") parsed.protocol = "wss:";
      return parsed.toString();
    } catch (_error) {
      return text;
    }
  }
  function startFolderWebSocketProbe(url, objectKeys, onHit) {
    const state = { configured: Boolean(url), opened: false, error: "", hits: new Set() };
    let ws = null;
    let readyDone = false;
    let resolveReady;
    const pending = new Set(objectKeys);
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const markReady = () => {
      if (readyDone) return;
      readyDone = true;
      resolveReady(state);
    };
    if (!url) {
      markReady();
      return { state, ready, stop: () => {} };
    }
    try {
      ws = new WebSocket(normalizeBrowserWebSocketUrl(url));
      const readyTimer = setTimeout(markReady, 800);
      ws.addEventListener("open", () => {
        state.opened = true;
        clearTimeout(readyTimer);
        markReady();
      });
      ws.addEventListener("message", (event) => {
        const text = String(event.data || "");
        Array.from(pending).forEach((objectKey) => {
          if (text.includes(objectKey)) {
            pending.delete(objectKey);
            state.hits.add(objectKey);
            onHit(objectKey);
          }
        });
      });
      ws.addEventListener("error", () => {
        state.error = "WebSocket 连接失败";
        clearTimeout(readyTimer);
        markReady();
      });
      ws.addEventListener("close", () => {
        if (!state.error && state.opened && pending.size) state.error = "WebSocket 已断开";
      });
    } catch (error) {
      state.error = error.message || "WebSocket 连接失败";
      markReady();
    }
    return {
      state,
      ready,
      stop: () => {
        if (ws && ws.readyState <= 1) ws.close();
      },
    };
  }
  function getSceneCases(sceneId) {
    return cases.filter((item) => item.sceneId === sceneId);
  }
  function getActiveScene() {
    return scenes.find((scene) => scene.id === activeScene) || scenes[0];
  }
  function getActiveCase() {
    return cases.find((entry) => entry.id === activeCase) || getSceneCases(activeScene)[0] || cases[0];
  }
  function getCaseTypeClass(caseType) {
    return caseType === "正常" ? "positive" : caseType === "边界" ? "boundary" : "negative";
  }
  function getSelectedExecutableCases() {
    return getSceneCases(activeScene).filter((item) => item.automation === "automated" && selectedRunCaseIds.has(item.id));
  }
  function resetRunSelectionForScene() {
    const firstExecutable = getSceneCases(activeScene).find((item) => item.automation === "automated");
    selectedRunCaseIds = new Set(firstExecutable ? [firstExecutable.id] : []);
    batchRun = null;
  }

  function setView(view) {
    const viewMeta = { run: ["TEST RUNNER", "执行工作台"], reports: ["RUN HISTORY", "历史报告"], env: ["ENVIRONMENT", "环境设置"] };
    $$("[data-view]").forEach((panel) => panel.classList.toggle("active", panel.dataset.view === view));
    $$("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === view));
    $("[data-view-kicker]").textContent = (viewMeta[view] || viewMeta.run)[0];
    $("[data-view-title]").textContent = (viewMeta[view] || viewMeta.run)[1];
    document.body.classList.remove("menu-open");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (view === "run") restoreActiveCaseRun();
    if (view === "reports") loadRuns().then(() => renderReports());
  }
  function syncEnvLabels() {
    persistActiveEnv();
    const env = envs[activeEnv];
    $("[data-active-env-label]").textContent = env.name;
    $("[data-active-env-name]").textContent = env.name;
    $("[data-env-context-name]").textContent = env.name;
    $("[data-env-context-desc]").textContent = env.desc || "自定义环境";
    $("[data-env-select]").value = activeEnv;
    renderReadiness();
  }
  function getCapabilityState(capability, env) {
    if (capability === "http" || capability === "localService") {
      const urls = [env.base?.gatewayUrl, env.base?.dataServiceUrl, env.base?.bizServiceUrl];
      return urls.every((value) => String(value || "").trim())
        ? { ok: true, detail: "基础服务地址已配置" }
        : { ok: false, detail: "基础服务地址不完整" };
    }
    const config = env.capabilities?.[capability];
    if (!config?.enabled) return { ok: false, detail: "能力未启用" };
    const missing = (capabilityRequiredFields[capability] || []).filter((field) => !String(config[field] || "").trim());
    return missing.length
      ? { ok: false, detail: "缺少 " + (moduleFieldLabels[missing[0]] || missing[0]) }
      : { ok: true, detail: "配置完整" };
  }
  function getCaseReadiness(item) {
    const states = item.capabilities.map((capability) => ({ capability, ...getCapabilityState(capability, envs[activeEnv]) }));
    return { ok: states.every((state) => state.ok), states, missing: states.filter((state) => !state.ok) };
  }
  function renderReadiness() {
    const item = getActiveCase();
    const readiness = getCaseReadiness(item);
    const card = $("[data-readiness-card]");
    const title = $("[data-run-readiness]");
    const detail = $("[data-run-readiness-detail]");
    const runButton = $("[data-run-selected]");
    const runSceneButton = $("[data-run-scene]");
    if (!card || !title || !detail) return;
    card.classList.remove("warn", "fail");
    if (!readiness.ok) {
      card.classList.add("fail");
      title.textContent = "配置不完整，暂不能执行";
      detail.textContent = readiness.missing.map((state) => (capabilityNames[state.capability] || state.capability) + "：" + state.detail).join("；");
    } else if (envCheckRunning) {
      card.classList.add("warn");
      title.textContent = "正在检查环境连通性";
      detail.textContent = "检查完成后会更新执行状态";
    } else if (envCheckResult && !envCheckResult.ok) {
      const failed = envCheckResult.results.find((entry) => !entry.ok);
      card.classList.add("fail");
      title.textContent = "环境存在不可达项";
      detail.textContent = failed ? (envCheckNames[failed.key] || failed.key) + "：" + (failed.detail || "检查失败") : "请到环境设置查看详情";
    } else if (envCheckResult?.ok) {
      title.textContent = "环境可用，可以执行";
      detail.textContent = "依赖连接检查已通过";
    } else {
      card.classList.add("warn");
      title.textContent = "配置完整，尚未检查连接";
      detail.textContent = "可先检查连通性；执行时仍会自动预检";
    }
    if (runButton) {
      const isAutomated = item.automation === "automated";
      runButton.disabled = running || folderUploadRunning || !isAutomated || !readiness.ok || Boolean(envCheckResult && !envCheckResult.ok);
      runButton.textContent = running ? "执行中…" : folderUploadRunning ? "文件夹上传中…" : isAutomated ? "执行当前用例" : "仅设计，暂不能执行";
    }
    if (runSceneButton) {
      const selectedCases = getSelectedExecutableCases();
      const allReady = selectedCases.every((entry) => getCaseReadiness(entry).ok);
      runSceneButton.disabled = running || folderUploadRunning || !selectedCases.length || !allReady || Boolean(envCheckResult && !envCheckResult.ok);
      runSceneButton.textContent = running ? "执行中…" : folderUploadRunning ? "文件夹上传中…" : `运行已选择用例（${selectedCases.length}）`;
    }
    renderFolderUpload();
  }
  function renderFolderUpload() {
    const panel = $("[data-folder-upload]");
    if (!panel) return;
    panel.hidden = activeScene !== "minio-upload";
    if (panel.hidden) return;
    const selectButton = $("[data-folder-select]");
    const uploadButton = $("[data-folder-upload-start]");
    const state = $("[data-folder-upload-state]");
    const summary = $("[data-folder-summary]");
    const progress = $("[data-folder-progress]");
    const resultNode = $("[data-folder-result]");
    const minioReady = getCapabilityState("minio", envs[activeEnv]).ok;
    const hasFailures = Boolean(folderUploadStats && (folderUploadStats.uploadFailed || folderUploadStats.apiFailed || folderUploadStats.websocketFailed));
    selectButton.disabled = folderUploadRunning;
    const hasDuplicateFileNames = Boolean(folderSelection?.duplicateFileNames?.length);
    uploadButton.disabled = folderUploadRunning || running || !folderFiles.length || !minioReady || hasDuplicateFileNames;
    uploadButton.textContent = folderUploadRunning ? "上传中…" : folderUploadStats ? "重新上传" : "上传到 MinIO";
    state.className = folderUploadRunning ? "state-pill warn" : hasFailures ? "state-pill fail" : folderUploadStats ? "state-pill pass" : "state-pill ready";
    state.textContent = folderUploadRunning ? "正在上传并验证" : hasFailures ? "存在验证失败" : folderUploadStats ? "上传并验证完成" : folderFiles.length ? "已选择文件夹" : "未选择文件夹";
    if (!folderSelection) {
      summary.textContent = "尚未选择文件夹";
    } else {
      const skipped = folderSelection.totalFiles - folderFiles.length;
      const options = folderFiles.length ? getFolderUploadOptions() : { uploadLimit: 0, uploadDelayMs: readNumberInput("[data-folder-upload-delay]", 0, 0, 60000) };
      const selectedText = `文件夹：${folderSelection.rootName} · ${folderFiles.length} 个 JSON · ${formatByteSize(folderSelection.totalBytes)}`;
      const planText = ` · 本次上传 ${options.uploadLimit}/${folderFiles.length} 个附件，间隔 ${options.uploadDelayMs}ms`;
      const skippedText = skipped > 0 ? ` · 已忽略 ${skipped} 个非 JSON 文件` : "";
      const duplicateText = hasDuplicateFileNames ? ` · ${folderSelection.duplicateFileNames.length} 个同名 JSON 会覆盖，请先改名` : "";
      summary.textContent = `${selectedText}${planText}${skippedText}${duplicateText}`;
    }
    if (folderUploadStats) {
      progress.hidden = false;
      progress.max = Math.max(folderUploadStats.total, 1);
      progress.value = folderUploadStats.completed;
      const failures = folderUploadStats.failures.slice(0, 5).map((entry) => `<span class="upload-failure">${escapeHtml(entry.path)}：${escapeHtml(entry.message)}</span>`).join("");
      const pending = folderUploadRunning ? ` · 接口待命中 ${folderUploadStats.apiPending} · WebSocket 待命中 ${folderUploadStats.websocketPending}` : "";
      const phase = folderUploadStats.phase ? ` · ${escapeHtml(folderUploadStats.phase)}` : "";
      const cumulative = folderUploadStats.phase === "验证完成" ? ` · 累计接口命中 ${folderUploadStats.apiPassed}/${folderUploadStats.uploaded}` : "";
      const detail = folderUploadStats.detail ? ` · ${escapeHtml(folderUploadStats.detail)}` : "";
      resultNode.className = hasFailures ? "folder-upload-result fail" : "folder-upload-result";
      resultNode.innerHTML = `上传处理 ${folderUploadStats.completed}/${folderUploadStats.total} · 上传成功 ${folderUploadStats.uploaded} · 接口命中 ${folderUploadStats.apiPassed} · WebSocket 命中 ${folderUploadStats.websocketPassed} · 上传失败 ${folderUploadStats.uploadFailed} · 接口失败 ${folderUploadStats.apiFailed} · WebSocket 失败 ${folderUploadStats.websocketFailed}${pending}${phase}${cumulative}${detail}${failures}`;
    } else {
      progress.hidden = true;
      progress.value = 0;
      resultNode.className = "folder-upload-result";
      resultNode.textContent = minioReady ? "选择后不会立即上传；上传完成后会验证查询接口和 WebSocket。" : "当前环境的 MinIO 配置不完整。";
    }
  }
  function selectFolderFiles(fileList) {
    const allFiles = Array.from(fileList || []);
    const jsonFiles = allFiles.filter((file) => /\.json$/i.test(file.name)).map((file) => ({ file, relativePath: getFolderRelativePath(file) }));
    const fileNameCounts = jsonFiles.reduce((counts, entry) => {
      const fileName = getFolderFileName(entry.relativePath).toLowerCase();
      counts[fileName] = (counts[fileName] || 0) + 1;
      return counts;
    }, {});
    const duplicateFileNames = Object.keys(fileNameCounts).filter((fileName) => fileNameCounts[fileName] > 1);
    folderFiles = jsonFiles;
    folderSelection = allFiles.length ? {
      rootName: String(allFiles[0].webkitRelativePath || "所选文件夹").split("/")[0] || "所选文件夹",
      totalFiles: allFiles.length,
      totalBytes: jsonFiles.reduce((total, entry) => total + entry.file.size, 0),
      duplicateFileNames,
    } : null;
    folderUploadStats = null;
    const limitInput = $("[data-folder-upload-limit]");
    if (limitInput) {
      limitInput.max = String(Math.max(jsonFiles.length, 1));
      limitInput.value = jsonFiles.length ? String(jsonFiles.length) : "";
      limitInput.placeholder = jsonFiles.length ? `最多 ${jsonFiles.length} 个` : "选择后自动填充";
    }
    renderFolderUpload();
  }
  async function uploadFolderFile(entry, hourPrefix) {
    const query = new URLSearchParams({ env: activeEnv, path: entry.relativePath, hourPrefix });
    const response = await fetch(`/api/minio/folder-upload?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": entry.file.type || "application/json" },
      body: entry.file,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "上传失败");
    return payload;
  }
  function readNumberInput(selector, fallback, min, max) {
    const node = $(selector);
    if (!node || String(node.value).trim() === "") return fallback;
    const value = Number(node.value);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  }
  function getFolderUploadOptions() {
    const total = Math.max(folderFiles.length, 1);
    return {
      uploadLimit: readNumberInput("[data-folder-upload-limit]", total, 1, total),
      uploadDelayMs: readNumberInput("[data-folder-upload-delay]", 0, 0, 60000),
      scanIntervalMs: 900,
      scanBatchSize: 200,
      verifyTimeoutMs: 30 * 1000,
    };
  }
  async function queryFolderRecentSnapshot(objectKeys, batchSize = 200) {
    const found = new Set();
    const chunks = [];
    const size = Math.min(1000, Math.max(20, Number(batchSize) || 200));
    for (let index = 0; index < objectKeys.length; index += size) {
      chunks.push(objectKeys.slice(index, index + size));
    }
    let lastDetail = "";
    for (const chunk of chunks) {
      const query = new URLSearchParams({ env: activeEnv });
      const response = await fetch(`/api/minio/folder-recent-snapshot?${query.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objectKeys: chunk }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "查询接口验证失败");
      (payload.found || []).forEach((objectKey) => found.add(objectKey));
      lastDetail = `最后一轮接口扫描：${payload.detail || "无详情"}`;
    }
    return { found, detail: lastDetail };
  }
  function syncFolderUploadStats(items, options = {}) {
    const final = Boolean(options.final);
    const uploadedItems = items.filter((item) => item.uploadOk);
    const uploadFailedItems = items.filter((item) => item.uploadDone && !item.uploadOk);
    const apiPassed = uploadedItems.filter((item) => item.apiOk).length;
    const websocketPassed = uploadedItems.filter((item) => item.websocketOk).length;
    const failures = uploadFailedItems.map((item) => ({ path: item.relativePath, message: item.error || "上传失败" }));
    if (final) {
      uploadedItems.forEach((item) => {
        const missed = [];
        if (!item.apiOk) missed.push("接口未查到");
        if (!item.websocketOk) missed.push("WebSocket 未收到");
        if (missed.length) failures.push({ path: item.relativePath, message: missed.join("；") });
      });
    }
    folderUploadStats = {
      total: items.length,
      completed: items.filter((item) => item.uploadDone).length,
      uploaded: uploadedItems.length,
      apiPassed,
      websocketPassed,
      uploadFailed: uploadFailedItems.length,
      apiFailed: final ? uploadedItems.length - apiPassed : 0,
      websocketFailed: final ? uploadedItems.length - websocketPassed : 0,
      apiPending: uploadedItems.length - apiPassed,
      websocketPending: uploadedItems.length - websocketPassed,
      phase: options.phase || "",
      detail: options.detail || "",
      failures,
    };
    renderFolderUpload();
  }
  async function uploadSelectedFolder() {
    if (running || folderUploadRunning || !folderFiles.length) return;
    const minioState = getCapabilityState("minio", envs[activeEnv]);
    if (!minioState.ok) {
      showToast(`MinIO 配置不完整：${minioState.detail}`);
      return;
    }
    if (folderSelection?.duplicateFileNames?.length) {
      showToast("存在同名 JSON，扁平上传会覆盖，请先改名");
      return;
    }
    await persistEnvs();
    folderUploadRunning = true;
    const uploadOptions = getFolderUploadOptions();
    const uploadHourPrefix = getFolderUploadHourPrefix();
    const selectedUploadFiles = folderFiles.slice(0, uploadOptions.uploadLimit);
    const items = selectedUploadFiles.map((entry) => ({
      ...entry,
      objectKey: getFolderObjectKey(entry.relativePath, uploadHourPrefix),
      uploadDone: false,
      uploadOk: false,
      apiOk: false,
      websocketOk: false,
      error: "",
    }));
    let stopApiPolling = false;
    let lastQueryDetail = "";
    const wsProbe = startFolderWebSocketProbe(
      envs[activeEnv].capabilities?.websocket?.url,
      items.map((item) => item.objectKey),
      (objectKey) => {
        const item = items.find((entry) => entry.objectKey === objectKey);
        if (item) item.websocketOk = true;
        syncFolderUploadStats(items, { phase: "上传中，正在收 WebSocket", detail: lastQueryDetail });
      },
    );
    syncFolderUploadStats(items, { phase: "准备监听 WebSocket", detail: `本次上传 ${items.length}/${folderFiles.length} 个附件，附件间隔 ${uploadOptions.uploadDelayMs}ms` });
    renderReadiness();
    await Promise.race([wsProbe.ready, wait(600)]);
    async function pollQueryApiLoop() {
      while (!stopApiPolling) {
        const pendingKeys = items.filter((item) => item.uploadOk && !item.apiOk).map((item) => item.objectKey);
        if (pendingKeys.length) {
          try {
            const result = await queryFolderRecentSnapshot(pendingKeys, uploadOptions.scanBatchSize);
            result.found.forEach((objectKey) => {
              const item = items.find((entry) => entry.objectKey === objectKey);
              if (item) item.apiOk = true;
            });
            lastQueryDetail = result.detail || lastQueryDetail;
            syncFolderUploadStats(items, { phase: "上传中，正在查 recent 接口", detail: lastQueryDetail });
          } catch (error) {
            lastQueryDetail = error.message || "查询接口验证失败";
            syncFolderUploadStats(items, { phase: "上传中，接口验证重试中", detail: lastQueryDetail });
          }
        }
        await wait(uploadOptions.scanIntervalMs);
      }
    }
    const apiPollPromise = pollQueryApiLoop();
    for (let index = 0; index < items.length; index += 1) {
      const entry = items[index];
      try {
        syncFolderUploadStats(items, { phase: `上传第 ${index + 1}/${items.length} 个附件`, detail: lastQueryDetail });
        const result = await uploadFolderFile(entry, uploadHourPrefix);
        entry.uploadOk = true;
        entry.objectKey = result.objectKey || entry.objectKey;
      } catch (error) {
        entry.error = error.message || "上传失败";
      } finally {
        entry.uploadDone = true;
        syncFolderUploadStats(items, { phase: "上传中，接口和 WebSocket 验证同步进行", detail: lastQueryDetail });
      }
      if (uploadOptions.uploadDelayMs > 0 && index < items.length - 1) {
        syncFolderUploadStats(items, { phase: "等待下一个附件上传", detail: `间隔 ${uploadOptions.uploadDelayMs}ms 后继续` });
        await wait(uploadOptions.uploadDelayMs);
      }
    }
    const verifyStartedAt = Date.now();
    const verifyTimeoutMs = uploadOptions.verifyTimeoutMs;
    while (Date.now() - verifyStartedAt < verifyTimeoutMs) {
      const pendingApiKeys = items.filter((item) => item.uploadOk && !item.apiOk).map((item) => item.objectKey);
      const pendingWs = items.some((item) => item.uploadOk && !item.websocketOk);
      if (!pendingApiKeys.length && !pendingWs) break;
      if (pendingApiKeys.length) {
        try {
          const result = await queryFolderRecentSnapshot(pendingApiKeys, uploadOptions.scanBatchSize);
          result.found.forEach((objectKey) => {
            const item = items.find((entry) => entry.objectKey === objectKey);
            if (item) item.apiOk = true;
          });
          lastQueryDetail = result.detail || lastQueryDetail;
        } catch (error) {
          lastQueryDetail = error.message || "查询接口验证失败";
        }
      }
      syncFolderUploadStats(items, { phase: "上传完成，等待异步结果", detail: lastQueryDetail });
      await wait(uploadOptions.scanIntervalMs);
    }
    stopApiPolling = true;
    await apiPollPromise.catch(() => {});
    wsProbe.stop();
    syncFolderUploadStats(items, { final: true, phase: "验证完成", detail: lastQueryDetail || (wsProbe.state.error ? wsProbe.state.error : "") });
    folderUploadRunning = false;
    renderReadiness();
    const failures = folderUploadStats.uploadFailed + folderUploadStats.apiFailed + folderUploadStats.websocketFailed;
    showToast(failures ? `文件夹导入完成：${failures} 项验证失败` : `文件夹导入完成：${folderUploadStats.uploaded} 个文件均通过验证`);
  }
  function formatRunTime(value) {
    if (!value) return "-";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value));
    } catch (_error) {
      return value;
    }
  }
  function rememberRun(result) {
    if (!result?.caseId) return;
    lastRunByCase[result.caseId] = result;
    const item = cases.find((entry) => entry.id === result.caseId);
    if (item) item.last = result.ok ? "刚刚通过" : "刚刚失败";
  }
  function applyRunToPanel(result) {
    if (!result) {
      latestStepDetails = [];
      $("[data-trace-id]").textContent = "执行后生成";
      $("[data-run-state]").className = "state-pill ready";
      $("[data-run-state]").textContent = "待执行";
      renderSelectedCase();
      return;
    }
    latestStepDetails = result.steps || [];
    $("[data-trace-id]").textContent = result.traceId || "未生成";
    $("[data-run-state]").className = result.ok ? "state-pill pass" : "state-pill fail";
    $("[data-run-state]").textContent = result.ok ? "执行通过" : "执行失败";
    renderSelectedCase(null, result);
  }
  function restoreActiveCaseRun() {
    applyRunToPanel(lastRunByCase[activeCase] || null);
  }
  function renderCaseList() {
    $("[data-active-case-count]").textContent = scenes.length + " 个内置场景";
    $("[data-case-list]").innerHTML = scenes.map((scene, index) => {
      const sceneCases = getSceneCases(scene.id);
      const automatedCount = sceneCases.filter((item) => item.automation === "automated").length;
      const latestRun = sceneCases.map((item) => lastRunByCase[item.id]).find(Boolean);
      const pillClass = latestRun ? (latestRun.ok ? "pass" : "fail") : "ready";
      const lastLabel = latestRun ? (latestRun.ok ? "最近通过" : "最近失败") : `${sceneCases.length} 个用例`;
      return `
      <button class="case-card ${scene.id === activeScene ? "active" : ""}" type="button" data-scene-id="${scene.id}">
        <div class="card-topline"><span class="case-index">${String(index + 1).padStart(2, "0")} · 测试场景</span><span class="state-pill ${pillClass}">${lastLabel}</span></div>
        <h3>${scene.name}</h3><p>${scene.summary}</p>
        <div class="scene-case-preview"><span>用例</span><strong>${automatedCount} 个已自动化 · ${sceneCases.length - automatedCount} 个待接入</strong><em class="ready">矩阵</em></div>
      </button>`;
    }).join("");
    $$("[data-scene-id]").forEach((button) => button.addEventListener("click", () => {
      activeScene = button.dataset.sceneId;
      activeCase = getSceneCases(activeScene)[0]?.id || activeCase;
      resetRunSelectionForScene();
      renderCaseList();
      restoreActiveCaseRun();
    }));
  }
  function renderTestCaseList() {
    const sceneCases = getSceneCases(activeScene);
    const listNode = $("[data-test-case-list]");
    if (!listNode) return;
    listNode.innerHTML = sceneCases.map((item) => {
      const lastRun = lastRunByCase[item.id];
      const canRun = item.automation === "automated";
      const pillClass = item.automation === "automated" ? (lastRun ? (lastRun.ok ? "pass" : "fail") : "ready") : "warn";
      const pillText = item.automation === "automated" ? (lastRun ? (lastRun.ok ? "最近通过" : "最近失败") : item.automationLabel) : item.automationLabel;
      return `
        <article class="test-case-card ${item.id === activeCase ? "active" : ""} ${canRun ? "" : "disabled"}" data-test-case-id="${item.id}">
          <div class="test-case-head">
            <span class="case-type ${getCaseTypeClass(item.caseType)}">${item.caseType}</span>
            <span class="state-pill ${pillClass}">${pillText}</span>
          </div>
          <button class="test-case-main" type="button" data-test-case-view="${item.id}">
            <strong>${item.name}</strong>
            <small>${item.summary}</small>
          </button>
          <label class="case-run-check">
            <input type="checkbox" data-run-case-check="${item.id}" ${selectedRunCaseIds.has(item.id) ? "checked" : ""} ${canRun ? "" : "disabled"} />
            <span>${canRun ? "本次执行" : "仅设计，不能选择"}</span>
          </label>
        </article>`;
    }).join("");
    $$("[data-test-case-view]").forEach((button) => button.addEventListener("click", () => {
      activeCase = button.dataset.testCaseView;
      applyRunToPanel(lastRunByCase[activeCase] || null);
    }));
    $$("[data-run-case-check]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) {
        selectedRunCaseIds.add(input.dataset.runCaseCheck);
      } else {
        selectedRunCaseIds.delete(input.dataset.runCaseCheck);
      }
      renderBatchQueue();
      renderReadiness();
    }));
    renderBatchQueue();
  }
  function renderBatchQueue() {
    const node = $("[data-batch-queue]");
    if (!node) return;
    const selectedCases = getSelectedExecutableCases();
    const progress = batchProgress ? `正在执行 ${batchProgress.current}/${batchProgress.total}` : `待批量执行 ${selectedCases.length} 个用例`;
    const entries = selectedCases.length
      ? selectedCases.map((entry, index) => `<span title="${entry.name}">${index + 1}. ${entry.name}</span>`).join("")
      : "<span>尚未选择可执行用例</span>";
    node.innerHTML = `<strong>已选批量队列</strong><span>${progress}</span><div class="batch-queue-list">${entries}</div>`;
  }
  function renderBatchResults() {
    const node = $("[data-batch-results]");
    if (!node) return;
    if (!batchRun) {
      node.classList.remove("show");
      node.innerHTML = "";
      return;
    }
    const total = batchRun.caseIds.length;
    const completed = Object.keys(batchRun.results).length;
    const passed = Object.values(batchRun.results).filter((result) => result.ok).length;
    const failed = completed - passed + (batchRun.errorCaseId ? 1 : 0);
    const summary = batchRun.running
      ? `已完成 ${completed}/${total}，正在执行第 ${batchRun.currentIndex}/${total} 个`
      : batchRun.interrupted
        ? `批量执行中断，已完成 ${completed}/${total}`
        : `执行完成：${passed} 通过，${failed} 失败`;
    const items = batchRun.caseIds.map((caseId, index) => {
      const item = cases.find((entry) => entry.id === caseId);
      const result = batchRun.results[caseId];
      const failedRequest = batchRun.errorCaseId === caseId;
      const state = result ? (result.ok ? "pass" : "fail") : failedRequest ? "fail" : batchRun.currentCaseId === caseId ? "running" : "ready";
      const status = result ? (result.ok ? "通过" : "失败") : failedRequest ? "请求失败" : state === "running" ? "执行中" : "等待执行";
      const detail = result ? `Trace ID：${result.traceId || "未生成"}` : failedRequest ? batchRun.errorMessage || "执行请求失败" : `队列第 ${index + 1} 个`;
      const selectable = Boolean(result);
      return `<button class="batch-result-item ${state} ${activeCase === caseId ? "active" : ""}" type="button" data-batch-result-case="${caseId}" ${selectable ? "" : "disabled"}><i></i><div class="batch-result-copy"><strong>${item?.name || caseId}</strong><span>${detail}</span></div><span class="batch-result-status">${status}</span></button>`;
    }).join("");
    node.classList.add("show");
    node.innerHTML = `<div class="batch-results-heading"><div><strong>本次批量执行结果</strong><span>${summary} · 点击已完成用例查看验收证据</span></div></div><div class="batch-result-list">${items}</div>`;
    $$('[data-batch-result-case]').forEach((button) => button.addEventListener("click", () => {
      const result = batchRun?.results[button.dataset.batchResultCase];
      if (!result) return;
      activeCase = button.dataset.batchResultCase;
      applyRunToPanel(result);
    }));
  }
  function renderSelectedCase(statuses, runResult) {
    const item = getActiveCase();
    const scene = getActiveScene();
    const result = runResult || (statuses ? null : lastRunByCase[activeCase]);
    const readiness = getCaseReadiness(item);
    $("[data-selected-scene-name]").textContent = scene.name;
    $("[data-selected-case-name]").textContent = item.name;
    $("[data-selected-capabilities]").innerHTML = readiness.states.map((state) => `<span class="${state.ok ? "ready" : "missing"}" title="${state.detail}">${capabilityNames[state.capability] || state.capability} · ${state.ok ? "已配置" : "缺失"}</span>`).join("");
    $("[data-case-objective]").textContent = item.objective;
    $("[data-case-expected]").textContent = item.expected;
    $("[data-verification-case]").textContent = `当前查看：${item.name}`;
    $("[data-step-section-hint]").textContent = batchProgress
      ? `正在批量执行 ${batchProgress.current}/${batchProgress.total}，仅展示当前用例结果`
      : "已选批量队列中的其它用例不合并在这里";
    renderTestCaseList();
    renderBatchResults();

    if (result?.steps?.length && !statuses) {
      $("[data-step-list]").innerHTML = renderVerificationRows(result.steps, result.steps.map((raw) => raw.ok ? "pass" : "fail"), result.steps);
      renderReadiness();
      return;
    }

    const sourceSteps = result?.steps?.length ? result.steps.map((step) => [step.name, step.detail || ""]) : item.steps;
    $("[data-step-list]").innerHTML = renderVerificationRows(sourceSteps, statuses, latestStepDetails);
    renderReadiness();
  }
  function renderEnvConfig() {
    const env = envs[activeEnv];
    $("[data-base-fields]").innerHTML = Object.entries(env.base).map(([key, value]) => `<div class="field"><label>${baseFieldLabels[key] || key}</label><input data-base-key="${key}" value="${value}" /></div>`).join("");
    $("[data-module-list]").innerHTML = Object.entries(env.capabilities).map(([key, config], index) => {
      const fields = moduleFields[key] || Object.keys(config).filter((field) => field !== "enabled");
      return `
        <details class="module-card ${config.enabled ? "" : "disabled"}" ${config.enabled && index === 0 ? "open" : ""} data-module-card="${key}">
          <summary>
            <div class="module-identity"><i>${capabilityShortNames[key] || key.slice(0, 2).toUpperCase()}</i><div><strong>${capabilityNames[key] || key}</strong><span>${key}</span></div></div>
            <div class="module-actions"><span class="module-hint">${config.enabled ? "已启用" : "未启用"}</span><label class="toggle"><input type="checkbox" data-module-toggle="${key}" ${config.enabled ? "checked" : ""} />启用</label></div>
          </summary>
          <div class="module-fields">${fields.map((field) => {
            const inputType = field === "passwordRef" || field === "secretKeyRef" ? "password" : "text";
            return `<div class="field"><label>${moduleFieldLabels[field] || field}</label><input type="${inputType}" data-module-key="${key}" data-module-field="${field}" value="${config[field] || ""}" autocomplete="off" /></div>`;
          }).join("")}</div>
        </details>`;
    }).join("");
    $$("[data-module-toggle]").forEach((input) => {
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", () => {
        const key = input.dataset.moduleToggle;
        env.capabilities[key].enabled = input.checked;
        const card = input.closest("[data-module-card]");
        card.classList.toggle("disabled", !input.checked);
        card.querySelector(".module-hint").textContent = input.checked ? "已启用" : "未启用";
        envCheckResult = null;
        renderReadiness();
      });
    });
    renderEnvCheck();
  }
  function renderEnvCheck() {
    const statusNode = $("[data-env-check-status]");
    const listNode = $("[data-env-check-list]");
    if (!statusNode || !listNode) return;
    if (envCheckRunning) {
      statusNode.textContent = "正在检查当前环境";
      listNode.innerHTML = "";
      renderReadiness();
      return;
    }
    if (!envCheckResult) {
      statusNode.textContent = "尚未检查当前环境";
      listNode.innerHTML = "";
      renderReadiness();
      return;
    }
    statusNode.textContent = envCheckResult.ok ? "当前环境可用" : "当前环境存在不可达项";
    listNode.innerHTML = envCheckResult.results.map((item) => {
      const title = envCheckNames[item.key] || item.key;
      const detail = item.detail || (item.ok ? "connected" : "check failed");
      return `<div class="env-check-item ${item.ok ? "pass" : "fail"}"><strong>${title}</strong><span>${detail}</span></div>`;
    }).join("");
    renderReadiness();
  }
  async function runCurrentEnvCheck() {
    if (envCheckRunning) return;
    envCheckRunning = true;
    envCheckResult = null;
    renderEnvCheck();
    try {
      const response = await fetch("/api/env-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: envs[activeEnv] }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "环境检查请求失败");
      envCheckResult = payload;
      renderEnvCheck();
      showToast(payload.ok ? "当前环境检查通过" : "当前环境检查有失败项");
    } catch (error) {
      envCheckResult = { ok: false, results: [{ key: "workbench", ok: false, detail: error.message || "环境检查接口不可用" }] };
      renderEnvCheck();
      showToast("环境检查接口不可用");
    } finally {
      envCheckRunning = false;
      renderEnvCheck();
    }
  }
  function renderLibrary() {
    if (!$("[data-library-grid]")) return;
    $("[data-library-grid]").innerHTML = cases.map((item) => `
      <article class="activity-card"><div class="card-topline"><span class="case-index">${item.category}</span><span class="state-pill ready">${item.steps.length} 步</span></div>
      <h3>${item.name}</h3><p>${item.summary}</p><div class="tag-row">${item.capabilities.map((cap) => `<span>${capabilityNames[cap] || cap}</span>`).join("")}</div>
      <div class="case-meta"><div class="meta-row"><span>配置方式</span><strong>页面维护</strong></div><div class="meta-row"><span>执行模式</span><strong>顺序执行 / 单步重试</strong></div></div></article>`).join("");
  }
  function syncReportFilterOptions() {
    const envSelect = $("[data-report-env-filter]");
    const caseSelect = $("[data-report-case-filter]");
    if (!envSelect || !caseSelect) return;
    const envValues = [...new Set(reports.map((item) => item.env).filter(Boolean))];
    const caseValues = new Map(reports.map((item) => [item.caseId || item.name, item.name]));
    envSelect.innerHTML = `<option value="all">全部环境</option>${envValues.map((value) => `<option value="${value}">${value}</option>`).join("")}`;
    caseSelect.innerHTML = `<option value="all">全部用例</option>${[...caseValues].map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}`;
    envSelect.value = envValues.includes(reportFilters.env) ? reportFilters.env : "all";
    caseSelect.value = caseValues.has(reportFilters.caseId) ? reportFilters.caseId : "all";
  }
  function renderReports() {
    syncReportFilterOptions();
    const filtered = reports.filter((item) => {
      if (reportFilters.status !== "all" && item.status !== reportFilters.status) return false;
      if (reportFilters.env !== "all" && item.env !== reportFilters.env) return false;
      if (reportFilters.caseId !== "all" && (item.caseId || item.name) !== reportFilters.caseId) return false;
      return !reportFilters.trace || String(item.trace || "").toLowerCase().includes(reportFilters.trace.toLowerCase());
    });
    const countNode = $("[data-report-count]");
    countNode.textContent = reports.length ? "显示 " + filtered.length + " / " + reports.length + " 次" : "暂无记录";
    if (!filtered.length) {
      $("[data-report-list]").innerHTML = `<div class="report-empty">${reports.length ? "没有符合当前筛选条件的报告。" : "还没有执行记录，请先到执行工作台运行一次用例。"}</div>`;
      return;
    }
    $("[data-report-list]").innerHTML = filtered.map((item) => {
      const open = selectedReportTrace === item.trace;
      const failedStep = (item.steps || []).find((step) => !step.ok);
      const evidence = [...item.evidence].sort((left, right) => Number(left.includes(": OK")) - Number(right.includes(": OK"))).slice(0, 6);
      const stepsHtml = (item.steps || []).map((raw, index) => {
        const step = localizeStep(raw);
        return `<div class="report-step ${raw.ok ? "pass" : "fail"}"><i class="dot"></i><div><strong>${index + 1}. ${step.name}</strong><span>${step.detail || (raw.ok ? "OK" : "失败")}</span></div></div>`;
      }).join("");
      return `
        <article class="report-card ${item.status} ${open ? "open" : ""}" data-report-trace="${item.trace}">
          <button class="report-card-head" type="button" data-report-toggle="${item.trace}" aria-expanded="${open}">
            <div>
              <div class="report-title-row"><h3>${item.name}</h3><span class="state-pill ${item.status}">${item.status === "pass" ? "通过" : "失败"}</span></div>
              <p class="report-meta">${item.env} · ${item.time} · ${item.trace}</p>
              ${failedStep ? `<p class="failure-brief">失败定位：${localizeStepName(failedStep.name)} · ${localizeStepDetail(failedStep.detail) || "需要排查"}</p>` : ""}
              <div class="report-evidence">${evidence.map((entry) => `<span class="${entry.includes(": OK") ? "" : "problem"}">${entry}</span>`).join("")}</div>
            </div>
            <span class="state-pill ready">${open ? "收起详情" : "查看详情"}</span>
          </button>
          <div class="report-detail">${stepsHtml || "<span>无步骤明细</span>"}</div>
        </article>`;
    }).join("");
    $$("[data-report-toggle]").forEach((button) => button.addEventListener("click", () => {
      const trace = button.dataset.reportToggle;
      selectedReportTrace = selectedReportTrace === trace ? null : trace;
      const run = reports.find((item) => item.trace === trace);
      if (run?.caseId && selectedReportTrace === trace) {
        activeCase = run.caseId;
        const matchedCase = getActiveCase();
        if (matchedCase?.sceneId) activeScene = matchedCase.sceneId;
        lastRunByCase[run.caseId] = run.raw || lastRunByCase[run.caseId];
      }
      renderReports();
    }));
  }
  function flattenRunEvidence(steps) {
    return steps.flatMap((entry) => {
      const name = localizeStepName(entry.name);
      const checks = entry.evidence && Array.isArray(entry.evidence.checks) ? entry.evidence.checks : null;
      if (checks) {
        return checks.map((check) => `${localizeStepName(check.name)}: ${check.ok ? "OK" : localizeStepDetail(check.detail)}`);
      }
      return [`${name}: ${entry.ok ? "OK" : localizeStepDetail(entry.detail)}`];
    });
  }
  function toReportItem(result) {
    return {
      name: result.caseName || result.caseId || "未知用例",
      caseId: result.caseId,
      env: result.envName || "-",
      status: result.ok ? "pass" : "fail",
      time: formatRunTime(result.startedAt),
      trace: result.traceId,
      evidence: flattenRunEvidence(result.steps || []).slice(0, 8),
      steps: result.steps || [],
      raw: result,
    };
  }
  async function loadRuns() {
    if (!HAS_SERVER_API) return false;
    try {
      const response = await fetch("/api/runs?limit=50", { cache: "no-store" });
      if (!response.ok) return false;
      const payload = await response.json();
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      reports.length = 0;
      runs.forEach((run) => {
        reports.push(toReportItem(run));
        if (run.caseId && !lastRunByCase[run.caseId]) {
          lastRunByCase[run.caseId] = run;
          const item = cases.find((entry) => entry.id === run.caseId);
          if (item) item.last = run.ok ? "最近通过" : "最近失败";
        }
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function saveEnvFromForm() {
    const env = envs[activeEnv];
    $$("[data-base-key]").forEach((input) => { env.base[input.dataset.baseKey] = input.value; });
    $$("[data-module-toggle]").forEach((input) => { env.capabilities[input.dataset.moduleToggle].enabled = input.checked; });
    $$("[data-module-key]").forEach((input) => { env.capabilities[input.dataset.moduleKey][input.dataset.moduleField] = input.value; });
    persistEnvs();
    envCheckResult = null;
    renderEnvCheck();
    renderSelectedCase();
    showToast("当前环境已保存，请重新检查连通性");
  }
  function resetCurrentEnv() {
    envs[activeEnv] = JSON.parse(JSON.stringify(defaultEnvs[activeEnv]));
    persistEnvs();
    renderEnvConfig();
    envCheckResult = null;
    renderEnvCheck();
    syncEnvLabels();
    renderSelectedCase();
    showToast("已恢复当前环境的默认配置");
  }

  function showToast(message) {
    const toast = $("[data-toast]");
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 1800);
  }
  async function requestCaseRun(item) {
    if (!HAS_SERVER_API) throw new Error("当前页面未连接测试工作台服务");
    const response = await fetch("/api/run-case", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: envs[activeEnv], case: item }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "执行接口请求失败");
    return result;
  }
  function assertExecutableCase(item) {
    if (item.automation !== "automated") {
      showToast("该用例目前仅设计，暂不能执行");
      return false;
    }
    const readiness = getCaseReadiness(item);
    if (!readiness.ok || (envCheckResult && !envCheckResult.ok)) {
      showToast("当前环境未就绪，请先处理缺失或不可达项");
      return false;
    }
    return true;
  }
  function applyRunResult(result) {
    rememberRun(result);
    reports.unshift(toReportItem(result));
    selectedReportTrace = result.traceId || null;
    applyRunToPanel(result);
    renderCaseList();
    renderReports();
  }
  async function runCaseWithPanel(item) {
    running = true;
    batchProgress = null;
    batchRun = null;
    const statuses = item.steps.map(() => "ready");
    statuses[0] = "running";
    latestStepDetails = [];
    const trace = `trace-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    $("[data-trace-id]").textContent = trace;
    $("[data-run-state]").className = "state-pill warn";
    $("[data-run-state]").textContent = "执行中";
    renderSelectedCase(statuses);

    try {
      const result = await requestCaseRun(item);
      running = false;
      applyRunResult(result);
      showToast(result.ok ? "用例执行通过" : "用例执行失败，已定位失败步骤");
      return result;
    } catch (error) {
      running = false;
      statuses[0] = "fail";
      latestStepDetails = [{ detail: error.message || "执行请求失败" }];
      $("[data-run-state]").className = "state-pill fail";
      $("[data-run-state]").textContent = "无法执行";
      renderSelectedCase(statuses);
      showToast("执行请求失败，没有生成虚假报告");
    }
  }
  async function runSelectedCase() {
    if (running || folderUploadRunning) return;
    const item = getActiveCase();
    if (!assertExecutableCase(item)) return;
    await runCaseWithPanel(item);
  }
  async function runActiveSceneCases() {
    if (running || folderUploadRunning) return;
    const executableCases = getSelectedExecutableCases();
    if (!executableCases.length) {
      showToast("请先选择要执行的可执行用例");
      return;
    }
    if (executableCases.some((item) => !assertExecutableCase(item))) return;
    running = true;
    const total = executableCases.length;
    let passCount = 0;
    batchRun = {
      caseIds: executableCases.map((item) => item.id),
      results: Object.create(null),
      currentCaseId: null,
      currentIndex: 0,
      running: true,
      interrupted: false,
    };
    for (let index = 0; index < executableCases.length; index += 1) {
      const item = executableCases[index];
      activeCase = item.id;
      batchProgress = { current: index + 1, total };
      batchRun.currentCaseId = item.id;
      batchRun.currentIndex = index + 1;
      latestStepDetails = [];
      const statuses = item.steps.map(() => "ready");
      statuses[0] = "running";
      $("[data-trace-id]").textContent = `批量执行 ${index + 1}/${total}`;
      $("[data-run-state]").className = "state-pill warn";
      $("[data-run-state]").textContent = `执行 ${index + 1}/${total}`;
      renderSelectedCase(statuses);
      try {
        const result = await requestCaseRun(item);
        batchRun.results[item.id] = result;
        passCount += result.ok ? 1 : 0;
        applyRunResult(result);
      } catch (error) {
        statuses[0] = "fail";
        latestStepDetails = [{ detail: error.message || "执行请求失败" }];
        $("[data-run-state]").className = "state-pill fail";
        $("[data-run-state]").textContent = "批量执行中断";
        batchRun.currentCaseId = null;
        batchRun.running = false;
        batchRun.interrupted = true;
        batchRun.errorCaseId = item.id;
        batchRun.errorMessage = error.message || "执行请求失败";
        batchProgress = null;
        renderSelectedCase(statuses);
        running = false;
        showToast("批量执行中断，没有生成虚假报告");
        return;
      }
    }
    running = false;
    batchProgress = null;
    batchRun.currentCaseId = null;
    batchRun.running = false;
    renderSelectedCase(null, lastRunByCase[activeCase] || null);
    renderCaseList();
    renderReports();
    showToast(`场景执行完成：${passCount}/${total} 通过`);
  }
  function clearReportFilters() {
    reportFilters.status = "all";
    reportFilters.env = "all";
    reportFilters.caseId = "all";
    reportFilters.trace = "";
    $("[data-report-status-filter]").value = "all";
    $("[data-report-trace-filter]").value = "";
    renderReports();
  }
  function bindEvents() {
    $$("[data-view-link]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.viewLink); }));
    $("[data-env-select]").addEventListener("change", (event) => { activeEnv = event.target.value; envCheckResult = null; syncEnvLabels(); renderEnvConfig(); restoreActiveCaseRun(); showToast(`已切换到${envs[activeEnv].name}`); });
    $("[data-save-env]").addEventListener("click", saveEnvFromForm);
    $("[data-reset-env]").addEventListener("click", resetCurrentEnv);
    $("[data-check-env]").addEventListener("click", runCurrentEnvCheck);
    $("[data-run-env-check]").addEventListener("click", runCurrentEnvCheck);
    $("[data-run-selected]").addEventListener("click", runSelectedCase);
    $("[data-run-scene]").addEventListener("click", runActiveSceneCases);
    $("[data-folder-select]").addEventListener("click", () => {
      const input = $("[data-folder-input]");
      input.value = "";
      input.click();
    });
    $("[data-folder-input]").addEventListener("change", (event) => selectFolderFiles(event.target.files));
    $("[data-folder-upload-start]").addEventListener("click", uploadSelectedFolder);
    $("[data-folder-upload-limit]").addEventListener("input", () => { folderUploadStats = null; renderFolderUpload(); });
    $("[data-folder-upload-delay]").addEventListener("input", () => { folderUploadStats = null; renderFolderUpload(); });
    $("[data-report-status-filter]").addEventListener("change", (event) => { reportFilters.status = event.target.value; renderReports(); });
    $("[data-report-env-filter]").addEventListener("change", (event) => { reportFilters.env = event.target.value; renderReports(); });
    $("[data-report-case-filter]").addEventListener("change", (event) => { reportFilters.caseId = event.target.value; renderReports(); });
    $("[data-report-trace-filter]").addEventListener("input", (event) => { reportFilters.trace = event.target.value.trim(); renderReports(); });
    $("[data-clear-report-filters]").addEventListener("click", clearReportFilters);
    $("[data-menu-button]").addEventListener("click", () => document.body.classList.toggle("menu-open"));
    $("[data-scrim]").addEventListener("click", () => document.body.classList.remove("menu-open"));
  }
  syncEnvLabels();
  renderCaseList();
  renderSelectedCase();
  renderEnvConfig();
  renderReports();
  bindEvents();
  Promise.all([loadServerState(), loadRuns()]).then(([loadedEnv]) => {
    if (loadedEnv) {
      syncEnvLabels();
      renderEnvConfig();
    }
    renderCaseList();
    restoreActiveCaseRun();
    renderReports();
  });
})();
