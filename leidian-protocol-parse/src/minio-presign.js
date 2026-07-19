import { existsSync } from "node:fs";
import { HeadObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_EXPIRY_SECONDS = 3600;
const DEFAULT_BUCKET = "leidian-device";
const DEFAULT_REGION = "us-east-1";

/** 内置预签名样例（路径符合 uploads/device{类型}/地址/日期/文件名 约定）。 */
export const PRESIGN_BUILTIN_SAMPLES = [
  {
    id: "01",
    name: "大气电场仪",
    dedupKey: `${DEFAULT_BUCKET}:uploads/device01/00010073/20260513/offset-7.json`,
  },
  {
    id: "0F",
    name: "智能 iSPD",
    dedupKey: `${DEFAULT_BUCKET}:uploads/device0F/00040090/20260513/offset-0.json`,
  },
  {
    id: "03",
    name: "接地电阻监测仪",
    dedupKey: `${DEFAULT_BUCKET}:uploads/device03/00010001/20260513/offset-0.json`,
  },
  {
    id: "14",
    name: "避雷器在线监测",
    dedupKey: `${DEFAULT_BUCKET}:uploads/device14/00014001/20260513/offset-0.json`,
  },
];

export function parseDedupKey(dedupKey) {
  if (!dedupKey || typeof dedupKey !== "string") {
    return { ok: false, error: "dedupKey 不能为空" };
  }
  const trimmed = dedupKey.trim();
  const sep = trimmed.indexOf(":");
  if (sep <= 0 || sep >= trimmed.length - 1) {
    return { ok: false, error: "dedupKey 格式应为 bucket:objectKey" };
  }
  const bucket = trimmed.slice(0, sep).trim();
  const objectKey = trimmed.slice(sep + 1).trim();
  if (!bucket || !objectKey) {
    return { ok: false, error: "bucket 或 objectKey 为空" };
  }
  return { ok: true, bucket, objectKey };
}

export function fileNameFromObjectKey(objectKey) {
  if (!objectKey) return "download";
  const slash = objectKey.lastIndexOf("/");
  return slash >= 0 && slash < objectKey.length - 1
    ? objectKey.slice(slash + 1)
    : objectKey;
}

export function normalizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== "string") {
    throw new Error("endpoint 不能为空");
  }
  const trimmed = endpoint.trim();
  return trimmed.includes("://") ? trimmed.replace(/\/$/, "") : `http://${trimmed}`.replace(/\/$/, "");
}

/**
 * 预签名 URL 主机名：须是宿主机浏览器能访问的地址（非 host.docker.internal）。
 */
export function resolveBrowserEndpoint(apiEndpoint) {
  const explicit =
    process.env.LEIDIAN_MINIO_BROWSER_ENDPOINT ??
    process.env.LEIDIAN_MINIO_PUBLIC_ENDPOINT ??
    process.env.MINIO_BROWSER_ENDPOINT;
  if (explicit?.trim()) {
    return normalizeEndpoint(explicit);
  }

  const base = apiEndpoint?.trim() || "http://localhost:19000";
  try {
    const url = new URL(base.includes("://") ? base : `http://${base}`);
    if (
      url.hostname === "host.docker.internal" ||
      url.hostname === "docker.host.internal"
    ) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.protocol}//localhost:${port}`;
    }
    return normalizeEndpoint(url.toString());
  } catch {
    return "http://localhost:19000";
  }
}

/** SDK 访问 MinIO（HeadObject 等）；Docker 内 localhost 会映射为 host.docker.internal。 */
export function resolveApiEndpointForSdk() {
  const explicit =
    process.env.LEIDIAN_MINIO_API_ENDPOINT ?? process.env.MINIO_API_ENDPOINT;
  if (explicit?.trim()) {
    return normalizeEndpoint(explicit);
  }

  const raw = normalizeEndpoint(
    process.env.LEIDIAN_MINIO_ENDPOINT ??
      process.env.MINIO_ENDPOINT ??
      "http://localhost:19000",
  );

  try {
    const url = new URL(raw);
    const inDocker = existsSync("/.dockerenv");
    if (
      inDocker &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    ) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80");
      return `${url.protocol}//host.docker.internal:${port}`;
    }
    return raw;
  } catch {
    return existsSync("/.dockerenv")
      ? "http://host.docker.internal:19000"
      : "http://localhost:19000";
  }
}

export function minioConfigFromEnv() {
  const apiEndpoint = resolveApiEndpointForSdk();
  const browserEndpoint = resolveBrowserEndpoint(
    process.env.LEIDIAN_MINIO_ENDPOINT ??
      process.env.MINIO_ENDPOINT ??
      "http://localhost:19000",
  );
  return {
    apiEndpoint,
    endpoint: browserEndpoint,
    browserEndpoint,
    accessKey:
      process.env.LEIDIAN_MINIO_ACCESS_KEY ??
      process.env.MINIO_ACCESS_KEY ??
      "minioadmin",
    secretKey:
      process.env.LEIDIAN_MINIO_SECRET_KEY ??
      process.env.MINIO_SECRET_KEY ??
      "minioadmin",
    defaultBucket:
      process.env.LEIDIAN_MINIO_DEVICE_BUCKET ??
      process.env.MINIO_DEVICE_BUCKET ??
      DEFAULT_BUCKET,
    expirySeconds: Number(
      process.env.LEIDIAN_MINIO_PRESIGN_EXPIRY_SECONDS ??
        process.env.MINIO_PRESIGN_EXPIRY_SECONDS ??
        DEFAULT_EXPIRY_SECONDS,
    ),
  };
}

export function getPresignDefaults() {
  const env = minioConfigFromEnv();
  const defaultDedupKey = PRESIGN_BUILTIN_SAMPLES[0].dedupKey;
  return {
    endpoint: env.endpoint,
    browserEndpoint: env.browserEndpoint,
    apiEndpoint: env.apiEndpoint,
    accessKey: env.accessKey,
    defaultBucket: env.defaultBucket,
    expirySeconds: env.expirySeconds,
    defaultDedupKey,
    samples: PRESIGN_BUILTIN_SAMPLES.map(({ id, name, dedupKey }) => ({
      id,
      name,
      dedupKey,
    })),
    hint: "生成前会检查 MinIO 是否存在该对象；不存在则返回错误，不生成 URL。",
  };
}

function resolvePresignOptions(options = {}) {
  const env = minioConfigFromEnv();
  const defaults = getPresignDefaults();

  const endpoint =
    options.endpoint?.trim() || env.browserEndpoint || env.endpoint;
  const accessKey = options.accessKey?.trim() || env.accessKey;
  const secretKey = options.secretKey?.trim() || env.secretKey;
  const expirySeconds = Math.max(
    60,
    Number(options.expirySeconds ?? env.expirySeconds) || DEFAULT_EXPIRY_SECONDS,
  );

  let dedupKey = options.dedupKey?.trim();
  let bucket = options.bucket?.trim();
  let objectKey = options.objectKey?.trim();

  if (!dedupKey && !bucket && !objectKey) {
    dedupKey = defaults.defaultDedupKey;
  }

  return { endpoint, accessKey, secretKey, expirySeconds, dedupKey, bucket, objectKey };
}

function createS3Client({ endpoint, accessKey, secretKey }) {
  return new S3Client({
    endpoint: normalizeEndpoint(endpoint),
    region: DEFAULT_REGION,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: true,
  });
}

function isNotFoundError(error) {
  const status = error?.$metadata?.httpStatusCode;
  const name = error?.name ?? "";
  const code = error?.Code ?? error?.code ?? "";
  return (
    status === 404 ||
    name === "NotFound" ||
    name === "NoSuchKey" ||
    code === "NotFound" ||
    code === "NoSuchKey"
  );
}

/** HeadObject：对象不存在返回 false，其它错误向上抛。 */
export async function checkObjectExists(bucket, objectKey, { accessKey, secretKey, apiEndpoint }) {
  const client = createS3Client({
    endpoint: apiEndpoint ?? resolveApiEndpointForSdk(),
    accessKey,
    secretKey,
  });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * 先 HeadObject 校验存在，再生成预签名 URL（浏览器用 browserEndpoint 主机名）。
 */
export async function presignGetObject(options = {}) {
  const resolved = resolvePresignOptions(options);
  const env = minioConfigFromEnv();
  const { accessKey, secretKey, expirySeconds } = resolved;
  const browserEndpoint = resolved.endpoint;
  const apiEndpoint = env.apiEndpoint;

  let bucket = resolved.bucket;
  let objectKey = resolved.objectKey;
  const dedupKey = resolved.dedupKey;

  if (dedupKey) {
    const parsed = parseDedupKey(dedupKey);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    bucket = parsed.bucket;
    objectKey = parsed.objectKey;
  }

  if (!bucket || !objectKey) {
    return {
      ok: false,
      error: "请提供 dedupKey，或同时提供 bucket 与 objectKey",
    };
  }

  try {
    const exists = await checkObjectExists(bucket, objectKey, {
      accessKey,
      secretKey,
      apiEndpoint,
    });
    if (!exists) {
      return {
        ok: false,
        error: `MinIO 对象不存在: ${bucket}/${objectKey}`,
        bucket,
        objectKey,
        dedupKey: dedupKey || `${bucket}:${objectKey}`,
      };
    }

    const signClient = createS3Client({
      endpoint: browserEndpoint,
      accessKey,
      secretKey,
    });
    const url = await getSignedUrl(
      signClient,
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      { expiresIn: expirySeconds },
    );
    return {
      ok: true,
      url,
      expiresInSeconds: expirySeconds,
      endpoint: normalizeEndpoint(browserEndpoint),
      bucket,
      objectKey,
      dedupKey: dedupKey || `${bucket}:${objectKey}`,
      fileName: fileNameFromObjectKey(objectKey),
      usedDefaults: describeUsedDefaults(options, resolved),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error) || "预签名失败",
      bucket,
      objectKey,
    };
  }
}

function describeUsedDefaults(request, resolved) {
  const defaults = getPresignDefaults();
  const used = [];
  if (!request.endpoint?.trim()) {
    used.push(`endpoint=${defaults.browserEndpoint}`);
  }
  if (!request.accessKey?.trim()) used.push(`accessKey=${defaults.accessKey}`);
  if (!request.secretKey?.trim()) used.push("secretKey=<环境变量>");
  if (!request.expirySeconds) used.push(`expirySeconds=${defaults.expirySeconds}`);
  if (!request.dedupKey?.trim() && !request.bucket?.trim() && !request.objectKey?.trim()) {
    used.push(`dedupKey=${defaults.defaultDedupKey}`);
  }
  return used;
}
