import { existsSync } from "node:fs";

function isDocker() {
  return existsSync("/.dockerenv");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** biz-service 直连（网关当前可能缺少 /api/v1/radar 路由）。 */
export function defaultRadarApiBaseUrl() {
  if (process.env.LEIDIAN_RADAR_API_BASE_URL?.trim()) {
    return process.env.LEIDIAN_RADAR_API_BASE_URL.trim().replace(/\/$/, "");
  }
  if (isDocker()) {
    return "http://leidian-biz-service:8083";
  }
  return "http://localhost:8083";
}

export function resolveRadarApiBaseUrl(requestUrl) {
  const fallback = defaultRadarApiBaseUrl();
  const trimmed = requestUrl?.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (isDocker() && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      // 旧默认 localhost:8080 是网关；recent 校验改为直连 biz:8083
      const port = !url.port || url.port === "8080" ? "8083" : url.port;
      return `http://leidian-biz-service:${port}`;
    }
    // 误填网关时自动改走 biz 直连路径对应的主机
    if (
      isDocker() &&
      (url.hostname === "leidian-gateway-service" || url.hostname === "gateway-service")
    ) {
      return "http://leidian-biz-service:8083";
    }
    return `${url.protocol}//${url.host}`.replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

/**
 * 路径选择：直连 biz 用 /radar/frames/recent；经网关用 /api/v1/radar/frames/recent。
 */
export function radarRecentPath(apiBaseUrl, minutes = 60) {
  const mins = Math.max(1, Number(minutes) || 60);
  const host = String(apiBaseUrl || "").toLowerCase();
  const viaGateway =
    host.includes("gateway") ||
    /:8080(\/|$)/.test(host) ||
    host.endsWith(":8080");
  const path = viaGateway
    ? `/api/v1/radar/frames/recent?minutes=${mins}`
    : `/radar/frames/recent?minutes=${mins}`;
  return path;
}

function unwrapFrames(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.list)) return body.data.list;
  if (Array.isArray(body?.data?.records)) return body.data.records;
  return [];
}

/**
 * 轮询 GET /api/v1/radar/frames/recent，按 frameId / objectKey / traceId 匹配。
 */
export async function verifyRadarRecentApi({
  apiBaseUrl,
  minutes = 60,
  frameIds = [],
  objectKeys = [],
  traceIds = [],
  timeoutMs = 30000,
  pollIntervalMs = 1500,
}) {
  const base = resolveRadarApiBaseUrl(apiBaseUrl);
  const path = radarRecentPath(base, minutes);
  const url = `${base}${path}`;
  const startedAt = Date.now();

  const expectedFrameIds = new Set(frameIds.filter(Boolean));
  const expectedObjectKeys = new Set(objectKeys.filter(Boolean));
  const expectedTraceIds = new Set(traceIds.filter(Boolean));

  if (!expectedFrameIds.size && !expectedObjectKeys.size && !expectedTraceIds.size) {
    return {
      ok: false,
      url,
      matched: [],
      missing: { frameIds: [], objectKeys: [], traceIds: [] },
      timedOut: false,
      waitedMs: 0,
      error: "没有可匹配的 frameId / objectKey / traceId",
      attempts: 0,
    };
  }

  const matched = [];
  const matchedFrameIds = new Set();
  const matchedObjectKeys = new Set();
  const matchedTraceIds = new Set();
  let attempts = 0;
  let lastError = null;

  function isComplete() {
    if (expectedFrameIds.size) return matchedFrameIds.size >= expectedFrameIds.size;
    if (expectedObjectKeys.size) return matchedObjectKeys.size >= expectedObjectKeys.size;
    return matchedTraceIds.size >= expectedTraceIds.size;
  }

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        lastError = `响应非 JSON (HTTP ${response.status})`;
        await sleep(pollIntervalMs);
        continue;
      }

      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${body?.message || text.slice(0, 120)}`;
        await sleep(pollIntervalMs);
        continue;
      }

      const frames = unwrapFrames(body);
      for (const frame of frames) {
        const frameId = frame?.frameId ?? null;
        const objectKey = frame?.objectKey ?? null;
        const traceId = frame?.traceId ?? null;
        const hit =
          (frameId && expectedFrameIds.has(frameId)) ||
          (objectKey && expectedObjectKeys.has(objectKey)) ||
          (traceId && expectedTraceIds.has(traceId));
        if (!hit) continue;

        const already =
          (frameId && matchedFrameIds.has(frameId)) ||
          (objectKey && matchedObjectKeys.has(objectKey));
        if (already) continue;

        matched.push({
          frameId,
          traceId,
          objectKey,
          eventTime: frame?.eventTime ?? null,
          downloadUrl: frame?.downloadUrl ?? null,
          foundAt: Date.now(),
        });
        if (frameId) matchedFrameIds.add(frameId);
        if (objectKey) matchedObjectKeys.add(objectKey);
        if (traceId) matchedTraceIds.add(traceId);
      }

      if (isComplete()) {
        return {
          ok: true,
          url,
          matched,
          missing: {
            frameIds: [...expectedFrameIds].filter((id) => !matchedFrameIds.has(id)),
            objectKeys: [...expectedObjectKeys].filter((key) => !matchedObjectKeys.has(key)),
            traceIds: [...expectedTraceIds].filter((id) => !matchedTraceIds.has(id)),
          },
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          attempts,
          error: null,
        };
      }
      lastError = null;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    url,
    matched,
    missing: {
      frameIds: [...expectedFrameIds].filter((id) => !matchedFrameIds.has(id)),
      objectKeys: [...expectedObjectKeys].filter((key) => !matchedObjectKeys.has(key)),
      traceIds: [...expectedTraceIds].filter((id) => !matchedTraceIds.has(id)),
    },
    timedOut: true,
    waitedMs: Date.now() - startedAt,
    attempts,
    error: lastError || "recent 接口未查到目标帧",
  };
}
