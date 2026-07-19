#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProtocolText } from "./parser.js";
import { getPresignDefaults, presignGetObject } from "./minio-presign.js";
import {
  clearWebhookEvents,
  getWebhookConfig,
  listWebhookEvents,
  recordWebhookEvent,
} from "./webhook-store.js";
import {
  getUploadTestDefaults,
  uploadRadarFrames,
  sendDeviceToKafka,
} from "./upload-test.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.split("=")[1] ?? process.env.PORT ?? 8099);

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/parse") {
    const body = await readBody(req);
    sendJson(res, parseProtocolText(body));
    return;
  }

  if (req.method === "GET" && req.url === "/api/presign/defaults") {
    sendJson(res, getPresignDefaults());
    return;
  }

  if (req.method === "POST" && req.url === "/api/presign") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body.trim() ? JSON.parse(body) : {};
    } catch {
      sendJson(res, { ok: false, error: "请求体必须是 JSON" });
      return;
    }
    sendJson(res, await presignGetObject(payload));
    return;
  }

  if (req.method === "GET" && req.url === "/api/webhook/config") {
    sendJson(res, getWebhookConfig(port, req));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/webhook/events")) {
    const onlyPost = new URL(req.url, "http://local").searchParams.get("onlyPost") === "1";
    sendJson(res, listWebhookEvents({ onlyPost }));
    return;
  }

  if (req.method === "DELETE" && req.url === "/api/webhook/events") {
    clearWebhookEvents();
    sendJson(res, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/api/upload-test/defaults") {
    sendJson(res, getUploadTestDefaults());
    return;
  }

  if (req.method === "POST" && req.url === "/api/upload-test/minio") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body.trim() ? JSON.parse(body) : {};
    } catch {
      sendJson(res, { ok: false, error: "请求体必须是 JSON" });
      return;
    }
    try {
      sendJson(res, await uploadRadarFrames(payload));
    } catch (error) {
      sendJson(res, { ok: false, error: error?.message || String(error) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/upload-test/device") {
    const body = await readBody(req);
    let payload = {};
    try {
      payload = body.trim() ? JSON.parse(body) : {};
    } catch {
      sendJson(res, { ok: false, error: "请求体必须是 JSON" });
      return;
    }
    try {
      sendJson(res, await sendDeviceToKafka(payload));
    } catch (error) {
      sendJson(res, { ok: false, error: error?.message || String(error) });
    }
    return;
  }

  if (req.method === "POST" && (req.url === "/api/webhook/minio" || req.url === "/minio-test" || req.url.startsWith("/minio-test/"))) {
    const body = await readBody(req);
    const event = recordWebhookEvent({
      method: req.method,
      path: req.url.split("?")[0],
      remoteAddr: req.socket?.remoteAddress ?? null,
      contentType: req.headers["content-type"] ?? null,
      bodyText: body,
    });
    sendJson(res, { ok: true, message: "webhook received", id: event.id });
    return;
  }

  const filePath = req.url === "/" ? "web/index.html" : `web/${decodeURIComponent(req.url.split("?")[0].slice(1))}`;
  serveStatic(res, path.join(root, filePath));
});

server.listen(port, () => {
  console.log(`Device protocol parser started: http://localhost:${port}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, data) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(res, target) {
  if (!target.startsWith(path.join(root, "web"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(target);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  }[ext] ?? "text/plain; charset=utf-8";
  // HTML 禁止缓存，避免页签/布局更新后浏览器仍用旧 index
  const headers = { "Content-Type": contentType };
  if (ext === ".html") {
    headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    headers.Pragma = "no-cache";
  } else if (ext === ".css" || ext === ".js") {
    headers["Cache-Control"] = "no-cache";
  }
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}
