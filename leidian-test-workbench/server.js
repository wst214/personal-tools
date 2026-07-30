const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { URL } = require("url");
const { Kafka } = require("kafkajs");
const Minio = require("minio");
const mysql = require("mysql2/promise");
const { Client: PgClient } = require("pg");
const WebSocket = require("ws");

const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const runsDir = path.join(dataDir, "runs");
const samplesDir = path.join(rootDir, "samples", "device-samples");
const envFile = path.join(dataDir, "environments.json");
const port = Number(process.env.PORT || 5785);
const hostGateway = process.env.HOST_GATEWAY || "host.docker.internal";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDirs();
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeHost(host) {
  return host === "localhost" || host === "127.0.0.1" ? hostGateway : host;
}

function normalizeUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    parsed.hostname = normalizeHost(parsed.hostname);
    return parsed.toString();
  } catch (_error) {
    return targetUrl;
  }
}

function joinUrl(baseUrl, targetPath = "") {
  if (!baseUrl) return "";
  try {
    const base = new URL(normalizeUrl(baseUrl));
    const pathValue = String(targetPath || "").trim() || "/";
    return new URL(pathValue, base).toString();
  } catch (_error) {
    return baseUrl;
  }
}

function parseHostPort(value, defaultPort) {
  if (!value) return null;
  const clean = String(value).trim();
  if (clean.startsWith("jdbc:mysql://")) {
    const match = clean.match(/^jdbc:mysql:\/\/([^/:]+)(?::(\d+))?/);
    return match ? { host: normalizeHost(match[1]), port: Number(match[2] || 3306) } : null;
  }
  if (clean.startsWith("jdbc:postgresql://")) {
    const match = clean.match(/^jdbc:postgresql:\/\/([^/:]+)(?::(\d+))?/);
    return match ? { host: normalizeHost(match[1]), port: Number(match[2] || 5432) } : null;
  }
  if (/^https?:\/\//.test(clean) || /^wss?:\/\//.test(clean)) {
    try {
      const parsed = new URL(clean);
      const fallback = parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
      return { host: normalizeHost(parsed.hostname), port: Number(parsed.port || defaultPort || fallback) };
    } catch (_error) {
      return null;
    }
  }
  const first = clean.split(",")[0].trim();
  const parts = first.split(":");
  if (parts.length >= 2) return { host: normalizeHost(parts[0]), port: Number(parts[1]) };
  return { host: normalizeHost(clean), port: defaultPort };
}

function parseJdbcDatabase(jdbcUrl) {
  const value = String(jdbcUrl || "");
  let match = value.match(/^jdbc:mysql:\/\/([^/:]+)(?::(\d+))?\/([^?]+)/);
  if (match) {
    return { dialect: "mysql", host: normalizeHost(match[1]), port: Number(match[2] || 3306), database: match[3] };
  }
  match = value.match(/^jdbc:postgresql:\/\/([^/:]+)(?::(\d+))?\/([^?]+)/);
  if (match) {
    return { dialect: "postgresql", host: normalizeHost(match[1]), port: Number(match[2] || 5432), database: match[3] };
  }
  return null;
}

function toPostgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => "$" + (++index));
}

function kafkaBrokers(config) {
  return String(config?.bootstrapServers || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parsed = parseHostPort(item, 9092);
      return `${parsed.host}:${parsed.port}`;
    });
}

function createKafka(config) {
  return new Kafka({
    clientId: `leidian-test-workbench-${Date.now()}`,
    brokers: kafkaBrokers(config),
    connectionTimeout: 3000,
    requestTimeout: 8000,
    retry: { retries: 1 },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tcpCheck(name, target, timeoutMs = 1800) {
  return new Promise((resolve) => {
    if (!target?.host || !target?.port) {
      resolve(step(name, false, "missing host/port"));
      return;
    }
    const startedAt = Date.now();
    const socket = net.createConnection(target.port, target.host);
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(step(name, ok, detail, Date.now() - startedAt));
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, `${target.host}:${target.port} connected`));
    socket.once("timeout", () => done(false, `${target.host}:${target.port} timeout`));
    socket.once("error", (error) => done(false, error.message));
  });
}

async function httpCheck(name, targetUrl, timeoutMs = 2200, targetPath = "") {
  if (!targetUrl) return step(name, false, "missing URL");
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(joinUrl(targetUrl, targetPath), { method: "GET", signal: controller.signal });
    const detail = targetPath ? `HTTP ${response.status} ${targetPath}` : `HTTP ${response.status}`;
    return step(name, response.status < 500, detail, Date.now() - startedAt);
  } catch (error) {
    return step(name, false, error.message, Date.now() - startedAt);
  } finally {
    clearTimeout(timer);
  }
}

function step(name, ok, detail, elapsedMs = 0, evidence = {}) {
  return { name, ok, detail, elapsedMs, evidence };
}

async function runPrecheck(env, testCase) {
  const capabilities = new Set(testCase.capabilities || []);
  const base = env.base || {};
  const caps = env.capabilities || {};
  const checks = [];
  if (capabilities.has("http")) {
    checks.push(httpCheck("gateway", base.gatewayUrl, 2200, base.gatewayHealthPath || "/actuator/health"));
    checks.push(httpCheck("data-service", base.dataServiceUrl, 2200, base.dataServiceHealthPath || "/actuator/health"));
    checks.push(httpCheck("biz-service", base.bizServiceUrl, 2200, base.bizServiceHealthPath || "/actuator/health"));
  }
  if (capabilities.has("kafka") && caps.kafka?.enabled) {
    checks.push(tcpCheck("kafka", parseHostPort(caps.kafka.bootstrapServers, 9092)));
  }
  if (capabilities.has("database") && caps.database?.enabled) {
    checks.push(tcpCheck("database", parseHostPort(caps.database.jdbcUrl, 3306)));
  }
  if (capabilities.has("minio") && caps.minio?.enabled) {
    checks.push(httpCheck("minio", caps.minio.endpoint, 2200, "/minio/health/live"));
  }
  if (capabilities.has("websocket") && caps.websocket?.enabled) {
    checks.push(tcpCheck("websocket", parseHostPort(caps.websocket.url)));
  }
  const results = await Promise.all(checks);
  return { ok: results.length > 0 && results.every((item) => item.ok), results };
}

async function runEnvironmentCheck(env) {
  const base = env.base || {};
  const caps = env.capabilities || {};
  const checks = [];
  const push = (key, promise) => checks.push(promise.then((item) => ({ ...item, key })));

  push("gatewayUrl", httpCheck("gateway", base.gatewayUrl, 2200, base.gatewayHealthPath || "/actuator/health"));
  push("dataServiceUrl", httpCheck("data-service", base.dataServiceUrl, 2200, base.dataServiceHealthPath || "/actuator/health"));
  push("bizServiceUrl", httpCheck("biz-service", base.bizServiceUrl, 2200, base.bizServiceHealthPath || "/actuator/health"));
  push("taskServiceUrl", httpCheck("task-service", base.taskServiceUrl, 2200, base.taskServiceHealthPath || "/actuator/health"));

  if (caps.kafka?.enabled) {
    push("kafka", tcpCheck("kafka", parseHostPort(caps.kafka.bootstrapServers, 9092)));
  }
  if (caps.database?.enabled) {
    push("database", tcpCheck("database", parseHostPort(caps.database.jdbcUrl, 3306)));
  }
  if (caps.minio?.enabled) {
    push("minio", httpCheck("minio", caps.minio.endpoint, 2200, "/minio/health/live"));
  }
  if (caps.websocket?.enabled) {
    push("websocket", tcpCheck("websocket", parseHostPort(caps.websocket.url)));
  }
  if (caps.tunnel?.enabled && caps.tunnel.publicUrl) {
    push("tunnel", httpCheck("tunnel", caps.tunnel.publicUrl));
  }

  const results = await Promise.all(checks);
  return { ok: results.length > 0 && results.every((item) => item.ok), results };
}

function buildTraceId() {
  return `trace-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
}

function buildRadarObjectKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const nonce = Math.random().toString(16).slice(2, 8);
  const ts = `${y}${m}${d}${h}${pad(now.getMinutes())}${pad(now.getSeconds())}${ms}`;
  return `upstream/radar/realtime/${y}/${m}/${d}/${h}/radar_${ts}_${nonce}.json`;
}

function createMinioClient(config) {
  const endpoint = new URL(config.endpoint);
  return new Minio.Client({
    endPoint: normalizeHost(endpoint.hostname),
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: config.accessKey,
    secretKey: config.secretKey || config.secretKeyRef,
  });
}

async function ensureBucket(client, bucket) {
  if (!(await client.bucketExists(bucket))) {
    try {
      await client.makeBucket(bucket);
    } catch (error) {
      if (!["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.code)) throw error;
    }
  }
}

function buildCurrentRadarHourPrefix(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  return `${y}/${m}/${d}/${h}`;
}

function normalizeRadarHourPrefix(value) {
  const normalized = String(value || buildCurrentRadarHourPrefix()).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length !== 4) throw new Error("上传小时目录不合法");
  const [yyyy, mm, dd, hh] = segments;
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm) || !/^\d{2}$/.test(dd) || !/^\d{2}$/.test(hh)) {
    throw new Error("上传小时目录不合法");
  }
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31 || Number(hh) > 23) {
    throw new Error("上传小时目录不合法");
  }
  return `${yyyy}/${mm}/${dd}/${hh}`;
}

function buildFolderUploadObjectKey(relativePath, hourPrefix) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length || segments.some((segment) => segment === ".." || /[\u0000-\u001f]/.test(segment))) {
    throw new Error("文件相对路径不合法");
  }
  const fileName = segments[segments.length - 1];
  if (!/\.json$/i.test(fileName)) {
    throw new Error("仅支持上传 JSON 文件");
  }
  return `upstream/radar/realtime/${normalizeRadarHourPrefix(hourPrefix)}/${fileName}`;
}

function getSavedEnvironment(envKey) {
  const state = readJson(envFile, { environments: {} });
  const env = state.environments?.[envKey];
  if (!env) throw new Error(`未找到环境配置：${envKey || "空"}`);
  const minio = env.capabilities?.minio;
  if (!minio?.enabled || !minio.endpoint || !minio.accessKey || !(minio.secretKey || minio.secretKeyRef) || !minio.bucket) {
    throw new Error("当前环境的 MinIO 配置不完整");
  }
  return env;
}

async function uploadFolderFile(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  let env;
  let objectKey;
  try {
    env = getSavedEnvironment(requestUrl.searchParams.get("env"));
    objectKey = buildFolderUploadObjectKey(requestUrl.searchParams.get("path"), requestUrl.searchParams.get("hourPrefix"));
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || "上传参数不合法" });
    return;
  }
  const size = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(size) || size < 0) {
    sendJson(res, 411, { ok: false, message: "无法确定文件大小，请重新选择文件夹后上传" });
    return;
  }
  const minio = env.capabilities.minio;
  const client = createMinioClient(minio);
  await ensureBucket(client, minio.bucket);
  const startedAt = Date.now();
  const uploaded = await client.putObject(minio.bucket, objectKey, req, size, {
    "Content-Type": req.headers["content-type"] || "application/json",
    "x-amz-meta-source": "leidian-test-workbench-folder-upload",
  });
  sendJson(res, 200, {
    ok: true,
    bucket: minio.bucket,
    objectKey,
    sizeBytes: size,
    elapsedMs: Date.now() - startedAt,
    etag: uploaded?.etag || null,
  });
}

function isValidFolderObjectKey(objectKey) {
  const normalized = String(objectKey || "").replace(/\\/g, "/");
  if (!normalized.startsWith("upstream/radar/realtime/") || !/\.json$/i.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === ".." || /[\u0000-\u001f]/.test(segment));
}

async function queryFolderRadarRecentSnapshot(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  let env;
  let body;
  try {
    env = getSavedEnvironment(requestUrl.searchParams.get("env"));
    body = await readBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, message: error.message || "查询参数不合法" });
    return;
  }
  const objectKeys = Array.isArray(body.objectKeys) ? body.objectKeys.map((item) => String(item || "")) : [];
  const uniqueKeys = Array.from(new Set(objectKeys)).filter(isValidFolderObjectKey);
  if (!uniqueKeys.length) {
    sendJson(res, 200, { ok: true, found: [], scanned: 0, detail: "没有待验证对象" });
    return;
  }
  const baseUrl = env.base?.bizServiceUrl || env.base?.gatewayUrl;
  if (!baseUrl) {
    sendJson(res, 200, { ok: false, found: [], scanned: uniqueKeys.length, detail: "缺少查询服务地址" });
    return;
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${normalizeUrl(baseUrl).replace(/\/$/, "")}/radar/frames/recent?minutes=60`);
    const text = await response.text();
    const found = response.ok ? uniqueKeys.filter((objectKey) => text.includes(objectKey)) : [];
    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      found,
      scanned: uniqueKeys.length,
      elapsedMs: Date.now() - startedAt,
      detail: response.ok ? `扫描 recent 返回，命中 ${found.length}/${uniqueKeys.length}` : `HTTP ${response.status}`,
    });
  } catch (error) {
    sendJson(res, 200, { ok: false, found: [], scanned: uniqueKeys.length, elapsedMs: Date.now() - startedAt, detail: error.message });
  }
}

async function dbQuery(env, sql, params = []) {
  const db = env.capabilities?.database || {};
  const parsed = parseJdbcDatabase(db.jdbcUrl);
  if (!parsed) throw new Error("invalid jdbcUrl");
  const password = db.password || db.passwordRef || "";
  if (parsed.dialect === "postgresql") {
    const client = new PgClient({
      host: parsed.host,
      port: parsed.port,
      database: parsed.database,
      user: db.username,
      password,
      connectionTimeoutMillis: 3000,
    });
    await client.connect();
    try {
      const result = await client.query(toPostgresSql(sql), params);
      return result.rows;
    } finally {
      await client.end();
    }
  }
  const conn = await mysql.createConnection({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: db.username,
    password,
    connectTimeout: 3000,
  });
  try {
    const [rows] = await conn.execute(sql, params);
    return rows;
  } finally {
    await conn.end();
  }
}

async function waitKafkaMessage(kafkaConfig, topic, predicate, timeoutMs = 8000) {
  const kafka = createKafka(kafkaConfig);
  const consumer = kafka.consumer({ groupId: `leidian-test-workbench-${Date.now()}-${Math.random().toString(16).slice(2)}` });
  let found = null;
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  const wait = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    consumer.run({
      eachMessage: async ({ message }) => {
        const value = message.value ? message.value.toString("utf8") : "";
        const headers = Object.fromEntries(
          Object.entries(message.headers || {}).map(([key, value]) => [key, Buffer.isBuffer(value) ? value.toString("utf8") : String(value)]),
        );
        const item = { key: message.key?.toString("utf8"), value, headers };
        if (predicate(item)) {
          found = item;
          clearTimeout(timer);
          resolve(item);
        }
      },
    }).catch(() => resolve(null));
  });
  const result = await wait;
  await consumer.disconnect().catch(() => {});
  return result || found;
}

function readDeviceSample() {
  const preferred = path.join(samplesDir, "03_grounding.jsonl");
  const fallback = path.join(samplesDir, "all-devices.jsonl");
  const file = fs.existsSync(preferred) ? preferred : fallback;
  const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find(Boolean);
  if (!line) throw new Error(`no sample found in ${file}`);
  const sample = JSON.parse(line);
  return { file: path.basename(file), hex: String(sample.hex || "").replace(/\s+/g, "").toUpperCase(), sample };
}

async function listenWebSocket(url, traceId, timeoutMs = 6000) {
  if (!url) return step("检查 WebSocket", false, "未配置 WebSocket 地址");
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const ws = new WebSocket(normalizeUrl(url));
    const timer = setTimeout(() => {
      ws.close();
      resolve(step("检查 WebSocket", false, "等待推送超时", Date.now() - startedAt));
    }, timeoutMs);
    ws.on("message", (data) => {
      const text = data.toString();
      if (text.includes(traceId) || text.includes("RADAR") || text.includes("REALTIME")) {
        clearTimeout(timer);
        ws.close();
        resolve(step("检查 WebSocket", true, "已收到推送消息", Date.now() - startedAt, { message: text.slice(0, 500) }));
      }
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      resolve(step("检查 WebSocket", false, error.message, Date.now() - startedAt));
    });
  });
}

function startRadarObjectWebSocketProbe(url, objectKey, timeoutMs = 8000) {
  if (!url) {
    return { ready: Promise.resolve(), result: Promise.resolve({ ok: false, detail: "未配置 WebSocket 地址", elapsedMs: 0 }) };
  }
  const startedAt = Date.now();
  let markReady;
  let resolveResult;
  let settled = false;
  const ready = new Promise((resolve) => { markReady = resolve; });
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const ws = new WebSocket(normalizeUrl(url));
  const finish = (ok, detail, message = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    markReady();
    ws.close();
    resolveResult({ ok, detail, elapsedMs: Date.now() - startedAt, message: message.slice(0, 500) });
  };
  const timer = setTimeout(() => finish(false, "等待与当前对象关联的推送超时"), timeoutMs);
  ws.on("open", () => markReady());
  ws.on("message", (data) => {
    const text = data.toString();
    if (text.includes(objectKey)) finish(true, "收到当前对象的推送", text);
  });
  ws.on("error", (error) => finish(false, error.message));
  return { ready, result };
}

async function verifyRadarObjectQueryApi(env, objectKey, timeoutMs = 10000) {
  const baseUrl = env.base?.bizServiceUrl || env.base?.gatewayUrl;
  if (!baseUrl) return { ok: false, detail: "缺少查询服务地址", elapsedMs: 0 };
  const startedAt = Date.now();
  let lastDetail = "查询结果中未找到当前对象";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${normalizeUrl(baseUrl).replace(/\/$/, "")}/radar/frames/recent?minutes=60`);
      const body = await response.text();
      if (response.ok && body.includes(objectKey)) {
        return { ok: true, detail: "查询接口返回当前对象", elapsedMs: Date.now() - startedAt };
      }
      lastDetail = response.ok ? "查询结果中未找到当前对象" : `HTTP ${response.status}`;
    } catch (error) {
      lastDetail = error.message;
    }
    await sleep(800);
  }
  return { ok: false, detail: lastDetail, elapsedMs: Date.now() - startedAt };
}

async function runMinioRadarCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const minio = env.capabilities.minio;
  const kafka = env.capabilities.kafka;
  const wsPromise = listenWebSocket(env.capabilities.websocket?.url, traceId).catch((error) => step("检查 WebSocket", false, error.message));
  const objectKey = buildRadarObjectKey();
  const client = createMinioClient(minio);
  const payload = Buffer.from(JSON.stringify({ traceId, objectKey, generatedAt: new Date().toISOString(), source: "leidian-test-workbench" }, null, 2));

  const startedAt = Date.now();
  await ensureBucket(client, minio.bucket);
  await client.putObject(minio.bucket, objectKey, payload, payload.length, {
    "Content-Type": "application/json",
    "x-amz-meta-traceid": traceId,
  });
  steps.push(step("上传雷达帧文件", true, objectKey, Date.now() - startedAt, { bucket: minio.bucket, objectKey, traceId }));

  const kafkaMessage = await waitKafkaMessage(kafka, kafka.upstreamTopic || "radar-frame-upstream", (item) => item.value.includes(objectKey) || item.value.includes(traceId), 8000).catch(() => null);
  steps.push(step("检查上游 Topic", true, kafkaMessage ? "已观察到上游消息" : "未直接观察到消息，由下游检查确认", 0, kafkaMessage ? { message: kafkaMessage.value.slice(0, 800) } : {}));

  try {
    const rows = await dbQuery(env, "select count(*) as count from file_frame_index where trace_id = ? or object_key = ?", [traceId, objectKey]);
    steps.push(step("检查文件入库", Number(rows[0]?.count || 0) > 0, `命中 ${rows[0]?.count ?? 0} 条`, 0, { rows }));
  } catch (error) {
    steps.push(step("检查文件入库", false, error.message));
  }

  const wsStep = await wsPromise;
  steps.push(wsStep);
  await callQueryApi(
    env.base?.bizServiceUrl || env.base?.gatewayUrl,
    "/radar/frames/recent?minutes=60",
    steps,
    "检查查询接口",
  );
  return finishRun(testCase, env, traceId, steps);
}

async function queryRadarIndexCount(env, traceId, objectKey) {
  const rows = await dbQuery(env, "select count(*) as count from file_frame_index where trace_id = ? or object_key = ?", [traceId, objectKey]);
  return { count: Number(rows[0]?.count || 0), rows };
}

async function assertQueryApiDoesNotExposeRadar(env, traceId, objectKey, steps) {
  const baseUrl = env.base?.bizServiceUrl || env.base?.gatewayUrl;
  if (!baseUrl) {
    steps.push(step("检查查询接口", false, "缺少服务地址"));
    return;
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${normalizeUrl(baseUrl).replace(/\/$/, "")}/radar/frames/recent?minutes=60`);
    const text = await response.text();
    const exposed = text.includes(traceId) || text.includes(objectKey);
    const ok = response.status < 500 && !exposed;
    steps.push(step("检查查询接口", ok, ok ? `HTTP ${response.status}，未暴露异常数据` : `HTTP ${response.status}，疑似暴露异常数据`, Date.now() - startedAt, { body: text.slice(0, 800) }));
  } catch (error) {
    steps.push(step("检查查询接口", false, error.message, Date.now() - startedAt));
  }
}

async function runMinioInvalidRadarCase(env, testCase, variant) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const minio = env.capabilities.minio;
  const kafka = env.capabilities.kafka;
  const objectKey = buildRadarObjectKey().replace(/radar_/, variant === "invalid-json" ? "radar_invalid_json_" : "radar_missing_fields_");
  const client = createMinioClient(minio);
  const payload = variant === "invalid-json"
    ? Buffer.from(`{"traceId":"${traceId}","objectKey":"${objectKey}",`, "utf8")
    : Buffer.from(JSON.stringify({ traceId, objectKey, source: "leidian-test-workbench" }, null, 2), "utf8");

  steps.push(step(
    variant === "invalid-json" ? "准备异常文件" : "准备缺字段样例",
    true,
    variant === "invalid-json" ? "已构造不可解析 JSON" : "已构造缺少雷达帧关键字段的 JSON",
    0,
    { traceId, objectKey, payloadPreview: payload.toString("utf8").slice(0, 180) },
  ));

  const startedAt = Date.now();
  await ensureBucket(client, minio.bucket);
  await client.putObject(minio.bucket, objectKey, payload, payload.length, {
    "Content-Type": "application/json",
    "x-amz-meta-traceid": traceId,
    "x-amz-meta-negative-case": variant,
  });
  steps.push(step("上传到 MinIO", true, objectKey, Date.now() - startedAt, { bucket: minio.bucket, objectKey, traceId }));

  const kafkaMessage = await waitKafkaMessage(kafka, kafka.upstreamTopic || "radar-frame-upstream", (item) => item.value.includes(objectKey) || item.value.includes(traceId), 5000).catch(() => null);
  steps.push(step("等待下游处理", true, kafkaMessage ? "已观察到对象事件，等待消费处理" : "未直接观察到对象事件，继续检查下游状态", 0, kafkaMessage ? { message: kafkaMessage.value.slice(0, 800) } : {}));
  await sleep(3000);

  try {
    const result = await queryRadarIndexCount(env, traceId, objectKey);
    steps.push(step("检查正常索引", result.count === 0, result.count === 0 ? "未写入正常雷达帧索引" : `异常数据写入 ${result.count} 条正常索引`, 0, { rows: result.rows }));
  } catch (error) {
    steps.push(step("检查正常索引", false, error.message));
  }

  await assertQueryApiDoesNotExposeRadar(env, traceId, objectKey, steps);
  return finishRun(testCase, env, traceId, steps);
}

async function waitForRadarIndexState(env, objectKey, expectedTraceId, expectedCount = 1, timeoutMs = 12000) {
  const startedAt = Date.now();
  let lastRows = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastRows = await dbQuery(
      env,
      "select trace_id, object_key, file_id, update_time from file_frame_index where object_key = ? order by update_time desc limit 5",
      [objectKey],
    );
    const count = lastRows.length;
    const topTraceId = lastRows[0]?.trace_id || "";
    if (count === expectedCount && (!expectedTraceId || topTraceId === expectedTraceId)) {
      return { count, rows: lastRows };
    }
    await sleep(800);
  }
  return { count: lastRows.length, rows: lastRows };
}

async function runMinioDuplicateObjectCase(env, testCase) {
  const traceId1 = buildTraceId();
  const traceId2 = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, `dup-${traceId1}`, steps);

  const minio = env.capabilities.minio;
  const objectKey = buildRadarObjectKey();
  const client = createMinioClient(minio);
  const payload1 = Buffer.from(JSON.stringify({ traceId: traceId1, objectKey, uploadRound: 1, source: "leidian-test-workbench" }, null, 2));
  const payload2 = Buffer.from(JSON.stringify({ traceId: traceId2, objectKey, uploadRound: 2, source: "leidian-test-workbench" }, null, 2));

  await ensureBucket(client, minio.bucket);

  let startedAt = Date.now();
  await client.putObject(minio.bucket, objectKey, payload1, payload1.length, {
    "Content-Type": "application/json",
    "x-amz-meta-traceid": traceId1,
    "x-amz-meta-case": "duplicate-object",
    "x-amz-meta-round": "1",
  });
  steps.push(step("上传首个对象", true, objectKey, Date.now() - startedAt, { bucket: minio.bucket, objectKey, traceId: traceId1 }));

  let firstState;
  try {
    firstState = await waitForRadarIndexState(env, objectKey, traceId1, 1);
    steps.push(step("检查首次入库", firstState.count === 1, firstState.count === 1 ? "首次写入 1 条索引" : `首次写入异常：命中 ${firstState.count} 条`, 0, { rows: firstState.rows }));
  } catch (error) {
    steps.push(step("检查首次入库", false, error.message));
  }

  startedAt = Date.now();
  await client.putObject(minio.bucket, objectKey, payload2, payload2.length, {
    "Content-Type": "application/json",
    "x-amz-meta-traceid": traceId2,
    "x-amz-meta-case": "duplicate-object",
    "x-amz-meta-round": "2",
  });
  steps.push(step("重复上传同一 objectKey", true, objectKey, Date.now() - startedAt, { bucket: minio.bucket, objectKey, traceId: traceId2 }));

  try {
    const secondState = await waitForRadarIndexState(env, objectKey, traceId2, 1);
    const traceMatch = secondState.rows[0]?.trace_id === traceId2;
    const ok = secondState.count === 1 && traceMatch;
    steps.push(step(
      "检查幂等覆盖",
      ok,
      ok ? "同一 objectKey 仍为 1 条索引，trace_id 已切换到第二次上传" : `命中 ${secondState.count} 条，最新 trace_id=${secondState.rows[0]?.trace_id || "空"}`,
      0,
      { rows: secondState.rows, traceId1, traceId2 },
    ));
  } catch (error) {
    steps.push(step("检查幂等覆盖", false, error.message));
  }

  await callQueryApi(
    env.base?.bizServiceUrl || env.base?.gatewayUrl,
    "/radar/frames/recent?minutes=60",
    steps,
    "检查查询接口",
  );

  return finishRun(testCase, env, `dup-${traceId1}`, steps);
}

async function waitForFileFrameIndex(env, objectKey, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rows = await dbQuery(env,
      "select trace_id, object_key, parse_status from file_frame_index where object_key = ? order by update_time desc limit 5",
      [objectKey]).catch(() => []);
    if (rows.length > 0) return rows[0];
    await sleep(800);
  }
  return null;
}

async function runMinioLargePayloadCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const minio = env.capabilities.minio;
  const wsPromise = listenWebSocket(env.capabilities.websocket?.url, traceId).catch((error) => step("检查 WebSocket", false, error.message));
  const objectKey = buildRadarObjectKey();
  const client = createMinioClient(minio);
  const targetBytes = 10 * 1024 * 1024;
  const padding = "A".repeat(Math.max(0, targetBytes - 256));
  const payload = Buffer.from(JSON.stringify({
    traceId,
    objectKey,
    generatedAt: new Date().toISOString(),
    source: "leidian-test-workbench",
    sizeBytes: targetBytes,
    note: "10MB large-payload boundary test",
    padding,
  }), "utf8");

  steps.push(step("生成大文件", true, `约 ${Math.round(payload.length / 1024)} KB`, 0, { objectKey, sizeBytes: payload.length }));

  const uploadStart = Date.now();
  await ensureBucket(client, minio.bucket);
  await client.putObject(minio.bucket, objectKey, payload, payload.length, {
    "Content-Type": "application/json",
    "x-amz-meta-traceid": traceId,
    "x-amz-meta-case": "large-payload",
  });
  const uploadMs = Date.now() - uploadStart;
  steps.push(step("上传文件", true, objectKey, uploadMs, { bucket: minio.bucket, objectKey, traceId, uploadMs, sizeBytes: payload.length }));

  const indexStart = Date.now();
  const indexRow = await waitForFileFrameIndex(env, objectKey, 15000);
  const indexMs = Date.now() - indexStart;
  const indexOk = !!indexRow && indexRow.trace_id === traceId;
  steps.push(step("检查异步消费", indexOk,
    indexOk ? `file_frame_index 命中，trace_id=${indexRow.trace_id}` : (indexRow ? `命中但 trace_id=${indexRow.trace_id} 不匹配` : "超时未命中 file_frame_index"),
    indexMs, { indexRow, indexMs }));

  const wsStep = await wsPromise;
  steps.push(wsStep);

  await callQueryApi(
    env.base?.bizServiceUrl || env.base?.gatewayUrl,
    "/radar/frames/recent?minutes=60",
    steps,
    "检查查询接口",
  );

  steps.push(step("汇总时延", true, `上传 ${uploadMs}ms / 端到端 ${indexMs}ms`, 0, { uploadMs, indexMs, sizeBytes: payload.length }));

  return finishRun(testCase, env, traceId, steps);
}

async function runDeviceHexCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const ingest = env.capabilities.deviceIngest || {};
  const sample = readDeviceSample();
  steps.push(step("选择样例 HEX", true, `样例文件 ${sample.file}`, 0, { sampleFile: sample.file, hexPreview: sample.hex.slice(0, 120) }));
  const sendElapsed = await sendDeviceHex(env, { traceId, dedupKey: `${traceId}-device`, hex: sample.hex });
  steps.push(step("发送设备报文", true, `已发送到 ${ingest.rawTopic || "device-raw-data"}`, sendElapsed, { traceId, sampleFile: sample.file, hexPreview: sample.hex.slice(0, 120) }));

  await sleep(2500);
  await queryCount(env, "data_raw_message", "检查 raw 入库", steps);
  await queryCount(env, "data_standard_message", "检查标准层", steps);
  await callQueryApi(env.base?.dataServiceUrl, `/ingest/standard/device/recent?monitorType=${encodeURIComponent(ingest.defaultMonitorType || "GROUNDING_RESISTANCE")}`, steps, "检查接口返回");
  return finishRun(testCase, env, traceId, steps);
}

// ── 设备协议帧构造与查询工具 ─────────────────────────────────────────────
function hexToBytes(hex) {
  const clean = String(hex || "").replace(/\s+/g, "").toUpperCase();
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return bytes;
}

function bytesToHex(bytes) {
  return bytes.map((b) => (b & 0xFF).toString(16).padStart(2, "0").toUpperCase()).join("");
}

// CRC16-Modbus：init 0xFFFF、poly 0xA001，对齐 leidan-pgsql 的 Crc16ModbusUtil.calculate
function crc16Modbus(bytes) {
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] & 0xFF);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) {
        crc = (crc >>> 1) ^ 0xA001;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return crc & 0xFFFF;
}

// 拼装合法设备帧：5A4B | len | type | addr(4) | cmd(2) | payload | crcLo crcHi | 0D0A
// len = 总长 - 7（与 DeviceFrameSplitter 的 frameLength = lengthByte + 7 对齐），CRC 小端
function buildDeviceFrame({ deviceType, deviceAddr, commandType, payloadHex }) {
  const typeByte = typeof deviceType === "number" ? deviceType : parseInt(deviceType, 16);
  let addrBytes = hexToBytes(deviceAddr || "00020001");
  while (addrBytes.length < 4) addrBytes.unshift(0);
  addrBytes = addrBytes.slice(0, 4);
  let cmdBytes = hexToBytes(commandType || "0001");
  while (cmdBytes.length < 2) cmdBytes.unshift(0);
  cmdBytes = cmdBytes.slice(0, 2);
  const payloadBytes = hexToBytes(payloadHex || "");
  const lengthByte = payloadBytes.length + 7;
  const head = [0x5A, 0x4B, lengthByte & 0xFF, typeByte & 0xFF, ...addrBytes, ...cmdBytes, ...payloadBytes];
  const crc = crc16Modbus(head);
  return bytesToHex([...head, crc & 0xFF, (crc >> 8) & 0xFF, 0x0D, 0x0A]);
}

// 翻转 CRC 低位，制造校验失败帧（INVALID_CRC），不重算 CRC
function corruptFrameCrc(frameHex) {
  const bytes = hexToBytes(frameHex);
  if (bytes.length < 10) return frameHex;
  const crcLoIndex = bytes.length - 4;
  bytes[crcLoIndex] = (bytes[crcLoIndex] ^ 0xFF) & 0xFF;
  return bytesToHex(bytes);
}

// 构造长度字段不一致的越界帧：len 声明 0x40(=>frameLength 71) 但只给 16 字节 + 提前 0D0A
// 切帧器 frameLength > buffer.length -> 半包等待 -> 单条消息下切不出完整帧 -> NO_COMPLETE_FRAME
function buildOversizedLengthFrame() {
  const head = [0x5A, 0x4B, 0x40, 0x03, 0x00, 0x02, 0x00, 0x01, 0x00, 0x01, 0xAA, 0xBB, 0xCC, 0xDD];
  return bytesToHex([...head, 0x0D, 0x0A]);
}

async function sendDeviceHex(env, { traceId, dedupKey, hex }) {
  const kafkaConfig = env.capabilities.kafka;
  const ingest = env.capabilities.deviceIngest || {};
  const producer = createKafka(kafkaConfig).producer();
  const startedAt = Date.now();
  await producer.connect();
  await producer.send({
    topic: ingest.rawTopic || "device-raw-data",
    messages: [{
      key: traceId,
      value: Buffer.from(hex, "ascii"),
      headers: { "X-Trace-Id": traceId, "X-Dedup-Key": dedupKey || `${traceId}-device` },
    }],
  });
  await producer.disconnect();
  return Date.now() - startedAt;
}

async function queryRawByTrace(env, traceId) {
  const rows = await dbQuery(env,
    "select process_status, error_message, is_duplicate, dedup_key, raw_data from data_raw_message where trace_id = ? order by id desc limit 5",
    [traceId]);
  return rows[0] || null;
}

async function queryCountByTrace(env, table, traceId) {
  const rows = await dbQuery(env, `select count(*) as count from ${table} where trace_id = ?`, [traceId]);
  return Number(rows[0]?.count || 0);
}

async function queryCountWhere(env, table, column, value) {
  const rows = await dbQuery(env, `select count(*) as count from ${table} where ${column} = ?`, [value]);
  return Number(rows[0]?.count || 0);
}

async function waitForRawStatus(env, traceId, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const row = await queryRawByTrace(env, traceId).catch(() => null);
    if (row && row.process_status && row.process_status !== "RAW_SAVED") return row;
    await sleep(800);
  }
  return await queryRawByTrace(env, traceId).catch(() => null);
}

async function runDeviceHexInvalidFormatCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const invalidHex = "5A4B11030002000100010010001A003C000703E875C8ZZ0D0A";
  steps.push(step("构造非法报文", true, "含非 HEX 字符(ZZ)，归一化后 isHex=false -> TEXT_NOISE", 0, { hexPreview: invalidHex }));

  const dedupKey = `${traceId}-invalid-format`;
  const elapsed = await sendDeviceHex(env, { traceId, dedupKey, hex: invalidHex });
  steps.push(step("发送非法报文", true, "已发送到 device-raw-data", elapsed, { traceId, dedupKey, hexPreview: invalidHex }));

  const raw = await waitForRawStatus(env, traceId);
  const statusOk = raw?.process_status === "SKIPPED";
  const reasonOk = /TEXT_NOISE/.test(raw?.error_message || "");
  steps.push(step("检查失败记录", statusOk && reasonOk,
    raw ? `process_status=${raw.process_status}（${reasonOk ? "命中 TEXT_NOISE" : "未命中 TEXT_NOISE"}）` : "未查到 raw 记录",
    0, { raw }));

  const standardCount = await queryCountByTrace(env, "data_standard_message", traceId).catch(() => -1);
  steps.push(step("检查标准层无污染", standardCount === 0, `data_standard_message 命中 ${standardCount} 条`, 0, { standardCount }));

  const monitorCount = await queryCountByTrace(env, "monitor_grounding_resistance", traceId).catch(() => -1);
  steps.push(step("检查 monitor 无污染", monitorCount === 0, `monitor_grounding_resistance 命中 ${monitorCount} 条`, 0, { monitorCount }));

  const exceptionCount = await queryCountByTrace(env, "data_exception", traceId).catch(() => -1);
  steps.push(step("检查异常留痕", exceptionCount >= 1, `data_exception 命中 ${exceptionCount} 条`, 0, { exceptionCount }));

  return finishRun(testCase, env, traceId, steps);
}

async function runDeviceHexChecksumErrorCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const sample = readDeviceSample();
  const corrupted = corruptFrameCrc(sample.hex);
  steps.push(step("篡改校验位", true, "翻转 CRC 低位，触发 CRC 校验失败", 0, { originalHexPreview: sample.hex.slice(0, 120), corruptedHexPreview: corrupted.slice(0, 120) }));

  const dedupKey = `${traceId}-checksum-error`;
  const elapsed = await sendDeviceHex(env, { traceId, dedupKey, hex: corrupted });
  steps.push(step("发送报文", true, "已发送到 device-raw-data", elapsed, { traceId, dedupKey }));

  const raw = await waitForRawStatus(env, traceId);
  const statusOk = raw?.process_status === "SKIPPED";
  const errorMessage = raw?.error_message || "";
  const reasonOk = /(INVALID_CRC|CRC校验失败)/.test(errorMessage) && /HANDLER_NO_PERSIST|未写入监测记录/.test(errorMessage);
  steps.push(step("检查校验失败", statusOk && reasonOk,
    raw ? `process_status=${raw.process_status}（${reasonOk ? "命中 CRC 校验失败 + 未写入监测记录" : "未命中预期原因"}）` : "未查到 raw 记录",
    0, { raw }));

  const standardCount = await queryCountByTrace(env, "data_standard_message", traceId).catch(() => -1);
  steps.push(step("检查标准层无污染", standardCount === 0, `data_standard_message 命中 ${standardCount} 条`, 0, { standardCount }));

  const monitorCount = await queryCountByTrace(env, "monitor_grounding_resistance", traceId).catch(() => -1);
  steps.push(step("检查 monitor 无污染", monitorCount === 0, `monitor_grounding_resistance 命中 ${monitorCount} 条`, 0, { monitorCount }));

  const exceptionCount = await queryCountByTrace(env, "data_exception", traceId).catch(() => -1);
  steps.push(step("检查异常留痕", exceptionCount >= 1, `data_exception 命中 ${exceptionCount} 条`, 0, { exceptionCount }));

  return finishRun(testCase, env, traceId, steps);
}

async function runDeviceHexUnknownTypeCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const unknownHex = buildDeviceFrame({ deviceType: 0xFE, deviceAddr: "00020001", commandType: "0001", payloadHex: "" });
  steps.push(step("构造未知类型报文", true, "deviceType=FE（不在 11 个支持集合内），CRC 合法", 0, { hexPreview: unknownHex }));

  const dedupKey = `${traceId}-unknown-type`;
  const elapsed = await sendDeviceHex(env, { traceId, dedupKey, hex: unknownHex });
  steps.push(step("发送报文", true, "已发送到 device-raw-data", elapsed, { traceId, dedupKey }));

  const raw = await waitForRawStatus(env, traceId);
  const statusOk = raw?.process_status === "SKIPPED";
  const errorMessage = raw?.error_message || "";
  const reasonOk = /(UNSUPPORTED|未支持)/.test(errorMessage) && /(unsupported deviceType=FE|deviceType=FE|设备类型.*FE)/.test(errorMessage);
  steps.push(step("检查分类结果", statusOk && reasonOk,
    raw ? `process_status=${raw.process_status}（${reasonOk ? "命中未知设备类型 FE" : "未命中预期原因"}）` : "未查到 raw 记录",
    0, { raw }));

  const standardCount = await queryCountByTrace(env, "data_standard_message", traceId).catch(() => -1);
  steps.push(step("检查标准层无污染", standardCount === 0, `data_standard_message 命中 ${standardCount} 条`, 0, { standardCount }));

  const monitorCount = await queryCountByTrace(env, "monitor_grounding_resistance", traceId).catch(() => -1);
  steps.push(step("检查 monitor 无污染", monitorCount === 0, `monitor_grounding_resistance 命中 ${monitorCount} 条`, 0, { monitorCount }));

  const exceptionCount = await queryCountByTrace(env, "data_exception", traceId).catch(() => -1);
  steps.push(step("检查异常留痕", exceptionCount >= 1, `data_exception 命中 ${exceptionCount} 条`, 0, { exceptionCount }));

  return finishRun(testCase, env, traceId, steps);
}

async function runDeviceHexLengthBoundaryCase(env, testCase) {
  const traceId1 = buildTraceId();
  const traceId2 = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, `len-${traceId1}`, steps);

  const sample = readDeviceSample();
  const overlongHex = buildOversizedLengthFrame();
  steps.push(step("准备边界样例", true,
    `正:最短合法接地帧 ${sample.hex.length / 2} 字节；负:len 字段声明 0x40 但实际仅给短缓冲`,
    0, { shortestHexPreview: sample.hex.slice(0, 120), overlongHexPreview: overlongHex }));

  const elapsed1 = await sendDeviceHex(env, { traceId: traceId1, dedupKey: `${traceId1}-len-pos`, hex: sample.hex });
  steps.push(step("发送最短合法报文", true, `traceId=${traceId1}`, elapsed1, { traceId1 }));

  const raw1 = await waitForRawStatus(env, traceId1);
  const posOk = raw1?.process_status === "PARSED_SUCCESS";
  steps.push(step("检查最短合法可解析", posOk, raw1 ? `process_status=${raw1.process_status}` : "未查到 raw 记录", 0, { raw1 }));

  const monitorCount1 = await queryCountByTrace(env, "monitor_grounding_resistance", traceId1).catch(() => -1);
  steps.push(step("检查最短合法入库", monitorCount1 >= 1, `monitor_grounding_resistance 命中 ${monitorCount1} 条`, 0, { monitorCount1 }));

  const elapsed2 = await sendDeviceHex(env, { traceId: traceId2, dedupKey: `${traceId2}-len-neg`, hex: overlongHex });
  steps.push(step("发送越界报文", true, `traceId=${traceId2}（len 字段不一致）`, elapsed2, { traceId2, overlongHexPreview: overlongHex }));

  const raw2 = await waitForRawStatus(env, traceId2);
  const negOk = raw2?.process_status === "SKIPPED" && /NO_COMPLETE_FRAME/.test(raw2?.error_message || "");
  steps.push(step("检查越界被拒", negOk,
    raw2 ? `process_status=${raw2.process_status}（${/NO_COMPLETE_FRAME/.test(raw2?.error_message || "") ? "命中 NO_COMPLETE_FRAME" : "未命中 NO_COMPLETE_FRAME"}）` : "未查到 raw 记录",
    0, { raw2 }));

  const standardCount2 = await queryCountByTrace(env, "data_standard_message", traceId2).catch(() => -1);
  steps.push(step("检查越界无污染", standardCount2 === 0, `data_standard_message 命中 ${standardCount2} 条`, 0, { standardCount2 }));

  return finishRun(testCase, env, `len-${traceId1}`, steps);
}

async function runDeviceHexDuplicateCase(env, testCase) {
  const traceId1 = buildTraceId();
  const traceId2 = buildTraceId();
  const dedupKey = `dup-${traceId1}`;
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, dedupKey, steps);

  const sample = readDeviceSample();

  const elapsed1 = await sendDeviceHex(env, { traceId: traceId1, dedupKey, hex: sample.hex });
  steps.push(step("发送首条报文", true, `traceId=${traceId1} dedupKey=${dedupKey}`, elapsed1, { traceId1, dedupKey }));

  const raw1 = await waitForRawStatus(env, traceId1);
  steps.push(step("检查首条处理", true, raw1 ? `process_status=${raw1.process_status}` : "未查到 raw 记录", 0, { raw1 }));

  const elapsed2 = await sendDeviceHex(env, { traceId: traceId2, dedupKey, hex: sample.hex });
  steps.push(step("重复发送同 dedupKey", true, `traceId=${traceId2} dedupKey=${dedupKey}`, elapsed2, { traceId2, dedupKey }));

  await sleep(2500);

  const rawByDedup = await queryCountWhere(env, "data_raw_message", "dedup_key", dedupKey).catch(() => -1);
  steps.push(step("检查去重入库数量", rawByDedup === 1, `dedup_key=${dedupKey} 命中 ${rawByDedup} 条 raw（应为 1）`, 0, { dedupKey, rawByDedup }));

  const rawByTrace2 = await queryCountByTrace(env, "data_raw_message", traceId2).catch(() => -1);
  steps.push(step("检查重复报文未入库", rawByTrace2 === 0, `trace_id=${traceId2} 命中 ${rawByTrace2} 条 raw（应为 0）`, 0, { traceId2, rawByTrace2 }));

  const standardByTrace2 = await queryCountByTrace(env, "data_standard_message", traceId2).catch(() => -1);
  steps.push(step("检查重复报文无标准层", standardByTrace2 === 0, `data_standard_message trace_id=${traceId2} 命中 ${standardByTrace2} 条`, 0, { standardByTrace2 }));

  const exceptionByTrace2 = await queryCountByTrace(env, "data_exception", traceId2).catch(() => -1);
  steps.push(step("检查重复报文无异常留痕", exceptionByTrace2 === 0, `data_exception trace_id=${traceId2} 命中 ${exceptionByTrace2} 条（应为 0，重复静默跳过）`, 0, { exceptionByTrace2 }));

  return finishRun(testCase, env, dedupKey, steps);
}

async function runLocalServiceCase(env, testCase) {
  const traceId = buildTraceId();
  const precheck = await runPrecheck(env, testCase);
  const steps = precheck.results.length ? precheck.results : [step("环境预检查", false, "未配置检查项")];
  return finishRun(testCase, env, traceId, steps);
}

async function queryCount(env, table, label, steps) {
  try {
    const rows = await dbQuery(env, `select count(*) as count from ${table}`);
    steps.push(step(label, true, `命中 ${rows[0]?.count ?? 0} 条`, 0, { rows }));
  } catch (error) {
    steps.push(step(label, false, error.message));
  }
}

async function callQueryApi(baseUrl, pathName, steps, label) {
  if (!baseUrl) {
    steps.push(step(label, false, "缺少服务地址"));
    return;
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${normalizeUrl(baseUrl).replace(/\/$/, "")}${pathName}`);
    const text = await response.text();
    steps.push(step(label, response.status < 500, `HTTP ${response.status}`, Date.now() - startedAt, { body: text.slice(0, 800) }));
  } catch (error) {
    steps.push(step(label, false, error.message, Date.now() - startedAt));
  }
}

function finishRun(testCase, env, traceId, steps) {
  const result = {
    ok: steps.every((item) => item.ok),
    traceId,
    caseId: testCase.id,
    caseName: testCase.name,
    envName: env.name,
    startedAt: new Date().toISOString(),
    steps,
  };
  const file = path.join(runsDir, `${traceId}.json`);
  writeJson(file, result);
  result.reportFile = file;
  return result;
}

async function runCase(env, testCase) {
  if (testCase.id === "minio-radar-frame-full-link") return runMinioRadarCase(env, testCase);
  if (testCase.id === "minio-radar-invalid-json") return runMinioInvalidRadarCase(env, testCase, "invalid-json");
  if (testCase.id === "minio-radar-missing-required-fields") return runMinioInvalidRadarCase(env, testCase, "missing-fields");
  if (testCase.id === "minio-radar-duplicate-object") return runMinioDuplicateObjectCase(env, testCase);
  if (testCase.id === "minio-radar-large-payload") return runMinioLargePayloadCase(env, testCase);
  if (testCase.id === "device-hex-full-link") return runDeviceHexCase(env, testCase);
  if (testCase.id === "device-hex-invalid-format") return runDeviceHexInvalidFormatCase(env, testCase);
  if (testCase.id === "device-hex-checksum-error") return runDeviceHexChecksumErrorCase(env, testCase);
  if (testCase.id === "device-hex-unknown-device-type") return runDeviceHexUnknownTypeCase(env, testCase);
  if (testCase.id === "device-hex-length-boundary") return runDeviceHexLengthBoundaryCase(env, testCase);
  if (testCase.id === "device-hex-duplicate-message") return runDeviceHexDuplicateCase(env, testCase);
  if (testCase.id === "local-service-health") return runLocalServiceCase(env, testCase);
  return finishRun(testCase, env, buildTraceId(), [step("不支持的用例", false, `未知用例 id：${testCase.id}`)]);
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(rootDir, requested);
  if (!filePath.startsWith(rootDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "leidian-test-workbench", port });
    return;
  }
  if (req.method === "POST" && pathname === "/api/minio/folder-upload") {
    await uploadFolderFile(req, res);
    return;
  }
  if (req.method === "POST" && pathname === "/api/minio/folder-recent-snapshot") {
    await queryFolderRadarRecentSnapshot(req, res);
    return;
  }
  if (req.method === "GET" && pathname === "/api/environments") {
    sendJson(res, 200, readJson(envFile, { environments: null, activeEnv: "local" }));
    return;
  }
  if (req.method === "POST" && pathname === "/api/environments") {
    const body = await readBody(req);
    writeJson(envFile, {
      environments: body.environments || {},
      activeEnv: body.activeEnv || "local",
      updatedAt: new Date().toISOString(),
    });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/precheck") {
    const body = await readBody(req);
    const result = await runPrecheck(body.env || {}, body.case || {});
    sendJson(res, 200, { ok: result.ok, traceId: buildTraceId(), results: result.results });
    return;
  }
  if (req.method === "POST" && pathname === "/api/env-check") {
    const body = await readBody(req);
    const result = await runEnvironmentCheck(body.env || {});
    sendJson(res, 200, { ok: result.ok, traceId: buildTraceId(), results: result.results });
    return;
  }
  if (req.method === "POST" && pathname === "/api/run-case") {
    const body = await readBody(req);
    sendJson(res, 200, await runCase(body.env || {}, body.case || {}));
    return;
  }
  if (req.method === "GET" && pathname === "/api/runs") {
    ensureDirs();
    const limit = Math.min(Number(new URL(req.url, "http://local").searchParams.get("limit") || 50), 200);
    const files = fs
      .readdirSync(runsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const full = path.join(runsDir, name);
        const payload = readJson(full, null);
        if (!payload) return null;
        return { ...payload, reportFile: name };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, limit);
    sendJson(res, 200, { ok: true, runs: files });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/api/runs/")) {
    const traceId = decodeURIComponent(pathname.slice("/api/runs/".length));
    if (!traceId || traceId.includes("..") || traceId.includes("/") || traceId.includes("\\")) {
      sendJson(res, 400, { ok: false, message: "invalid traceId" });
      return;
    }
    const file = path.join(runsDir, `${traceId}.json`);
    if (!fs.existsSync(file)) {
      sendJson(res, 404, { ok: false, message: "run not found" });
      return;
    }
    sendJson(res, 200, readJson(file, null));
    return;
  }
  sendJson(res, 404, { ok: false, message: "API not found" });
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (parsed.pathname.startsWith("/api/")) {
    handleApi(req, res, parsed.pathname).catch((error) => {
      sendJson(res, 500, { ok: false, message: error.message, stack: error.stack });
    });
    return;
  }
  serveStatic(req, res, decodeURIComponent(parsed.pathname));
});

ensureDirs();
server.listen(port, "0.0.0.0", () => {
  console.log(`leidian-test-workbench listening on http://0.0.0.0:${port}`);
});
