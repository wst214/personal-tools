/**
 * 基于 producer ack 的 Kafka 写入验证（partition/offset）。
 */
export async function verifyKafkaRecords({ kafka, topic, records }) {
  const pending = records.filter((item) => item.hex);
  if (!pending.length) {
    return {
      ok: false,
      found: [],
      missing: [],
      timedOut: false,
      waitedMs: 0,
      error: "没有可验证的消息",
    };
  }

  const startedAt = Date.now();
  const found = [];
  const missing = [];

  let offsetsByPartition = null;
  try {
    const admin = kafka.admin();
    await admin.connect();
    const offsets = await admin.fetchTopicOffsets(topic);
    offsetsByPartition = new Map(offsets.map((item) => [item.partition, Number(item.high)]));
    await admin.disconnect();
  } catch (error) {
    return {
      ok: false,
      found: [],
      missing: pending.map((item) => item.hex),
      timedOut: false,
      waitedMs: Date.now() - startedAt,
      error: `读取 topic offset 失败: ${error?.message || String(error)}`,
    };
  }

  for (const item of pending) {
    const partition = item.partition;
    const offset = item.offset != null ? Number(item.offset) : null;
    if (partition == null || offset == null || Number.isNaN(offset)) {
      missing.push(item.hex);
      continue;
    }

    const high = offsetsByPartition.get(String(partition)) ?? offsetsByPartition.get(partition);
    const ok = high != null && high > offset;
    if (ok) {
      found.push({
        ok: true,
        hex: item.hex,
        partition,
        offset: String(offset),
        highWatermark: String(high),
        verifiedBy: "producer-ack+offset",
        verifiedAt: Date.now(),
      });
    } else {
      missing.push(item.hex);
    }
  }

  return {
    ok: missing.length === 0,
    found,
    missing,
    timedOut: false,
    waitedMs: Date.now() - startedAt,
    error: missing.length ? "部分消息未通过 Kafka offset 验证" : null,
  };
}
