import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client, HeadBucketCommand, CreateBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { minioConfigFromEnv, normalizeEndpoint, resolveApiEndpointForSdk } from "./minio-presign.js";
import { defaultWsRadarUrl, resolveWsRadarUrl, startRadarFrameListener } from "./ws-radar-verify.js";
import {
  defaultRadarKafkaBootstrap,
  defaultRadarKafkaTopic,
  startRadarKafkaListener,
} from "./radar-kafka-verify.js";
import { defaultRadarApiBaseUrl, resolveRadarApiBaseUrl, verifyRadarRecentApi } from "./radar-api-verify.js";

const RADAR_UNDERSCORE = /radar_(\d{12,14})/i;
const DATE_TIME = /(\d{8})_(\d{6})/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

function isDocker() {
  return existsSync("/.dockerenv");
}

function defaultRadarSourceDir() {
  if (process.env.LEIDIAN_RADAR_SOURCE_DIR?.trim()) {
    return process.env.LEIDIAN_RADAR_SOURCE_DIR.trim();
  }
  return "D:\\mytools\\leidian-protocol-parse\\minio帧文件\\20250719";
}

/** Docker 内 Windows 盘符 → 容器挂载点（compose 挂载 D:/ 到 /host-d）。 */
function hostDriveMountRoot(driveLetter) {
  const letter = String(driveLetter || "").toUpperCase();
  const fromEnv = process.env[`LEIDIAN_HOST_DRIVE_${letter}`]?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (letter === "D") return "/host-d";
  return null;
}

function mapWindowsPathInDocker(windowsPath) {
  const normalized = windowsPath.replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/?(.*)$/.exec(normalized);
  if (!match) {
    throw new Error(`无法解析 Windows 路径: ${windowsPath}`);
  }
  const drive = match[1].toUpperCase();
  const mountRoot = hostDriveMountRoot(drive);
  if (!mountRoot) {
    throw new Error(
      `Docker 未挂载 ${drive}: 盘。当前默认仅挂载 D: → /host-d；其他盘请在 compose 中增加挂载并设置 LEIDIAN_HOST_DRIVE_${drive}`,
    );
  }
  const rest = (match[2] || "").replace(/^\/+/, "");
  return rest ? path.posix.join(mountRoot, rest) : mountRoot;
}

function resolveSourceDir(sourceDir) {
  const trimmed = sourceDir?.trim() || defaultRadarSourceDir();
  if (WINDOWS_PATH.test(trimmed) && isDocker()) {
    return mapWindowsPathInDocker(trimmed);
  }
  // 兼容旧默认路径（已不再单独挂载 /data/radar-frames）
  if (isDocker() && trimmed === "/data/radar-frames") {
    return mapWindowsPathInDocker(defaultRadarSourceDir());
  }
  return path.resolve(trimmed);
}

function createS3Client({ endpoint, accessKey, secretKey }) {
  return new S3Client({
    endpoint: normalizeEndpoint(endpoint),
    region: "us-east-1",
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    forcePathStyle: true,
  });
}

function parseTimestampFromName(fileName) {
  const base = fileName.toLowerCase().endsWith(".json") ? fileName.slice(0, -5) : fileName;

  let match = RADAR_UNDERSCORE.exec(base);
  if (match) {
    let ts = match[1];
    if (ts.length === 12) ts += "00";
    return ts;
  }

  match = DATE_TIME.exec(base);
  if (match) return match[1] + match[2];

  throw new Error(`无法从文件名解析时间: ${fileName}`);
}

function buildObjectKey(timestamp) {
  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(4, 6);
  const day = timestamp.slice(6, 8);
  const hour = timestamp.slice(8, 10);
  return `upstream/radar/realtime/${year}/${month}/${day}/${hour}/radar_${timestamp}.json`;
}

/** 递归收集目录下所有 .json（跳过隐藏目录如 .git）。 */
function walkJsonFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取目录 ${dir}: ${error?.message || error}`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

function collectFrames(sourceDir, limit) {
  const dir = resolveSourceDir(sourceDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`数据源目录不存在: ${dir}`);
  }

  const jsonFiles = walkJsonFiles(dir).sort((a, b) => a.localeCompare(b, "en"));

  if (!jsonFiles.length) {
    throw new Error(`目录内无 JSON 文件（含子目录）: ${dir}`);
  }

  const frames = [];
  const skipped = [];
  for (const filePath of jsonFiles) {
    try {
      const timestamp = parseTimestampFromName(path.basename(filePath));
      frames.push({
        path: filePath,
        fileName: path.basename(filePath),
        relativePath: path.relative(dir, filePath).replace(/\\/g, "/"),
        timestamp,
        objectKey: buildObjectKey(timestamp),
        frameId: `radar-${timestamp}`,
      });
    } catch (error) {
      skipped.push(`${path.relative(dir, filePath)}: ${error.message}`);
    }
  }

  if (!frames.length) {
    throw new Error("没有可上传的帧文件（含子目录 JSON，但文件名均无法解析时间）");
  }

  let result = frames;
  if (limit > 0 && result.length > limit) {
    result = result.slice(0, limit);
  }

  return { frames: result, skipped, totalInDir: frames.length };
}

function resolveMinioUploadEndpoint(requestEndpoint) {
  const apiEndpoint = minioConfigFromEnv().apiEndpoint || resolveApiEndpointForSdk();
  const trimmed = requestEndpoint?.trim();
  if (!trimmed) return apiEndpoint;

  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (isDocker() && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return apiEndpoint;
    }
    return normalizeEndpoint(trimmed);
  } catch {
    return apiEndpoint;
  }
}

function resolveMinioOptions(options = {}) {
  const env = minioConfigFromEnv();
  return {
    endpoint: resolveMinioUploadEndpoint(options.endpoint),
    accessKey: options.accessKey?.trim() || env.accessKey,
    secretKey: options.secretKey?.trim() || env.secretKey,
    bucket: options.bucket?.trim() || process.env.LEIDIAN_MINIO_FRAME_BUCKET || "leidian-frame",
    sourceDir: options.sourceDir?.trim() || defaultRadarSourceDir(),
    interval: Math.max(0, Number(options.interval ?? 20)),
    limit: Math.max(0, Number(options.limit ?? 0)),
    once: Boolean(options.once),
    dryRun: Boolean(options.dryRun),
    verifyMinio: options.verifyMinio !== false,
    verifyKafka: Boolean(options.verifyKafka),
    verifyWebSocket: Boolean(options.verifyWebSocket),
    verifyApi: options.verifyApi !== false,
    wsUrl: options.wsUrl?.trim() || defaultWsRadarUrl(),
    kafkaBootstrap: options.kafkaBootstrap?.trim() || defaultRadarKafkaBootstrap(),
    kafkaTopic: options.kafkaTopic?.trim() || defaultRadarKafkaTopic(),
    apiBaseUrl: resolveRadarApiBaseUrl(options.apiBaseUrl),
    apiMinutes: Math.max(1, Number(options.apiMinutes ?? 60)),
    verifyTimeoutMs: Math.max(1000, Number(options.verifyTimeoutMs ?? 30000)),
  };
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { created: false };
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return { created: true };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getMinioUploadDefaults() {
  const resolved = resolveMinioOptions({});
  const env = minioConfigFromEnv();
  return {
    endpoint: resolved.endpoint,
    browserEndpoint: env.browserEndpoint,
    apiEndpoint: resolved.endpoint,
    accessKey: resolved.accessKey,
    bucket: resolved.bucket,
    sourceDir: resolved.sourceDir,
    interval: resolved.interval,
    limit: resolved.limit,
    wsUrl: defaultWsRadarUrl(),
    kafkaBootstrap: defaultRadarKafkaBootstrap(),
    kafkaTopic: defaultRadarKafkaTopic(),
    apiBaseUrl: defaultRadarApiBaseUrl(),
    apiMinutes: 60,
    verifyMinio: true,
    verifyKafka: true,
    verifyWebSocket: true,
    verifyApi: true,
    verifyTimeoutMs: 30000,
    hint: isDocker()
      ? "Docker 模式：数据源可直接填 D:\\...（已挂载整盘 D:→/host-d）；验证 MinIO + Kafka + WebSocket + biz recent。"
      : "上传后验证 MinIO / radar-frame-upstream / WebSocket / biz recent 数据接口。",
  };
}

export async function uploadRadarFrames(options = {}) {
  const resolved = resolveMinioOptions(options);
  let frames;
  let skipped;
  let totalInDir;
  try {
    ({ frames, skipped, totalInDir } = collectFrames(resolved.sourceDir, resolved.limit));
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
  const uploadList = resolved.once ? frames.slice(0, 1) : frames;

  if (resolved.dryRun) {
    return {
      ok: true,
      dryRun: true,
      sourceDir: path.resolve(resolveSourceDir(resolved.sourceDir)),
      bucket: resolved.bucket,
      totalInDir,
      skipped,
      planned: uploadList.map((frame) => ({
        fileName: frame.fileName,
        relativePath: frame.relativePath,
        objectKey: frame.objectKey,
        frameId: frame.frameId,
      })),
    };
  }

  const client = createS3Client({
    endpoint: resolved.endpoint,
    accessKey: resolved.accessKey,
    secretKey: resolved.secretKey,
  });

  let bucketCreated = false;
  try {
    const bucketResult = await ensureBucket(client, resolved.bucket);
    bucketCreated = bucketResult.created;
  } catch (error) {
    const detail = error?.errors?.map((e) => e?.message).filter(Boolean).join("; ");
    return {
      ok: false,
      error: `检查/创建 bucket 失败: ${detail || error?.message || String(error)}`,
      endpoint: resolved.endpoint,
    };
  }

  const results = [];
  let okCount = 0;
  let failCount = 0;
  let wsStartError = null;
  let kafkaStartError = null;

  // 验证监听失败不阻断上传，只在结果里标记失败
  let wsListener = null;
  if (resolved.verifyWebSocket) {
    wsListener = await startRadarFrameListener({
      wsUrl: resolveWsRadarUrl(resolved.wsUrl),
      timeoutMs: resolved.verifyTimeoutMs,
    });
    if (!wsListener.ready) {
      wsStartError = wsListener.error || "WebSocket 监听启动失败";
      wsListener = null;
    }
  }

  let kafkaListener = null;
  if (resolved.verifyKafka) {
    kafkaListener = await startRadarKafkaListener({
      bootstrapServers: resolved.kafkaBootstrap,
      topic: resolved.kafkaTopic,
      timeoutMs: resolved.verifyTimeoutMs,
    });
    if (!kafkaListener.ready) {
      kafkaStartError = kafkaListener.error || "Kafka 监听启动失败";
      kafkaListener = null;
    }
  }

  for (let idx = 0; idx < uploadList.length; idx += 1) {
    const frame = uploadList[idx];
    const traceId = randomUUID().replace(/-/g, "");
    const t0 = Date.now();
    let status = "failed";
    let error = null;
    let minioVerify = null;

    try {
      const body = readFileSync(frame.path);
      await client.send(
        new PutObjectCommand({
          Bucket: resolved.bucket,
          Key: frame.objectKey,
          Body: body,
          ContentType: "application/json",
          Metadata: { traceid: traceId },
        }),
      );
      status = "success";
      okCount += 1;
      wsListener?.track({ traceId, objectKey: frame.objectKey, frameId: frame.frameId });
      kafkaListener?.track({ traceId, objectKey: frame.objectKey, frameId: frame.frameId });

      if (resolved.verifyMinio) {
        try {
          const head = await client.send(
            new HeadObjectCommand({ Bucket: resolved.bucket, Key: frame.objectKey }),
          );
          minioVerify = {
            ok: true,
            bucket: resolved.bucket,
            objectKey: frame.objectKey,
            contentLength: head.ContentLength ?? null,
            etag: head.ETag ?? null,
            contentType: head.ContentType ?? null,
          };
        } catch (headError) {
          minioVerify = {
            ok: false,
            bucket: resolved.bucket,
            objectKey: frame.objectKey,
            error: headError?.message || String(headError),
          };
        }
      }
    } catch (err) {
      failCount += 1;
      error = err?.message || String(err);
    }

    const t1 = Date.now();
    results.push({
      index: idx + 1,
      total: uploadList.length,
      status,
      traceId,
      objectKey: frame.objectKey,
      fileName: frame.fileName,
      frameId: frame.frameId,
      t0,
      t1,
      durationMs: t1 - t0,
      error,
      minioVerify,
    });

    if (idx < uploadList.length - 1 && resolved.interval > 0) {
      await sleep(resolved.interval * 1000);
    }
  }

  let kafkaVerify = null;
  let verify = null;
  if (kafkaListener || wsListener) {
    const [kafkaResult, wsResult] = await Promise.all([
      kafkaListener ? kafkaListener.finish(resolved.verifyTimeoutMs) : Promise.resolve(null),
      wsListener ? wsListener.finish(resolved.verifyTimeoutMs) : Promise.resolve(null),
    ]);
    kafkaVerify = kafkaResult;
    verify = wsResult;
  }
  if (resolved.verifyKafka && !kafkaVerify) {
    kafkaVerify = {
      ok: false,
      topic: resolved.kafkaTopic,
      matched: [],
      missing: { objectKeys: results.filter((r) => r.status === "success").map((r) => r.objectKey) },
      timedOut: false,
      waitedMs: 0,
      error: kafkaStartError || "Kafka 监听未启动",
    };
  }
  if (resolved.verifyWebSocket && !verify) {
    verify = {
      ok: false,
      wsUrl: resolveWsRadarUrl(resolved.wsUrl),
      matched: [],
      missing: { traceIds: [], objectKeys: [] },
      timedOut: Boolean(wsStartError),
      waitedMs: 0,
      error: wsStartError || "WebSocket 监听未启动",
    };
  }

  for (const item of results.filter((row) => row.status === "success")) {
    if (kafkaVerify) {
      const hit = kafkaVerify.matched?.find((m) => m.objectKey === item.objectKey);
      item.kafkaVerify = hit
        ? { ok: true, frameId: hit.frameId, downloadUrl: hit.downloadUrl, waitedMs: kafkaVerify.waitedMs }
        : {
            ok: false,
            timedOut: kafkaVerify.timedOut,
            error: kafkaVerify.error || "未收到 radar-frame-upstream 消息",
            waitedMs: kafkaVerify.waitedMs,
          };
    }
    if (verify) {
      const hit = verify.matched?.find(
        (m) => m.traceId === item.traceId || m.objectKey === item.objectKey,
      );
      item.wsVerify = hit
        ? { ok: true, frameId: hit.frameId, downloadUrl: hit.downloadUrl, waitedMs: verify.waitedMs }
        : {
            ok: false,
            timedOut: verify.timedOut,
            error: verify.error || "未收到 RADAR_FRAME_READY",
            waitedMs: verify.waitedMs,
          };
    }
  }

  let apiVerify = null;
  if (resolved.verifyApi) {
    const successful = results.filter((row) => row.status === "success");
    if (successful.length) {
      apiVerify = await verifyRadarRecentApi({
        apiBaseUrl: resolved.apiBaseUrl,
        minutes: resolved.apiMinutes,
        frameIds: successful.map((item) => item.frameId),
        objectKeys: successful.map((item) => item.objectKey),
        traceIds: successful.map((item) => item.traceId),
        timeoutMs: resolved.verifyTimeoutMs,
      });
      for (const item of successful) {
        const hit = apiVerify.matched?.find(
          (m) =>
            m.frameId === item.frameId ||
            m.objectKey === item.objectKey ||
            m.traceId === item.traceId,
        );
        item.apiVerify = hit
          ? {
              ok: true,
              frameId: hit.frameId,
              downloadUrl: hit.downloadUrl,
              eventTime: hit.eventTime,
              waitedMs: apiVerify.waitedMs,
            }
          : {
              ok: false,
              timedOut: apiVerify.timedOut,
              error: apiVerify.error || "recent 接口未查到该帧",
              waitedMs: apiVerify.waitedMs,
            };
      }
    }
  }

  const minioVerifyList = results.map((r) => r.minioVerify).filter(Boolean);
  const minioVerifyOk = !resolved.verifyMinio || minioVerifyList.every((v) => v.ok);
  const kafkaOk = !resolved.verifyKafka || (kafkaVerify?.ok ?? true);
  const verifyOk = !resolved.verifyWebSocket || (verify?.ok ?? true);
  const apiOk = !resolved.verifyApi || (apiVerify?.ok ?? true);
  const allUploadOk = failCount === 0;

  return {
    ok: allUploadOk && minioVerifyOk && kafkaOk && verifyOk && apiOk,
    sourceDir: path.resolve(resolveSourceDir(resolved.sourceDir)),
    bucket: resolved.bucket,
    bucketCreated,
    totalInDir,
    skipped,
    success: okCount,
    failed: failCount,
    minioVerify: {
      ok: minioVerifyOk,
      checked: minioVerifyList.length,
      passed: minioVerifyList.filter((v) => v.ok).length,
      items: minioVerifyList,
    },
    kafkaVerify,
    verify,
    apiVerify,
    results,
  };
}
