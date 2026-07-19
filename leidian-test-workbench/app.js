(function () {
  const envs = {
    local: {
      name: "本地环境",
      desc: "localhost 服务栈",
      base: { gatewayUrl: "http://localhost:8080", gatewayHealthPath: "/actuator/health", dataServiceUrl: "http://localhost:8082", dataServiceHealthPath: "/actuator/health", bizServiceUrl: "http://localhost:8083", bizServiceHealthPath: "/actuator/health", taskServiceUrl: "http://localhost:8084", taskServiceHealthPath: "/actuator/health" },
      capabilities: {
        kafka: { enabled: true, bootstrapServers: "localhost:9092", upstreamTopic: "radar-frame-upstream", standardTopic: "leidian.realtime.standard" },
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
      }
    });
  }

  function persistEnvs() {
    window.localStorage.setItem(ENV_STORAGE_KEY, JSON.stringify(envs));
    if (HAS_SERVER_API) {
      fetch("/api/environments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environments: envs, activeEnv }),
      }).catch(() => {
        showToast("已保存到浏览器，本地服务暂不可用");
      });
    }
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

  const cases = [
    {
      id: "minio-radar-frame-full-link",
      name: "MinIO 雷达帧上传全链路",
      category: "MinIO 链路",
      summary: "上传雷达帧 JSON，检查 MinIO 通知、Kafka、DB、标准消息、WebSocket 和查询 API。",
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
      id: "device-hex-full-link",
      name: "设备 HEX 解析入库查询链路",
      category: "设备链路",
      summary: "发送设备 HEX 到 device-raw-data，检查 raw、standard、monitor 表和 biz 查询接口。",
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
      id: "local-service-health",
      name: "服务连通性检查",
      category: "连通性",
      summary: "按当前环境检查 gateway、data-service、biz-service 是否可连通。",
      capabilities: ["http", "localService"],
      last: "未执行",
      steps: [
        ["读取当前环境", "加载基础服务 URL"],
        ["检查端口", "确认服务端口可访问"],
        ["检查基础接口", "请求健康检查或基础地址"],
        ["汇总服务状态", "输出服务连通性结果"],
      ],
    },
  ].filter((item) => item.id !== "local-service-health");

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
  const moduleFields = { kafka: ["bootstrapServers", "upstreamTopic", "standardTopic"], database: ["jdbcUrl", "username", "passwordRef"], minio: ["endpoint", "accessKey", "secretKeyRef", "bucket"], websocket: ["url"], deviceIngest: ["rawTopic", "standardTopic", "defaultMonitorType"], tunnel: ["publicUrl", "provider"] };
  const HAS_SERVER_API = window.location.protocol === "http:" || window.location.protocol === "https:";
  let activeEnv = window.localStorage.getItem(ACTIVE_ENV_STORAGE_KEY) || "local";
  if (!envs[activeEnv]) activeEnv = "local";
  let activeCase = cases[0].id;
  let running = false;
  let latestStepDetails = [];
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function updateClock() {
    $("[data-current-time]").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  }
  function setView(view) {
    $$("[data-view]").forEach((panel) => panel.classList.toggle("active", panel.dataset.view === view));
    $$("[data-view-link]").forEach((link) => link.classList.toggle("active", link.dataset.viewLink === view));
    $("[data-view-title]").textContent = ({ run: "执行中心", env: "环境配置", cases: "用例库", reports: "执行报告" })[view] || "执行中心";
    document.body.classList.remove("menu-open");
    if (view === "run") restoreActiveCaseRun();
    if (view === "reports") loadRuns().then(() => renderReports());
  }
  function syncEnvLabels() {
    persistActiveEnv();
    const env = envs[activeEnv];
    $("[data-active-env-label]").textContent = env.name;
    $("[data-active-env-name]").textContent = env.name;
    $("[data-env-select]").value = activeEnv;
    $$("[data-env-card]").forEach((card) => card.classList.toggle("active", card.dataset.envCard === activeEnv));
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
      $("[data-trace-id]").textContent = "未生成";
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
    $("[data-case-list]").innerHTML = cases.map((item, index) => {
      const lastRun = lastRunByCase[item.id];
      const pillClass = lastRun ? (lastRun.ok ? "pass" : "fail") : "ready";
      const lastLabel = lastRun ? (lastRun.ok ? "最近通过" : "最近失败") : item.last;
      return `
      <button class="case-card ${item.id === activeCase ? "active" : ""}" type="button" data-case-id="${item.id}">
        <div class="card-topline"><span class="case-index">${String(index + 1).padStart(2, "0")} / ${item.category}</span><span class="state-pill ${pillClass}">${lastLabel}</span></div>
        <h3>${item.name}</h3><p>${item.summary}</p>
        <div class="tag-row">${item.capabilities.map((cap) => `<span>${capabilityNames[cap] || cap}</span>`).join("")}</div>
      </button>`;
    }).join("");
    $$("[data-case-id]").forEach((button) => button.addEventListener("click", () => {
      activeCase = button.dataset.caseId;
      renderCaseList();
      restoreActiveCaseRun();
    }));
  }
  function renderSelectedCase(statuses, runResult) {
    const item = cases.find((entry) => entry.id === activeCase) || cases[0];
    const result = runResult || (statuses ? null : lastRunByCase[activeCase]);
    $("[data-selected-case-name]").textContent = item.name;
    $("[data-selected-capabilities]").innerHTML = item.capabilities.map((cap) => `<span>${capabilityNames[cap] || cap}</span>`).join("");

    if (result?.steps?.length && !statuses) {
      $("[data-step-list]").innerHTML = result.steps.map((raw, index) => {
        const step = localizeStep(raw);
        const status = raw.ok ? "pass" : "fail";
        return `<div class="step-item ${status}"><span class="step-no">${index + 1}</span><div class="step-copy"><strong>${step.name}</strong><span>${step.detail || ""}</span></div><span class="step-evidence">${raw.ok ? "已采集证据" : "需要排查"}</span></div>`;
      }).join("");
      return;
    }

    const sourceSteps = result?.steps?.length ? result.steps.map((step) => [step.name, step.detail || ""]) : item.steps;
    $("[data-step-list]").innerHTML = sourceSteps.map((step, index) => {
      const status = statuses && statuses[index] ? statuses[index] : "ready";
      const detail = latestStepDetails[index]?.detail;
      const evidence = detail || (status === "pass" ? "已采集证据" : status === "running" ? "执行中" : status === "fail" ? "需要排查" : "待执行");
      const title = Array.isArray(step) ? step[0] : step.name;
      const desc = Array.isArray(step) ? step[1] : (step.detail || "");
      return `<div class="step-item ${status}"><span class="step-no">${index + 1}</span><div class="step-copy"><strong>${title}</strong><span>${desc}</span></div><span class="step-evidence">${evidence}</span></div>`;
    }).join("");
  }
  function renderEnvConfig() {
    const env = envs[activeEnv];
    $("[data-base-fields]").innerHTML = Object.entries(env.base).map(([key, value]) => `<div class="field"><label>${baseFieldLabels[key] || key}</label><input data-base-key="${key}" value="${value}" /></div>`).join("");
    $("[data-module-list]").innerHTML = Object.entries(env.capabilities).map(([key, config]) => `
      <div class="module-card">
        <div class="module-head"><div><strong>${capabilityNames[key] || key}</strong><span>${key}</span></div><label class="toggle"><input type="checkbox" data-module-toggle="${key}" ${config.enabled ? "checked" : ""} />启用</label></div>
        <div class="module-fields">${(moduleFields[key] || Object.keys(config).filter((field) => field !== "enabled")).map((field) => `<div class="field"><label>${field}</label><input data-module-key="${key}" data-module-field="${field}" value="${config[field] || ""}" /></div>`).join("")}</div>
      </div>`).join("");
    renderEnvCheck();
  }
  function renderEnvCheck() {
    const statusNode = $("[data-env-check-status]");
    const listNode = $("[data-env-check-list]");
    if (!statusNode || !listNode) return;
    if (envCheckRunning) {
      statusNode.textContent = "正在检查当前环境";
      listNode.innerHTML = "";
      return;
    }
    if (!envCheckResult) {
      statusNode.textContent = "尚未检查当前环境";
      listNode.innerHTML = "";
      return;
    }
    statusNode.textContent = envCheckResult.ok ? "当前环境可用" : "当前环境存在不可达项";
    listNode.innerHTML = envCheckResult.results.map((item) => {
      const title = envCheckNames[item.key] || item.key;
      const detail = item.detail || (item.ok ? "connected" : "check failed");
      return `<div class="env-check-item ${item.ok ? "pass" : "fail"}"><strong>${title}</strong><span>${detail}</span></div>`;
    }).join("");
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
      envCheckResult = payload;
      renderEnvCheck();
      showToast(payload.ok ? "当前环境检查通过" : "当前环境检查有失败项");
    } catch (_error) {
      envCheckResult = { ok: false, results: [{ key: "env", ok: false, detail: "环境检查接口不可用" }] };
      renderEnvCheck();
      showToast("环境检查接口不可用");
    } finally {
      envCheckRunning = false;
      renderEnvCheck();
    }
  }
  function renderLibrary() {
    $("[data-library-grid]").innerHTML = cases.map((item) => `
      <article class="activity-card"><div class="card-topline"><span class="case-index">${item.category}</span><span class="state-pill ready">${item.steps.length} 步</span></div>
      <h3>${item.name}</h3><p>${item.summary}</p><div class="tag-row">${item.capabilities.map((cap) => `<span>${capabilityNames[cap] || cap}</span>`).join("")}</div>
      <div class="case-meta"><div class="meta-row"><span>配置方式</span><strong>页面维护</strong></div><div class="meta-row"><span>执行模式</span><strong>顺序执行 / 单步重试</strong></div></div></article>`).join("");
  }
  function renderReports() {
    const statusLabel = { pass: "通过", warn: "部分通过", fail: "失败" };
    const countNode = $("[data-report-count]");
    if (!reports.length) {
      countNode.textContent = "暂无记录";
      $("[data-report-list]").innerHTML = `<div class="report-empty">还没有执行记录。先到执行中心跑一次用例，报告会出现在这里。</div>`;
      return;
    }
    countNode.textContent = `最近 ${reports.length} 次`;
    $("[data-report-list]").innerHTML = reports.map((item) => {
      const open = selectedReportTrace === item.trace;
      const stepsHtml = (item.steps || []).map((raw, index) => {
        const step = localizeStep(raw);
        return `
        <div class="report-step ${raw.ok ? "pass" : "fail"}">
          <i class="dot"></i>
          <div><strong>${index + 1}. ${step.name}</strong><span>${step.detail || (raw.ok ? "OK" : "失败")}</span></div>
        </div>`;
      }).join("");
      return `
      <article class="report-card ${open ? "open" : ""}" data-report-trace="${item.trace}">
        <div class="report-card-head">
          <div>
            <h3>${item.name}</h3>
            <p>${item.env} · ${item.time} · ${item.trace}</p>
            <div class="report-evidence">${item.evidence.map((evidence) => `<span>${evidence}</span>`).join("")}</div>
          </div>
          <span class="state-pill ${item.status}">${statusLabel[item.status] || item.status}</span>
        </div>
        <div class="report-detail">${stepsHtml || "<span class=\"muted-label\">无步骤明细</span>"}</div>
      </article>`;
    }).join("");
    $$("[data-report-trace]").forEach((card) => card.addEventListener("click", () => {
      const trace = card.dataset.reportTrace;
      selectedReportTrace = selectedReportTrace === trace ? null : trace;
      renderReports();
      const run = reports.find((item) => item.trace === trace);
      if (run?.caseId && selectedReportTrace === trace) {
        activeCase = run.caseId;
        if (lastRunByCase[run.caseId] || run.raw) {
          lastRunByCase[run.caseId] = run.raw || lastRunByCase[run.caseId];
        }
      }
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
    showToast("当前环境配置已保存，刷新页面不会丢");
  }
  function resetCurrentEnv() {
    envs[activeEnv] = JSON.parse(JSON.stringify(defaultEnvs[activeEnv]));
    persistEnvs();
    renderEnvConfig();
    envCheckResult = null;
    renderEnvCheck();
    showToast("已恢复当前环境的默认配置");
  }

  function showToast(message) {
    const toast = $("[data-toast]");
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 1800);
  }
  async function runSelectedCase() {
    if (running) return;
    running = true;
    const item = cases.find((entry) => entry.id === activeCase) || cases[0];
    const statuses = item.steps.map(() => "ready");
    latestStepDetails = [];
    const trace = `trace-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
    $("[data-trace-id]").textContent = trace;
    $("[data-run-state]").className = "state-pill warn";
    $("[data-run-state]").textContent = "执行中";
    renderSelectedCase(statuses);

    if (HAS_SERVER_API) {
      try {
        const response = await fetch("/api/run-case", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ env: envs[activeEnv], case: item }),
        });
        const result = await response.json();
        rememberRun(result);
        applyRunToPanel(result);
        reports.unshift(toReportItem(result));
        selectedReportTrace = result.traceId || null;
        renderCaseList();
        renderReports();
        showToast(result.ok ? "用例执行完成" : "用例执行失败，请看报告");
        running = false;
        return;
      } catch (_error) {
        showToast("本地服务不可用，使用页面模拟执行");
      }
    }

    let index = 0;
    const timer = window.setInterval(() => {
      if (index > 0) statuses[index - 1] = "pass";
      if (index < statuses.length) {
        statuses[index] = "running";
        renderSelectedCase(statuses);
        index += 1;
        return;
      }
      window.clearInterval(timer);
      statuses[statuses.length - 1] = "pass";
      const mockResult = {
        ok: true,
        caseId: item.id,
        caseName: item.name,
        envName: envs[activeEnv].name,
        startedAt: new Date().toISOString(),
        traceId: trace,
        steps: item.steps.map(([name, detail]) => ({ name, ok: true, detail })),
      };
      rememberRun(mockResult);
      applyRunToPanel(mockResult);
      reports.unshift(toReportItem(mockResult));
      selectedReportTrace = trace;
      renderCaseList();
      renderReports();
      running = false;
    }, 550);
  }
  function bindEvents() {
    $$("[data-view-link]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); setView(link.dataset.viewLink); }));
    $("[data-env-select]").addEventListener("change", (event) => { activeEnv = event.target.value; envCheckResult = null; syncEnvLabels(); renderEnvConfig(); showToast(`已切换到${envs[activeEnv].name}`); });
    $$("[data-env-card]").forEach((card) => card.addEventListener("click", () => { activeEnv = card.dataset.envCard; envCheckResult = null; syncEnvLabels(); renderEnvConfig(); }));
    $("[data-save-env]").addEventListener("click", saveEnvFromForm);
    $("[data-reset-env]").addEventListener("click", resetCurrentEnv);
    $("[data-check-env]").addEventListener("click", runCurrentEnvCheck);
    $("[data-run-selected]").addEventListener("click", runSelectedCase);
    $("[data-menu-button]").addEventListener("click", () => document.body.classList.toggle("menu-open"));
    $("[data-scrim]").addEventListener("click", () => document.body.classList.remove("menu-open"));
  }
  updateClock();
  window.setInterval(updateClock, 30000);
  syncEnvLabels();
  renderCaseList();
  renderSelectedCase();
  renderEnvConfig();
  renderLibrary();
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
