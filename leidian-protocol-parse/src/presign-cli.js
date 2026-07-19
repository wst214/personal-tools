#!/usr/bin/env node
import { presignGetObject } from "./minio-presign.js";

function printHelp() {
  console.log(`用法:
  node src/presign-cli.js --dedup-key "leidian-device:uploads/device01/.../a.json"
  node src/presign-cli.js --bucket leidian-device --object-key uploads/.../a.json

环境变量（可选，与 data-service 一致）:
  LEIDIAN_MINIO_ENDPOINT / MINIO_ENDPOINT          默认 http://localhost:19000
  LEIDIAN_MINIO_ACCESS_KEY / MINIO_ACCESS_KEY      默认 minioadmin
  LEIDIAN_MINIO_SECRET_KEY / MINIO_SECRET_KEY      默认 minioadmin
  LEIDIAN_MINIO_PRESIGN_EXPIRY_SECONDS             默认 3600

选项:
  --endpoint <url>       覆盖 endpoint
  --access-key <key>
  --secret-key <key>
  --expiry <seconds>     有效期（秒），最少 60
  --dedup-key <key>      bucket:objectKey
  --bucket <name>
  --object-key <key>
  -h, --help
`);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    const map = {
      "--endpoint": "endpoint",
      "--access-key": "accessKey",
      "--secret-key": "secretKey",
      "--expiry": "expirySeconds",
      "--dedup-key": "dedupKey",
      "--bucket": "bucket",
      "--object-key": "objectKey",
    };
    const key = map[arg];
    if (key) {
      options[key] = argv[++i];
      continue;
    }
    if (!arg.startsWith("-") && !options.dedupKey && !options.bucket) {
      options.dedupKey = arg;
    }
  }
  if (options.expirySeconds) {
    options.expirySeconds = Number(options.expirySeconds);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const result = await presignGetObject(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
