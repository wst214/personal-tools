import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

function isDocker() {
  return existsSync("/.dockerenv");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function defaultRadarKafkaBootstrap() {
  if (process.env.LEIDIAN_KAFKA_BOOTSTRAP_SERVERS?.trim()) {
    return process.env.LEIDIAN_KAFKA_BOOTSTRAP_SERVERS.trim();
  }
  if (isDocker()) return "kafka:29092";
  return "localhost:9092";
}

/** MinIO 雷达帧上传事件 topic（data-service 消费入口）。 */
export function defaultRadarKafkaTopic() {
  return (
    process.env.LEIDIAN_KAFKA_RADAR_TOPIC?.trim() ||
    process.env.KAFKA_RADAR_FRAME_UPSTREAM_TOPIC?.trim() ||
    "radar-frame-upstream"
  );
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function decodeKey(key) {
  if (!key) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

/**
 * 解析 radar-frame-upstream 上的 MinIO 通知（与 MinioUploadedNotificationParser 对齐）。
 */
export function extractRadarUpstreamFields(msg) {
  if (!msg || typeof msg !== "object") {
    return { bucket: null, objectKey: null, frameId: null, traceId: null };
  }

  // S3/MinIO Records[] 格式
  const records = msg.Records;
  if (Array.isArray(records) && records.length) {
    const s3 = records[0]?.s3 ?? {};
    const bucket = s3.bucket?.name ?? null;
    const objectKey = decodeKey(s3.object?.key ?? null);
    return {
      bucket,
      objectKey,
      frameId: objectKey ? frameIdFromObjectKey(objectKey) : null,
      traceId: null,
    };
  }

  // 扁平字段
  let bucket = msg.bucket ?? msg.Bucket ?? msg.bucketName ?? null;
  let objectKey = msg.key ?? msg.objectKey ?? msg.object ?? msg.path ?? null;

  // Key = "bucket/objectKey"
  if (!bucket && typeof msg.Key === "string" && msg.Key.includes("/")) {
    const decoded = decodeKey(msg.Key);
    const slash = decoded.indexOf("/");
    if (slash > 0) {
      bucket = decoded.slice(0, slash);
      objectKey = decoded.slice(slash + 1);
    }
  }

  // data 包裹
  if ((!bucket || !objectKey) && msg.data && typeof msg.data === "object") {
    bucket = bucket ?? msg.data.bucket ?? msg.data.Bucket ?? msg.data.name ?? null;
    objectKey = objectKey ?? msg.data.key ?? msg.data.Key ?? msg.data.objectKey ?? msg.data.path ?? null;
  }

  objectKey = decodeKey(objectKey);
  return {
    bucket: bucket ?? null,
    objectKey: objectKey ?? null,
    frameId: objectKey ? frameIdFromObjectKey(objectKey) : null,
    traceId: msg.traceId ?? msg.TraceId ?? null,
  };
}

function frameIdFromObjectKey(objectKey) {
  const base = objectKey.split("/").pop() || "";
  const m = /radar[_\-]?(\d{12,14})/i.exec(base);
  if (!m) return null;
  let ts = m[1];
  if (ts.length === 12) ts += "00";
  return `radar-${ts}`;
}

/**
 * 监听 radar-frame-upstream：等 GROUP_JOIN 后再上传，按 objectKey 匹配。
 */
export async function startRadarKafkaListener({
  bootstrapServers,
  topic,
  timeoutMs = 30000,
}) {
  let Kafka;
  try {
    const mod = await import("kafkajs");
    Kafka = mod.Kafka;
  } catch (error) {
    return {
      ready: false,
      error: `缺少 kafkajs: ${error?.message || error}`,
      track() {},
      async finish() {
        return {
          ok: false,
          topic,
          matched: [],
          missing: { objectKeys: [] },
          timedOut: false,
          waitedMs: 0,
          error: error?.message || String(error),
        };
      },
    };
  }

  const brokers = (bootstrapServers || defaultRadarKafkaBootstrap())
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const kafkaTopic = topic || defaultRadarKafkaTopic();
  const kafka = new Kafka({ clientId: "leidian-radar-upstream-verify", brokers });
  const consumer = kafka.consumer({
    groupId: `leidian-radar-upstream-verify-${randomUUID()}`,
    sessionTimeout: 15000,
  });

  const startedAt = Date.now();
  const expectedObjectKeys = new Set();
  const matchedObjectKeys = new Set();
  const matched = [];

  let finished = false;
  let timer;
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  function isComplete() {
    return expectedObjectKeys.size > 0 && matchedObjectKeys.size >= expectedObjectKeys.size;
  }

  async function stopConsumer() {
    // kafkajs consumer.stop() 在部分环境下会挂起；必须限时并允许 finish 先返回
    const cleanup = (async () => {
      try {
        await consumer.stop();
      } catch {
        /* ignore */
      }
      await consumer.disconnect().catch(() => {});
    })();
    await Promise.race([cleanup, sleep(2000)]);
  }

  function finish(extra = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolveDone({
      ok: extra.error ? false : isComplete(),
      topic: kafkaTopic,
      bootstrapServers: brokers.join(","),
      matched,
      missing: {
        objectKeys: [...expectedObjectKeys].filter((key) => !matchedObjectKeys.has(key)),
      },
      timedOut: Boolean(extra.timedOut),
      waitedMs: Date.now() - startedAt,
      error: extra.error ?? null,
    });
    // 先返回校验结果，再异步清理，避免 stop() 拖死整次上传
    void stopConsumer();
  }

  try {
    await consumer.connect();
    await consumer.subscribe({ topic: kafkaTopic, fromBeginning: false });

    const joined = new Promise((resolve) => {
      consumer.on(consumer.events.GROUP_JOIN, () => resolve());
    });

    const runPromise = consumer.run({
      eachMessage: async ({ message, partition }) => {
        if (finished) return;
        const msg = parseJson(message.value);
        if (!msg) return;
        const fields = extractRadarUpstreamFields(msg);
        if (!fields.objectKey || !expectedObjectKeys.has(fields.objectKey)) return;

        matched.push({
          ...fields,
          partition,
          offset: message.offset,
          receivedAt: Date.now(),
        });
        matchedObjectKeys.add(fields.objectKey);
        if (isComplete()) {
          finish({ timedOut: false });
        }
      },
    });
    runPromise.catch(() => {});

    const joinedOk = await Promise.race([
      joined.then(() => true),
      sleep(10000).then(() => false),
    ]);
    if (!joinedOk) {
      void stopConsumer();
      return {
        ready: false,
        error: "Kafka consumer GROUP_JOIN 超时，无法保证收到消息",
        track() {},
        async finish() {
          return {
            ok: false,
            topic: kafkaTopic,
            matched: [],
            missing: { objectKeys: [] },
            timedOut: false,
            waitedMs: Date.now() - startedAt,
            error: "Kafka consumer GROUP_JOIN 超时",
          };
        },
      };
    }

    await sleep(500);

    return {
      ready: true,
      track({ objectKey }) {
        if (objectKey) expectedObjectKeys.add(objectKey);
        if (isComplete()) {
          finish({ timedOut: false });
        }
      },
      async finish(extraTimeoutMs = timeoutMs) {
        if (finished) return donePromise;
        if (!expectedObjectKeys.size) {
          finish({ error: "没有可匹配的 objectKey" });
          return donePromise;
        }
        timer = setTimeout(() => {
          finish({ timedOut: true });
        }, extraTimeoutMs);
        return donePromise;
      },
    };
  } catch (error) {
    void stopConsumer();
    return {
      ready: false,
      error: error?.message || String(error),
      track() {},
      async finish() {
        return {
          ok: false,
          topic: kafkaTopic,
          matched: [],
          missing: { objectKeys: [] },
          timedOut: false,
          waitedMs: Date.now() - startedAt,
          error: error?.message || String(error),
        };
      },
    };
  }
}
