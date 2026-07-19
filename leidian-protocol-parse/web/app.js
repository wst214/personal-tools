const input = document.querySelector("#input");
const output = document.querySelector("#output");
const statusText = document.querySelector("#status");
const frameCount = document.querySelector("#frameCount");
const crcState = document.querySelector("#crcState");
const summary = document.querySelector("#summary");
const detail = document.querySelector("#detail");
const sampleHint = document.querySelector("#sampleHint");
const sampleGrid = document.querySelector("#sampleGrid");
const parseBtn = document.querySelector("#parseBtn");
const sampleBtn = document.querySelector("#sampleBtn");
const clearBtn = document.querySelector("#clearBtn");
const copyBtn = document.querySelector("#copyBtn");
const presignBtn = document.querySelector("#presignBtn");
const presignDedupKey = document.querySelector("#presignDedupKey");
const presignExpiry = document.querySelector("#presignExpiry");
const presignUrl = document.querySelector("#presignUrl");
const presignOpenBtn = document.querySelector("#presignOpenBtn");
const presignCopyBtn = document.querySelector("#presignCopyBtn");
const presignOutput = document.querySelector("#presignOutput");
const presignSampleGrid = document.querySelector("#presignSampleGrid");
const presignDefaultsHint = document.querySelector("#presignDefaultsHint");
const presignDefaultsList = document.querySelector("#presignDefaultsList");
const presignResetBtn = document.querySelector("#presignResetBtn");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabParse = document.querySelector("#tab-parse");
const tabPresign = document.querySelector("#tab-presign");
const tabWebhook = document.querySelector("#tab-webhook");
const tabUpload = document.querySelector("#tab-upload");
const headerSubtitle = document.querySelector("#headerSubtitle");

const envProfileList = document.querySelector("#envProfileList");
const envProfileDialog = document.querySelector("#envProfileDialog");
const envProfileForm = document.querySelector("#envProfileForm");
const envDialogTitle = document.querySelector("#envDialogTitle");
const envProfileName = document.querySelector("#envProfileName");
const envMinioEndpoint = document.querySelector("#envMinioEndpoint");
const envMinioAccessKey = document.querySelector("#envMinioAccessKey");
const envMinioSecretKey = document.querySelector("#envMinioSecretKey");
const envKafkaBootstrap = document.querySelector("#envKafkaBootstrap");
const envWsUrl = document.querySelector("#envWsUrl");
const envApiBaseUrl = document.querySelector("#envApiBaseUrl");
const envResetBtn = document.querySelector("#envResetBtn");
const envDialogCancel = document.querySelector("#envDialogCancel");
const envStatus = document.querySelector("#envStatus");

const webhookPostCount = document.querySelector("#webhookPostCount");
const webhookStatus = document.querySelector("#webhookStatus");
const webhookLastTime = document.querySelector("#webhookLastTime");
const webhookConfigHint = document.querySelector("#webhookConfigHint");
const webhookConfigList = document.querySelector("#webhookConfigList");
const webhookCopyEndpointBtn = document.querySelector("#webhookCopyEndpointBtn");
const webhookAutoRefresh = document.querySelector("#webhookAutoRefresh");
const webhookOnlyPost = document.querySelector("#webhookOnlyPost");
const webhookRefreshBtn = document.querySelector("#webhookRefreshBtn");
const webhookClearBtn = document.querySelector("#webhookClearBtn");
const webhookHistory = document.querySelector("#webhookHistory");

const uploadMinioState = document.querySelector("#uploadMinioState");
const uploadDeviceState = document.querySelector("#uploadDeviceState");
const uploadLastTime = document.querySelector("#uploadLastTime");
const uploadMinioHint = document.querySelector("#uploadMinioHint");
const uploadDeviceHint = document.querySelector("#uploadDeviceHint");
const uploadMinioBucket = document.querySelector("#uploadMinioBucket");
const uploadMinioSourceDir = document.querySelector("#uploadMinioSourceDir");
const uploadMinioInterval = document.querySelector("#uploadMinioInterval");
const uploadMinioLimit = document.querySelector("#uploadMinioLimit");
const uploadMinioOnce = document.querySelector("#uploadMinioOnce");
const uploadMinioVerifyObject = document.querySelector("#uploadMinioVerifyObject");
const uploadMinioVerifyKafka = document.querySelector("#uploadMinioVerifyKafka");
const uploadMinioVerifyWs = document.querySelector("#uploadMinioVerifyWs");
const uploadMinioVerifyApi = document.querySelector("#uploadMinioVerifyApi");
const uploadMinioKafkaTopic = document.querySelector("#uploadMinioKafkaTopic");
const uploadMinioApiMinutes = document.querySelector("#uploadMinioApiMinutes");
const uploadMinioVerifyTimeout = document.querySelector("#uploadMinioVerifyTimeout");
const uploadMinioResetBtn = document.querySelector("#uploadMinioResetBtn");
const uploadMinioDryBtn = document.querySelector("#uploadMinioDryBtn");
const uploadMinioBtn = document.querySelector("#uploadMinioBtn");
const uploadMinioOutput = document.querySelector("#uploadMinioOutput");
const uploadMinioResult = document.querySelector("#uploadMinioResult");
const uploadMinioObjectVerify = document.querySelector("#uploadMinioObjectVerify");
const uploadMinioKafkaVerify = document.querySelector("#uploadMinioKafkaVerify");
const uploadMinioVerify = document.querySelector("#uploadMinioVerify");
const uploadMinioApiVerify = document.querySelector("#uploadMinioApiVerify");
const uploadDeviceTopic = document.querySelector("#uploadDeviceTopic");
const uploadDeviceLimit = document.querySelector("#uploadDeviceLimit");
const uploadDeviceSleepMs = document.querySelector("#uploadDeviceSleepMs");
const uploadDeviceHexWrap = document.querySelector("#uploadDeviceHexWrap");
const uploadDeviceHex = document.querySelector("#uploadDeviceHex");
const uploadDeviceFileWrap = document.querySelector("#uploadDeviceFileWrap");
const uploadDeviceFilePath = document.querySelector("#uploadDeviceFilePath");
const uploadDeviceVerifyKafka = document.querySelector("#uploadDeviceVerifyKafka");
const uploadDeviceVerifyTimeout = document.querySelector("#uploadDeviceVerifyTimeout");
const uploadDeviceSampleGrid = document.querySelector("#uploadDeviceSampleGrid");
const uploadDeviceResetBtn = document.querySelector("#uploadDeviceResetBtn");
const uploadDeviceBtn = document.querySelector("#uploadDeviceBtn");
const uploadDeviceOutput = document.querySelector("#uploadDeviceOutput");
const uploadDeviceResult = document.querySelector("#uploadDeviceResult");
const uploadDeviceVerify = document.querySelector("#uploadDeviceVerify");
const uploadDeviceSourceRadios = document.querySelectorAll('input[name="uploadDeviceSource"]');

/** Secret Key 未改时使用服务端环境变量（输入框展示用文案）。 */
const PRESIGN_SECRET_BUILTIN_LABEL = "（环境变量，无需填写）";
const ENV_STORAGE_KEY = "leidian-env-config-v1";
const ENV_PROFILES_STORAGE_KEY = "leidian-env-profiles-v2";

const presignFields = [presignDedupKey, presignExpiry];
const envFields = [
  envMinioEndpoint,
  envMinioAccessKey,
  envMinioSecretKey,
  envKafkaBootstrap,
  envWsUrl,
  envApiBaseUrl,
];

/** @type {{ id: string, name: string, minioEndpoint: string, minioAccessKey: string, minioSecretKey: string, kafkaBootstrap: string, wsUrl: string, apiBaseUrl: string }[]} */
let envProfiles = [];
let activeEnvId = "";
let editingEnvId = null;

const samples = [
  { id: "01", name: "低误报雷暴预警仪", command: "0001", hex: "5A 4B 14 01 00 01 00 35 00 01 00 05 00 05 00 19 04 A4 06 1E 00 00 04 11 57 0D 0A" },
  { id: "19", name: "GPS版低误报雷暴预警仪", command: "0001", hex: "5A 4B 41 19 00 19 00 04 00 01 00 61 00 61 00 00 04 B8 03 59 00 01 00 02 07 EA 00 05 00 0D 00 0C 00 32 00 38 00 45 CD 6C D4 42 00 4E 3C C5 19 42 38 39 38 36 30 34 34 36 31 30 32 35 37 30 35 32 31 38 31 39 B8 2B 0D 0A" },
  { id: "03", name: "接地电阻监测仪", command: "0001", hex: "5A 4B 11 03 00 01 00 01 00 01 00 10 00 1A 00 3C 00 07 03 E8 36 C9 0D 0A" },
  { id: "0F", name: "智能监测型iSPD/PDU", command: "0001", hex: "5A 4B 17 0F 00 04 00 01 00 01 00 00 00 00 08 17 08 C8 09 C4 09 50 10 82 01 11 13 D7 0D 0A" },
  { id: "05", name: "雷电流峰值监测仪", command: "0001", hex: "5A 4B 14 05 00 05 00 01 00 01 20 00 07 E3 09 12 14 00 00 00 01 17 A3 88 C0 0D 0A" },
  { id: "15", name: "GPS版本雷电流智能监测仪", command: "0001", hex: "5A 4B 3D 15 80 05 04 56 00 01 F3 DC 07 E8 0B 0A 08 24 00 00 00 00 00 1A 6A 07 E8 0B 0A 08 25 0F 00 00 94 0F 19 42 4E 0C 42 D4 42 45 38 39 38 36 30 34 46 32 31 30 32 33 37 31 30 34 33 31 30 33 54 75 0D 0A" },
  { id: "09", name: "智能断接卡", command: "0001", hex: "5A 4B 0A 09 00 09 00 01 00 01 01 02 C6 DE 17 0D 0A" },
  { id: "10", name: "定位仪远程监测控制终端", command: "0001", hex: "5A 4B 2C 10 00 10 00 01 00 01 01 43 5C 00 00 3F C0 00 00 43 A5 00 00 3F 73 33 33 42 48 00 00 44 9A 51 EC 00 01 01 01 09 98 04 B1 02 6C 01 F7 16 FF 0D 0A" },
  { id: "17", name: "电源控制板", command: "0001", hex: "5A 4B 22 17 17 00 00 28 00 01 3A A9 5C 43 2F 94 17 BE 02 89 86 04 19 15 24 D0 15 87 47 00 E9 28 1E 01 00 00 41 29 A1 0D 0A" },
  { id: "14", name: "避雷器在线监测仪", command: "000A", hex: "5A 4B 14 14 00 14 00 01 00 0A FF 4A 07 E7 0A 1B 10 1C 07 00 00 00 33 23 86 0D 0A" },
  { id: "18", name: "SPD多重雷击波形监测", command: "0001", hex: "5A 4B 23 18 00 18 00 01 00 01 38 39 38 36 30 37 42 34 30 33 32 35 44 30 30 31 37 30 39 39 3C 07 E9 06 14 11 12 21 83 51 0D 0A" },
];

const fieldMeta = {
  instantValue: ["瞬时电场值", "kV/m", "int16", "原始值直接使用，支持负数"],
  averageValue: ["平均电场值", "kV/m", "int16", "原始值直接使用，支持负数"],
  changeRate: ["电场变化率", "kV/m", "int16", "原始值直接使用，支持负数"],
  deviceVoltage: ["设备电压", "V", "uint16", "raw / 100"],
  motorSpeed: ["电机转速", "rpm", "uint16", "原始值直接使用"],
  warningLevel: ["预警等级", "级", "uint16", "0-5级"],
  circuitNumber: ["放大电阻选择", "-", "hex", "1字节HEX"],
  gpsTimeType: ["时间类别", "-", "uint16", "1=GPS时间，2=系统时钟"],
  year: ["年", "年", "uint16", "HEX转十进制"],
  month: ["月", "月", "uint8/uint16", "HEX转十进制"],
  day: ["日", "日", "uint8/uint16", "HEX转十进制"],
  hour: ["时", "时", "uint8/uint16", "HEX转十进制"],
  minute: ["分", "分", "uint8/uint16", "HEX转十进制"],
  second: ["秒", "秒", "uint8/uint16", "HEX转十进制"],
  millisecond: ["毫秒", "ms", "uint16", "HEX转十进制"],
  longitudeDirection: ["经度方向", "-", "ASCII", "E/W"],
  longitude: ["经度", "deg", "float32", "IEEE754浮点，保留6位小数"],
  latitudeDirection: ["纬度方向", "-", "ASCII", "N/S"],
  latitude: ["纬度", "deg", "float32", "IEEE754浮点，保留6位小数"],
  card: ["物联网卡ICCID", "-", "ASCII", "20字节ASCII"],
  resistanceValue: ["接地电阻值", "ohm", "uint16", "原始值直接使用"],
  temperature: ["温度", "C", "uint16", "原始值直接使用"],
  humidity: ["湿度", "%RH", "uint16", "按设备协议解释"],
  phValue: ["PH值", "-", "uint16", "原始值直接使用"],
  soilResistivity: ["土壤电阻率", "ohm*m", "uint16", "原始值直接使用"],
  strikeCount: ["雷击次数", "次", "uint16", "原始值直接使用"],
  strikeCurrent: ["雷击电流", "kA", "int16/uint16", "按设备类型换算"],
  leakageCurrent: ["漏电流", "uA/mA", "uint16", "0F: raw/10 uA；14: raw/10"],
  ambientTemperature: ["环境温度", "C", "uint16", "raw / 100"],
  targetTemperature: ["目标温度", "C", "uint16", "raw / 100"],
  workingVoltage: ["工作电压", "V", "uint16", "raw / 10"],
  switchStatus: ["开关状态", "-", "uint16", "位标志，按协议位定义解释"],
  lightningStrikeCurrent: ["雷击电流", "kA", "uint16", "raw / 100"],
  lightningStrikeNum: ["雷击次数", "次", "uint16", "原始值直接使用"],
  batteryVoltage: ["电池电压", "V", "uint16", "raw / 1000 或设备专用缩放"],
  realYear: ["实时年", "年", "uint16", "GPS实时时间"],
  realMonth: ["实时月", "月", "uint8", "GPS实时时间"],
  realDay: ["实时日", "日", "uint8", "GPS实时时间"],
  realHour: ["实时时", "时", "uint8", "GPS实时时间"],
  realMinute: ["实时分", "分", "uint8", "GPS实时时间"],
  realSecond: ["实时秒", "秒", "uint8", "GPS实时时间"],
  realMillisecond: ["实时毫秒", "ms", "uint16", "GPS实时时间"],
  disconnectStatus: ["断接状态", "-", "uint8", "0/1状态值"],
  powerSupplyType: ["供电类型", "-", "uint8", "设备协议枚举"],
  voltage: ["交流电压", "V", "float32", "IEEE754大端浮点"],
  current: ["交流电流", "A", "float32", "IEEE754大端浮点"],
  activePower: ["有功功率", "W", "float32", "IEEE754大端浮点"],
  powerFactor: ["功率因数", "-", "float32", "IEEE754大端浮点"],
  frequency: ["频率", "Hz", "float32", "IEEE754大端浮点"],
  totalActiveEnergy: ["总有功电能", "kWh", "float32", "IEEE754大端浮点"],
  relayNc: ["常闭继电器", "-", "uint8", "0/1状态值"],
  relay24v: ["24V继电器", "-", "uint8", "0/1状态值"],
  relay12v: ["12V继电器", "-", "uint8", "0/1状态值"],
  relay6v: ["6V继电器", "-", "uint8", "0/1状态值"],
  dcVoltage24v: ["24V直流电压", "V", "uint16", "raw / 100"],
  dcVoltage12v: ["12V直流电压", "V", "uint16", "raw / 100"],
  dcVoltage6v: ["6V直流电压", "V", "uint16", "raw / 100"],
  dcVoltage5v: ["5V直流电压", "V", "uint16", "raw / 100"],
  voltage15v: ["15V电压", "V", "uint16", "raw / 1000"],
  voltage24v: ["24V电压", "V", "uint16", "raw / 1000"],
  voltage12v: ["12V电压", "V", "uint16", "raw / 1000"],
  voltage6v: ["6V电压", "V", "uint16", "raw / 1000"],
  uploadFrequency: ["上传频率", "-", "uint8", "设备协议配置值"],
  iccidHex: ["ICCID原始HEX", "-", "hex", "原始HEX片段"],
  deviceTemperature: ["设备温度", "C", "int16", "raw / 10"],
  fanStartTemperature: ["风扇启动温度", "C", "uint8", "原始值直接使用"],
  fanStopTemperature: ["风扇停止温度", "C", "uint8", "原始值直接使用"],
  fanControlStatus: ["风扇控制状态", "-", "uint8", "设备协议枚举"],
  version: ["版本号", "-", "uint8", "原始值直接使用"],
  messageKind: ["消息类型", "-", "enum", "HEARTBEAT=心跳，WAVEFORM=波形"],
  positivePeakCurrent: ["正峰值电流", "A", "uint16", "raw * 量程因子"],
  negativePeakCurrent: ["负峰值电流", "A", "uint16", "raw * 量程因子"],
  positiveAccumulatedValue: ["正累计值", "-", "uint32", "原始值直接使用"],
  negativeAccumulatedValue: ["负累计值", "-", "uint32", "原始值直接使用"],
  rangeType: ["量程类型", "-", "hex", "01=小量程，02=大量程"],
  heartbeatFrequencyMinutes: ["心跳频率", "分钟", "uint8", "原始值直接使用"],
  waveformHex: ["波形数据", "-", "hex", "2014字节波形数据块"],
};

const groups = [
  { title: "电场数据", keys: ["instantValue", "averageValue", "changeRate", "deviceVoltage", "motorSpeed", "warningLevel", "circuitNumber"] },
  { title: "GPS信息", keys: ["gpsTimeType", "year", "month", "day", "hour", "minute", "second", "millisecond", "longitudeDirection", "longitude", "latitudeDirection", "latitude", "card"] },
  { title: "接地数据", keys: ["resistanceValue", "temperature", "humidity", "phValue", "soilResistivity"] },
  { title: "雷击与电气数据", keys: ["strikeCount", "strikeCurrent", "lightningStrikeCurrent", "lightningStrikeNum", "batteryVoltage", "leakageCurrent", "ambientTemperature", "targetTemperature", "workingVoltage", "switchStatus"] },
  { title: "实时定位数据", keys: ["realYear", "realMonth", "realDay", "realHour", "realMinute", "realSecond", "realMillisecond", "latitude", "latitudeDirection", "longitude", "longitudeDirection", "card"] },
  { title: "终端电参", keys: ["disconnectStatus", "powerSupplyType", "voltage", "current", "activePower", "powerFactor", "frequency", "totalActiveEnergy", "relayNc", "relay24v", "relay12v", "relay6v", "dcVoltage24v", "dcVoltage12v", "dcVoltage6v", "dcVoltage5v"] },
  { title: "电源板数据", keys: ["voltage15v", "voltage24v", "voltage12v", "voltage6v", "uploadFrequency", "iccidHex", "deviceTemperature", "fanStartTemperature", "fanStopTemperature", "fanControlStatus", "version"] },
  { title: "SPD波形/心跳", keys: ["messageKind", "rangeType", "positivePeakCurrent", "negativePeakCurrent", "positiveAccumulatedValue", "negativeAccumulatedValue", "heartbeatFrequencyMinutes", "waveformHex"] },
];

let latestJson = "{}";
let parseTimer = null;
let activeSampleId = null;
let presignDefaults = null;
let activePresignSampleId = null;
let webhookConfig = null;
let webhookEvents = [];
let webhookExpandedId = null;
let webhookRefreshTimer = null;
let uploadDefaults = null;
let uploadSelectedSampleIds = new Set();

const uploadMinioFields = [
  uploadMinioBucket,
  uploadMinioSourceDir,
  uploadMinioInterval,
  uploadMinioLimit,
];

const TAB_SUBTITLES = {
  parse: "粘贴 HEX 报文，查看帧结构与字段说明",
  presign: "MinIO 私有桶临时下载链接；使用顶部当前启用的环境",
  webhook: "接收 MinIO 上传 Webhook，查看 POST 请求体 JSON",
  upload: "MinIO 雷达帧上传与设备报文 Kafka 联调测试",
};

renderSampleButtons();
initTabs();
initPresignFieldBehavior();
initEnvPanel();
initWebhookPanel();
initUploadPanel();
loadPresignDefaults();
loadEnvDefaults();

parseBtn.addEventListener("click", parse);
input.addEventListener("input", () => {
  activeSampleId = null;
  updateActiveSample();
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parse, 220);
});
sampleBtn.addEventListener("click", () => loadSample(samples[0].id));
clearBtn.addEventListener("click", () => {
  input.value = "";
  activeSampleId = null;
  updateActiveSample();
  resetView();
});
copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(latestJson);
  copyBtn.textContent = "已复制";
  setTimeout(() => {
    copyBtn.textContent = "复制 JSON";
  }, 900);
});

presignBtn.addEventListener("click", generatePresign);
presignResetBtn.addEventListener("click", () => {
  activePresignSampleId = null;
  updateActivePresignSample();
  applyPresignBuiltinToForm();
});
presignOpenBtn.addEventListener("click", () => {
  const url = presignUrl.value.trim();
  if (url) window.open(url, "_blank", "noopener,noreferrer");
});
presignCopyBtn.addEventListener("click", async () => {
  const url = presignUrl.value.trim();
  if (!url) return;
  await navigator.clipboard.writeText(url);
  presignCopyBtn.textContent = "已复制";
  setTimeout(() => {
    presignCopyBtn.textContent = "复制 URL";
  }, 900);
});

function initTabs() {
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
}

function switchTab(tabId) {
  tabButtons.forEach((button) => {
    const active = button.dataset.tab === tabId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  tabParse.classList.toggle("active", tabId === "parse");
  tabParse.hidden = tabId !== "parse";
  tabPresign.classList.toggle("active", tabId === "presign");
  tabPresign.hidden = tabId !== "presign";
  tabWebhook.classList.toggle("active", tabId === "webhook");
  tabWebhook.hidden = tabId !== "webhook";
  tabUpload.classList.toggle("active", tabId === "upload");
  tabUpload.hidden = tabId !== "upload";
  headerSubtitle.textContent = TAB_SUBTITLES[tabId] ?? TAB_SUBTITLES.parse;

  if (tabId === "webhook") {
    loadWebhookEvents();
    startWebhookAutoRefresh();
  } else {
    stopWebhookAutoRefresh();
  }

  if (tabId === "upload" && !uploadDefaults) {
    loadUploadDefaults();
  }
}

function initWebhookPanel() {
  webhookRefreshBtn?.addEventListener("click", loadWebhookEvents);
  webhookClearBtn?.addEventListener("click", clearWebhookEvents);
  webhookOnlyPost?.addEventListener("change", () => renderWebhookHistory(webhookEvents));
  webhookCopyEndpointBtn?.addEventListener("click", copyWebhookEndpoint);
  loadWebhookConfig();
}

function startWebhookAutoRefresh() {
  stopWebhookAutoRefresh();
  webhookRefreshTimer = setInterval(() => {
    if (webhookAutoRefresh?.checked && !tabWebhook.hidden) {
      loadWebhookEvents();
    }
  }, 3000);
}

function stopWebhookAutoRefresh() {
  if (webhookRefreshTimer) {
    clearInterval(webhookRefreshTimer);
    webhookRefreshTimer = null;
  }
}

async function loadWebhookConfig() {
  try {
    const response = await fetch("/api/webhook/config");
    webhookConfig = await response.json();
    webhookConfigHint.textContent = webhookConfig.hint ?? "";
    const rows = [
      ["本机 MinIO 配置", webhookConfig.minioMcEndpoint],
      ["Compose 同网", webhookConfig.dockerReceiveUrl],
      ["当前访问", webhookConfig.localReceiveUrl],
      ["路径", webhookConfig.primaryPath],
    ];
    webhookConfigList.innerHTML = rows
      .map(
        ([label, value]) => `
        <div class="webhook-config-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value ?? "")}</dd>
        </div>`,
      )
      .join("");
  } catch {
    webhookConfigHint.textContent = "无法加载配置，请确认服务已启动";
  }
}

async function copyWebhookEndpoint() {
  const url = webhookConfig?.minioMcEndpoint ?? webhookConfig?.localReceiveUrl ?? "";
  if (!url) return;
  await navigator.clipboard.writeText(url);
  webhookCopyEndpointBtn.textContent = "已复制";
  setTimeout(() => {
    webhookCopyEndpointBtn.textContent = "复制 URL";
  }, 900);
}

async function loadWebhookEvents() {
  try {
    const onlyPost = webhookOnlyPost?.checked ? "1" : "0";
    const response = await fetch(`/api/webhook/events?onlyPost=${onlyPost}`);
    const data = await response.json();
    webhookEvents = data.events ?? [];
    webhookPostCount.textContent = String(data.postCount ?? 0);
    webhookLastTime.textContent = data.lastPostAt ?? "—";
    const received = (data.postCount ?? 0) > 0;
    webhookStatus.textContent = received ? "已收到" : "等待中";
    webhookStatus.className = received ? "pass" : "warn";
    renderWebhookHistory(webhookEvents);
  } catch {
    webhookStatus.textContent = "服务未响应";
    webhookStatus.className = "warn";
  }
}

function renderWebhookHistory(list) {
  const onlyPost = webhookOnlyPost?.checked;
  const filtered = onlyPost ? list.filter((e) => e.method === "POST") : list;
  if (!filtered.length) {
    webhookHistory.className = "webhook-history empty";
    webhookHistory.innerHTML = "<span>暂无记录，向 uploads/ 上传文件后显示</span>";
    return;
  }
  webhookHistory.className = "webhook-history";
  webhookHistory.innerHTML = filtered
    .map((event, idx) => {
      const expanded = webhookExpandedId === event.id;
      const body = event.bodyPretty || event.body || "";
      return `
        <article class="webhook-entry">
          <button type="button" class="webhook-row${expanded ? " expanded" : ""}" data-webhook-id="${escapeHtml(event.id)}">
            <span class="webhook-row-chevron" aria-hidden="true">${expanded ? "▼" : "▶"}</span>
            <span class="webhook-row-no">${filtered.length - idx}</span>
            <span class="pill ${event.method === "POST" ? "good" : ""}">${event.method}</span>
            <span class="webhook-row-time">${escapeHtml(event.receivedAt)}</span>
            <span class="webhook-row-key">${escapeHtml(event.objectKey || event.path)}</span>
            <span class="webhook-row-size">${event.bodyLength} B</span>
          </button>
          <pre class="webhook-json-inline${expanded ? " is-open" : ""}">${expanded ? escapeHtml(body) : ""}</pre>
        </article>
      `;
    })
    .join("");

  webhookHistory.querySelectorAll("[data-webhook-id]").forEach((row) => {
    row.addEventListener("click", () => toggleWebhookDetail(row.dataset.webhookId));
  });
}

function toggleWebhookDetail(id) {
  webhookExpandedId = webhookExpandedId === id ? null : id;
  renderWebhookHistory(webhookEvents);
}

async function clearWebhookEvents() {
  await fetch("/api/webhook/events", { method: "DELETE" });
  webhookExpandedId = null;
  await loadWebhookEvents();
}

function initUploadPanel() {
  uploadMinioResetBtn?.addEventListener("click", applyUploadMinioBuiltin);
  uploadMinioDryBtn?.addEventListener("click", () => runMinioUpload(true));
  uploadMinioBtn?.addEventListener("click", () => runMinioUpload(false));
  uploadDeviceResetBtn?.addEventListener("click", applyUploadDeviceBuiltin);
  uploadDeviceBtn?.addEventListener("click", runDeviceUpload);
  uploadDeviceSourceRadios.forEach((radio) => {
    radio.addEventListener("change", syncUploadDeviceSourceUi);
  });
  initUploadFieldBehavior();
}

function initUploadFieldBehavior() {
  uploadMinioFields.forEach((field) => {
    if (!field) return;
    field.addEventListener("focus", () => {
      if (!field.classList.contains("is-builtin")) return;
      field.classList.remove("is-builtin");
      requestAnimationFrame(() => field.select());
    });
    field.addEventListener("blur", () => {
      const builtin = getUploadMinioBuiltinValue(field);
      if (!String(field.value).trim() && builtin !== undefined) {
        field.value = builtin;
        field.classList.add("is-builtin");
      }
    });
  });
}

function getUploadMinioBuiltinValue(field) {
  const builtin = uploadDefaults?.minio;
  if (!builtin) return undefined;
  switch (field?.id) {
    case "uploadMinioBucket":
      return builtin.bucket ?? "";
    case "uploadMinioSourceDir":
      return builtin.sourceDir ?? "";
    case "uploadMinioInterval":
      return String(builtin.interval ?? 20);
    case "uploadMinioLimit":
      return String(builtin.limit ?? 0);
    default:
      return undefined;
  }
}

function applyUploadMinioBuiltin() {
  const builtin = uploadDefaults?.minio;
  if (!builtin) return;
  uploadMinioBucket.value = builtin.bucket ?? "";
  uploadMinioSourceDir.value = builtin.sourceDir ?? "";
  uploadMinioInterval.value = String(builtin.interval ?? 20);
  uploadMinioLimit.value = String(builtin.limit ?? 0);
  uploadMinioOnce.checked = false;
  uploadMinioVerifyObject.checked = builtin.verifyMinio !== false;
  uploadMinioVerifyKafka.checked = builtin.verifyKafka !== false;
  uploadMinioVerifyWs.checked = builtin.verifyWebSocket !== false;
  uploadMinioVerifyApi.checked = builtin.verifyApi !== false;
  uploadMinioKafkaTopic.value = builtin.kafkaTopic ?? "";
  uploadMinioApiMinutes.value = String(builtin.apiMinutes ?? 60);
  uploadMinioVerifyTimeout.value = String(Math.round((builtin.verifyTimeoutMs ?? 30000) / 1000));
  uploadMinioFields.forEach((field) => field?.classList.add("is-builtin"));
}

function applyUploadDeviceBuiltin() {
  const builtin = uploadDefaults?.device;
  if (!builtin) return;
  uploadDeviceTopic.value = builtin.topic ?? "";
  uploadDeviceLimit.value = String(builtin.limit ?? 0);
  uploadDeviceSleepMs.value = String(builtin.sleepMs ?? 0);
  uploadDeviceVerifyKafka.checked = builtin.verifyKafka !== false;
  uploadDeviceVerifyTimeout.value = String(Math.round((builtin.verifyTimeoutMs ?? 15000) / 1000));
  uploadDeviceFilePath.value = "";
  uploadDeviceHex.value = "";
  document.querySelector('input[name="uploadDeviceSource"][value="builtin"]')?.click();
  uploadSelectedSampleIds = new Set((builtin.samples ?? []).map((item) => item.id));
  renderUploadDeviceSamples();
  syncUploadDeviceSourceUi();
}

async function loadUploadDefaults() {
  try {
    const response = await fetch("/api/upload-test/defaults");
    uploadDefaults = await response.json();
    uploadMinioHint.textContent = uploadDefaults.minio?.hint ?? "";
    uploadDeviceHint.textContent = uploadDefaults.device?.hint ?? "";
    uploadSelectedSampleIds = new Set((uploadDefaults.device?.samples ?? []).map((item) => item.id));
    applyUploadMinioBuiltin();
    applyUploadDeviceBuiltin();
    renderUploadDeviceSamples();
  } catch {
    uploadMinioHint.textContent = "无法加载配置，请确认服务已启动";
    uploadDeviceHint.textContent = "无法加载配置，请确认服务已启动";
  }
}

function renderUploadDeviceSamples() {
  const list = uploadDefaults?.device?.samples ?? samples.map((item) => ({ id: item.id, name: item.name }));
  if (!uploadDeviceSampleGrid) return;
  uploadDeviceSampleGrid.innerHTML = list
    .map(
      (item) => `
    <button class="sample-card${uploadSelectedSampleIds.has(item.id) ? " active" : ""}" type="button" data-upload-sample-id="${item.id}">
      <span>${item.id}</span>
      <strong>${escapeHtml(item.name)}</strong>
    </button>
  `,
    )
    .join("");
  uploadDeviceSampleGrid.querySelectorAll("[data-upload-sample-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.uploadSampleId;
      if (uploadSelectedSampleIds.has(id)) {
        uploadSelectedSampleIds.delete(id);
      } else {
        uploadSelectedSampleIds.add(id);
      }
      renderUploadDeviceSamples();
    });
  });
  const source = getUploadDeviceSource();
  uploadDeviceSampleGrid.hidden = source !== "builtin";
}

function getUploadDeviceSource() {
  return document.querySelector('input[name="uploadDeviceSource"]:checked')?.value ?? "builtin";
}

function syncUploadDeviceSourceUi() {
  const source = getUploadDeviceSource();
  uploadDeviceHexWrap.hidden = source !== "hex";
  uploadDeviceFileWrap.hidden = source !== "file";
  uploadDeviceSampleGrid.hidden = source !== "builtin";
}

function buildMinioUploadPayload(dryRun) {
  const env = readEnvForm();
  const payload = {
    endpoint: env.minioEndpoint,
    accessKey: env.minioAccessKey,
    bucket: uploadMinioBucket.value.trim(),
    sourceDir: uploadMinioSourceDir.value.trim(),
    interval: Number(uploadMinioInterval.value),
    limit: Number(uploadMinioLimit.value),
    once: uploadMinioOnce.checked,
    dryRun,
    verifyMinio: uploadMinioVerifyObject?.checked !== false,
    verifyKafka: uploadMinioVerifyKafka?.checked === true,
    verifyWebSocket: uploadMinioVerifyWs.checked,
    verifyApi: uploadMinioVerifyApi?.checked !== false,
    kafkaBootstrap: env.kafkaBootstrap,
    kafkaTopic: uploadMinioKafkaTopic?.value.trim() || "",
    wsUrl: env.wsUrl,
    apiBaseUrl: env.apiBaseUrl,
    apiMinutes: Number(uploadMinioApiMinutes?.value || 60),
    verifyTimeoutMs: Number(uploadMinioVerifyTimeout.value) * 1000,
  };
  if (env.minioSecretKey) {
    payload.secretKey = env.minioSecretKey;
  }
  return payload;
}

function buildDeviceUploadPayload() {
  const source = getUploadDeviceSource();
  const env = readEnvForm();
  const payload = {
    bootstrapServers: env.kafkaBootstrap,
    topic: uploadDeviceTopic.value.trim(),
    limit: Number(uploadDeviceLimit.value),
    sleepMs: Number(uploadDeviceSleepMs.value),
    verifyKafka: uploadDeviceVerifyKafka.checked,
    verifyTimeoutMs: Number(uploadDeviceVerifyTimeout.value) * 1000,
    source,
  };
  if (source === "hex") {
    payload.hexText = uploadDeviceHex.value;
  } else if (source === "file") {
    payload.filePath = uploadDeviceFilePath.value.trim();
  } else if (uploadSelectedSampleIds.size) {
    payload.sampleIds = [...uploadSelectedSampleIds];
  }
  return payload;
}

function stampUploadLastTime() {
  const now = new Date();
  uploadLastTime.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDeviceUploadState(result, failed = false) {
  const base = `已发送 ${result.sent ?? 0} 条`;
  if (!result.verify) {
    return failed ? `失败` : `PASS`;
  }
  return result.verify.ok && !failed ? "PASS" : "WARN";
}

function shortKey(value, head = 18, tail = 10) {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function renderMinioResult(result, dryRun) {
  if (!uploadMinioResult) return;
  if (dryRun) {
    const planned = result.planned ?? [];
    uploadMinioResult.className = planned.length ? "upload-result" : "upload-result empty";
    uploadMinioResult.innerHTML = planned.length
      ? `
      <div class="upload-result-card">
        <div class="upload-result-head">
          <strong>预检通过</strong>
          <span class="pill good">可上传 ${planned.length} 帧</span>
        </div>
        <div class="upload-result-meta">
          <div class="upload-verify-row"><dt>目录</dt><dd title="${escapeHtml(result.sourceDir ?? "")}">${escapeHtml(result.sourceDir ?? "—")}</dd></div>
          <div class="upload-verify-row"><dt>首帧 Key</dt><dd title="${escapeHtml(planned[0]?.objectKey ?? "")}">${escapeHtml(shortKey(planned[0]?.objectKey ?? ""))}</dd></div>
        </div>
      </div>`
      : "<span>没有可上传帧</span>";
    return;
  }

  const rows = result.results ?? [];
  if (!rows.length) {
    uploadMinioResult.className = "upload-result empty";
    uploadMinioResult.innerHTML = `<span>${escapeHtml(result.error ?? "无上传结果")}</span>`;
    return;
  }

  uploadMinioResult.className = "upload-result";
  uploadMinioResult.innerHTML = `
    <div class="upload-result-card ${result.failed ? "warn" : ""}">
      <div class="upload-result-head">
        <strong>上传完成</strong>
        <span class="pill ${result.failed ? "warn" : "good"}">${result.success ?? 0} 成功 / ${result.failed ?? 0} 失败</span>
      </div>
    </div>
    ${rows.map((row) => `
      <div class="upload-result-card ${row.status === "success" ? "" : "warn"}">
        <div class="upload-result-head">
          <strong>#${row.index} ${escapeHtml(row.fileName ?? "")}</strong>
          <span class="pill ${row.status === "success" ? "good" : "warn"}">${row.status === "success" ? "上传成功" : "上传失败"}</span>
        </div>
        <div class="upload-result-meta">
          <div class="upload-verify-row"><dt>traceId</dt><dd title="${escapeHtml(row.traceId ?? "")}">${escapeHtml(shortKey(row.traceId ?? ""))}</dd></div>
          <div class="upload-verify-row"><dt>objectKey</dt><dd title="${escapeHtml(row.objectKey ?? "")}">${escapeHtml(shortKey(row.objectKey ?? ""))}</dd></div>
          <div class="upload-verify-row"><dt>耗时</dt><dd>${row.durationMs ?? "—"} ms</dd></div>
        </div>
      </div>
    `).join("")}
  `;
}

function renderMinioVerify(result, enabled) {
  if (!uploadMinioVerify) return;
  if (!enabled) {
    uploadMinioVerify.className = "upload-verify empty";
    uploadMinioVerify.innerHTML = "<span>未启用验证</span>";
    return;
  }
  if (!result?.verify) {
    uploadMinioVerify.className = "upload-verify empty";
    uploadMinioVerify.innerHTML = "<span>本次未执行 WebSocket 验证</span>";
    return;
  }

  const verify = result.verify;
  const matched = verify.matched ?? [];
  uploadMinioVerify.className = "upload-verify";
  if (!matched.length) {
    uploadMinioVerify.innerHTML = `
      <div class="upload-verify-card warn">
        <div class="upload-verify-head">
          <strong>未收到 RADAR_FRAME_READY</strong>
          <span class="pill warn">${verify.timedOut ? "超时" : "失败"}</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒</dd></div>
          <div class="upload-verify-row"><dt>地址</dt><dd title="${escapeHtml(verify.wsUrl ?? "")}">${escapeHtml(shortKey(verify.wsUrl ?? "", 24, 16))}</dd></div>
          ${verify.error ? `<div class="upload-verify-row"><dt>原因</dt><dd>${escapeHtml(verify.error)}</dd></div>` : ""}
        </div>
      </div>`;
    return;
  }

  uploadMinioVerify.innerHTML = matched.map((item) => `
    <div class="upload-verify-card pass">
      <div class="upload-verify-head">
        <strong>${escapeHtml(item.frameId ?? "RADAR_FRAME_READY")}</strong>
        <span class="pill good">PASS</span>
      </div>
      <div class="upload-verify-meta">
        <div class="upload-verify-row"><dt>traceId</dt><dd title="${escapeHtml(item.traceId ?? "")}">${escapeHtml(shortKey(item.traceId ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>objectKey</dt><dd title="${escapeHtml(item.objectKey ?? "")}">${escapeHtml(shortKey(item.objectKey ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒</dd></div>
      </div>
    </div>
  `).join("");
}

function renderDeviceResult(result) {
  if (!uploadDeviceResult) return;
  const rows = result.results ?? [];
  if (!rows.length) {
    uploadDeviceResult.className = "upload-result empty";
    uploadDeviceResult.innerHTML = `<span>${escapeHtml(result.error ?? "无发送结果")}</span>`;
    return;
  }

  uploadDeviceResult.className = "upload-result";
  uploadDeviceResult.innerHTML = `
    <div class="upload-result-card ${result.ok ? "" : "warn"}">
      <div class="upload-result-head">
        <strong>发送完成</strong>
        <span class="pill ${result.ok ? "good" : "warn"}">${result.sent ?? rows.length} 条</span>
      </div>
      <div class="upload-result-meta">
        <div class="upload-verify-row"><dt>Topic</dt><dd>${escapeHtml(result.topic ?? "—")}</dd></div>
        <div class="upload-verify-row"><dt>Bootstrap</dt><dd>${escapeHtml(result.bootstrapServers ?? "—")}</dd></div>
      </div>
    </div>
    ${rows.map((row) => `
      <div class="upload-result-card">
        <div class="upload-result-head">
          <strong>#${row.index} ${escapeHtml(row.deviceName ?? row.deviceId ?? "设备报文")}</strong>
          <span class="pill good">已发送</span>
        </div>
        <div class="upload-result-meta">
          <div class="upload-verify-row"><dt>HEX</dt><dd title="${escapeHtml(row.hex ?? row.hexPreview ?? "")}">${escapeHtml(row.hexPreview ?? shortKey(row.hex ?? ""))}</dd></div>
          <div class="upload-verify-row"><dt>offset</dt><dd>${row.partition ?? "—"} / ${row.offset ?? "—"}</dd></div>
        </div>
      </div>
    `).join("")}
  `;
}

function renderDeviceVerify(result, enabled) {
  if (!uploadDeviceVerify) return;
  if (!enabled) {
    uploadDeviceVerify.className = "upload-verify empty";
    uploadDeviceVerify.innerHTML = "<span>未启用验证</span>";
    return;
  }
  if (!result?.verify) {
    uploadDeviceVerify.className = "upload-verify empty";
    uploadDeviceVerify.innerHTML = "<span>本次未执行 Kafka 验证</span>";
    return;
  }

  const verify = result.verify;
  const found = verify.found ?? [];
  const missing = verify.missing ?? [];
  uploadDeviceVerify.className = "upload-verify";

  if (!found.length && missing.length) {
    uploadDeviceVerify.innerHTML = `
      <div class="upload-verify-card warn">
        <div class="upload-verify-head">
          <strong>Kafka 验证失败</strong>
          <span class="pill warn">缺 ${missing.length} 条</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>耗时</dt><dd>${verify.waitedMs ?? 0} ms</dd></div>
          ${verify.error ? `<div class="upload-verify-row"><dt>原因</dt><dd>${escapeHtml(verify.error)}</dd></div>` : ""}
        </div>
      </div>`;
    return;
  }

  uploadDeviceVerify.innerHTML = `
    <div class="upload-verify-card ${verify.ok ? "pass" : "warn"}">
      <div class="upload-verify-head">
        <strong>Kafka 验证${verify.ok ? "通过" : "异常"}</strong>
        <span class="pill ${verify.ok ? "good" : "warn"}">${found.length}/${found.length + missing.length}</span>
      </div>
      <div class="upload-verify-meta">
        <div class="upload-verify-row"><dt>方式</dt><dd>producer ack + offset</dd></div>
        <div class="upload-verify-row"><dt>耗时</dt><dd>${verify.waitedMs ?? 0} ms</dd></div>
      </div>
    </div>
    ${found.map((item) => `
      <div class="upload-verify-card pass">
        <div class="upload-verify-head">
          <strong>partition ${item.partition}</strong>
          <span class="pill good">offset ${escapeHtml(item.offset ?? "—")}</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>高水位</dt><dd>${escapeHtml(item.highWatermark ?? "—")}</dd></div>
          <div class="upload-verify-row"><dt>HEX</dt><dd title="${escapeHtml(item.hex ?? "")}">${escapeHtml(shortKey(item.hex ?? ""))}</dd></div>
        </div>
      </div>
    `).join("")}
  `;
}

function renderMinioObjectVerify(result, enabled) {
  if (!uploadMinioObjectVerify) return;
  if (!enabled) {
    uploadMinioObjectVerify.className = "upload-verify empty";
    uploadMinioObjectVerify.innerHTML = "<span>未启用验证</span>";
    return;
  }
  const summary = result?.minioVerify;
  const items = summary?.items ?? [];
  if (!items.length) {
    uploadMinioObjectVerify.className = "upload-verify empty";
    uploadMinioObjectVerify.innerHTML = "<span>本次未执行 MinIO 对象校验</span>";
    return;
  }
  uploadMinioObjectVerify.className = "upload-verify";
  uploadMinioObjectVerify.innerHTML = `
    <div class="upload-verify-card ${summary.ok ? "pass" : "warn"}">
      <div class="upload-verify-head">
        <strong>MinIO 对象${summary.ok ? "存在" : "异常"}</strong>
        <span class="pill ${summary.ok ? "good" : "warn"}">${summary.passed ?? 0}/${summary.checked ?? 0}</span>
      </div>
    </div>
    ${items.map((item) => `
      <div class="upload-verify-card ${item.ok ? "pass" : "warn"}">
        <div class="upload-verify-head">
          <strong>${item.ok ? "HeadObject PASS" : "HeadObject FAIL"}</strong>
          <span class="pill ${item.ok ? "good" : "warn"}">${item.ok ? "PASS" : "FAIL"}</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>objectKey</dt><dd title="${escapeHtml(item.objectKey ?? "")}">${escapeHtml(shortKey(item.objectKey ?? ""))}</dd></div>
          <div class="upload-verify-row"><dt>大小</dt><dd>${item.contentLength != null ? `${item.contentLength} B` : "—"}</dd></div>
          ${item.error ? `<div class="upload-verify-row"><dt>原因</dt><dd>${escapeHtml(item.error)}</dd></div>` : ""}
        </div>
      </div>
    `).join("")}
  `;
}

function renderMinioKafkaVerify(result, enabled) {
  if (!uploadMinioKafkaVerify) return;
  if (!enabled) {
    uploadMinioKafkaVerify.className = "upload-verify empty";
    uploadMinioKafkaVerify.innerHTML = "<span>未启用验证</span>";
    return;
  }
  const verify = result?.kafkaVerify;
  if (!verify) {
    uploadMinioKafkaVerify.className = "upload-verify empty";
    uploadMinioKafkaVerify.innerHTML = "<span>本次未执行 Kafka 验证</span>";
    return;
  }
  const matched = verify.matched ?? [];
  uploadMinioKafkaVerify.className = "upload-verify";
  if (!matched.length) {
    uploadMinioKafkaVerify.innerHTML = `
      <div class="upload-verify-card warn">
        <div class="upload-verify-head">
          <strong>未收到 Kafka 上传事件</strong>
          <span class="pill warn">${verify.timedOut ? "超时" : "失败"}</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>Topic</dt><dd>${escapeHtml(verify.topic ?? "—")}</dd></div>
          <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒</dd></div>
          ${verify.error ? `<div class="upload-verify-row"><dt>原因</dt><dd>${escapeHtml(verify.error)}</dd></div>` : ""}
        </div>
      </div>`;
    return;
  }
  uploadMinioKafkaVerify.innerHTML = matched.map((item) => `
    <div class="upload-verify-card pass">
      <div class="upload-verify-head">
        <strong>${escapeHtml(item.frameId ?? item.objectKey ?? "Kafka 消息")}</strong>
        <span class="pill good">PASS</span>
      </div>
      <div class="upload-verify-meta">
        <div class="upload-verify-row"><dt>Topic</dt><dd>${escapeHtml(verify.topic ?? "—")}</dd></div>
        <div class="upload-verify-row"><dt>traceId</dt><dd title="${escapeHtml(item.traceId ?? "")}">${escapeHtml(shortKey(item.traceId ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>objectKey</dt><dd title="${escapeHtml(item.objectKey ?? "")}">${escapeHtml(shortKey(item.objectKey ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒</dd></div>
      </div>
    </div>
  `).join("");
}

function renderMinioApiVerify(result, enabled) {
  if (!uploadMinioApiVerify) return;
  if (!enabled) {
    uploadMinioApiVerify.className = "upload-verify empty";
    uploadMinioApiVerify.innerHTML = "<span>未启用验证</span>";
    return;
  }
  const verify = result?.apiVerify;
  if (!verify) {
    uploadMinioApiVerify.className = "upload-verify empty";
    uploadMinioApiVerify.innerHTML = "<span>本次未执行数据接口验证</span>";
    return;
  }
  const matched = verify.matched ?? [];
  uploadMinioApiVerify.className = "upload-verify";
  if (!matched.length) {
    uploadMinioApiVerify.innerHTML = `
      <div class="upload-verify-card warn">
        <div class="upload-verify-head">
          <strong>recent 未查到目标帧</strong>
          <span class="pill warn">${verify.timedOut ? "超时" : "失败"}</span>
        </div>
        <div class="upload-verify-meta">
          <div class="upload-verify-row"><dt>接口</dt><dd title="${escapeHtml(verify.url ?? "")}">${escapeHtml(shortKey(verify.url ?? "", 28, 18))}</dd></div>
          <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒 / ${verify.attempts ?? 0} 次</dd></div>
          ${verify.error ? `<div class="upload-verify-row"><dt>原因</dt><dd>${escapeHtml(verify.error)}</dd></div>` : ""}
        </div>
      </div>`;
    return;
  }
  uploadMinioApiVerify.innerHTML = matched.map((item) => `
    <div class="upload-verify-card pass">
      <div class="upload-verify-head">
        <strong>${escapeHtml(item.frameId ?? "recent 命中")}</strong>
        <span class="pill good">PASS</span>
      </div>
      <div class="upload-verify-meta">
        <div class="upload-verify-row"><dt>traceId</dt><dd title="${escapeHtml(item.traceId ?? "")}">${escapeHtml(shortKey(item.traceId ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>objectKey</dt><dd title="${escapeHtml(item.objectKey ?? "")}">${escapeHtml(shortKey(item.objectKey ?? ""))}</dd></div>
        <div class="upload-verify-row"><dt>等待</dt><dd>${Math.round((verify.waitedMs ?? 0) / 1000)} 秒</dd></div>
      </div>
    </div>
  `).join("");
}

function formatMinioUploadState(result, failed = false) {
  if (result.dryRun) {
    return `可上传 ${result.planned?.length ?? 0} 帧`;
  }
  return result.ok && !failed ? "PASS" : "WARN";
}

async function runMinioUpload(dryRun) {
  uploadMinioOutput.textContent = dryRun ? "预检中..." : "上传中...";
  uploadMinioState.textContent = dryRun ? "预检中" : "上传中";
  uploadMinioState.className = "warn";
  if (uploadMinioResult) {
    uploadMinioResult.className = "upload-result empty";
    uploadMinioResult.innerHTML = "<span>处理中...</span>";
  }
  [uploadMinioObjectVerify, uploadMinioKafkaVerify, uploadMinioVerify, uploadMinioApiVerify].forEach((el) => {
    if (!el) return;
    el.className = "upload-verify empty";
    el.innerHTML = "<span>等待上传完成...</span>";
  });
  const payload = buildMinioUploadPayload(dryRun);
  const controller = new AbortController();
  // 预留给 WS 连接 / Kafka JOIN / 上传本身；校验超时最多串行两段（Kafka+WS 并行后 + API）
  const clientTimeoutMs = dryRun
    ? 20000
    : Math.max(45000, (Number(payload.verifyTimeoutMs) || 30000) * 2 + 35000);
  const abortTimer = setTimeout(() => controller.abort(), clientTimeoutMs);
  try {
    const response = await fetch("/api/upload-test/minio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json();
    uploadMinioOutput.textContent = JSON.stringify(result, null, 2);
    renderMinioResult(result, dryRun);
    renderMinioObjectVerify(result, payload.verifyMinio && !dryRun);
    renderMinioKafkaVerify(result, payload.verifyKafka && !dryRun);
    renderMinioVerify(result, payload.verifyWebSocket && !dryRun);
    renderMinioApiVerify(result, payload.verifyApi && !dryRun);
    uploadMinioState.textContent = dryRun
      ? `可上传 ${result.planned?.length ?? 0} 帧`
      : formatMinioUploadState(result, !result.ok);
    uploadMinioState.className = result.ok ? "pass" : "warn";
    stampUploadLastTime();
  } catch (error) {
    const msg =
      error?.name === "AbortError"
        ? `请求超时（${Math.round(clientTimeoutMs / 1000)}s）。可先取消「校验 Kafka / WebSocket / API」只测上传，或缩短校验等待秒数`
        : error.message;
    uploadMinioOutput.textContent = JSON.stringify({ ok: false, error: msg }, null, 2);
    if (uploadMinioResult) {
      uploadMinioResult.className = "upload-result empty";
      uploadMinioResult.innerHTML = `<span>${escapeHtml(msg)}</span>`;
    }
    [uploadMinioObjectVerify, uploadMinioKafkaVerify, uploadMinioVerify, uploadMinioApiVerify].forEach((el) => {
      if (!el) return;
      el.className = "upload-verify empty";
      el.innerHTML = `<span>${escapeHtml(msg)}</span>`;
    });
    uploadMinioState.textContent = error?.name === "AbortError" ? "超时" : "服务未响应";
    uploadMinioState.className = "warn";
  } finally {
    clearTimeout(abortTimer);
  }
}

async function runDeviceUpload() {
  uploadDeviceOutput.textContent = "发送中...";
  uploadDeviceState.textContent = "发送中";
  uploadDeviceState.className = "warn";
  if (uploadDeviceResult) {
    uploadDeviceResult.className = "upload-result empty";
    uploadDeviceResult.innerHTML = "<span>处理中...</span>";
  }
  if (uploadDeviceVerify) {
    uploadDeviceVerify.className = "upload-verify empty";
    uploadDeviceVerify.innerHTML = "<span>等待发送完成...</span>";
  }
  try {
    const payload = buildDeviceUploadPayload();
    const response = await fetch("/api/upload-test/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    uploadDeviceOutput.textContent = JSON.stringify(result, null, 2);
    renderDeviceResult(result);
    renderDeviceVerify(result, payload.verifyKafka);
    uploadDeviceState.textContent = formatDeviceUploadState(result, !result.ok);
    uploadDeviceState.className = result.ok ? "pass" : "warn";
    stampUploadLastTime();
  } catch (error) {
    uploadDeviceOutput.textContent = JSON.stringify({ ok: false, error: error.message }, null, 2);
    if (uploadDeviceResult) {
      uploadDeviceResult.className = "upload-result empty";
      uploadDeviceResult.innerHTML = `<span>${escapeHtml(error.message)}</span>`;
    }
    uploadDeviceState.textContent = "服务未响应";
    uploadDeviceState.className = "warn";
  }
}

async function loadPresignDefaults() {
  try {
    const response = await fetch("/api/presign/defaults");
    presignDefaults = await response.json();
    presignDefaultsHint.textContent = "生成前会检查 MinIO 是否存在该附件";
    renderPresignDefaultsList();
    renderPresignSampleButtons();
    applyPresignBuiltinToForm();
  } catch {
    presignDefaultsHint.textContent = "无法加载内置参数，请确认服务已启动";
  }
}

function renderPresignDefaultsList() {
  if (!presignDefaults || !presignDefaultsList) return;
  const rows = [
    ["Endpoint（浏览器）", presignDefaults.browserEndpoint ?? presignDefaults.endpoint],
    ["Access Key", presignDefaults.accessKey],
    ["Secret Key", PRESIGN_SECRET_BUILTIN_LABEL],
    ["默认 dedup_key", presignDefaults.defaultDedupKey],
    ["有效期", `${presignDefaults.expirySeconds} 秒`],
  ];
  presignDefaultsList.innerHTML = rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
}

function renderPresignSampleButtons() {
  const list = presignDefaults?.samples ?? [];
  if (!presignSampleGrid) return;
  presignSampleGrid.innerHTML = list
    .map(
      (sample) => `
    <button class="sample-card" type="button" data-presign-id="${sample.id}">
      <span>${sample.id}</span>
      <strong>${escapeHtml(sample.name)}</strong>
      <em class="sample-path">${escapeHtml(shortDedupKey(sample.dedupKey))}</em>
    </button>
  `,
    )
    .join("");
  presignSampleGrid.querySelectorAll("[data-presign-id]").forEach((button) => {
    button.addEventListener("click", () => loadPresignSample(button.dataset.presignId));
  });
}

function loadPresignSample(sampleId) {
  const sample = presignDefaults?.samples?.find((item) => item.id === sampleId);
  if (!sample) return;
  activePresignSampleId = sample.id;
  presignDedupKey.value = sample.dedupKey;
  presignDedupKey.classList.remove("is-builtin");
  updateActivePresignSample();
}

function updateActivePresignSample() {
  presignSampleGrid?.querySelectorAll("[data-presign-id]").forEach((button) => {
    button.classList.toggle("active", button.dataset.presignId === activePresignSampleId);
  });
}

function getPresignBuiltinValues() {
  if (!presignDefaults) return null;
  return {
    dedupKey: presignDefaults.defaultDedupKey ?? "",
    expirySeconds: String(presignDefaults.expirySeconds ?? 3600),
  };
}

function applyPresignBuiltinToForm() {
  const builtin = getPresignBuiltinValues();
  if (!builtin) return;
  presignDedupKey.value = builtin.dedupKey;
  presignExpiry.value = builtin.expirySeconds;
  presignFields.forEach((field) => markPresignFieldBuiltin(field));
}

function markPresignFieldBuiltin(field) {
  const builtin = getBuiltinValueForField(field);
  if (builtin === undefined) return;
  field.dataset.builtinValue = builtin;
  field.classList.add("is-builtin");
}

function getBuiltinValueForField(field) {
  const builtin = getPresignBuiltinValues();
  if (!builtin) return undefined;
  switch (field.id) {
    case "presignDedupKey":
      return builtin.dedupKey;
    case "presignExpiry":
      return builtin.expirySeconds;
    default:
      return undefined;
  }
}

function syncPresignFieldBuiltinState(field) {
  const builtin = getBuiltinValueForField(field);
  if (builtin === undefined) return;
  const current = field.id === "presignExpiry" ? String(field.value).trim() : field.value.trim();
  if (current === builtin) {
    field.classList.add("is-builtin");
  } else {
    field.classList.remove("is-builtin");
  }
}

function initPresignFieldBehavior() {
  presignFields.forEach((field) => {
    if (!field) return;
    field.addEventListener("focus", () => {
      if (!field.classList.contains("is-builtin")) return;
      field.classList.remove("is-builtin");
      requestAnimationFrame(() => field.select());
    });

    field.addEventListener("input", () => {
      syncPresignFieldBuiltinState(field);
    });

    field.addEventListener("blur", () => {
      if (!String(field.value).trim()) {
        const builtin = getBuiltinValueForField(field);
        if (builtin !== undefined) {
          field.value = builtin;
          markPresignFieldBuiltin(field);
        }
      } else {
        syncPresignFieldBuiltinState(field);
      }
    });
  });
}

function buildPresignPayload() {
  const env = readEnvForm();
  const payload = {
    endpoint: env.minioEndpoint,
    accessKey: env.minioAccessKey,
    dedupKey: presignDedupKey.value.trim(),
    expirySeconds: Number(presignExpiry.value),
  };
  if (env.minioSecretKey) {
    payload.secretKey = env.minioSecretKey;
  }
  return payload;
}

function createEnvId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `env-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getServerEnvDefaults() {
  const minio = uploadDefaults?.minio;
  const device = uploadDefaults?.device;
  const presign = presignDefaults;
  return {
    minioEndpoint:
      minio?.apiEndpoint ||
      minio?.endpoint ||
      presign?.browserEndpoint ||
      presign?.endpoint ||
      "",
    minioAccessKey: minio?.accessKey || presign?.accessKey || "",
    minioSecretKey: "",
    kafkaBootstrap: minio?.kafkaBootstrap || device?.bootstrapServers || "",
    wsUrl: minio?.wsUrl || "",
    apiBaseUrl: minio?.apiBaseUrl || "",
  };
}

function normalizeEnvValues(values = {}) {
  return {
    minioEndpoint: String(values.minioEndpoint || "").trim(),
    minioAccessKey: String(values.minioAccessKey || "").trim(),
    minioSecretKey:
      values.minioSecretKey && values.minioSecretKey !== PRESIGN_SECRET_BUILTIN_LABEL
        ? String(values.minioSecretKey).trim()
        : "",
    kafkaBootstrap: String(values.kafkaBootstrap || "").trim(),
    wsUrl: String(values.wsUrl || "").trim(),
    apiBaseUrl: String(values.apiBaseUrl || "").trim(),
  };
}

function makeEnvProfile(values = {}, name = "默认环境") {
  return {
    id: values.id || createEnvId(),
    name: String(name || values.name || "未命名环境").trim() || "未命名环境",
    ...normalizeEnvValues(values),
  };
}

function getActiveEnvProfile() {
  return envProfiles.find((p) => p.id === activeEnvId) || envProfiles[0] || null;
}

function persistEnvProfiles() {
  localStorage.setItem(
    ENV_PROFILES_STORAGE_KEY,
    JSON.stringify({ activeId: activeEnvId, profiles: envProfiles }),
  );
}

function readLegacyStoredEnv() {
  try {
    const raw = localStorage.getItem(ENV_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function loadEnvProfilesFromStorage(defaults) {
  try {
    const raw = localStorage.getItem(ENV_PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const profiles = Array.isArray(parsed?.profiles)
        ? parsed.profiles.map((p) => makeEnvProfile(p, p.name))
        : [];
      if (profiles.length) {
        envProfiles = profiles;
        activeEnvId =
          profiles.some((p) => p.id === parsed.activeId) ? parsed.activeId : profiles[0].id;
        return;
      }
    }
  } catch {
    // fall through to migrate / defaults
  }

  const legacy = readLegacyStoredEnv();
  if (legacy) {
    const profile = makeEnvProfile({ ...defaults, ...legacy }, "默认环境");
    envProfiles = [profile];
    activeEnvId = profile.id;
    persistEnvProfiles();
    return;
  }

  const profile = makeEnvProfile(defaults, "本地默认");
  envProfiles = [profile];
  activeEnvId = profile.id;
  persistEnvProfiles();
}

function shortEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) return "未配置 Endpoint";
  return value.replace(/^https?:\/\//, "");
}

function setEnvStatus(message) {
  if (envStatus) envStatus.textContent = message;
}

function renderEnvProfiles() {
  if (!envProfileList) return;
  envProfileList.innerHTML = "";

  envProfiles.forEach((profile) => {
    const active = profile.id === activeEnvId;
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `env-profile-tile${active ? " active" : ""}`;
    tile.setAttribute("aria-pressed", active ? "true" : "false");
    tile.innerHTML = `
      <div class="env-profile-main">
        <span class="env-profile-badge ${active ? "online" : "offline"}">${active ? "启用" : "备用"}</span>
        <div class="env-profile-body">
          <span class="env-profile-name">${escapeHtml(profile.name)}</span>
          <span class="env-profile-addr">${escapeHtml(shortEndpoint(profile.minioEndpoint))}</span>
        </div>
      </div>
      <button type="button" class="env-profile-delete" title="删除" aria-label="删除环境"><span aria-hidden="true">×</span></button>
    `;
    tile.addEventListener("click", (e) => {
      if (e.target.closest(".env-profile-delete")) return;
      if (profile.id === activeEnvId) {
        openEnvProfileDialog(profile.id);
        return;
      }
      activateEnvProfile(profile.id);
    });
    tile.addEventListener("dblclick", (e) => {
      if (e.target.closest(".env-profile-delete")) return;
      openEnvProfileDialog(profile.id);
    });
    tile.querySelector(".env-profile-delete")?.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteEnvProfile(profile.id);
    });
    envProfileList.appendChild(tile);
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "env-profile-add";
  add.innerHTML = `
    <span class="env-profile-add-icon" aria-hidden="true">+</span>
    <span class="env-profile-add-text">新增环境</span>
  `;
  add.addEventListener("click", () => openEnvProfileDialog(null));
  envProfileList.appendChild(add);
}

function activateEnvProfile(id) {
  const profile = envProfiles.find((p) => p.id === id);
  if (!profile) return;
  activeEnvId = profile.id;
  persistEnvProfiles();
  renderEnvProfiles();
  setEnvStatus(`已启用「${profile.name}」· ${shortEndpoint(profile.minioEndpoint)}`);
}

function deleteEnvProfile(id) {
  if (envProfiles.length <= 1) {
    alert("至少保留一个环境");
    return;
  }
  const profile = envProfiles.find((p) => p.id === id);
  if (!profile) return;
  if (!confirm(`删除环境「${profile.name}」？`)) return;
  envProfiles = envProfiles.filter((p) => p.id !== id);
  if (activeEnvId === id) activeEnvId = envProfiles[0].id;
  persistEnvProfiles();
  renderEnvProfiles();
  const active = getActiveEnvProfile();
  setEnvStatus(active ? `已启用「${active.name}」` : "暂无环境");
}

/** 预签名 / 上传测试读当前启用的环境配置。 */
function readEnvForm() {
  const active = getActiveEnvProfile();
  return normalizeEnvValues(active || {});
}

function readEnvDialogForm() {
  const secret = envMinioSecretKey?.value.trim() || "";
  return {
    name: envProfileName?.value.trim() || "未命名环境",
    minioEndpoint: envMinioEndpoint?.value.trim() || "",
    minioAccessKey: envMinioAccessKey?.value.trim() || "",
    minioSecretKey:
      secret && secret !== PRESIGN_SECRET_BUILTIN_LABEL ? secret : "",
    kafkaBootstrap: envKafkaBootstrap?.value.trim() || "",
    wsUrl: envWsUrl?.value.trim() || "",
    apiBaseUrl: envApiBaseUrl?.value.trim() || "",
  };
}

function applyEnvToForm(values, { markBuiltin = false } = {}) {
  if (!values) return;
  if (envProfileName) envProfileName.value = values.name ?? "";
  if (envMinioEndpoint) envMinioEndpoint.value = values.minioEndpoint ?? "";
  if (envMinioAccessKey) envMinioAccessKey.value = values.minioAccessKey ?? "";
  if (envMinioSecretKey) {
    envMinioSecretKey.type = "text";
    envMinioSecretKey.value =
      values.minioSecretKey && values.minioSecretKey !== PRESIGN_SECRET_BUILTIN_LABEL
        ? values.minioSecretKey
        : PRESIGN_SECRET_BUILTIN_LABEL;
  }
  if (envKafkaBootstrap) envKafkaBootstrap.value = values.kafkaBootstrap ?? "";
  if (envWsUrl) envWsUrl.value = values.wsUrl ?? "";
  if (envApiBaseUrl) envApiBaseUrl.value = values.apiBaseUrl ?? "";
  envFields.forEach((field) => field?.classList.toggle("is-builtin", Boolean(markBuiltin)));
}

function openEnvProfileDialog(id) {
  editingEnvId = id;
  const defaults = getServerEnvDefaults();
  if (id) {
    const profile = envProfiles.find((p) => p.id === id);
    if (!profile) return;
    if (envDialogTitle) envDialogTitle.textContent = "编辑环境";
    applyEnvToForm(profile, { markBuiltin: false });
  } else {
    if (envDialogTitle) envDialogTitle.textContent = "新增环境";
    applyEnvToForm(
      { name: `环境 ${envProfiles.length + 1}`, ...defaults },
      { markBuiltin: true },
    );
  }
  envProfileDialog?.showModal?.();
  envProfileName?.focus();
  envProfileName?.select();
}

function closeEnvProfileDialog() {
  editingEnvId = null;
  envProfileDialog?.close?.();
}

function saveEnvFromDialog(event) {
  event?.preventDefault?.();
  const values = readEnvDialogForm();
  if (!values.name) {
    alert("请填写环境名称");
    return;
  }
  if (editingEnvId) {
    const idx = envProfiles.findIndex((p) => p.id === editingEnvId);
    if (idx >= 0) {
      envProfiles[idx] = makeEnvProfile({ ...envProfiles[idx], ...values, id: editingEnvId }, values.name);
      activeEnvId = editingEnvId;
    }
  } else {
    const profile = makeEnvProfile(values, values.name);
    envProfiles.push(profile);
    activeEnvId = profile.id;
  }
  persistEnvProfiles();
  renderEnvProfiles();
  const active = getActiveEnvProfile();
  setEnvStatus(
    active
      ? `当前启用「${active.name}」· ${shortEndpoint(active.minioEndpoint)}`
      : "已保存",
  );
  closeEnvProfileDialog();
}

function resetEnvDialogToServerDefaults() {
  const defaults = getServerEnvDefaults();
  const name =
    envProfileName?.value.trim() ||
    (editingEnvId ? getActiveEnvProfile()?.name : null) ||
    `环境 ${envProfiles.length + 1}`;
  applyEnvToForm({ name, ...defaults }, { markBuiltin: true });
}

async function loadEnvDefaults() {
  try {
    if (!uploadDefaults) {
      const response = await fetch("/api/upload-test/defaults");
      uploadDefaults = await response.json();
    }
    if (!presignDefaults) {
      const response = await fetch("/api/presign/defaults");
      presignDefaults = await response.json();
    }
    const defaults = getServerEnvDefaults();
    loadEnvProfilesFromStorage(defaults);
    renderEnvProfiles();
    const active = getActiveEnvProfile();
  setEnvStatus(
    active
      ? `当前启用「${active.name}」· ${shortEndpoint(active.minioEndpoint)}（再点一次可编辑）`
      : "请新增环境",
  );
  } catch {
    setEnvStatus("无法加载默认配置，请确认服务已启动");
    renderEnvProfiles();
  }
}

function initEnvPanel() {
  envResetBtn?.addEventListener("click", resetEnvDialogToServerDefaults);
  envDialogCancel?.addEventListener("click", closeEnvProfileDialog);
  envProfileForm?.addEventListener("submit", saveEnvFromDialog);
  envProfileDialog?.addEventListener("cancel", () => {
    editingEnvId = null;
  });
  envFields.forEach((field) => {
    if (!field) return;
    field.addEventListener("focus", () => {
      if (!field.classList.contains("is-builtin")) return;
      field.classList.remove("is-builtin");
      if (field === envMinioSecretKey && field.value === PRESIGN_SECRET_BUILTIN_LABEL) {
        field.value = "";
        field.type = "password";
      }
      requestAnimationFrame(() => field.select());
    });
    field.addEventListener("blur", () => {
      if (field === envMinioSecretKey) {
        if (!field.value.trim() || field.value === PRESIGN_SECRET_BUILTIN_LABEL) {
          field.type = "text";
          field.value = PRESIGN_SECRET_BUILTIN_LABEL;
          field.classList.add("is-builtin");
        }
      }
    });
  });
}

function shortDedupKey(dedupKey) {
  if (!dedupKey) return "";
  const sep = dedupKey.indexOf(":");
  if (sep < 0) return dedupKey;
  return dedupKey.slice(sep + 1);
}

async function generatePresign() {
  const payload = buildPresignPayload();

  presignOutput.textContent = "生成中...";
  presignUrl.value = "";
  presignOpenBtn.disabled = true;
  presignCopyBtn.disabled = true;

  try {
    const response = await fetch("/api/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    presignOutput.textContent = JSON.stringify(result, null, 2);
    if (result.ok && result.url) {
      presignUrl.value = result.url;
      presignOpenBtn.disabled = false;
      presignCopyBtn.disabled = false;
    } else {
      presignUrl.value = "";
    }
  } catch (error) {
    presignOutput.textContent = JSON.stringify({ ok: false, error: error.message }, null, 2);
  }
}

async function parse() {
  const text = input.value.trim();
  if (!text) {
    resetView();
    return;
  }
  statusText.textContent = "解析中";
  statusText.className = "working";
  try {
    const response = await fetch("/api/parse", { method: "POST", body: text });
    const result = await response.json();
    latestJson = JSON.stringify(result, null, 2);
    output.textContent = latestJson;
    renderSummary(result);
    renderDetail(result);
  } catch (error) {
    latestJson = JSON.stringify({ error: error.message }, null, 2);
    output.textContent = latestJson;
    statusText.textContent = "服务未响应";
    statusText.className = "bad";
  }
}

function renderSampleButtons() {
  sampleGrid.innerHTML = samples.map((sample) => `
    <button class="sample-card" type="button" data-sample-id="${sample.id}">
      <span>${sample.id}</span>
      <strong>${escapeHtml(sample.name)}</strong>
      <em>${sample.command}</em>
    </button>
  `).join("");
  sampleGrid.querySelectorAll("[data-sample-id]").forEach((button) => {
    button.addEventListener("click", () => loadSample(button.dataset.sampleId));
  });
}

function loadSample(sampleId) {
  const sample = samples.find((item) => item.id === sampleId);
  if (!sample) return;
  activeSampleId = sample.id;
  input.value = sample.hex;
  sampleHint.textContent = `当前样例：${sample.id} ${sample.name} / 命令 ${sample.command}`;
  updateActiveSample();
  parse();
}

function updateActiveSample() {
  sampleGrid.querySelectorAll("[data-sample-id]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sampleId === activeSampleId);
  });
  if (!activeSampleId) {
    sampleHint.textContent = "可粘贴带空格、换行、0x 前缀的 HEX 报文。";
  }
}

function renderSummary(result) {
  const frames = result.frames ?? [];
  const crcOk = frames.length > 0 && frames.every((frame) => frame.crcValid);
  frameCount.textContent = String(result.frameCount ?? frames.length);
  crcState.textContent = frames.length ? (crcOk ? "PASS" : "WARN") : "-";
  crcState.className = crcOk ? "pass" : "warn";
  statusText.textContent = result.ok ? "解析完成" : "需要检查";
  statusText.className = result.ok ? "good" : "bad";
  if (!frames.length) {
    summary.className = "summary empty";
    summary.innerHTML = "<span>未找到完整协议帧</span>";
    return;
  }
  summary.className = "summary";
  summary.innerHTML = frames.map((frame) => `
    <article class="frame-card">
      <div class="frame-title">
        <strong>#${frame.index + 1} ${escapeHtml(frame.deviceName)}</strong>
        <span class="${frame.crcValid ? "pill good" : "pill warn"}">${frame.crcValid ? "CRC PASS" : "CRC WARN"}</span>
      </div>
      <dl>
        <div><dt>设备类型</dt><dd>${frame.deviceType}</dd></div>
        <div><dt>设备地址</dt><dd>${frame.deviceAddress}</dd></div>
        <div><dt>命令</dt><dd>${commandLabel(frame.commandType)}</dd></div>
        <div><dt>长度</dt><dd>${frame.frameLength} B</dd></div>
      </dl>
    </article>
  `).join("");
}

function renderDetail(result) {
  const frames = result.frames ?? [];
  if (!frames.length) {
    detail.className = "detail empty";
    detail.innerHTML = "<span>解析后会在这里显示中文字段说明</span>";
    return;
  }
  detail.className = "detail";
  detail.innerHTML = frames.map((frame) => `
    <section class="detail-frame">
      <h3>帧结构</h3>
      ${tableHtml([
        ["字段", "值", "单位", "类型", "说明"],
        ["帧头", `5A 4B ${frame.frameHex.startsWith("5A4B") ? "OK" : "异常"}`, "-", "fixed", "固定帧头"],
        ["长度字节", `0x${toHexByte(frame.lengthByte)} (${frame.lengthByte})`, "字节", "uint8", "协议长度字段"],
        ["设备类型", `${frame.deviceType} - ${frame.deviceName}`, "-", "uint8", "设备型号标识"],
        ["设备地址", frame.deviceAddress, "-", "uint32 hex", "设备通信地址"],
        ["指令类型", commandLabel(frame.commandType), "-", "uint16 hex", "业务命令"],
        ["数据区", compactHex(frame.payloadHex), "-", "hex", "参与业务字段解析的 payload"],
        ["CRC16", `0x${frame.crcHex} ${frame.crcValid ? "OK" : "异常"}`, "-", "CRC16 Modbus", "低字节在前"],
        ["整帧长度", `${frame.frameLength}`, "字节", "computed", "当前切出的完整帧长度"],
      ], "structure-table")}
      <h3>字段解析</h3>
      ${fieldSectionsHtml(frame.parsed ?? {})}
    </section>
  `).join("");
}

function fieldSectionsHtml(parsed) {
  const sections = groups
    .map((group) => {
      const rows = group.keys
        .filter((key) => parsed[key] !== undefined && !["deviceType", "deviceName", "deviceAddress", "commandType"].includes(key))
        .map((key) => fieldRow(key, parsed[key]));
      return rows.length ? `<h4>${group.title}</h4>${tableHtml([["字段", "值", "单位", "类型", "缩放/说明"], ...rows], "field-table")}` : "";
    })
    .filter(Boolean);
  return sections.length ? sections.join("") : "<p class=\"empty-line\">该帧暂无可展示字段说明。</p>";
}

function fieldRow(key, value) {
  const meta = fieldMeta[key] ?? [key, "-", "-", "-"];
  return [meta[0], formatValue(key, value), meta[1], meta[2], meta[3]];
}

function tableHtml(rows, className) {
  return `
    <table class="${className}">
      <tbody>
        ${rows.map((row, index) => `
          <tr class="${index === 0 ? "table-head" : ""}">
            ${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function formatValue(key, value) {
  if (key === "gpsTimeType") {
    return `${value} (${value === 1 ? "GPS时间" : value === 2 ? "系统时钟" : "未知"})`;
  }
  if (key === "messageKind") {
    return `${value} (${value === "HEARTBEAT" ? "心跳" : value === "WAVEFORM" ? "波形" : value})`;
  }
  return String(value);
}

function commandLabel(command) {
  const labels = {
    "0001": "0001 - 上传测量",
    "0002": "0002 - 远程控制",
    "000A": "000A - 雷击事件",
    "0102": "0102 - 时间校准",
  };
  return labels[command] ?? command;
}

function compactHex(value) {
  if (!value) return "";
  if (value.length <= 56) return value;
  return `${value.slice(0, 28)} ... ${value.slice(-28)}`;
}

function toHexByte(value) {
  return Number(value).toString(16).toUpperCase().padStart(2, "0");
}

function resetView() {
  latestJson = "{}";
  output.textContent = latestJson;
  statusText.textContent = "等待输入";
  statusText.className = "";
  frameCount.textContent = "0";
  crcState.textContent = "-";
  crcState.className = "";
  summary.className = "summary empty";
  summary.innerHTML = "<span>尚未解析</span>";
  detail.className = "detail empty";
  detail.innerHTML = "<span>解析后会在这里显示中文字段说明</span>";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
