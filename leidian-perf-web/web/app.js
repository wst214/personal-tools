const ENV_KEYS = [
  ["testTime", "测试时间"],
  ["tester", "测试人员"],
  ["pgVersion", "数据库版本"],
  ["postgisVersion", "PostGIS 版本"],
  ["cpu", "CPU"],
  ["memory", "内存"],
  ["disk", "硬盘"],
  ["os", "操作系统"],
  ["dbDeploy", "数据库部署方式"],
  ["appDeploy", "应用服务部署方式"],
  ["loadTester", "压测机配置"],
  ["network", "网络环境"],
  ["isProduction", "是否正式环境"],
];

const ENV_EDITABLE = new Set([
  "tester",
  "cpu",
  "memory",
  "disk",
  "os",
  "dbDeploy",
  "appDeploy",
  "loadTester",
  "network",
  "isProduction",
]);

const PREFLIGHT_STORAGE_KEY_PREFIX = "perf_web_preflight_v1";

const PREFLIGHT_LABELS = {
  "preflight:db_connect": "数据库连接",
  "preflight:postgis": "PostGIS 扩展",
  "preflight:schema": "perf Schema",
  "preflight:sql_00_init_schema": "DDL · 00 初始化",
  "preflight:sql_01_planning_tables": "DDL · 01 规划表",
  "preflight:sql_02_device_tables": "DDL · 02 设备表",
  "preflight:sql_03_partitioned_tables": "DDL · 03 分区表",
  "preflight:sql_04_functions_triggers": "DDL · 04 函数触发器",
  "preflight:sql_05_default_partitions": "DDL · 05 月分区",
  "preflight:mine_site_gist": "mine_site 空间索引",
};

const CHECK_LABELS = {
  "row_count:mine_site": "行数 · mine_site",
  "row_count:thunderstorm_process": "行数 · 雷暴过程",
  "row_count:standard_atmosphere_electric_field": "行数 · 大气电场 standard",
  "row_count:biz_atmosphere_electric_field_event": "行数 · 大气电场 biz",
  "row_count:raw_kafka_message": "行数 · raw",
  "row_count:standard_lightning_strike_cmb": "行数 · CMB",
  "row_count:standard_lightning_strike_locator": "行数 · Locator",
  "row_count:biz_lightning_event": "行数 · 雷击 biz",
  "row_count:thunderstorm_warning_event": "行数 · 预警事件",
  "row_count:thunderstorm_warning_message": "行数 · 预警信息",
  "row_count:device_alarm_event": "行数 · 设备告警",
  "row_count:thunderstorm_notice_event": "行数 · 工况联动",
  "row_count:inspection_task": "行数 · 巡检",
  "row_count:hidden_risk": "行数 · 隐患",
  "row_count:repair_order": "行数 · 维修工单",
};

const RAW_BREAKDOWN_LABELS = {
  raw_atmosphere: "大气电场报文",
  raw_lightning: "雷击报文",
  raw_lowfreq: "低频设备报文",
  raw_radar: "雷达报文",
  raw_padding: "填充报文",
  raw_abnormal: "异常报文",
  raw_total: "raw 合计",
};

const ENV_STORAGE_KEY_PREFIX = "perf_web_env_v2";

// 与 volume_matrix.stage_total_target_rows 一致；/api/stages 未带 totalRows 时兜底
const STAGE_TOTAL_ROWS_FALLBACK = {
  S0: 38193,
  S1: 6018746,
  S2: 27069020,
  S3: 51173350,
  S4: 116930925,
};

let pollTimer = null;
let statusPollTimer = null;
let systemBusy = false;
let loadInProgress = false;
let catalogStages = [];
let lastReport = null;
let lastPreflight = null;
let preflightTimer = null;
let envDraft = loadEnvDraft();
let stageRecords = null;
let volumeViewStage = "S0";
let perfViewStage = "S0";
let volumeMatrixCache = {};
let allStagesMatrix = null;
let benchConfig = null;
let activePage = "prep";
const PERF_PAGE_SIZE = 8;
let perfHistoryAllRows = [];
let perfHistoryPage = 1;
let resourceHistoryAllRows = [];
let resourceHistoryPage = 1;
let prometheusUrl = "http://host.docker.internal:9090";
let prometheusInstance = "192.168.1.41:9100";
let deleteEnabled = false;

const $ = (id) => document.getElementById(id);

const els = {
  dialect: $("dialect"),
  dialectSwitches: document.querySelectorAll("[data-dialect-switch]"),
  host: $("host"),
  port: $("port"),
  database: $("database"),
  user: $("user"),
  password: $("password"),
  schema: $("schema"),
  stage: $("stage"),
  t0: $("t0"),
  seed: $("seed"),
  truncate: $("truncate"),
  autoValidate: $("autoValidate"),
  btnPreflight: $("btnPreflight"),
  btnInit: $("btnInit"),
  btnLoad: $("btnLoad"),
  btnValidate: $("btnValidate"),
  logOutput: $("logOutput"),
  prepHint: $("prepHint"),
  loadHint: $("loadHint"),
  jobBadge: $("jobBadge"),
  stageBadge: $("stageBadge"),
  preflightList: $("preflightList"),
  dbSnapshot: $("dbSnapshot"),
  stageOverviewBody: $("stageOverviewBody"),
  envTableBody: $("envTableBody"),
  volumeTableBody: $("volumeTableBody"),
  validationTableBody: $("validationTableBody"),
  rawCheckList: $("rawCheckList"),
  perfTableBody: $("perfTableBody"),
  perfPager: $("perfPager"),
  perfPagerPrev: $("perfPagerPrev"),
  perfPagerNext: $("perfPagerNext"),
  perfPagerInfo: $("perfPagerInfo"),
  perfSelectAllPage: $("perfSelectAllPage"),
  btnDeletePerfRuns: $("btnDeletePerfRuns"),
  btnDeleteAllPerfRuns: $("btnDeleteAllPerfRuns"),
  resourceTableBody: $("resourceTableBody"),
  resourcePager: $("resourcePager"),
  resourcePagerPrev: $("resourcePagerPrev"),
  resourcePagerNext: $("resourcePagerNext"),
  resourcePagerInfo: $("resourcePagerInfo"),
  resourceSelectAllPage: $("resourceSelectAllPage"),
  btnDeleteResourceCollects: $("btnDeleteResourceCollects"),
  btnDeleteAllResourceCollects: $("btnDeleteAllResourceCollects"),
  btnCollectResources: $("btnCollectResources"),
  btnRefreshSlowSql: $("btnRefreshSlowSql"),
  resourceBadge: $("resourceBadge"),
  slowSqlTableBody: $("slowSqlTableBody"),
  conclusionTableBody: $("conclusionTableBody"),
  preflightBadge: $("preflightBadge"),
  loadBadge: $("loadBadge"),
  volumeBadge: $("volumeBadge"),
  validationBadge: $("validationBadge"),
  prepTabStatus: $("prepTabStatus"),
  loadTabStatus: $("loadTabStatus"),
  resultTabStatus: $("resultTabStatus"),
  perfTabStatus: $("perfTabStatus"),
  perfBadge: $("perfBadge"),
  benchWriteIterations: $("benchWriteIterations"),
  benchQueryIterations: $("benchQueryIterations"),
  benchQueryConcurrency: $("benchQueryConcurrency"),
  benchSlowSqlMs: $("benchSlowSqlMs"),
  benchPerf05AggMinutes: $("benchPerf05AggMinutes"),
  perfStageTabs: $("perfStageTabs"),
  perfStageMeta: $("perfStageMeta"),
  benchScenarioList: $("benchScenarioList"),
  btnBenchAll: $("btnBenchAll"),
  btnBenchSelected: $("btnBenchSelected"),
  benchHint: $("benchHint"),
  benchLog: $("benchLog"),
  toolsDesc: $("toolsDesc"),
  toolsTopoDb: $("toolsTopoDb"),
  toolsTableBody: $("toolsTableBody"),
  toolsConfigSummary: $("toolsConfigSummary"),
  toolsConfigSnippet: $("toolsConfigSnippet"),
  toolsHint: $("toolsHint"),
  volumeStageTabs: $("volumeStageTabs"),
  volumeStageMeta: $("volumeStageMeta"),
  rawBreakdownBody: $("rawBreakdownBody"),
  pageTabs: document.querySelectorAll(".page-tab"),
  pagePanels: document.querySelectorAll(".page-panel"),
};

function switchPage(pageId) {
  activePage = pageId;
  els.pageTabs.forEach((btn) => {
    const on = btn.dataset.page === pageId;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  els.pagePanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `page-${pageId}`);
  });
  if (pageId === "result") {
    renderResultPageForStage(volumeViewStage || els.stage.value);
  }
}

function setTabPill(el, kind, text) {
  if (!el) return;
  el.className = `tab-pill ${kind}`;
  el.textContent = text;
}

function loadEnvDraft() {
  try {
    return JSON.parse(localStorage.getItem(envStorageKey()) || "{}");
  } catch {
    return {};
  }
}

function saveEnvDraft() {
  localStorage.setItem(envStorageKey(), JSON.stringify(envDraft));
}

function activeDialect() {
  return els?.dialect?.value || "postgres";
}

function envStorageKey() {
  return `${ENV_STORAGE_KEY_PREFIX}_${activeDialect()}`;
}

function preflightStorageKey() {
  return `${PREFLIGHT_STORAGE_KEY_PREFIX}_${activeDialect()}`;
}

function envFieldSpecs() {
  if (activeDialect() === "dameng") {
    return [
      ["testTime", "测试时间"],
      ["tester", "测试人员"],
      ["dmVersion", "数据库版本"],
      ["geoVersion", "GEO 空间模块版本"],
      ["cpu", "CPU"],
      ["memory", "内存"],
      ["disk", "硬盘"],
      ["os", "操作系统"],
      ["dbDeploy", "数据库部署方式"],
      ["appDeploy", "应用服务部署方式"],
      ["loadTester", "压测机配置"],
      ["network", "网络环境"],
      ["isProduction", "是否正式环境"],
    ];
  }
  return ENV_KEYS;
}

function currentConnFingerprint() {
  return {
    dialect: activeDialect(),
    host: els.host?.value?.trim() || "",
    port: els.port?.value?.trim() || "",
    database: els.database?.value?.trim() || "",
    user: els.user?.value?.trim() || "",
    schema: (els.schema?.value?.trim() || "perf").toLowerCase(),
  };
}

function sameConnFingerprint(a, b) {
  if (!a || !b) return false;
  return (
    a.dialect === b.dialect &&
    a.host === b.host &&
    a.port === b.port &&
    a.database === b.database &&
    a.user === b.user &&
    a.schema === b.schema
  );
}

function savePreflightSnapshot(report) {
  if (!report?.preflight) return;
  const snapshot = {
    conn: currentConnFingerprint(),
    stage: report.stage || els.stage.value,
    preflight: report.preflight,
    section11_1: report.section11_1 || {},
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(preflightStorageKey(), JSON.stringify(snapshot));
}

function loadPreflightSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(preflightStorageKey()) || "null");
  } catch {
    return null;
  }
}

function clearPreflightSnapshot() {
  localStorage.removeItem(preflightStorageKey());
}

function restorePreflightSnapshot() {
  const snapshot = loadPreflightSnapshot();
  if (!snapshot?.preflight || !sameConnFingerprint(snapshot.conn, currentConnFingerprint())) {
    return false;
  }
  lastPreflight = snapshot.preflight;
  renderCheckList(els.preflightList, snapshot.preflight?.prerequisites, "点击「检查前置条件」");
  renderDbSnapshot(snapshot.preflight);
  renderEnvTable(snapshot.section11_1 || stageRecord(els.stage.value).section11_1 || {});
  updatePageStatus({ preflight: snapshot.preflight, workflow: {} });
  refreshInitButton();
  return true;
}

function syncDialectSwitchUI() {
  const current = activeDialect();
  els.dialectSwitches?.forEach((btn) => {
    const isOn = btn.dataset.dialectSwitch === current;
    btn.classList.toggle("primary", isOn);
    btn.classList.toggle("secondary", !isOn);
    btn.setAttribute("aria-pressed", isOn ? "true" : "false");
  });
}

const TOOLS_COPY = {
  postgres: {
    desc:
      "全场景仅压数据库 SQL，不经 Gateway/API，不涉及 Kafka/应用解析。dbserver 尽量只跑 PostgreSQL、PostGIS 与 node_exporter；Prometheus/Grafana 与压测操作台可放本机。",
    topoDb: "PostgreSQL + PostGIS · node_exporter :9100 · pg_stat_statements 等 PG 配置",
    rows: [
      ["PostgreSQL 16 + PostGIS", "ok", "db", "被测库 <code>leidian_perf</code>", "前置检查可验证扩展与 DDL"],
      ["node_exporter", "ok", "db", "CPU/内存/磁盘/IO 监控", "监听 <code>:9100</code>；须在被测服务器，不能仅装本机"],
      ["pg_stat_statements", "ok", "db", "Top SQL、慢查询统计", "<code>shared_preload_libraries</code> + 重启 + <code>CREATE EXTENSION</code>"],
      ["perf-web 操作台", "ok", "local", "造数、校验、SQL 压测", "<code>docker compose up</code>，默认 <code>:8100</code>"],
      ["Prometheus", "ok", "local", "抓取 node_exporter 时序", "scrape <code>dbserver:9100</code>；压测前确认 scrape 正常"],
      ["Grafana", "warn", "local", "按压测时间窗口看图", "接 Prometheus；非必须但填报告更方便"],
      ["auto_explain / 慢 SQL 日志", "warn", "db", "慢 SQL 执行计划佐证", "与 pg_stat_statements 一并写入 <code>postgresql.conf</code>"],
      ["psql / Navicat 等客户端", "warn", "local", "EXPLAIN、查 pg_stat_*", "压测后手工执行 EXPLAIN 与 pg_stat_statements 分析"],
    ],
    configSummary: "dbserver：PostgreSQL 监控配置片段",
    configSnippet: `# postgresql.conf（修改后重启 PostgreSQL）
shared_preload_libraries = 'pg_stat_statements,auto_explain'
pg_stat_statements.track = all
track_io_timing = on
log_min_duration_statement = 500ms
auto_explain.log_min_duration = 500ms
auto_explain.log_analyze = on

# 重启后执行
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`,
    hint:
      "一轮压测分工：本机操作台造数/校验 → 确认 Prometheus 抓取 dbserver → SQL 压测 → 点「采集资源与执行计划」汇总 CPU/慢SQL/EXPLAIN → 必要时 Grafana 看图、慢 SQL 表补人工结论。",
  },
  dameng: {
    desc:
      "全场景仅压数据库 SQL，不经 Gateway/API，不涉及 Kafka/应用解析。dbserver 尽量只跑达梦 DM8 与 node_exporter；Prometheus/Grafana 与压测操作台可放本机。",
    topoDb: "达梦 DM8 · node_exporter :9100 · DM 监控视图/日志配置",
    rows: [
      ["达梦 DM8", "ok", "db", "被测库 <code>LEIDIAN_PERF</code>", "前置检查可验证实例连通与基础 DDL"],
      ["node_exporter", "ok", "db", "CPU/内存/磁盘/IO 监控", "监听 <code>:9100</code>；须在被测服务器，不能仅装本机"],
      ["DM 监控视图 / SQL 日志", "ok", "db", "Top SQL、慢查询统计", "按 DM8 实例参数开启；替代 pg_stat_statements"],
      ["perf-web 操作台", "ok", "local", "造数、校验、SQL 压测", "<code>docker compose up</code>，默认 <code>:8100</code>"],
      ["Prometheus", "ok", "local", "抓取 node_exporter 时序", "scrape <code>dbserver:9100</code>；压测前确认 scrape 正常"],
      ["Grafana", "warn", "local", "按压测时间窗口看图", "接 Prometheus；非必须但填报告更方便"],
      ["执行计划 / 慢 SQL 日志", "warn", "db", "库内慢 SQL 与执行计划佐证", "压测后查 V$SQL_HISTORY / 必要时 SVR_LOG + EXPLAIN"],
      ["disql / Navicat 等客户端", "warn", "local", "EXPLAIN、查系统视图", "压测后手工分析 SQL 计划与热点语句"],
    ],
    configSummary: "dbserver：达梦 DM8 监控配置建议",
    configSnippet: `# 达梦 DM8：按实例启用慢 SQL 与监控视图（示例）
# 1) 确保实例正常运行，记录版本与参数
# 2) 启用慢 SQL 日志（阈值按压测场景设置）
# 3) 确保 ENABLE_MONITOR=1；库内慢SQL按场景时间窗读 V$SQL_HISTORY（TIME_USED 为微秒）
# 4) 结合 node_exporter 与 Prometheus 对齐压测时间窗`,
    hint:
      "一轮压测分工：本机操作台造数/校验 → 确认 Prometheus 抓取 dbserver → SQL 压测 → 点「采集资源与执行计划」汇总 CPU 与慢SQL线索 → 必要时 Grafana 看图、再用 DM 客户端补执行计划结论。",
  },
};

function renderToolsByDialect() {
  const dialect = activeDialect();
  syncPerfTableDamengColumns();
  const copy = TOOLS_COPY[dialect] || TOOLS_COPY.postgres;
  if (els.toolsDesc) els.toolsDesc.textContent = copy.desc;
  if (els.toolsTopoDb) els.toolsTopoDb.textContent = copy.topoDb;
  if (els.toolsConfigSummary) els.toolsConfigSummary.textContent = copy.configSummary;
  if (els.toolsConfigSnippet) els.toolsConfigSnippet.textContent = copy.configSnippet;
  if (els.toolsHint) els.toolsHint.textContent = copy.hint;
  if (els.toolsTableBody) {
    const html = copy.rows
      .map(([tool, level, loc, purpose, note]) => {
        const pillClass = level === "ok" ? "ok" : "warn";
        const pillText = level === "ok" ? "必需" : "建议";
        const locClass = loc === "db" ? "loc-db" : "loc-local";
        const locText = loc === "db" ? "dbserver" : "本机 Docker";
        return `<tr>
          <td>${tool}</td>
          <td><span class="pill ${pillClass}">${pillText}</span></td>
          <td><span class="loc-pill ${locClass}">${locText}</span></td>
          <td>${purpose}</td>
          <td>${note}</td>
        </tr>`;
      })
      .join("");
    els.toolsTableBody.innerHTML = html;
  }
}

async function persistEnvToServer() {
  if (!stageRecords) return;
  try {
    const res = await fetch(`/api/records/${els.stage.value}/env`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...envDraft, dialect: activeDialect() }),
    });
    if (res.ok) stageRecords = await res.json();
  } catch {
    /* 离线时仅 localStorage */
  }
}

async function loadRecords(options = {}) {
  const silent = options.silent === true;
  const dialect = activeDialect();
  const prevUpdatedAt = silent
    ? stageRecords?.dialects?.[dialect]?.stages?.[perfViewStage]?.updatedAt
    : null;
  try {
    const res = await fetch("/api/records");
    const next = await res.json();
    const nextUpdatedAt = next?.dialects?.[dialect]?.stages?.[perfViewStage]?.updatedAt;
    const changed = !silent || nextUpdatedAt !== prevUpdatedAt;
    stageRecords = next;
    if (!changed) return;
  } catch {
    if (!silent) stageRecords = { stages: {} };
    return;
  }
  updateVolumeStageTabs();
  updatePerfStageTabs();
  if (activePage === "perf") {
    renderPerfPageForStage(perfViewStage, { resetPage: !silent });
  } else if (activePage === "result") {
    renderResultPageForStage(volumeViewStage);
  }
}

async function fetchVolumeMatrix(stage) {
  if (volumeMatrixCache[stage]) return volumeMatrixCache[stage];
  const res = await fetch(`/api/volume-matrix?stage=${encodeURIComponent(stage)}`);
  const data = await res.json();
  if (res.ok) volumeMatrixCache[stage] = data;
  return data;
}

async function loadAllStagesMatrix() {
  if (allStagesMatrix) return allStagesMatrix;
  const res = await fetch("/api/volume-matrix");
  const data = await res.json();
  if (res.ok) allStagesMatrix = data.stages || {};
  return allStagesMatrix;
}

function mergeVolumeRows(targetRows, savedRows) {
  if (!savedRows?.some((r) => r.actual != null)) return targetRows;
  const byKey = new Map(savedRows.map((r) => [r.objectKey, r]));
  return targetRows.map((t) => {
    const s = byKey.get(t.objectKey);
    if (s?.actual == null) return t;
    const actual = s.actual;
    const passed = actual >= t.target;
    let note = "";
    if (actual < t.target) note = `不足 ${t.target - actual}`;
    else if (actual > t.target) note = `超出 +${actual - t.target}`;
    return {
      ...t,
      actual,
      passed,
      note,
    };
  });
}

function stageRecord(stage) {
  return stageRecords?.dialects?.[activeDialect()]?.stages?.[stage] || {};
}

function refreshWorkflowStatusForCurrentDialect(stage) {
  const saved = stageRecord(stage);
  const hasVolume = (saved.section11_2 || []).some((r) => r.actual != null);
  const hasValidation = (saved.section11_3 || []).some((g) => g.passed != null);
  const volumeOk = hasVolume && (saved.section11_2 || []).every((r) => r.passed !== false);
  const validationOk = hasValidation && (saved.section11_3 || []).every((g) => g.passed !== false);

  setTabPill(els.prepTabStatus, "idle", "未检查");
  setBadge(els.preflightBadge, "idle", "未检查");
  updatePrepHint(null);
  updateLoadHint(null);

  if (!hasVolume && !hasValidation) {
    setTabPill(els.loadTabStatus, "idle", "待执行");
    setBadge(els.loadBadge, "idle", "待执行");
  } else {
    const loadOk = volumeOk && validationOk;
    setTabPill(els.loadTabStatus, loadOk ? "ok" : "warn", loadOk ? "达标" : "已造数");
    setBadge(els.loadBadge, loadOk ? "ok" : "warn", loadOk ? "完成" : "已执行");
  }
  updateResultTabStatusFromSaved(stage);
}

function dialectHasAnySavedData(dialect) {
  const stages = stageRecords?.dialects?.[dialect]?.stages || {};
  return ["S0", "S1", "S2", "S3", "S4"].some((s) => {
    const e = stages[s] || {};
    return (
      (e.section11_2 || []).length > 0 ||
      (e.section11_3 || []).length > 0 ||
      (e.benchmarkHistory || []).length > 0 ||
      (e.resourceHistory || []).length > 0
    );
  });
}

function updateVolumeStageTabs() {
  if (!els.volumeStageTabs) return;
  els.volumeStageTabs.querySelectorAll(".stage-tab").forEach((btn) => {
    const code = btn.dataset.stage;
    const saved = stageRecord(code);
    const hasData =
      saved.section11_2?.some((r) => r.actual != null) ||
      saved.section11_3?.some((g) => g.passed != null);
    btn.classList.toggle("active", code === volumeViewStage);
    btn.classList.toggle("has-data", Boolean(hasData));
  });
}

function stageTotalRowsLabel(code, row) {
  if (row?.totalRowsLabel) return row.totalRowsLabel;
  const cat = catalogStages.find((c) => c.code === code);
  if (cat?.totalRowsLabel) return cat.totalRowsLabel;
  if (row?.totalRows != null) return fmtStageTotalRows(row.totalRows);
  if (cat?.totalRows != null) return fmtStageTotalRows(cat.totalRows);
  if (STAGE_TOTAL_ROWS_FALLBACK[code] != null) {
    return fmtStageTotalRows(STAGE_TOTAL_ROWS_FALLBACK[code]);
  }
  return "";
}

function fmtStageTotalRows(total) {
  const n = Number(total);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 100_000_000) {
    const yi = n / 100_000_000;
    const text = yi >= 10 ? String(Math.round(yi)) : yi.toFixed(2).replace(/\.?0+$/, "");
    return `约${text}亿条`;
  }
  if (n >= 10_000) {
    const wan = n / 10_000;
    const text = wan >= 1000 ? String(Math.round(wan)) : wan.toFixed(1).replace(/\.0$/, "");
    return `约${text}万条`;
  }
  return `约${n.toLocaleString("zh-CN")}条`;
}

function formatStageCell(code, row) {
  const label = stageTotalRowsLabel(code, row);
  return label ? `${code}（${label}）` : code;
}

function buildMergedStageConclusions() {
  return catalogStages.map((cat) => {
    const saved = stageRecord(cat.code);
    const row =
      saved.stageConclusion ||
      (saved.section11_7 || []).find((r) => r.stage === cat.code);
    if (row) {
      return {
        ...row,
        stage: cat.code,
        totalRows: row.totalRows ?? cat.totalRows,
        totalRowsLabel: row.totalRowsLabel ?? cat.totalRowsLabel,
      };
    }
    return {
      stage: cat.code,
      label: cat.label,
      scale: cat.summary || "—",
      totalRows: cat.totalRows,
      totalRowsLabel: cat.totalRowsLabel,
      conclusion: "—",
      issues: "—",
      proceed: "—",
    };
  });
}

function renderConclusionsFromRecords(highlightStage) {
  renderConclusions(buildMergedStageConclusions(), highlightStage);
}

function updateResultTabStatusFromSaved(stage) {
  const saved = stageRecord(stage);
  const hasVolume = saved.section11_2?.some((r) => r.actual != null);
  const hasValidation = saved.section11_3?.some((g) => g.passed != null);
  const volumeOk = hasVolume && (saved.section11_2 || []).every((r) => r.passed !== false);
  const validationOk =
    hasValidation && (saved.section11_3 || []).every((g) => g.passed !== false);
  const recordReady = volumeOk && validationOk;
  const partial = hasVolume || hasValidation;
  setTabPill(
    els.resultTabStatus,
    recordReady ? "ok" : partial ? "warn" : "idle",
    recordReady ? "已核对" : partial ? "待校验" : "—"
  );
}

async function renderResultPageForStage(stage) {
  volumeViewStage = stage;
  updateVolumeStageTabs();
  const saved = stageRecord(stage);
  const matrix = await fetchVolumeMatrix(stage);
  const targetRows = matrix.rows || [];
  const rows = mergeVolumeRows(targetRows, saved.section11_2);
  const breakdown = saved.rawBreakdown || matrix.rawBreakdown;

  const cat = catalogStages.find((c) => c.code === stage);
  const hasRecord = saved.section11_2?.some((r) => r.actual != null);
  const hasValidation = saved.section11_3?.some((g) => g.passed != null);
  const updated = saved.updatedAt ? ` · 记录于 ${saved.updatedAt}` : "";
  if (els.volumeStageMeta) {
    const hints = [];
    if (hasRecord) hints.push("造数已记录");
    if (hasValidation) hints.push("校验已记录");
    const recordHint = hints.length
      ? hints.join(" · ")
      : "仅显示目标行数，造数校验后写入实际值";
    els.volumeStageMeta.textContent = `${stage} ${cat?.label || ""} — ${recordHint}${updated}`;
  }
  renderVolumeRows(rows);
  renderRawBreakdown(breakdown);
  if (saved.section11_3?.length) {
    renderValidationGroups(saved.section11_3);
    renderCheckList(els.rawCheckList, saved.rawChecks || [], "无明细");
  } else {
    renderValidationGroups([]);
    renderCheckList(els.rawCheckList, [], "无明细");
  }
  renderConclusionsFromRecords(stage);
  updateResultTabStatusFromSaved(stage);
  renderStageOverview();
}

function updatePerfStageTabs() {
  if (!els.perfStageTabs) return;
  els.perfStageTabs.querySelectorAll(".stage-tab").forEach((btn) => {
    const code = btn.dataset.stage;
    const saved = stageRecord(code);
    const hasData = (saved.benchmarkHistory || []).length > 0;
    btn.classList.toggle("active", code === perfViewStage);
    btn.classList.toggle("has-data", hasData);
  });
}

function renderPerfPageForStage(stage, options = {}) {
  perfViewStage = stage;
  updatePerfStageTabs();
  const saved = stageRecord(stage);
  const cat = catalogStages.find((c) => c.code === stage);
  const benchRows = flattenBenchmarkHistory(saved.benchmarkHistory);
  const resourceRows = flattenResourceHistory(saved.resourceHistory);
  const runCount = (saved.benchmarkHistory || []).length;
  const rowCount = benchRows.length;
  if (els.perfStageMeta) {
    const label = cat?.label || "";
    els.perfStageMeta.textContent = runCount
      ? `${stage} ${label} — 已 ${runCount} 轮压测 · 本档共 ${rowCount} 条场景记录`
      : `${stage} ${label} — 本档位尚无压测记录`;
  }
  renderPerfResults(benchRows, { resetPage: options.resetPage !== false });
  renderPerfStatusForStage(stage, benchRows);
  renderResourceResults(resourceRows, { resetPage: options.resetPage !== false });
  renderSlowSqlSection(stage, saved);
  if (activeDialect() === "dameng") {
    ensureSlowSqlDetails(stage).then(() => {
      renderSlowSqlSection(stage, stageRecord(stage));
    });
  }
}

function renderRawBreakdown(breakdown) {
  if (!els.rawBreakdownBody) return;
  const keys = Object.keys(RAW_BREAKDOWN_LABELS);
  if (!breakdown || !keys.some((k) => breakdown[k] != null)) {
    els.rawBreakdownBody.innerHTML = '<tr><td colspan="2" class="placeholder">暂无</td></tr>';
    return;
  }
  els.rawBreakdownBody.innerHTML = keys
    .map(
      (k) => `
    <tr class="${k === "raw_total" ? "row-current" : ""}">
      <td>${escapeHtml(RAW_BREAKDOWN_LABELS[k])}</td>
      <td>${fmtNum(breakdown[k])}</td>
    </tr>`
    )
    .join("");
}

async function renderVolumeForStage(stage) {
  await renderResultPageForStage(stage);
}

function renderStageOverview() {
  if (!els.stageOverviewBody) return;
  const rows = catalogStages.map((cat) => {
    const code = cat.code;
    const saved = stageRecord(code);
    const volumeRows = saved.section11_2 || [];
    const targetCount = volumeRows.length || allStagesMatrix?.[code]?.length || 0;
    const hasActual = volumeRows.some((r) => r.actual != null);
    const decided = volumeRows.filter((r) => r.passed != null);
    const passCount = decided.filter((r) => r.passed).length;

    let status;
    let pill = "idle";
    if (!hasActual) {
      status = "未记录";
    } else if (decided.length > 0 && decided.every((r) => r.passed)) {
      status = "已全部达标";
      pill = "ok";
    } else {
      status = "已记录";
      pill = "warn";
    }

    const passText = hasActual ? `${passCount}/${decided.length || targetCount}` : "—";
    const updated = saved.updatedAt ? saved.updatedAt.replace("T", " ").slice(0, 19) : "—";
    const cur = code === volumeViewStage ? "row-current" : "";

    return `
      <tr class="${cur}">
        <td><strong>${code}</strong></td>
        <td>${escapeHtml(cat.label)}</td>
        <td><span class="pill ${pill}">${status}</span></td>
        <td>${passText}</td>
        <td class="sub">${escapeHtml(updated)}</td>
        <td><button type="button" class="link-btn" data-view-stage="${code}">查看明细</button></td>
      </tr>`;
  });
  els.stageOverviewBody.innerHTML =
    rows.join("") || '<tr><td colspan="6" class="placeholder">无档位配置</td></tr>';

  els.stageOverviewBody.querySelectorAll("[data-view-stage]").forEach((btn) => {
    btn.addEventListener("click", () => {
      renderVolumeForStage(btn.dataset.viewStage);
      switchPage("result");
    });
  });
}

function renderDbSnapshot(preflight) {
  if (!els.dbSnapshot) return;
  if (!preflight) {
    els.dbSnapshot.innerHTML = '<p class="placeholder">检查前置条件后显示</p>';
    return;
  }
  if (preflight.loadInProgress) {
    els.dbSnapshot.innerHTML =
      "<p><strong>造数进行中</strong>，已跳过全表行数统计，避免与 COPY 互锁。</p>" +
      "<p>造数结束后将自动恢复检查；各档位历史记录仍在「造数结果」。</p>";
    return;
  }
  const snap = preflight.actualSnapshot || {};
  const total = Object.values(snap).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const inferred = preflight.inferredStage;

  if (total === 0) {
    els.dbSnapshot.innerHTML =
      "<p>当前库<strong>为空</strong>，尚未灌入测试数据。</p><p>完成造数后，各档位逐表记录保存在「造数结果」页。</p>";
    return;
  }

  const parts = [
    `<p>库内核心表合计约 <strong>${fmtNum(total)}</strong> 行（矿区、雷暴过程、大气电场、raw、雷击 biz）。</p>`,
  ];
  if (inferred) {
    parts.push(`<p>与档位 <strong>${inferred}</strong> 目标一致，当前库可视为该档数据。</p>`);
  } else {
    parts.push("<p>未能唯一匹配某一档位，可能正在换档或行数有偏差。</p>");
  }
  parts.push("<p class=\"sub\">此处只看实时库；历史各档造数明细不在这里重复展示。</p>");
  els.dbSnapshot.innerHTML = parts.join("");
}

function renderSectionsFromRecords(stage) {
  const saved = stageRecord(stage);
  if (saved.section11_1 && Object.keys(saved.section11_1).length) {
    renderEnvTable(saved.section11_1);
  }
  if (stage === volumeViewStage) {
    if (saved.section11_3?.length) {
      renderValidationGroups(saved.section11_3);
      renderCheckList(els.rawCheckList, saved.rawChecks || [], "无明细");
    }
    renderConclusionsFromRecords(stage);
    updateResultTabStatusFromSaved(stage);
  }
  if (stage === perfViewStage) {
    renderPerfPageForStage(stage, { resetPage: false });
  }
}

function payload(extra = {}) {
  const body = {
    dialect: activeDialect(),
    host: els.host.value.trim(),
    port: els.port.value.trim(),
    database: els.database.value.trim(),
    user: els.user.value.trim(),
    password: els.password.value,
    schema: els.schema.value.trim() || "perf",
    stage: els.stage.value,
    seed: Number(els.seed.value) || 42,
    truncate: els.truncate.checked,
    autoValidate: els.autoValidate.checked,
    ...extra,
  };
  const t0 = els.t0.value.trim();
  if (t0) body.t0 = t0;
  return body;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1_000_000) return n.toLocaleString("zh-CN");
  return String(n);
}

function passCell(passed) {
  if (passed === true) return '<span class="pill ok">是</span>';
  if (passed === false) return '<span class="pill fail">否</span>';
  return "—";
}

function setBadge(el, kind, text) {
  if (!el) return;
  el.className = `section-badge ${kind}`;
  el.textContent = text;
}

function setJobBadge(status) {
  els.jobBadge.className = `job-badge ${status}`;
  const map = { idle: "空闲", running: "执行中…", success: "完成", failed: "失败" };
  els.jobBadge.textContent = map[status] || status;
}

function labelForCheck(name) {
  if (name === "preflight:postgis") {
    if (lastPreflight?.spatialLabel) return lastPreflight.spatialLabel;
    return activeDialect() === "dameng" ? "GEO 空间模块" : "PostGIS 扩展";
  }
  if (CHECK_LABELS[name]) return CHECK_LABELS[name];
  if (PREFLIGHT_LABELS[name]) return PREFLIGHT_LABELS[name];
  if (name.startsWith("relation:") && name.endsWith("_biz_1_1")) {
    return `关联 · ${name.replace("relation:", "").replace("_biz_1_1", "")} 1:1`;
  }
  return name;
}

function refreshInitButton() {
  const busy = Boolean(pollTimer) || loadInProgress;
  const schemaReady = Boolean(lastPreflight?.ddlOk);
  els.btnInit.disabled = busy || schemaReady;
  els.btnInit.title = schemaReady ? "Schema 已初始化，不可重复执行" : "";
}

function setBusy(busy) {
  systemBusy = busy;
  const locked = busy || loadInProgress;
  els.btnPreflight.disabled = locked;
  els.btnLoad.disabled = locked;
  els.btnValidate.disabled = locked;
  if (els.btnBenchAll) els.btnBenchAll.disabled = locked;
  if (els.btnBenchSelected) els.btnBenchSelected.disabled = locked;
  if (els.btnCollectResources) els.btnCollectResources.disabled = locked;
  if (els.btnBenchAll) els.btnBenchAll.title = "";
  if (els.btnBenchSelected) els.btnBenchSelected.title = "";
  if (els.btnCollectResources) els.btnCollectResources.title = "";
  refreshInitButton();
}

function applyLoadGuardStatus(status) {
  loadInProgress = Boolean(status?.loadInProgress);
  const busy = Boolean(status?.busy);
  if (!pollTimer) {
    systemBusy = busy;
    setBusy(busy);
  }
  if (loadInProgress && !pollTimer) {
    setJobBadge("running");
    setTabPill(els.prepTabStatus, "running", "造数中");
    setBadge(els.loadBadge, "running", "造数中");
    if (els.prepHint) {
      els.prepHint.textContent =
        "造数进行中：已阻塞压测、全表统计与资源采集；请查看「造数执行」日志或等待完成。";
      els.prepHint.className = "hint warn";
    }
    if (els.loadHint) {
      els.loadHint.textContent = "造数进行中，请勿重复启动或执行 SQL 压测。";
      els.loadHint.className = "hint warn";
    }
  }
}

async function refreshSystemStatus() {
  try {
    const res = await fetch("/api/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload()),
    });
    if (!res.ok) return;
    const wasLoad = loadInProgress;
    applyLoadGuardStatus(await res.json());
    if (wasLoad && !loadInProgress && !pollTimer) {
      stopStatusPolling();
      setBusy(false);
      setJobBadge("idle");
    }
  } catch {
    /* ignore */
  }
}

function startStatusPolling() {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(() => refreshSystemStatus(), 3000);
}

function stopStatusPolling() {
  if (!statusPollTimer) return;
  clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function renderBenchLog(lines) {
  if (!els.benchLog) return;
  els.benchLog.textContent = (lines && lines.length ? lines : ["等待执行…"]).join("\n");
  els.benchLog.scrollTop = els.benchLog.scrollHeight;
}

async function loadBenchConfig() {
  const res = await fetch("/api/bench/scenarios");
  benchConfig = await res.json();
  const d = benchConfig?.defaults || {};
  if (els.benchPerf05AggMinutes && d.perf05_agg_bucket_minutes != null) {
    els.benchPerf05AggMinutes.value = d.perf05_agg_bucket_minutes;
  }
  renderBenchScenarios();
}

function benchQueryConcurrencyDefault() {
  const n = Number(els.benchQueryConcurrency?.value);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  const sc = benchConfig?.defaults?.stage_concurrency || {};
  return sc.query_low || 20;
}

function benchSlowSqlThresholdDefault() {
  const n = Number(els.benchSlowSqlMs?.value);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return benchConfig?.defaults?.slow_sql_threshold_ms || 500;
}

function benchPerf05AggMinutesDefault() {
  const n = Number(els.benchPerf05AggMinutes?.value);
  if (Number.isFinite(n) && n >= 1) return Math.min(60, Math.round(n));
  return benchConfig?.defaults?.perf05_agg_bucket_minutes || 10;
}

function benchDisplayConcurrency(cfg) {
  if (cfg.concurrency != null) return cfg.concurrency;
  if (cfg.kind === "read" || cfg.compound) return benchQueryConcurrencyDefault();
  return cfg.concurrency || 1;
}

function benchWarmupDefault() {
  return benchConfig?.defaults?.warmup ?? 5;
}

function benchWriteIterationsDefault() {
  return Number(els.benchWriteIterations?.value) || benchConfig?.defaults?.iterations || 50;
}

function benchQueryIterationsDefault() {
  return Number(els.benchQueryIterations?.value) || 500;
}

function benchScenarioIterations(cfg) {
  if (cfg.kind === "read" || cfg.compound) return benchQueryIterationsDefault();
  return benchWriteIterationsDefault();
}

function benchDisplayThresholds(cfg) {
  if (cfg.compound && cfg.sub_queries) {
    const parts = Object.entries(cfg.sub_queries).map(
      ([k, v]) => `${k} P95≤${v.p95_limit_ms}ms / P99≤${v.p99_limit_ms ?? v.p95_limit_ms * 2}ms`
    );
    return `${parts.join(" · ")} · 统计 P50/P95/P99/TPS`;
  }
  const p95 = cfg.p95_limit_ms != null ? `P95≤${cfg.p95_limit_ms}ms` : "";
  const p99 = cfg.p99_limit_ms != null ? `P99≤${cfg.p99_limit_ms}ms` : "";
  return [p95, p99, "统计 P50/P95/P99/TPS"].filter(Boolean).join(" · ");
}

function benchScenarioPrecheck(id) {
  const map = {
    "PERF-01": "前置：库内有大气电场、矿区、设备地址、时间范围",
    "PERF-02": "前置：库内有 raw 报文与大气电场等关联数据",
    "PERF-03": "前置：库内有雷暴过程与闪电事件数据",
    "PERF-04": "前置：库内有 biz 大气电场存量，解析 24h 查询时间窗",
    "PERF-05": "前置：库内有 biz 大气电场、雷暴过程；固定 1 条过程的 data_window_start/end",
    "PERF-05-AGG":
      "前置：同 PERF-05；按可配置时间桶聚合过程窗曲线，降低返回明细量",
    "PERF-06":
      activeDialect() === "dameng"
        ? "前置：库内有矿区、雷暴过程、闪电 DMGEO2 空间数据"
        : "前置：库内有矿区、雷暴过程、闪电 PostGIS 数据",
  };
  return map[id] || "前置：完成当前档位造数与校验";
}

function benchScenarioFlow(id, cfg) {
  const conc = benchDisplayConcurrency(cfg);
  const warmup = benchWarmupDefault();
  const iters = benchScenarioIterations(cfg);
  const pre = benchScenarioPrecheck(id);
  let exec;
  if (cfg.kind === "write") {
    const table = cfg.table || "目标表";
    exec = `每次 INSERT ${table} → COMMIT（压测前后按 PERF_BENCH 标记清理）`;
  } else if (id === "PERF-06") {
    exec =
      "每轮 Word 三条 SQL（数量 / 来源分布 / 类型分布）串行执行，分项统计 P95 并单独展示";
  } else if (id === "PERF-05") {
    exec = "固定同一雷暴过程 data_window，5 台设备瞬时值/平均值/变化率全量曲线 SELECT（不降采样）";
  } else if (id === "PERF-05-AGG") {
    exec = `固定同一雷暴过程 data_window，5 台设备按 ${benchPerf05AggMinutesDefault()} 分钟时间桶聚合曲线 SELECT（AVG/MAX 聚合）`;
  } else {
    exec = "每次 SELECT 查询（只读，无事务）";
  }
  return `${pre} → ${conc} 线程独立连库 → 每线程预热 ${warmup} 次 + 正式 ${iters} 次 → ${exec} → 统计 P50/P95/P99/TPS`;
}

function benchScenarioDisplayName(id, cfg) {
  if (id === "PERF-05-AGG") {
    return `多电场仪雷暴过程窗曲线查询（${benchPerf05AggMinutesDefault()}分钟聚合）`;
  }
  return cfg.name || id;
}

function renderBenchScenarios() {
  if (!els.benchScenarioList || !benchConfig?.scenarios) return;
  const scenarios = benchConfig.scenarios;
  els.benchScenarioList.innerHTML = Object.entries(scenarios)
    .map(
      ([id, cfg]) => `
    <label class="bench-scenario-item">
      <input type="checkbox" name="benchScenario" value="${id}" checked />
      <span class="bench-scenario-title"><strong>${id}</strong> ${escapeHtml(benchScenarioDisplayName(id, cfg))}</span>
      <span class="sub">${cfg.kind === "write" ? "SQL 写入" : "SQL 查询"} · 并发 ${benchDisplayConcurrency(cfg)} · ${benchDisplayThresholds(cfg)}</span>
      <span class="flow">${escapeHtml(benchScenarioFlow(id, cfg))}</span>
    </label>`
    )
    .join("");
}

function selectedBenchScenarios() {
  if (!els.benchScenarioList) return [];
  return [...els.benchScenarioList.querySelectorAll('input[name="benchScenario"]:checked')].map(
    (n) => n.value
  );
}

function renderBenchmarkResult(benchmark) {
  const stage = benchmark?.stage || perfViewStage || "S0";
  perfViewStage = stage;
  // 压测结果已由服务端 append 进 benchmarkHistory；勿再与 section11_4 合并（会 6+6=12）
  renderPerfPageForStage(stage, { resetPage: true });
}

function renderLog(lines) {
  els.logOutput.textContent = (lines && lines.length ? lines : ["等待操作…"]).join("\n");
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function renderCheckList(container, items, emptyText) {
  if (!items?.length) {
    container.innerHTML = `<p class="placeholder">${escapeHtml(emptyText)}</p>`;
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const cls = item.passed ? "pass" : "fail";
      const icon = item.passed ? "✅" : "❌";
      return `
        <div class="check-item ${cls}">
          <div class="icon">${icon}</div>
          <div>
            <div class="title">${escapeHtml(labelForCheck(item.name))}</div>
            <div class="detail">${escapeHtml(item.detail)}</div>
          </div>
        </div>`;
    })
    .join("");
}

function defaultPrepHintText() {
  const schema = (els.schema?.value || (activeDialect() === "dameng" ? "PERF" : "perf")).trim();
  const spatial = activeDialect() === "dameng" ? "DMGEO2 空间模块" : "PostGIS";
  return `确认 ${spatial}、${schema} schema 与 00～05 DDL 就绪后再进入造数。造数进行中会自动阻塞压测、全表统计与资源采集。`;
}

function updatePrepHint(preflight) {
  if (!preflight) {
    els.prepHint.textContent = defaultPrepHintText();
    els.prepHint.className = "hint";
    return;
  }
  if (preflight.loadInProgress) {
    els.prepHint.textContent =
      preflight.loadBlockReason ||
      "造数进行中，压测与全表统计已阻塞；DDL 检查仍可用，行数统计已跳过。";
    els.prepHint.className = "hint warn";
    return;
  }
  if (preflight.prerequisitesOk) {
    els.prepHint.textContent = "前置已通过，可切换到「造数执行」开始灌数。";
    els.prepHint.className = "hint ok";
    return;
  }
  if (!preflight.ddlOk) {
    const spatial =
      preflight.spatialLabel || (activeDialect() === "dameng" ? "GEO 空间模块" : "PostGIS");
    els.prepHint.textContent = `需先「初始化 Schema」或修复 ${spatial} / 连接。`;
    els.prepHint.className = "hint warn";
    return;
  }
  els.prepHint.textContent = "部分检查项未通过，请查看右侧列表。";
  els.prepHint.className = "hint warn";
}

function updateLoadHint(preflight) {
  if (!preflight) {
    if (activeDialect() === "dameng") {
      els.loadHint.textContent =
        "达梦链路已接入（造数/校验/压测/报告）；记录与 PostgreSQL 完全分开保存。压测需本机安装 dmPython。";
      els.loadHint.className = "hint";
      return;
    }
    els.loadHint.textContent = "请先在「环境与准备」通过前置检查。";
    els.loadHint.className = "hint";
    return;
  }
  if (preflight.loadInProgress) {
    els.loadHint.textContent =
      preflight.loadBlockReason || "造数进行中，请勿重复启动或执行 SQL 压测。";
    els.loadHint.className = "hint warn";
    return;
  }
  if (!preflight.prerequisitesOk) {
    els.loadHint.textContent = "前置未就绪，请返回「环境与准备」处理。";
    els.loadHint.className = "hint warn";
    return;
  }
  if (!preflight.readyForLoad && preflight.loadBlockReason) {
    els.loadHint.textContent = preflight.loadBlockReason;
    els.loadHint.className = "hint warn";
    return;
  }
  els.loadHint.textContent = `可对 ${els.stage.value} 执行造数。`;
  els.loadHint.className = "hint ok";
}

function mergeEnvSection(section, draft) {
  const merged = { ...(draft || {}) };
  // 服务端/落盘记录优先，避免 localStorage 旧占位符覆盖
  for (const [key, val] of Object.entries(section || {})) {
    if (val != null && String(val).trim() !== "") merged[key] = val;
  }
  return merged;
}
function renderEnvTable(section) {
  const merged = mergeEnvSection(section, envDraft);
  els.envTableBody.innerHTML = envFieldSpecs().map(([key, label]) => {
    const val = merged[key] ?? "";
    const editable = ENV_EDITABLE.has(key);
    if (editable) {
      return `
        <tr>
          <th>${escapeHtml(label)}</th>
          <td><input class="env-input" data-env-key="${key}" type="text" value="${escapeHtml(val)}" placeholder="填写" /></td>
        </tr>`;
    }
    return `
      <tr>
        <th>${escapeHtml(label)}</th>
        <td class="auto-val">${escapeHtml(val) || "—"}</td>
      </tr>`;
  }).join("");

  els.envTableBody.querySelectorAll(".env-input").forEach((input) => {
    input.addEventListener("change", () => {
      envDraft[input.dataset.envKey] = input.value.trim();
      saveEnvDraft();
      persistEnvToServer();
    });
  });
}

function renderVolumeRows(rows) {
  if (!rows?.length) {
    els.volumeTableBody.innerHTML = '<tr><td colspan="5" class="placeholder">造数并校验后填充</td></tr>';
    setBadge(els.volumeBadge, "idle", "—");
    return;
  }
  const allPass = rows.every((r) => r.passed === true);
  const anyData = rows.some((r) => r.actual != null);
  setBadge(
    els.volumeBadge,
    allPass && anyData ? "ok" : anyData ? "fail" : "idle",
    allPass && anyData ? "全部达标" : anyData ? "存在偏差" : "—"
  );

  els.volumeTableBody.innerHTML = rows
    .map(
      (r) => `
    <tr class="${r.passed === false ? "row-fail" : r.passed === true ? "row-ok" : ""}">
      <td>${escapeHtml(r.label)}</td>
      <td>${fmtNum(r.target)}</td>
      <td>${r.actual != null ? fmtNum(r.actual) : "—"}</td>
      <td>${passCell(r.passed)}</td>
      <td class="note">${escapeHtml(r.note)}</td>
    </tr>`
    )
    .join("");
}

function renderValidationGroups(groups) {
  if (!groups?.length) {
    els.validationTableBody.innerHTML = '<tr><td colspan="4" class="placeholder">执行校验后展示</td></tr>';
    setBadge(els.validationBadge, "idle", "—");
    return;
  }
  const decided = groups.filter((g) => g.passed != null);
  const allOk = decided.length > 0 && decided.every((g) => g.passed);
  setBadge(
    els.validationBadge,
    decided.length ? (allOk ? "ok" : "fail") : "idle",
    decided.length ? (allOk ? "全部通过" : "存在未通过") : "—"
  );

  els.validationTableBody.innerHTML = groups
    .map(
      (g) => `
    <tr class="${g.passed === false ? "row-fail" : g.passed === true ? "row-ok" : ""}">
      <td>${escapeHtml(g.item)}</td>
      <td>${escapeHtml(g.result)}</td>
      <td>${passCell(g.passed)}</td>
      <td class="note">${escapeHtml(g.note)}</td>
    </tr>`
    )
    .join("");
}

function parseRunAtMs(value) {
  if (!value || value === "—") return 0;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function formatSlowCount(v) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "—";
  return String(n);
}

function syncPerfTableDamengColumns() {
  const isDm = activeDialect() === "dameng";
  document.querySelectorAll(".dameng-only-col").forEach((el) => {
    el.hidden = !isDm;
  });
  document.querySelectorAll(".postgres-only-col").forEach((el) => {
    el.hidden = isDm;
  });
}

function perfTableColspan() {
  return activeDialect() === "dameng" ? 16 : 14;
}

function perfSlowColumnsHtml(r) {
  if (activeDialect() !== "dameng") return "";
  return `
      <td title="压测客户端耗时 ≥ 阈值">${escapeHtml(formatSlowCount(r.slowSqlBenchCount))}</td>
      <td title="V$SQL_HISTORY 场景时间窗">${escapeHtml(formatSlowCount(r.slowSqlDmCount))}</td>`;
}

function sortBenchmarkRows(rows) {
  return [...rows].sort((a, b) => {
    const byTime = parseRunAtMs(b.runAt) - parseRunAtMs(a.runAt);
    if (byTime !== 0) return byTime;
    return String(a.id || "").localeCompare(String(b.id || ""), undefined, { numeric: true });
  });
}

function normalizeBenchmarkRow(r) {
  if (!r) return r;
  const totalOps = r.total_ops ?? r.totalOps;
  const successOps = r.success_ops ?? r.successOps;
  const errorCount = r.error_count ?? r.errorCount;
  const fmt = (v) => (v == null || v === "" ? undefined : Number(v).toFixed(1));
  const fmtInt = (v) => (v == null || v === "" ? undefined : String(v));
  const executions =
    r.executions != null && String(r.executions).trim()
      ? String(r.executions)
      : totalOps != null
        ? String(totalOps)
        : undefined;
  const successRate =
    r.successRate != null && String(r.successRate).trim()
      ? String(r.successRate)
      : totalOps && successOps != null
        ? `${((successOps / totalOps) * 100).toFixed(1)}%`
        : undefined;
  return {
    ...r,
    concurrency:
      r.concurrency != null && String(r.concurrency).trim()
        ? String(r.concurrency)
        : r.concurrency,
    executions,
    successOps:
      r.successOps != null && String(r.successOps).trim()
        ? String(r.successOps)
        : fmtInt(successOps),
    errorCount:
      r.errorCount != null && String(r.errorCount).trim()
        ? String(r.errorCount)
        : fmtInt(errorCount) ??
          (totalOps != null && successOps != null
            ? String(Math.max(0, Number(totalOps) - Number(successOps)))
            : undefined),
    successRate,
    avgMs: r.avgMs ?? fmt(r.avg_ms),
    p95: r.p95 ?? fmt(r.p95_ms),
    p99: r.p99 ?? fmt(r.p99_ms),
    tps: r.tps != null && String(r.tps).trim() ? String(r.tps) : fmt(r.tps),
    startedAt: r.startedAt ?? r.started_at,
    finishedAt: r.finishedAt ?? r.finished_at,
    connPeak: r.connPeak ?? r.conn_peak,
    slowSqlCount: r.slowSqlCount ?? r.slow_sql_count,
    slowSqlBenchCount:
      r.slowSqlBenchCount ??
      r.slow_sql_bench_count ??
      r.slowSqlCount ??
      r.slow_sql_count,
    slowSqlDmCount: r.slowSqlDmCount ?? r.slow_sql_dm_count,
    slowSqlThresholdMs: r.slowSqlThresholdMs ?? r.slow_sql_threshold_ms,
    slowSqlDetails: r.slowSqlDetails ?? r.slow_sql_details ?? [],
  };
}

const PERF06_SUB_ORDER = ["count", "source_dist", "type_dist"];
const PERF06_SUB_LABELS = {
  count: "50km闪电数量",
  source_dist: "来源类型分布",
  type_dist: "闪电类型分布",
};

function expandCompoundBenchmarkRow(r) {
  const perf06Sub = /^PERF-06[-·](count|source_dist|type_dist)$/.exec(r.id || "");
  if (perf06Sub) {
    const tag = perf06Sub[1];
    return [
      {
        ...r,
        id: `PERF-06·${tag}`,
        name:
          r.name && !/^PERF-06/.test(r.name)
            ? `闪电事件时空统计查询 — ${r.name}`
            : `闪电事件时空统计查询 — ${PERF06_SUB_LABELS[tag] || r.name || tag}`,
        compoundSub: true,
      },
    ];
  }
  const subs = r.subQueries || r.sub_queries;
  if (subs && typeof subs === "object" && Object.keys(subs).length) {
    const order = PERF06_SUB_ORDER.filter((k) => k in subs).concat(
      Object.keys(subs).filter((k) => !PERF06_SUB_ORDER.includes(k))
    );
    return order.map((tag) => {
      const sq = subs[tag];
      return {
        ...r,
        id: `${r.id}·${tag}`,
        name: `${r.name} — ${sq.label || tag}`,
        executions: sq.executions != null ? String(sq.executions) : r.executions,
        successOps: sq.successOps != null ? String(sq.successOps) : r.successOps,
        errorCount:
          sq.errorCount != null
            ? String(sq.errorCount)
            : sq.executions != null && sq.successOps != null
              ? String(Math.max(0, Number(sq.executions) - Number(sq.successOps)))
              : r.errorCount,
        successRate: sq.successRate ?? r.successRate,
        avgMs: sq.avgMs ?? r.avgMs,
        p95: sq.p95 ?? r.p95,
        p99: sq.p99 ?? r.p99,
        tps: sq.tps ?? r.tps,
        passed: sq.passed ?? r.passed,
        compoundSub: true,
      };
    });
  }
  // 旧记录：从 note 解析分项 P95，次数按 3 条 SQL 均分展示
  if (r.id === "PERF-06" && r.note && String(r.note).includes("compound")) {
    const parsed = {};
    for (const m of String(r.note).matchAll(
      /(count|source_dist|type_dist) P95=(\d+(?:\.\d+)?)ms≤(\d+)/g
    )) {
      parsed[m[1]] = { p95: m[2], limit: Number(m[3]) };
    }
    if (Object.keys(parsed).length) {
      const labels = {
        count: "50km闪电数量",
        source_dist: "来源类型分布",
        type_dist: "闪电类型分布",
      };
      const totalExec = Number(r.executions);
      const subExec =
        Number.isFinite(totalExec) && totalExec > 0 ? String(Math.round(totalExec / 3)) : r.executions;
      return PERF06_SUB_ORDER.filter((tag) => parsed[tag]).map((tag) => {
        const item = parsed[tag];
        const p95n = Number(item.p95);
        return {
          ...r,
          id: `${r.id}·${tag}`,
          name: `${r.name} — ${labels[tag] || tag}`,
          executions: subExec,
          successOps: r.successRate === "100.0%" ? subExec : undefined,
          errorCount: r.successRate === "100.0%" ? "0" : undefined,
          successRate: r.successRate,
          avgMs: "—",
          p95: Number.isFinite(p95n) ? p95n.toFixed(1) : item.p95,
          p99: "—",
          tps: "—",
          passed: Number.isFinite(p95n) ? p95n <= item.limit : r.passed,
          compoundSub: true,
        };
      });
    }
  }
  return [r];
}

function flattenBenchmarkHistory(history) {
  const indexed = (history || []).map((run, idx) => ({ run, idx }));
  indexed.sort((a, b) => {
    const byTime = parseRunAtMs(b.run.runAt) - parseRunAtMs(a.run.runAt);
    if (byTime !== 0) return byTime;
    return b.idx - a.idx;
  });
  const rows = [];
  for (const { run } of indexed) {
    const runAt = run.runAt || "—";
    const runId = run.runId || "";
    for (const r of run.results || []) {
      for (const row of expandCompoundBenchmarkRow(normalizeBenchmarkRow(r))) {
        rows.push({ ...row, runAt, runId });
      }
    }
  }
  return rows;
}

function benchmarkHistoryForStage(stage) {
  return stageRecord(stage).benchmarkHistory || [];
}

function syncTablePager(pager, infoEl, prevEl, nextEl, page, total) {
  if (!pager) return;
  const totalPages = total > 0 ? Math.max(1, Math.ceil(total / PERF_PAGE_SIZE)) : 0;
  const show = total > PERF_PAGE_SIZE;
  pager.hidden = !show;
  pager.classList.toggle("is-hidden", !show);
  pager.style.display = show ? "" : "none";
  if (infoEl) {
    if (total === 0) {
      infoEl.textContent = "—";
    } else if (!show) {
      infoEl.textContent = `共 ${total} 条`;
    } else {
      infoEl.textContent = `第 ${page}/${totalPages} 页，共 ${total} 条`;
    }
  }
  if (prevEl) prevEl.disabled = !show || page <= 1;
  if (nextEl) nextEl.disabled = !show || page >= totalPages;
}

function renderPerfPager(total) {
  syncTablePager(
    els.perfPager,
    els.perfPagerInfo,
    els.perfPagerPrev,
    els.perfPagerNext,
    perfHistoryPage,
    total
  );
}

function renderPerfResults(rows, options = {}) {
  if (options.resetPage) perfHistoryPage = 1;
  if (options.page != null) perfHistoryPage = options.page;
  syncPerfTableDamengColumns();

  if (!rows?.length) {
    perfHistoryAllRows = [];
    perfHistoryPage = 1;
    const tip =
      activeDialect() === "dameng" && dialectHasAnySavedData("postgres")
        ? "当前查看达梦 DM8，暂无压测记录；PostgreSQL 下有历史数据，请切换顶部数据库类型按钮查看。"
        : "当前档位尚无压测记录（切换上方档位 Tab 查看各阶段结果）";
    els.perfTableBody.innerHTML =
      `<tr><td colspan="${perfTableColspan()}" class="placeholder">${escapeHtml(tip)}</td></tr>`;
    renderPerfPager(0);
    updatePerfDeleteControls();
    return;
  }

  perfHistoryAllRows = rows;
  const total = perfHistoryAllRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PERF_PAGE_SIZE));
  if (perfHistoryPage > totalPages) perfHistoryPage = totalPages;
  if (perfHistoryPage < 1) perfHistoryPage = 1;

  const start = (perfHistoryPage - 1) * PERF_PAGE_SIZE;
  const pageRows = perfHistoryAllRows.slice(start, start + PERF_PAGE_SIZE);

  els.perfTableBody.innerHTML = pageRows
    .map(
      (r) => `
    <tr class="${r.passed === false ? "row-fail" : r.passed === true ? "row-ok" : ""}" data-run-id="${escapeHtml(r.runId || "")}">
      <td class="col-check"><input type="checkbox" class="perf-row-select" data-run-id="${escapeHtml(r.runId || "")}" /></td>
      <td class="sub">${escapeHtml(formatRunAt(r.runAt))}</td>
      <td>${escapeHtml(r.id)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.concurrency || "—")}</td>
      <td>${escapeHtml(r.executions || "—")}</td>
      <td>${escapeHtml(r.successOps ?? "—")}</td>
      <td>${escapeHtml(r.errorCount ?? "—")}</td>
      <td>${escapeHtml(r.successRate || "—")}</td>
      <td>${escapeHtml(r.avgMs || "—")}</td>
      <td>${escapeHtml(r.p95 || "—")}</td>
      <td>${escapeHtml(r.p99 || "—")}</td>
      <td>${escapeHtml(r.tps || "—")}</td>
      ${perfSlowColumnsHtml(r)}
      <td>${passCell(r.passed)}</td>
    </tr>`
    )
    .join("");
  renderPerfPager(total);
  bindPerfTableSelection();
}

function selectedPerfRunIds() {
  if (!els.perfTableBody) return [];
  const ids = new Set();
  els.perfTableBody.querySelectorAll(".perf-row-select:checked").forEach((cb) => {
    const id = cb.dataset.runId;
    if (id) ids.add(id);
  });
  return [...ids];
}

function updatePerfDeleteControls() {
  const ids = selectedPerfRunIds();
  const hasRows = perfHistoryAllRows.length > 0;
  if (els.btnDeletePerfRuns) {
    els.btnDeletePerfRuns.disabled = ids.length === 0;
  }
  if (els.btnDeleteAllPerfRuns) {
    els.btnDeleteAllPerfRuns.disabled = !hasRows;
  }
  if (els.perfSelectAllPage && els.perfTableBody) {
    const boxes = [...els.perfTableBody.querySelectorAll(".perf-row-select")];
    const checked = boxes.filter((cb) => cb.checked).length;
    els.perfSelectAllPage.checked = boxes.length > 0 && checked === boxes.length;
    els.perfSelectAllPage.indeterminate = checked > 0 && checked < boxes.length;
  }
}

function bindPerfTableSelection() {
  if (els.perfSelectAllPage) {
    els.perfSelectAllPage.onclick = (e) => e.stopPropagation();
    els.perfSelectAllPage.onchange = () => {
      const on = els.perfSelectAllPage.checked;
      els.perfTableBody?.querySelectorAll(".perf-row-select").forEach((cb) => {
        cb.checked = on;
      });
      updatePerfDeleteControls();
    };
  }
  els.perfTableBody?.querySelectorAll(".perf-row-select").forEach((cb) => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      const runId = cb.dataset.runId;
      if (runId && cb.checked) {
        els.perfTableBody.querySelectorAll(`.perf-row-select[data-run-id="${runId}"]`).forEach((other) => {
          other.checked = true;
        });
      }
      updatePerfDeleteControls();
    };
  });
  updatePerfDeleteControls();
}

async function deleteSelectedPerfRuns() {
  const runIds = selectedPerfRunIds();
  if (!runIds.length) {
    window.alert("请先勾选要删除的压测记录");
    return;
  }
  const rowCount = perfHistoryAllRows.filter((r) => runIds.includes(r.runId)).length;
  const ok = window.confirm(
    `确认删除 ${runIds.length} 轮压测记录（共 ${rowCount} 条场景结果）？\n删除后不可恢复。`
  );
  if (!ok) return;

  try {
    const res = await fetch("/api/benchmark/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: perfViewStage,
        runIds,
        dialect: activeDialect(),
      }),
    });
    const ct = res.headers.get("Content-Type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(
        res.status === 404
          ? "删除接口不可用，请重启 perf-web 容器后重试（docker compose restart perf-web）"
          : text.slice(0, 120) || `删除失败（HTTP ${res.status}）`
      );
    }
    if (!res.ok) throw new Error(data.error || "删除失败");
    await loadRecords();
    if (els.perfSelectAllPage) {
      els.perfSelectAllPage.checked = false;
      els.perfSelectAllPage.indeterminate = false;
    }
    renderPerfPageForStage(perfViewStage, { resetPage: true });
  } catch (err) {
    window.alert(err.message || String(err));
  }
}

async function deleteAllPerfRuns() {
  if (!perfHistoryAllRows.length) {
    window.alert("当前档位没有压测记录");
    return;
  }
  const runRounds = benchmarkHistoryForStage(perfViewStage).length;
  const rowCount = perfHistoryAllRows.length;
  const ok = window.confirm(
    `确认删除 ${perfViewStage} 全部压测记录（${runRounds} 轮，共 ${rowCount} 条场景结果）？\n删除后不可恢复。`
  );
  if (!ok) return;

  try {
    const res = await fetch("/api/benchmark/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: perfViewStage,
        deleteAll: true,
        dialect: activeDialect(),
      }),
    });
    const ct = res.headers.get("Content-Type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(
        res.status === 404
          ? "删除接口不可用，请重启 perf-web 容器后重试（docker compose restart perf-web）"
          : text.slice(0, 120) || `删除失败（HTTP ${res.status}）`
      );
    }
    if (!res.ok) throw new Error(data.error || "删除失败");
    await loadRecords();
    if (els.perfSelectAllPage) {
      els.perfSelectAllPage.checked = false;
      els.perfSelectAllPage.indeterminate = false;
    }
    renderPerfPageForStage(perfViewStage, { resetPage: true });
  } catch (err) {
    window.alert(err.message || String(err));
  }
}

function changePerfPage(delta) {
  if (!perfHistoryAllRows.length) return;
  const totalPages = Math.max(1, Math.ceil(perfHistoryAllRows.length / PERF_PAGE_SIZE));
  const next = perfHistoryPage + delta;
  if (next < 1 || next > totalPages) return;
  renderPerfResults(perfHistoryAllRows, { page: next });
}

function formatRunAt(value) {
  if (!value || value === "—") return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** 将说明列中的 ISO 时间转为与压测历史一致的本地格式 */
function formatResourceNote(note) {
  if (!note) return "";
  return String(note).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g,
    (iso) => formatRunAt(iso)
  );
}

function renderPerfStatusForStage(stage, rows) {
  const decided = rows.filter((r) => r.passed != null);
  const allOk = decided.length > 0 && decided.every((r) => r.passed);
  const latestRun = benchmarkHistoryForStage(stage).at(-1);
  const latestDecided = (latestRun?.results || []).filter((r) => r.passed != null);
  const latestPassed =
    latestRun?.passed != null
      ? latestRun.passed
      : latestDecided.length
        ? latestDecided.every((r) => r.passed)
        : null;
  setBadge(
    els.perfBadge,
    rows.length ? (latestPassed === false ? "fail" : latestPassed ? "ok" : "idle") : "idle",
    rows.length
      ? latestPassed === false
        ? "最近一轮未通过"
        : latestPassed
          ? `${stage} · 共 ${rows.length} 条`
          : "已记录"
      : "—"
  );
  setTabPill(
    els.perfTabStatus,
    rows.length ? (allOk ? "ok" : latestPassed === false ? "fail" : "warn") : "idle",
    rows.length ? `${stage} ${rows.length} 条` : "待执行"
  );
}

function renderPerfForStage(stage, options = {}) {
  const rows = flattenBenchmarkHistory(benchmarkHistoryForStage(stage));
  renderPerfResults(rows, { resetPage: options.resetPage !== false });
  renderPerfStatusForStage(stage, rows);
}

function renderPerfPlaceholder(rows) {
  if (rows?.length && rows[0]?.runAt) {
    renderPerfResults(rows);
    return;
  }
  renderPerfPageForStage(perfViewStage, { resetPage: false });
}

function resourceCellClass(val) {
  return val && String(val).trim() && val !== "—" ? "" : "muted";
}

function resourceHistoryForStage(stage) {
  return stageRecord(stage).resourceHistory || [];
}

function resourceTableColspan() {
  return activeDialect() === "dameng" ? 14 : 12;
}

function formatResourceScenarioId(id) {
  const raw = String(id || "");
  const m = /^PERF-06[-·](count|source_dist|type_dist)$/.exec(raw);
  if (m) return `PERF-06·${m[1]}`;
  return raw;
}

function normalizeResourceRow(r) {
  return {
    ...r,
    id: formatResourceScenarioId(r.id),
    slowSqlCount: r.slowSqlCount ?? r.slow_sql_count,
    slowSqlBenchCount:
      r.slowSqlBenchCount ??
      r.slow_sql_bench_count ??
      r.slowSqlCount ??
      r.slow_sql_count,
    slowSqlDmCount: r.slowSqlDmCount ?? r.slow_sql_dm_count,
  };
}

function resourceSlowColumnsHtml(r) {
  if (activeDialect() !== "dameng") return "";
  return `
      <td class="col-metric ${resourceCellClass(r.slowSqlBenchCount)}" title="压测客户端耗时 ≥ 阈值">${escapeHtml(formatSlowCount(r.slowSqlBenchCount))}</td>
      <td class="col-metric ${resourceCellClass(r.slowSqlDmCount)}" title="V$SQL_HISTORY 场景时间窗">${escapeHtml(formatSlowCount(r.slowSqlDmCount))}</td>`;
}

function resourceSlowCountColumnHtml(r) {
  if (activeDialect() === "dameng") return "";
  return `<td class="col-metric ${resourceCellClass(r.slowSqlCount)}">${escapeHtml(r.slowSqlCount || "—")}</td>`;
}

function flattenSlowSqlDetailRows(stage) {
  const latest = benchmarkHistoryForStage(stage).at(-1);
  if (!latest?.results?.length) return [];
  const rows = [];
  for (const raw of latest.results) {
    const r = normalizeBenchmarkRow(raw);
    const details = r.slowSqlDetails || [];
    if (!details.length) continue;
    const scene =
      r.name && !/^PERF-\d/.test(String(r.name))
        ? `${r.id} · ${r.name}`
        : formatResourceScenarioId(r.id);
    for (const d of details) {
      rows.push({
        scene,
        source: d.source === "dm" ? "库内" : "样本",
        timeMs: d.timeMs ?? d.time_ms ?? "—",
        sqlText: d.sqlText || d.sql_text || "—",
        startTime: d.startTime || d.start_time || "—",
      });
    }
  }
  return rows;
}

function buildSlowSqlSummaryRows(stage) {
  const latest = benchmarkHistoryForStage(stage).at(-1);
  if (!latest?.results?.length) return [];
  const rows = [];
  for (const raw of latest.results) {
    const r = normalizeBenchmarkRow(raw);
    const bench = Number(r.slowSqlBenchCount);
    const dm = Number(r.slowSqlDmCount);
    const hasBench = Number.isFinite(bench) && bench > 0;
    const hasDm = Number.isFinite(dm) && dm > 0;
    if (!hasBench && !hasDm) continue;
    const thr = r.slowSqlThresholdMs || 500;
    const scene =
      r.name && !/^PERF-\d/.test(String(r.name))
        ? `${r.id} · ${r.name}`
        : formatResourceScenarioId(r.id);
    let symptom = hasBench ? `样本慢SQL ${bench} 条` : "";
    if (hasDm) symptom += `${symptom ? "；" : ""}库内慢SQL ${dm} 条`;
    rows.push({
      scene,
      source: "汇总",
      timeMs: "—",
      sqlText: `${symptom}（≥${thr}ms）· 点击「刷新明细」加载 SQL 文本`,
      startTime: "—",
    });
  }
  return rows;
}

function buildLocalBenchSlowSqlDetailRows(stage) {
  const latest = benchmarkHistoryForStage(stage).at(-1);
  if (!latest?.results?.length) return [];
  const rows = [];
  for (const raw of latest.results) {
    const r = normalizeBenchmarkRow(raw);
    const existing = r.slowSqlDetails || [];
    const scene =
      r.name && !/^PERF-\d/.test(String(r.name))
        ? `${r.id} · ${r.name}`
        : formatResourceScenarioId(r.id);
    if (existing.length) {
      for (const d of existing) {
        rows.push({
          scene,
          source: d.source === "dm" ? "库内" : "样本",
          timeMs: d.timeMs ?? d.time_ms ?? "—",
          sqlText: d.sqlText || d.sql_text || "—",
          startTime: d.startTime || d.start_time || "—",
        });
      }
      continue;
    }
    const bench = Number(r.slowSqlBenchCount);
    if (!Number.isFinite(bench) || bench <= 0) continue;
    const preview = raw.sqlPreview || raw.sql_preview || "";
    const maxMs = raw.max_ms ?? raw.maxMs;
    if (!preview && (maxMs == null || maxMs === "")) continue;
    let timeMs = maxMs;
    try {
      timeMs = roundMs(maxMs) ?? r.slowSqlThresholdMs ?? 500;
    } catch {
      timeMs = r.slowSqlThresholdMs || 500;
    }
    rows.push({
      scene,
      source: "样本",
      timeMs,
      sqlText: preview || "（SQL 文本未缓存，请 docker restart leidian-perf-web 后点「刷新明细」）",
      startTime: "—",
    });
  }
  return rows;
}

function roundMs(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

async function ensureSlowSqlDetails(stage) {
  if (activeDialect() !== "dameng") return;
  const latest = benchmarkHistoryForStage(stage).at(-1);
  if (!latest?.results?.length) return;
  const needs = latest.results.some((raw) => {
    const r = normalizeBenchmarkRow(raw);
    const bench = Number(r.slowSqlBenchCount);
    const dm = Number(r.slowSqlDmCount);
    const hasSlow = (Number.isFinite(bench) && bench > 0) || (Number.isFinite(dm) && dm > 0);
    return hasSlow && !(r.slowSqlDetails && r.slowSqlDetails.length);
  });
  if (!needs) return;
  await refreshSlowSqlDetails(stage, { silent: true });
}

async function refreshSlowSqlDetails(stage, options = {}) {
  if (activeDialect() !== "dameng") {
    window.alert("慢 SQL 明细当前仅支持达梦 DM8");
    return;
  }
  const latest = benchmarkHistoryForStage(stage).at(-1);
  if (!latest) {
    if (!options.silent) window.alert("请先执行 SQL 压测");
    return;
  }
  const badge = $("slowSqlSectionBadge");
  if (badge && !options.silent) setBadge(badge, "running", "查询中…");
  if (els.btnRefreshSlowSql && !options.silent) els.btnRefreshSlowSql.disabled = true;
  try {
    const res = await fetch("/api/slow-sql/details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload(),
        stage,
        runId: latest.runId,
      }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(res.ok ? "服务端返回非 JSON" : `HTTP ${res.status}`);
    }
    if (!res.ok) {
      if (res.status === 404) {
        const localRows = buildLocalBenchSlowSqlDetailRows(stage);
        if (localRows.length) {
          renderSlowSqlPlaceholder(localRows);
          if (badge) setBadge(badge, "warn", `${localRows.length} 条（本地）`);
          return;
        }
        throw new Error(
          "慢 SQL 接口未加载（HTTP 404）。请在项目目录执行：docker restart leidian-perf-web，等待 5 秒后再点「刷新明细」"
        );
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await loadRecords();
    renderSlowSqlSection(stage, stageRecord(stage));
    if (!options.silent) {
      const count = (data.details || []).length;
      setBadge(badge, count ? "warn" : "idle", count ? `${count} 条明细` : "无慢SQL");
    }
  } catch (err) {
    if (!options.silent) {
      setBadge(badge, "fail", "失败");
      window.alert(err.message);
    }
  } finally {
    if (els.btnRefreshSlowSql && !options.silent) els.btnRefreshSlowSql.disabled = false;
  }
}

function renderSlowSqlSection(stage, saved) {
  const detailRows = flattenSlowSqlDetailRows(stage);
  let rows = detailRows;
  if (!rows.length) rows = buildLocalBenchSlowSqlDetailRows(stage);
  if (!rows.length) rows = buildSlowSqlSummaryRows(stage);
  const badge = $("slowSqlSectionBadge");
  if (badge) {
    if (detailRows.length) {
      setBadge(badge, "warn", `${detailRows.length} 条明细`);
    } else if (rows.length && rows[0]?.source !== "汇总") {
      setBadge(badge, "warn", `${rows.length} 条（本地）`);
    } else if (rows.length) {
      setBadge(badge, "idle", "待刷新");
    } else {
      setBadge(badge, "idle", "无慢SQL");
    }
  }
  renderSlowSqlPlaceholder(rows);
}

function expandResourceRow(r) {
  const norm = normalizeResourceRow(r);
  if (norm.id === "PERF-06" && !String(r.id || "").includes("·") && !String(r.id || "").includes("-count")) {
    return PERF06_SUB_ORDER.map((tag) => ({
      ...norm,
      id: `PERF-06·${tag}`,
    }));
  }
  return [norm];
}

function flattenResourceHistory(history) {
  const indexed = (history || []).map((run, idx) => ({ run, idx }));
  indexed.sort((a, b) => {
    const byTime = parseRunAtMs(b.run.collectedAt) - parseRunAtMs(a.run.collectedAt);
    if (byTime !== 0) return byTime;
    return b.idx - a.idx;
  });
  const rows = [];
  for (const { run } of indexed) {
    const collectedAt = run.collectedAt || "—";
    const collectId = run.collectId || "";
    for (const r of run.results || []) {
      for (const row of expandResourceRow(r)) {
        rows.push({ ...row, collectedAt, collectId });
      }
    }
  }
  return rows;
}

function renderResourcePager(total) {
  syncTablePager(
    els.resourcePager,
    els.resourcePagerInfo,
    els.resourcePagerPrev,
    els.resourcePagerNext,
    resourceHistoryPage,
    total
  );
}

function renderResourceResults(rows, options = {}) {
  if (options.resetPage) resourceHistoryPage = 1;
  if (options.page != null) resourceHistoryPage = options.page;
  syncPerfTableDamengColumns();

  if (!rows?.length) {
    resourceHistoryAllRows = [];
    resourceHistoryPage = 1;
    const tip =
      activeDialect() === "dameng" && dialectHasAnySavedData("postgres")
        ? "当前查看达梦 DM8，暂无配套采集记录；PostgreSQL 下有历史数据，请切换顶部数据库类型按钮查看。"
        : "当前档位尚无配套采集记录（压测后点「采集资源与执行计划」）";
    els.resourceTableBody.innerHTML =
      `<tr><td colspan="${resourceTableColspan()}" class="placeholder">${escapeHtml(tip)}</td></tr>`;
    renderResourcePager(0);
    setBadge(els.resourceBadge, "idle", "—");
    updateResourceDeleteControls();
    return;
  }

  resourceHistoryAllRows = rows;
  const total = resourceHistoryAllRows.length;
  const totalPages = Math.max(1, Math.ceil(total / PERF_PAGE_SIZE));
  if (resourceHistoryPage > totalPages) resourceHistoryPage = totalPages;
  if (resourceHistoryPage < 1) resourceHistoryPage = 1;

  const start = (resourceHistoryPage - 1) * PERF_PAGE_SIZE;
  const pageRows = resourceHistoryAllRows.slice(start, start + PERF_PAGE_SIZE);
  const filled = rows.some((r) => r.cpuAvg || r.cpuPeak || r.memAvg);

  els.resourceTableBody.innerHTML = pageRows
    .map(
      (r) => `
    <tr data-collect-id="${escapeHtml(r.collectId || "")}">
      <td class="col-check"><input type="checkbox" class="resource-row-select" data-collect-id="${escapeHtml(r.collectId || "")}" /></td>
      <td class="sub col-collected-at">${escapeHtml(formatRunAt(r.collectedAt))}</td>
      <td class="col-scenario">${escapeHtml(r.id)}</td>
      <td class="col-metric ${resourceCellClass(r.cpuAvg)}">${escapeHtml(r.cpuAvg || "—")}</td>
      <td class="col-metric ${resourceCellClass(r.cpuPeak)}">${escapeHtml(r.cpuPeak || "—")}</td>
      <td class="col-metric ${resourceCellClass(r.memAvg)}">${escapeHtml(r.memAvg || "—")}</td>
      <td class="col-metric ${resourceCellClass(r.diskIoWait)}">${escapeHtml(r.diskIoWait || "—")}</td>
      <td class="col-metric ${resourceCellClass(r.connPeak)}">${escapeHtml(r.connPeak || "—")}</td>
      ${resourceSlowColumnsHtml(r)}
      ${resourceSlowCountColumnHtml(r)}
      <td class="col-metric">${escapeHtml(r.partitionPrune || "—")}</td>
      <td class="col-metric">${escapeHtml(r.indexHit || "—")}</td>
      <td class="sub col-note ${resourceCellClass(r.note)}" title="${escapeHtml(formatResourceNote(r.note))}">${escapeHtml(formatResourceNote(r.note))}</td>
    </tr>`
    )
    .join("");
  setBadge(
    els.resourceBadge,
    filled ? "ok" : "idle",
    filled ? `${perfViewStage || els.stage.value} · 共 ${total} 条` : "—"
  );
  renderResourcePager(total);
  bindResourceTableSelection();
}

function selectedResourceCollectIds() {
  if (!els.resourceTableBody) return [];
  const ids = new Set();
  els.resourceTableBody.querySelectorAll(".resource-row-select:checked").forEach((cb) => {
    const id = cb.dataset.collectId;
    if (id) ids.add(id);
  });
  return [...ids];
}

function updateResourceDeleteControls() {
  const ids = selectedResourceCollectIds();
  const hasRows = resourceHistoryAllRows.length > 0;
  if (els.btnDeleteResourceCollects) {
    els.btnDeleteResourceCollects.disabled = ids.length === 0;
  }
  if (els.btnDeleteAllResourceCollects) {
    els.btnDeleteAllResourceCollects.disabled = !hasRows;
  }
  if (els.resourceSelectAllPage && els.resourceTableBody) {
    const boxes = [...els.resourceTableBody.querySelectorAll(".resource-row-select")];
    const checked = boxes.filter((cb) => cb.checked).length;
    els.resourceSelectAllPage.checked = boxes.length > 0 && checked === boxes.length;
    els.resourceSelectAllPage.indeterminate = checked > 0 && checked < boxes.length;
  }
}

function bindResourceTableSelection() {
  if (els.resourceSelectAllPage) {
    els.resourceSelectAllPage.onclick = (e) => e.stopPropagation();
    els.resourceSelectAllPage.onchange = () => {
      const on = els.resourceSelectAllPage.checked;
      els.resourceTableBody?.querySelectorAll(".resource-row-select").forEach((cb) => {
        cb.checked = on;
      });
      updateResourceDeleteControls();
    };
  }
  els.resourceTableBody?.querySelectorAll(".resource-row-select").forEach((cb) => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      const collectId = cb.dataset.collectId;
      if (collectId && cb.checked) {
        els.resourceTableBody
          .querySelectorAll(`.resource-row-select[data-collect-id="${collectId}"]`)
          .forEach((other) => {
            other.checked = true;
          });
      }
      updateResourceDeleteControls();
    };
  });
  updateResourceDeleteControls();
}

async function deleteSelectedResourceCollects() {
  const collectIds = selectedResourceCollectIds();
  if (!collectIds.length) {
    window.alert("请先勾选要删除的资源采集记录");
    return;
  }
  const rowCount = resourceHistoryAllRows.filter((r) => collectIds.includes(r.collectId)).length;
  const ok = window.confirm(
    `确认删除 ${collectIds.length} 轮资源采集记录（共 ${rowCount} 条场景结果）？\n删除后不可恢复。`
  );
  if (!ok) return;

  try {
    const res = await fetch("/api/resources/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: perfViewStage || els.stage.value,
        collectIds,
        dialect: activeDialect(),
      }),
    });
    const ct = res.headers.get("Content-Type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(
        res.status === 404
          ? "删除接口不可用，请重启 perf-web 容器后重试（docker compose restart perf-web）"
          : text.slice(0, 120) || `删除失败（HTTP ${res.status}）`
      );
    }
    if (!res.ok) throw new Error(data.error || "删除失败");
    await loadRecords();
    if (els.resourceSelectAllPage) {
      els.resourceSelectAllPage.checked = false;
      els.resourceSelectAllPage.indeterminate = false;
    }
    renderResourceForStage(perfViewStage || els.stage.value, { resetPage: true });
  } catch (err) {
    window.alert(err.message || String(err));
  }
}

async function deleteAllResourceCollects() {
  if (!resourceHistoryAllRows.length) {
    window.alert("当前档位没有配套采集记录");
    return;
  }
  const collectRounds = resourceHistoryForStage(perfViewStage || els.stage.value).length;
  const rowCount = resourceHistoryAllRows.length;
  const stage = perfViewStage || els.stage.value;
  const ok = window.confirm(
    `确认删除 ${stage} 全部配套采集记录（${collectRounds} 轮，共 ${rowCount} 条场景结果）？\n删除后不可恢复。`
  );
  if (!ok) return;

  try {
    const res = await fetch("/api/resources/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage,
        deleteAll: true,
        dialect: activeDialect(),
      }),
    });
    const ct = res.headers.get("Content-Type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      throw new Error(
        res.status === 404
          ? "删除接口不可用，请重启 perf-web 容器后重试（docker compose restart perf-web）"
          : text.slice(0, 120) || `删除失败（HTTP ${res.status}）`
      );
    }
    if (!res.ok) throw new Error(data.error || "删除失败");
    await loadRecords();
    if (els.resourceSelectAllPage) {
      els.resourceSelectAllPage.checked = false;
      els.resourceSelectAllPage.indeterminate = false;
    }
    renderResourceForStage(stage, { resetPage: true });
  } catch (err) {
    window.alert(err.message || String(err));
  }
}

function changeResourcePage(delta) {
  if (!resourceHistoryAllRows.length) return;
  const totalPages = Math.max(1, Math.ceil(resourceHistoryAllRows.length / PERF_PAGE_SIZE));
  const next = resourceHistoryPage + delta;
  if (next < 1 || next > totalPages) return;
  renderResourceResults(resourceHistoryAllRows, { page: next });
}

function renderResourceForStage(stage, options = {}) {
  const rows = flattenResourceHistory(resourceHistoryForStage(stage));
  renderResourceResults(rows, { resetPage: options.resetPage !== false });
}

function renderResourcePlaceholder(rows) {
  if (rows?.length && rows[0]?.collectedAt) {
    renderResourceResults(rows);
    return;
  }
  renderResourceForStage(perfViewStage || els.stage.value, { resetPage: false });
}

async function collectResources() {
  const stage = perfViewStage || els.stage.value;
  const history = benchmarkHistoryForStage(stage);
  if (!history.length) {
    window.alert("请先执行 SQL 压测，再点「采集资源与执行计划」。");
    return;
  }
  setBadge(els.resourceBadge, "running", "采集分析中…");
  if (els.btnCollectResources) els.btnCollectResources.disabled = true;
  try {
    const res = await fetch("/api/resources/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload(),
        stage,
        prometheusUrl,
        prometheusInstance,
        slowSqlThresholdMs: benchSlowSqlThresholdDefault(),
        runId: history.at(-1)?.runId,
      }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        res.ok
          ? "服务端返回非 JSON，请执行 docker compose up -d --build 重建操作台"
          : `接口异常 HTTP ${res.status}，请重建操作台后重试（当前可能缺少 /api/resources/collect）`
      );
    }
    if (!res.ok) throw new Error(data.error || "采集失败");
    await loadRecords();
    renderPerfPageForStage(stage, { resetPage: true });
  } catch (err) {
    setBadge(els.resourceBadge, "fail", "失败");
    window.alert(err.message);
  } finally {
    if (els.btnCollectResources) els.btnCollectResources.disabled = false;
  }
}

function renderSlowSqlPlaceholder(rows) {
  const list = rows?.length ? rows : [];
  if (!list.length) {
    els.slowSqlTableBody.innerHTML =
      `<tr><td colspan="5" class="placeholder">最近一轮压测无慢 SQL（≥阈值）</td></tr>`;
    return;
  }
  els.slowSqlTableBody.innerHTML = list
    .map(
      (r) => `
    <tr>
      <td class="col-scenario">${escapeHtml(r.scene || "—")}</td>
      <td>${escapeHtml(r.source || "—")}</td>
      <td class="col-metric">${escapeHtml(String(r.timeMs ?? "—"))}</td>
      <td class="col-sql" title="${escapeHtml(r.sqlText || "")}"><code>${escapeHtml(r.sqlText || "—")}</code></td>
      <td class="sub">${escapeHtml(r.startTime || "—")}</td>
    </tr>`
    )
    .join("");
}

function renderConclusions(rows, currentStage) {
  els.conclusionTableBody.innerHTML = (rows || [])
    .map((r) => {
      const cur = r.stage === currentStage ? "row-current" : "";
      return `
      <tr class="${cur}">
        <td><strong>${escapeHtml(formatStageCell(r.stage, r))}</strong></td>
        <td>${escapeHtml(r.scale)}</td>
        <td>${escapeHtml(r.conclusion || "—")}</td>
        <td class="note">${escapeHtml(r.issues || "—")}</td>
        <td>${escapeHtml(r.proceed || "—")}</td>
      </tr>`;
    })
    .join("");
}

function updatePageStatus(report) {
  const pf = report?.preflight;
  const wf = report?.workflow || {};

  if (pf) {
    if (pf.loadInProgress) {
      setTabPill(els.prepTabStatus, "running", "造数中");
      setBadge(els.preflightBadge, "warn", "造数中");
      updatePrepHint(pf);
      updateLoadHint(pf);
      return;
    }
    const ok = pf.prerequisitesOk;
    setTabPill(els.prepTabStatus, ok ? "ok" : pf.prerequisites ? "fail" : "idle", ok ? "就绪" : pf.prerequisites ? "未通过" : "未检查");
    setBadge(els.preflightBadge, ok ? "ok" : pf.prerequisites ? "fail" : "idle", ok ? "通过" : pf.prerequisites ? "未通过" : "未检查");
    updatePrepHint(pf);
    updateLoadHint(pf);
  }

  if (wf.hasData) {
    const loadOk = wf.volumeOk && wf.validationOk;
    setTabPill(els.loadTabStatus, loadOk ? "ok" : "warn", loadOk ? "达标" : "已造数");
    setBadge(els.loadBadge, loadOk ? "ok" : "warn", loadOk ? "完成" : "已执行");
  }

  const recordReady = wf.volumeOk && wf.validationOk;
  const partial = wf.hasData;
  setTabPill(
    els.resultTabStatus,
    recordReady ? "ok" : partial ? "warn" : "idle",
    recordReady ? "已核对" : partial ? "待校验" : "—"
  );
}

async function renderReport(report) {
  if (!report) return;
  lastReport = report;
  lastPreflight = report.preflight;
  savePreflightSnapshot(report);
  const stage = report.stage || els.stage.value;
  const validated = (report.section11_3 || []).some((g) => g.passed != null);

  els.stageBadge.textContent = stage;
  renderCheckList(els.preflightList, report.preflight?.prerequisites, "点击「检查前置条件」");
  renderDbSnapshot(report.preflight);
  refreshInitButton();
  renderEnvTable(report.section11_1 || {});

  await loadRecords();
  if (validated) {
    volumeViewStage = stage;
  }
  await renderResultPageForStage(volumeViewStage || stage);

  perfViewStage = stage;
  renderPerfPageForStage(perfViewStage, { resetPage: false });

  const inferred = report.preflight?.inferredStage;
  if (inferred && report.preflight?.stages?.some((s) => s.code === inferred && s.status === "match")) {
    els.stage.value = inferred;
    els.stageBadge.textContent = inferred;
  }
  updatePageStatus(report);
}

async function fetchReport(validate = false) {
  const res = await fetch("/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload(), validate, persist: validate }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "report failed");
  return data;
}

async function runPreflight() {
  if (systemBusy && pollTimer) return;
  setTabPill(els.prepTabStatus, "running", "检查中…");
  switchPage("prep");
  try {
    const report = await fetchReport(false);
    await renderReport(report);
    if (report?.preflight?.loadInProgress) {
      loadInProgress = true;
      startStatusPolling();
      setBusy(true);
    } else {
      loadInProgress = false;
      if (!pollTimer) setBusy(false);
    }
  } catch (err) {
    setTabPill(els.prepTabStatus, "fail", "失败");
    els.preflightList.innerHTML = `<p class="placeholder">${escapeHtml(err.message)}</p>`;
  }
}

async function pollJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const job = await res.json();
  if (job.action === "benchmark") {
    renderBenchLog(job.log);
  } else {
    renderLog(job.log);
  }

  if (job.status === "running") {
    setJobBadge("running");
    setBusy(true);
    if (job.action === "load") {
      startStatusPolling();
    }
    if (job.action === "benchmark") {
      setTabPill(els.perfTabStatus, "running", "执行中");
      if (activePage !== "perf") switchPage("perf");
    } else {
      setBadge(els.loadBadge, "running", "执行中");
      if (activePage !== "load") switchPage("load");
    }
    return;
  }

  clearInterval(pollTimer);
  pollTimer = null;
  await refreshSystemStatus();
  if (!loadInProgress) {
    setBusy(false);
    stopStatusPolling();
  }
  setJobBadge(job.status === "success" ? "success" : "failed");

  if (job.error) {
    const errLines = [...(job.log || []), "", `错误: ${job.error}`];
    if (job.action === "benchmark") renderBenchLog(errLines);
    else renderLog(errLines);
  }

  if (job.action === "benchmark" && job.benchmark) {
    await loadRecords();
    if (job.benchmark.stage) perfViewStage = job.benchmark.stage;
    renderBenchmarkResult(job.benchmark);
    switchPage("perf");
    return;
  }

  if (job.report) {
    await renderReport(job.report);
    switchPage("result");
  } else if (job.action === "validate" || (job.action === "load" && els.autoValidate.checked)) {
    try {
      const report = await fetchReport(true);
      await renderReport(report);
      switchPage("result");
    } catch {
      /* ignore */
    }
  } else if (job.status === "success") {
    try {
      const report = await fetchReport(false);
      await renderReport(report);
      if (job.action === "load") switchPage("result");
    } catch {
      /* ignore */
    }
  }
}

async function startBenchmark(scenarios) {
  if (pollTimer) return;
  if (!scenarios?.length) {
    window.alert("请至少勾选一个压测场景");
    return;
  }

  switchPage("perf");
  renderBenchLog([`启动 SQL 压测 [${perfViewStage}]: ${scenarios.join(", ")}…`]);
  setBusy(true);
  setJobBadge("running");
  setTabPill(els.perfTabStatus, "running", "执行中");

  const body = {
    ...payload(),
    action: "benchmark",
    stage: perfViewStage,
    scenarios,
    writeIterations: benchWriteIterationsDefault(),
    queryIterations: benchQueryIterationsDefault(),
    queryConcurrency: benchQueryConcurrencyDefault(),
    slowSqlThresholdMs: benchSlowSqlThresholdDefault(),
    perf05AggBucketMinutes: benchPerf05AggMinutesDefault(),
  };

  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    setBusy(false);
    setJobBadge("failed");
    renderBenchLog([data.error || "启动失败"]);
    return;
  }
  pollTimer = setInterval(() => pollJob(data.id), 800);
  startStatusPolling();
  pollJob(data.id);
}

async function startJob(action) {
  if (pollTimer) return;
  if (action === "init-schema" && lastPreflight?.ddlOk) {
    window.alert(lastPreflight.initBlockReason || "Schema 已初始化，禁止重复执行。");
    return;
  }
  let forceLoad = false;
  if (action === "load" && lastPreflight && !lastPreflight.readyForLoad) {
    if (!window.confirm(`${lastPreflight.loadBlockReason || "前置未通过"}。\n仍要继续造数吗？`)) return;
    forceLoad = true;
  }

  switchPage("load");
  renderLog([`正在启动: ${action}…`]);
  setBusy(true);
  setJobBadge("running");
  setBadge(els.loadBadge, "running", "执行中");

  const body = { ...payload(), action };
  if (forceLoad) body.forceLoad = true;

  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    setBusy(false);
    setJobBadge("failed");
    renderLog([data.error || "启动失败"]);
    return;
  }
  pollTimer = setInterval(() => pollJob(data.id), 800);
  if (action === "load") startStatusPolling();
  pollJob(data.id);
}

async function refreshValidate() {
  const stage = volumeViewStage || els.stage.value;
  setBadge(els.validationBadge, "running", "校验中…");
  switchPage("result");
  try {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload(), stage, validate: true, persist: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "report failed");
    await renderReport(data);
  } catch (err) {
    setBadge(els.validationBadge, "fail", "失败");
    window.alert(err.message);
  }
}

async function loadCatalog() {
  const res = await fetch("/api/stages");
  const data = await res.json();
  catalogStages = data.stages || [];
  if (stageRecords && els.conclusionTableBody) {
    renderConclusionsFromRecords(volumeViewStage || els.stage?.value || "S0");
  }
}

async function loadDefaults(dialect = null, options = {}) {
  const query = dialect ? `?dialect=${encodeURIComponent(dialect)}` : "";
  const res = await fetch(`/api/defaults${query}`);
  const d = await res.json();
  const keepStage = Boolean(options.keepStage);
  const keepLoadOptions = Boolean(options.keepLoadOptions);
  if (els.dialect && d.dialect) els.dialect.value = d.dialect;
  syncDialectSwitchUI();
  els.host.value = d.host;
  els.port.value = d.port;
  els.database.value = d.database;
  els.user.value = d.user;
  if (d.password) els.password.value = d.password;
  els.schema.value = d.schema;
  if (!keepStage) {
    els.stage.value = d.stage;
    els.stageBadge.textContent = d.stage;
  }
  if (!keepLoadOptions) {
    els.seed.value = d.seed;
    els.truncate.checked = d.truncate;
    els.autoValidate.checked = d.autoValidate;
  }
  if (d.envProfile) {
    envDraft = { ...d.envProfile };
    saveEnvDraft();
  }
  if (d.prometheusUrl) prometheusUrl = d.prometheusUrl;
  if (d.prometheusInstance) prometheusInstance = d.prometheusInstance;
  updatePerfDeleteControls();
  updateResourceDeleteControls();
}

els.pageTabs.forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

els.btnPreflight.addEventListener("click", runPreflight);
els.btnInit.addEventListener("click", () => startJob("init-schema"));
els.btnLoad.addEventListener("click", () => startJob("load"));
els.btnValidate.addEventListener("click", refreshValidate);
if (els.btnBenchAll) {
  els.btnBenchAll.addEventListener("click", () =>
    startBenchmark(Object.keys(benchConfig?.scenarios || {}))
  );
}
if (els.btnBenchSelected) {
  els.btnBenchSelected.addEventListener("click", () => startBenchmark(selectedBenchScenarios()));
}
if (els.perfPagerPrev) {
  els.perfPagerPrev.addEventListener("click", () => changePerfPage(-1));
}
if (els.perfPagerNext) {
  els.perfPagerNext.addEventListener("click", () => changePerfPage(1));
}
if (els.benchWriteIterations) {
  els.benchWriteIterations.addEventListener("change", () => renderBenchScenarios());
  els.benchWriteIterations.addEventListener("input", () => renderBenchScenarios());
}
if (els.benchQueryIterations) {
  els.benchQueryIterations.addEventListener("change", () => renderBenchScenarios());
  els.benchQueryIterations.addEventListener("input", () => renderBenchScenarios());
}
if (els.benchQueryConcurrency) {
  els.benchQueryConcurrency.addEventListener("change", () => renderBenchScenarios());
  els.benchQueryConcurrency.addEventListener("input", () => renderBenchScenarios());
}
if (els.benchSlowSqlMs) {
  els.benchSlowSqlMs.addEventListener("change", () => renderBenchScenarios());
  els.benchSlowSqlMs.addEventListener("input", () => renderBenchScenarios());
}
if (els.benchPerf05AggMinutes) {
  els.benchPerf05AggMinutes.addEventListener("change", () => renderBenchScenarios());
  els.benchPerf05AggMinutes.addEventListener("input", () => renderBenchScenarios());
}
if (els.btnCollectResources) {
  els.btnCollectResources.addEventListener("click", collectResources);
}
if (els.btnRefreshSlowSql) {
  els.btnRefreshSlowSql.addEventListener("click", () =>
    refreshSlowSqlDetails(perfViewStage || els.stage.value)
  );
}
if (els.btnDeletePerfRuns) {
  els.btnDeletePerfRuns.addEventListener("click", deleteSelectedPerfRuns);
}
if (els.btnDeleteAllPerfRuns) {
  els.btnDeleteAllPerfRuns.addEventListener("click", deleteAllPerfRuns);
}

if (els.resourcePagerPrev) {
  els.resourcePagerPrev.addEventListener("click", () => changeResourcePage(-1));
}
if (els.resourcePagerNext) {
  els.resourcePagerNext.addEventListener("click", () => changeResourcePage(1));
}
if (els.btnDeleteResourceCollects) {
  els.btnDeleteResourceCollects.addEventListener("click", deleteSelectedResourceCollects);
}
if (els.btnDeleteAllResourceCollects) {
  els.btnDeleteAllResourceCollects.addEventListener("click", deleteAllResourceCollects);
}

if (els.volumeStageTabs) {
  els.volumeStageTabs.querySelectorAll(".stage-tab").forEach((btn) => {
    btn.addEventListener("click", () => renderResultPageForStage(btn.dataset.stage));
  });
}

if (els.perfStageTabs) {
  els.perfStageTabs.querySelectorAll(".stage-tab").forEach((btn) => {
    btn.addEventListener("click", () => renderPerfPageForStage(btn.dataset.stage, { resetPage: true }));
  });
}

["dialect", "host", "port", "database", "user", "password", "schema"].forEach((id) => {
  const node = els[id];
  if (!node) return;
  node.addEventListener("change", async () => {
    if (id === "dialect") {
      await loadDefaults(activeDialect(), { keepStage: true, keepLoadOptions: true });
      syncDialectSwitchUI();
      renderToolsByDialect();
      envDraft = loadEnvDraft();
      renderEnvTable(stageRecord(els.stage.value).section11_1 || {});
      await loadRecords();
      volumeViewStage = els.stage.value;
      perfViewStage = els.stage.value;
      await renderResultPageForStage(volumeViewStage);
      renderPerfPageForStage(perfViewStage, { resetPage: true });
      refreshWorkflowStatusForCurrentDialect(els.stage.value);
      if (!restorePreflightSnapshot()) {
        lastPreflight = null;
        updatePrepHint(null);
        updateLoadHint(null);
      }
      refreshInitButton();
      setBusy(systemBusy);
      return;
    }
    clearPreflightSnapshot();
    lastPreflight = null;
    refreshInitButton();
    updatePrepHint(null);
    updateLoadHint(null);
  });
  if (node.tagName === "INPUT") {
    node.addEventListener("keyup", () => {
      clearPreflightSnapshot();
      lastPreflight = null;
      refreshInitButton();
      updatePrepHint(null);
      updateLoadHint(null);
    });
  }
});

els.dialectSwitches?.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!els.dialect) return;
    const next = btn.dataset.dialectSwitch;
    if (!next || next === els.dialect.value) return;
    els.dialect.value = next;
    els.dialect.dispatchEvent(new Event("change"));
  });
});


els.stage.addEventListener("change", () => {
  els.stageBadge.textContent = els.stage.value;
  renderBenchScenarios();
  renderSectionsFromRecords(els.stage.value);
  renderVolumeForStage(els.stage.value);
  perfViewStage = els.stage.value;
  renderPerfPageForStage(perfViewStage, { resetPage: true });
  if (lastPreflight) updateLoadHint(lastPreflight);
});

(async function init() {
  await loadDefaults();
  renderToolsByDialect();
  await loadCatalog();
  await loadBenchConfig();
  await loadRecords();
  setInterval(() => loadRecords({ silent: true }), 15000);
  await loadAllStagesMatrix();
  volumeViewStage = els.stage.value;
  perfViewStage = els.stage.value;
  renderEnvTable(stageRecord(volumeViewStage).section11_1 || {});
  renderSectionsFromRecords(volumeViewStage);
  await renderResultPageForStage(volumeViewStage);
  renderPerfPageForStage(perfViewStage, { resetPage: false });
  if (!restorePreflightSnapshot()) {
    updatePrepHint(null);
    updateLoadHint(null);
  }
  await refreshSystemStatus();
  if (loadInProgress) {
    startStatusPolling();
  }
})();
