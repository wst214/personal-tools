import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DEVICE_BUILTIN_SAMPLES, normalizeHex } from "./device-samples.js";
import { verifyKafkaRecords } from "./kafka-verify.js";

function isDocker() {
  return existsSync("/.dockerenv");
}

function defaultKafkaBootstrap() {
  if (process.env.LEIDIAN_KAFKA_BOOTSTRAP_SERVERS?.trim()) {
    return process.env.LEIDIAN_KAFKA_BOOTSTRAP_SERVERS.trim();
  }
  if (process.env.KAFKA_BOOTSTRAP_SERVERS?.trim()) {
    return process.env.KAFKA_BOOTSTRAP_SERVERS.trim();
  }
  if (isDocker()) {
    return "kafka:29092";
  }
  return "localhost:9092";
}

function resolveKafkaBootstrap(requestBootstrap) {
  const fallback = defaultKafkaBootstrap();
  const trimmed = requestBootstrap?.trim();
  if (!trimmed) return fallback;

  if (!isDocker()) return trimmed;

  return trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((broker) => {
      if (/localhost:9092/i.test(broker) || /127\.0\.0\.1:9092/.test(broker)) {
        return "kafka:29092";
      }
      if (/leidian-kafka:9092/i.test(broker)) {
        return "kafka:29092";
      }
      return broker;
    })
    .join(",");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveKafkaOptions(options = {}) {
  return {
    bootstrapServers: resolveKafkaBootstrap(options.bootstrapServers),
    topic:
      options.topic?.trim() ||
      process.env.LEIDIAN_KAFKA_DEVICE_TOPIC ||
      process.env.KAFKA_DEVICE_RAW_TOPIC ||
      "device-raw-data",
    limit: Math.max(0, Number(options.limit ?? 0)),
    sleepMs: Math.max(0, Number(options.sleepMs ?? 0)),
    source: options.source || "builtin",
    hexText: options.hexText || "",
    filePath: options.filePath?.trim() || "",
    sampleIds: Array.isArray(options.sampleIds) ? options.sampleIds : null,
    verifyKafka: Boolean(options.verifyKafka),
    verifyTimeoutMs: Math.max(1000, Number(options.verifyTimeoutMs ?? 15000)),
  };
}

async function loadHexLines(options) {
  const resolved = resolveKafkaOptions(options);

  if (resolved.source === "file") {
    const filePath = path.resolve(resolved.filePath);
    if (!existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    const lines = [];
    const rl = readline.createInterface({
      input: createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const obj = JSON.parse(trimmed);
      const hex = normalizeHex(obj.hex);
      if (!hex) throw new Error(`行缺少 hex 字段: ${trimmed.slice(0, 80)}`);
      lines.push({ hex, meta: obj });
    }
    return applyLimit(lines, resolved.limit);
  }

  if (resolved.source === "hex") {
    const chunks = resolved.hexText
      .split(/\r?\n/)
      .map((line) => normalizeHex(line))
      .filter(Boolean);
    if (!chunks.length) {
      throw new Error("自定义 HEX 为空");
    }
    return applyLimit(
      chunks.map((hex) => ({ hex })),
      resolved.limit,
    );
  }

  let samples = DEVICE_BUILTIN_SAMPLES;
  if (resolved.sampleIds?.length) {
    const idSet = new Set(resolved.sampleIds);
    samples = samples.filter((item) => idSet.has(item.id));
    if (!samples.length) {
      throw new Error("未匹配到内置样例 ID");
    }
  }

  return applyLimit(
    samples.map((item) => ({ hex: normalizeHex(item.hex), meta: item })),
    resolved.limit,
  );
}

function applyLimit(lines, limit) {
  if (limit > 0 && lines.length > limit) {
    return lines.slice(0, limit);
  }
  return lines;
}

export function getDeviceUploadDefaults() {
  const resolved = resolveKafkaOptions({});
  return {
    bootstrapServers: resolved.bootstrapServers,
    topic: resolved.topic,
    limit: resolved.limit,
    sleepMs: resolved.sleepMs,
    verifyKafka: true,
    verifyTimeoutMs: 15000,
    samples: DEVICE_BUILTIN_SAMPLES.map(({ id, name }) => ({ id, name })),
    hint: isDocker()
      ? "Docker 模式：容器内默认 kafka:29092（INTERNAL listener）。发送后可回读 topic 验证。"
      : "将 HEX 报文作为 ASCII 字节发送到 Kafka topic device-raw-data，与设备接入一致。",
  };
}

export async function sendDeviceToKafka(options = {}) {
  const resolved = resolveKafkaOptions(options);
  let lines;
  try {
    lines = await loadHexLines(options);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }

  if (!lines.length) {
    return { ok: false, error: "没有可发送的报文" };
  }

  let Kafka;
  try {
    const mod = await import("kafkajs");
    Kafka = mod.Kafka;
  } catch (error) {
    return {
      ok: false,
      error: "缺少 kafkajs 依赖，请在项目目录执行: npm install",
      detail: error?.message,
    };
  }

  const kafka = new Kafka({
    clientId: "leidian-upload-test",
    brokers: resolved.bootstrapServers.split(",").map((s) => s.trim()).filter(Boolean),
  });
  const producer = kafka.producer();
  const results = [];

  try {
    await producer.connect();
    for (let i = 0; i < lines.length; i += 1) {
      const item = lines[i];
      const t0 = Date.now();
      const metadata = await producer.send({
        topic: resolved.topic,
        messages: [{ value: item.hex }],
        acks: -1,
      });
      const t1 = Date.now();
      const record = metadata?.[0];
      results.push({
        index: i + 1,
        hexPreview: item.hex.length > 48 ? `${item.hex.slice(0, 24)}...${item.hex.slice(-12)}` : item.hex,
        hex: item.hex,
        deviceId: item.meta?.id,
        deviceName: item.meta?.name,
        partition: record?.partition ?? null,
        offset: record?.baseOffset ?? record?.offset ?? null,
        t0,
        t1,
        durationMs: t1 - t0,
      });
      if (resolved.sleepMs > 0 && i < lines.length - 1) {
        await sleep(resolved.sleepMs);
      }
    }
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      sent: results.length,
      results,
    };
  } finally {
    await producer.disconnect().catch(() => {});
  }

  let verify = null;
  if (resolved.verifyKafka) {
    verify = await verifyKafkaRecords({
      kafka,
      topic: resolved.topic,
      records: results,
      timeoutMs: resolved.verifyTimeoutMs,
    });
  }

  const verifyOk = !resolved.verifyKafka || verify?.ok;
  return {
    ok: verifyOk,
    bootstrapServers: resolved.bootstrapServers,
    topic: resolved.topic,
    sent: results.length,
    results,
    verify,
  };
}
