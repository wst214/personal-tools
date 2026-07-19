import { existsSync } from "node:fs";

function isDocker() {
  return existsSync("/.dockerenv");
}

export function defaultWsRadarUrl() {
  if (process.env.LEIDIAN_WS_RADAR_URL?.trim()) {
    return process.env.LEIDIAN_WS_RADAR_URL.trim();
  }
  if (isDocker()) {
    return "ws://leidian-gateway-service:8080/api/biz/realtime/ws";
  }
  return "ws://localhost:8080/api/biz/realtime/ws";
}

export function resolveWsRadarUrl(requestUrl) {
  const fallback = defaultWsRadarUrl();
  const trimmed = requestUrl?.trim();
  if (!trimmed) return fallback;

  try {
    const url = new URL(trimmed);
    if (isDocker() && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      const port = url.port || "8080";
      return `ws://leidian-gateway-service:${port}${url.pathname}${url.search}`;
    }
    return trimmed;
  } catch {
    return fallback;
  }
}

function parseWsMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function buildVerifyResult({
  ok,
  wsUrl,
  matched,
  expectedTraceIds,
  expectedObjectKeys,
  matchedTraceIds,
  matchedObjectKeys,
  startedAt,
  timedOut = false,
  error = null,
}) {
  const missingTraceIds = [...expectedTraceIds].filter((id) => !matchedTraceIds.has(id));
  const missingObjectKeys = [...expectedObjectKeys].filter((key) => !matchedObjectKeys.has(key));
  return {
    ok: error ? false : ok,
    wsUrl,
    matched,
    missing: {
      traceIds: missingTraceIds,
      objectKeys: missingObjectKeys,
    },
    timedOut,
    waitedMs: Date.now() - startedAt,
    error,
  };
}

/**
 * 上传前启动监听，上传过程中动态注册 traceId / objectKey。
 */
export async function startRadarFrameListener({ wsUrl, timeoutMs = 30000 }) {
  let WebSocketImpl;
  try {
    const mod = await import("ws");
    WebSocketImpl = mod.default;
  } catch (error) {
    return {
      ready: false,
      error: `缺少 ws 依赖，请在项目目录执行: npm install (${error?.message || error})`,
      track() {},
      async finish() {
        return buildVerifyResult({
          ok: false,
          wsUrl: resolveWsRadarUrl(wsUrl),
          matched: [],
          expectedTraceIds: new Set(),
          expectedObjectKeys: new Set(),
          matchedTraceIds: new Set(),
          matchedObjectKeys: new Set(),
          startedAt: Date.now(),
          error: error?.message || String(error),
        });
      },
    };
  }

  const resolvedUrl = resolveWsRadarUrl(wsUrl);
  const startedAt = Date.now();
  const expectedTraceIds = new Set();
  const expectedObjectKeys = new Set();
  const matchedTraceIds = new Set();
  const matchedObjectKeys = new Set();
  const matched = [];

  let ws;
  let timer;
  let finishWait;
  let finished = false;
  const donePromise = new Promise((resolve) => {
    finishWait = resolve;
  });

  function isComplete() {
    const traceDone = !expectedTraceIds.size || matchedTraceIds.size >= expectedTraceIds.size;
    const keyDone = !expectedObjectKeys.size || matchedObjectKeys.size >= expectedObjectKeys.size;
    return traceDone && keyDone && (expectedTraceIds.size > 0 || expectedObjectKeys.size > 0);
  }

  function finish(extra = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (ws && ws.readyState === WebSocketImpl.OPEN) {
      ws.close();
    }
    finishWait(
      buildVerifyResult({
        ok: isComplete(),
        wsUrl: resolvedUrl,
        matched,
        expectedTraceIds,
        expectedObjectKeys,
        matchedTraceIds,
        matchedObjectKeys,
        startedAt,
        timedOut: Boolean(extra.timedOut),
        error: extra.error ?? null,
      }),
    );
  }

  try {
    ws = new WebSocketImpl(resolvedUrl);
  } catch (error) {
    return {
      ready: false,
      error: error?.message || String(error),
      track() {},
      async finish() {
        return buildVerifyResult({
          ok: false,
          wsUrl: resolvedUrl,
          matched: [],
          expectedTraceIds,
          expectedObjectKeys,
          matchedTraceIds,
          matchedObjectKeys,
          startedAt,
          error: error?.message || String(error),
        });
      },
    };
  }

  return await new Promise((resolveStarter) => {
    let starterResolved = false;
    const connectTimer = setTimeout(() => {
      if (starterResolved) return;
      starterResolved = true;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolveStarter({
        ready: false,
        error: `WebSocket 连接超时: ${resolvedUrl}`,
        track() {},
        async finish() {
          return buildVerifyResult({
            ok: false,
            wsUrl: resolvedUrl,
            matched: [],
            expectedTraceIds,
            expectedObjectKeys,
            matchedTraceIds,
            matchedObjectKeys,
            startedAt,
            timedOut: true,
            error: `WebSocket 连接超时: ${resolvedUrl}`,
          });
        },
      });
    }, Math.min(8000, Math.max(3000, timeoutMs)));

    function resolveOnce(result) {
      if (starterResolved) return;
      starterResolved = true;
      clearTimeout(connectTimer);
      resolveStarter(result);
    }

    ws.on("open", () => {
      resolveOnce({
        ready: true,
        track({ traceId, objectKey }) {
          if (traceId) expectedTraceIds.add(traceId);
          if (objectKey) expectedObjectKeys.add(objectKey);
          if (isComplete()) finish({ timedOut: false });
        },
        async finish(extraTimeoutMs = timeoutMs) {
          if (finished) return donePromise;
          if (!expectedTraceIds.size && !expectedObjectKeys.size) {
            finish({ error: "没有可匹配的 traceId 或 objectKey" });
            return donePromise;
          }
          timer = setTimeout(() => finish({ timedOut: true }), extraTimeoutMs);
          return donePromise;
        },
      });
    });

    ws.on("message", (data) => {
      const msg = parseWsMessage(data);
      if (!msg || msg.type !== "RADAR_FRAME_READY") return;

      const payload = msg.data ?? {};
      const traceId = payload.traceId ?? null;
      const objectKey = payload.objectKey ?? null;
      const traceHit = traceId && expectedTraceIds.has(traceId);
      const keyHit = objectKey && expectedObjectKeys.has(objectKey);
      if (!traceHit && !keyHit) return;

      matched.push({
        traceId,
        objectKey,
        frameId: payload.frameId ?? null,
        downloadUrl: payload.downloadUrl ?? null,
        eventTime: payload.eventTime ?? null,
        receivedAt: Date.now(),
        message: msg,
      });
      if (traceId) matchedTraceIds.add(traceId);
      if (objectKey) matchedObjectKeys.add(objectKey);
      if (isComplete()) finish({ timedOut: false });
    });

    ws.on("error", (error) => {
      const errMsg = error?.message || String(error);
      if (!finished) {
        finish({ error: errMsg });
      }
      resolveOnce({
        ready: false,
        error: errMsg,
        track() {},
        async finish() {
          return donePromise;
        },
      });
    });

    ws.on("close", () => {
      if (!starterResolved) {
        resolveOnce({
          ready: false,
          error: `WebSocket 连接关闭: ${resolvedUrl}`,
          track() {},
          async finish() {
            return buildVerifyResult({
              ok: false,
              wsUrl: resolvedUrl,
              matched: [],
              expectedTraceIds,
              expectedObjectKeys,
              matchedTraceIds,
              matchedObjectKeys,
              startedAt,
              timedOut: true,
              error: `WebSocket 连接关闭: ${resolvedUrl}`,
            });
          },
        });
        return;
      }
      if (!finished) {
        finish({ timedOut: true, error: "WebSocket 连接已关闭" });
      }
    });
  });
}

/** 一次性等待（兼容旧调用）。 */
export async function waitForRadarFrameReady(options) {
  const listener = await startRadarFrameListener({
    wsUrl: options.wsUrl,
    timeoutMs: options.timeoutMs,
  });
  if (!listener.ready) {
    return listener.finish();
  }
  const traceIds = options.traceIds ?? [];
  const objectKeys = options.objectKeys ?? [];
  const count = Math.max(traceIds.length, objectKeys.length);
  for (let i = 0; i < count; i += 1) {
    listener.track({
      traceId: traceIds[i] ?? null,
      objectKey: objectKeys[i] ?? null,
    });
  }
  return listener.finish(options.timeoutMs);
}
