#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { parseProtocolText } from "./parser.js";

async function main() {
  const args = process.argv.slice(2);
  let input = "";

  if (args[0] === "-f" || args[0] === "--file") {
    if (!args[1]) {
      throw new Error("请在 -f 后面提供文件路径");
    }
    input = fs.readFileSync(args[1], "utf8");
  } else if (args.length > 0) {
    input = args.join(" ");
  } else if (!process.stdin.isTTY) {
    input = fs.readFileSync(0, "utf8");
  } else {
    input = await readInteractiveInput();
  }

  const result = parseProtocolText(input);
  console.log(JSON.stringify(result, null, 2));
}

function readInteractiveInput() {
  console.log("粘贴设备协议 HEX 内容，输入空行开始解析：");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (line.trim() === "") {
        rl.close();
        resolve(lines.join("\n"));
      } else {
        lines.push(line);
      }
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
