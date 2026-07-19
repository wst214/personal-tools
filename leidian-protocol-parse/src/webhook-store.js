/**
 * MinIO Webhook 事件内存存储（本地测试用，重启服务后清空）。
 */

const MAX_EVENTS = 100;

/** @type {import('./webhook-store.js').WebhookEvent[]} */
const events = [];

/**
 * @typedef {Object} WebhookEvent
 * @property {string} id
 * @property {string} receivedAt
 * @property {string} method
 * @property {string} path
 * @property {string|null} remoteAddr
 * @property {string|null} contentType
 * @property {number} bodyLength
 * @property {string|null} bucket
 * @property {string|null} objectKey
 * @property {string} body
 * @property {string} bodyPretty
 */

export function recordWebhookEvent({ method, path, remoteAddr, contentType, bodyText }) {
  const body = bodyText ?? "";
  const { bucket, objectKey } = extractMinioFields(body);
  /** @type {WebhookEvent} */
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: formatLocalTime(),
    method: method ?? "POST",
    path: path ?? "/",
    remoteAddr: remoteAddr ?? null,
    contentType: contentType ?? null,
    bodyLength: Buffer.byteLength(body, "utf8"),
    bucket,
    objectKey,
    body,
    bodyPretty: prettyJson(body),
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  return event;
}

export function listWebhookEvents({ onlyPost = false } = {}) {
  const items = onlyPost ? events.filter((e) => e.method === "POST") : [...events];
  const postItems = events.filter((e) => e.method === "POST");
  const latestPost = postItems[0] ?? null;
  return {
    total: events.length,
    postCount: postItems.length,
    lastPostAt: latestPost?.receivedAt ?? null,
    latestPostAt: latestPost?.receivedAt ?? null,
    latestPostPath: latestPost?.path ?? null,
    latestPostBody: latestPost?.body ?? "",
    latestPostBodyPretty: latestPost?.bodyPretty ?? "",
    events: items.map(serializeEvent),
  };
}

export function clearWebhookEvents() {
  events.length = 0;
}

/**
 * @param {number} port
 * @param {import('node:http').IncomingMessage} [req]
 */
export function getWebhookConfig(port, req) {
  const hostHeader = req?.headers?.host;
  const localUrl = hostHeader
    ? `http://${hostHeader}/minio-test`
    : `http://localhost:${port}/minio-test`;
  return {
    receivePaths: ["/minio-test", "/api/webhook/minio"],
    primaryPath: "/minio-test",
    localReceiveUrl: localUrl,
    dockerReceiveUrl: `http://leidian-tool:${port}/minio-test`,
    minioMcEndpoint: `http://host.docker.internal:${port}/minio-test`,
    hint: "MinIO notify_webhook 填 dockerReceiveUrl（同 Compose 网络）或 minioMcEndpoint（MinIO 在 Docker、工具在宿主机）",
  };
}

function serializeEvent(event) {
  return {
    id: event.id,
    receivedAt: event.receivedAt,
    method: event.method,
    path: event.path,
    remoteAddr: event.remoteAddr,
    contentType: event.contentType,
    bodyLength: event.bodyLength,
    bucket: event.bucket,
    objectKey: event.objectKey,
    body: event.body,
    bodyPretty: event.bodyPretty,
  };
}

function formatLocalTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prettyJson(text) {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function extractMinioFields(bodyText) {
  if (!bodyText) return { bucket: null, objectKey: null };
  try {
    const data = JSON.parse(bodyText);
    const records = data.Records;
    if (Array.isArray(records) && records.length > 0) {
      const s3 = records[0].s3 ?? {};
      let key = s3.object?.key;
      if (typeof key === "string") {
        key = decodeURIComponent(key.replace(/\+/g, " "));
      }
      return { bucket: s3.bucket?.name ?? null, objectKey: key ?? null };
    }
    let key = data.Key ?? data.key;
    if (typeof key === "string" && key.includes("/")) {
      const idx = key.indexOf("/");
      return { bucket: key.slice(0, idx), objectKey: key.slice(idx + 1) };
    }
    return { bucket: data.bucket ?? null, objectKey: key ?? null };
  } catch {
    return { bucket: null, objectKey: null };
  }
}
