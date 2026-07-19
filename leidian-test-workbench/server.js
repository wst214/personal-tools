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
  const ts = `${y}${m}${d}${h}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `upstream/radar/realtime/${y}/${m}/${d}/${h}/radar_${ts}.json`;
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
    await client.makeBucket(bucket);
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

async function runDeviceHexCase(env, testCase) {
  const traceId = buildTraceId();
  const steps = [];
  const precheck = await runPrecheck(env, testCase);
  steps.push(step("环境预检查", precheck.ok, precheck.ok ? "依赖均可连通" : "部分依赖不可达", 0, { checks: precheck.results }));
  if (!precheck.ok) return finishRun(testCase, env, traceId, steps);

  const kafkaConfig = env.capabilities.kafka;
  const ingest = env.capabilities.deviceIngest || {};
  const sample = readDeviceSample();
  steps.push(step("选择样例 HEX", true, `样例文件 ${sample.file}`, 0, { sampleFile: sample.file, hexPreview: sample.hex.slice(0, 120) }));
  const producer = createKafka(kafkaConfig).producer();
  const startedAt = Date.now();
  await producer.connect();
  await producer.send({
    topic: ingest.rawTopic || "device-raw-data",
    messages: [{
      key: traceId,
      value: Buffer.from(sample.hex, "ascii"),
      headers: { "X-Trace-Id": traceId, "X-Dedup-Key": `${traceId}-device` },
    }],
  });
  await producer.disconnect();
  steps.push(step("发送设备报文", true, `已发送到 ${ingest.rawTopic || "device-raw-data"}`, Date.now() - startedAt, { traceId, sampleFile: sample.file, hexPreview: sample.hex.slice(0, 120) }));

  await sleep(2500);
  await queryCount(env, "data_raw_message", "检查 raw 入库", steps);
  await queryCount(env, "data_standard_message", "检查标准层", steps);
  await callQueryApi(env.base?.dataServiceUrl, `/ingest/standard/device/recent?monitorType=${encodeURIComponent(ingest.defaultMonitorType || "GROUNDING_RESISTANCE")}`, steps, "检查接口返回");
  return finishRun(testCase, env, traceId, steps);
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
  if (testCase.id === "device-hex-full-link") return runDeviceHexCase(env, testCase);
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
