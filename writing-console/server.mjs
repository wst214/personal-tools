import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.WRITING_CONSOLE_PORT || 8310);
const PUBLIC_DIR = join(__dirname, "public");
const DEFAULT_ROOT = resolve(__dirname, "..", "writing");
const ROOT = resolve(process.env.WRITING_ROOT || DEFAULT_ROOT);

const jobs = new Map();
let dashboardProc = null;

const ACTIONS = {
  "long-new": {
    title: "开长篇",
    skill: "story-long-write",
    needBook: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-long-write。\n写作根目录：${ROOT}\n动作：开一本新长篇。\n书名：${book}\n${note ? `补充要求：${note}\n` : ""}按项目已部署的 oh-story 流程创建大纲/设定/追踪并开始第 1 章准备。不要只给建议，直接落盘。`,
  },
  "short-new": {
    title: "开短篇",
    skill: "story-short-write",
    needBook: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-short-write。\n写作根目录：${ROOT}\n动作：开一篇新短篇。\n书名：${book}\n${note ? `补充要求：${note}\n` : ""}按 oh-story 短篇流程落盘小节大纲与正文骨架，直接写文件。`,
  },
  "long-next": {
    title: "写下一章",
    skill: "story-long-write",
    needActive: true,
    prompt: ({ book, chapter, note }) =>
      `请执行 skill story-long-write。\n写作根目录：${ROOT}\n当前书：${book}\n动作：${chapter ? `写第 ${chapter} 章` : "日更 / 写下一章"}\n${note ? `补充要求：${note}\n` : ""}先读活跃书追踪与细纲，再落盘正文，并更新追踪。`,
  },
  "short-write": {
    title: "写/续写短篇",
    skill: "story-short-write",
    needActive: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-short-write。\n写作根目录：${ROOT}\n当前书：${book}\n动作：继续写短篇正文并精修。\n${note ? `补充要求：${note}\n` : ""}直接改项目文件。`,
  },
  deslop: {
    title: "去 AI 味",
    skill: "story-deslop",
    needActive: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-deslop。\n写作根目录：${ROOT}\n当前书：${book}\n${note ? `补充要求：${note}\n` : ""}检测并清除 AI 写作痕迹，改写后写回文件。`,
  },
  review: {
    title: "审查",
    skill: "story-review",
    needActive: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-review。\n写作根目录：${ROOT}\n当前书：${book}\n${note ? `补充要求：${note}\n` : ""}做多视角审查并输出可执行修改建议；能直接修的硬伤一并修。`,
  },
  "long-scan": {
    title: "长篇扫榜",
    skill: "story-long-scan",
    prompt: ({ note }) =>
      `请执行 skill story-long-scan。\n写作根目录：${ROOT}\n${note ? `关注点：${note}\n` : ""}扫榜结果写入拆文库相关目录。`,
  },
  "short-scan": {
    title: "短篇扫榜",
    skill: "story-short-scan",
    prompt: ({ note }) =>
      `请执行 skill story-short-scan。\n写作根目录：${ROOT}\n${note ? `关注点：${note}\n` : ""}结果写入拆文库。`,
  },
  "long-analyze": {
    title: "长篇拆文",
    skill: "story-long-analyze",
    prompt: ({ note }) =>
      `请执行 skill story-long-analyze。\n写作根目录：${ROOT}\n${note ? `目标作品/链接/说明：${note}\n` : "请先问我要拆哪本书，再落盘拆文结果。"}`,
  },
  "short-analyze": {
    title: "短篇拆文",
    skill: "story-short-analyze",
    prompt: ({ note }) =>
      `请执行 skill story-short-analyze。\n写作根目录：${ROOT}\n${note ? `目标作品/说明：${note}\n` : "请先问我要拆哪篇，再落盘。"}`,
  },
  cover: {
    title: "生成封面",
    skill: "story-cover",
    needActive: true,
    prompt: ({ book, note }) =>
      `请执行 skill story-cover。\n写作根目录：${ROOT}\n当前书：${book}\n${note ? `风格要求：${note}\n` : ""}生成封面并保存到项目。`,
  },
  import: {
    title: "导入已有小说",
    skill: "story-import",
    prompt: ({ note }) =>
      `请执行 skill story-import。\n写作根目录：${ROOT}\n${note ? `导入说明/路径：${note}\n` : "请询问原文位置后导入为标准项目结构。"}`,
  },
};

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function safeBookName(name) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ");
  if (!cleaned) throw new Error("书名不能为空");
  if (cleaned === "." || cleaned === "..") throw new Error("非法书名");
  return cleaned;
}

function consoleDir() {
  const p = join(ROOT, ".console");
  ensureDir(p);
  return p;
}

function readActiveBook() {
  const p = join(ROOT, ".active-book");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8").trim();
}

function writeActiveBook(rel) {
  writeFileSync(join(ROOT, ".active-book"), `${rel}\n`, "utf8");
}

function listBooks() {
  if (!existsSync(ROOT)) return [];
  const books = [];
  for (const name of readdirSync(ROOT)) {
    if (name.startsWith(".")) continue;
    const full = join(ROOT, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (name === "skills" || name === "拆文库" || name === "node_modules") continue;
    const longish =
      existsSync(join(full, "正文")) ||
      existsSync(join(full, "大纲")) ||
      existsSync(join(full, "设定")) ||
      existsSync(join(full, "追踪"));
    const shortish =
      existsSync(join(full, "正文.md")) &&
      (existsSync(join(full, "小节大纲.md")) || existsSync(join(full, "设定.md")));
    if (!longish && !shortish) continue;
    books.push({
      name,
      path: name,
      kind: shortish && !existsSync(join(full, "正文")) ? "short" : "long",
      active: readActiveBook() === name,
    });
  }
  return books.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

function deployStatus() {
  const p = join(ROOT, ".story-deployed");
  if (!existsSync(p)) return { deployed: false };
  const text = readFileSync(p, "utf8");
  const pick = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    deployed: true,
    agents_version: pick("agents_version"),
    setup_skill_version: pick("setup_skill_version"),
    target_cli: pick("target_cli"),
    deployed_at: pick("deployed_at"),
  };
}

function whichClaude() {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function scaffoldBook({ book, kind }) {
  const name = safeBookName(book);
  const dir = join(ROOT, name);
  if (existsSync(dir)) throw new Error(`目录已存在：${name}`);
  if (kind === "short") {
    ensureDir(dir);
    writeFileSync(join(dir, "正文.md"), `# ${name}\n\n`, "utf8");
    writeFileSync(join(dir, "小节大纲.md"), `# ${name} · 小节大纲\n\n`, "utf8");
    writeFileSync(join(dir, "设定.md"), `# ${name} · 设定\n\n`, "utf8");
  } else {
    for (const sub of ["正文", "大纲", "设定", "追踪", "对标"]) ensureDir(join(dir, sub));
    writeFileSync(join(dir, "追踪", "质检进度.md"), `# ${name} · 质检进度\n\n`, "utf8");
  }
  writeActiveBook(name);
  ensureDir(join(ROOT, "拆文库"));
  return { book: name, kind, path: dir };
}

function writeTask(task) {
  const dir = consoleDir();
  const id = task.id || randomUUID().slice(0, 8);
  const stamp = new Date().toISOString();
  const payload = { ...task, id, created_at: stamp };
  writeFileSync(join(dir, "current-task.json"), JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(
    join(dir, "current-task.md"),
    `# 当前写作任务\n\n- 时间：${stamp}\n- 动作：${payload.title}\n- Skill：${payload.skill}\n- 书名：${payload.book || "（无）"}\n\n## 请直接执行\n\n\`\`\`text\n${payload.prompt}\n\`\`\`\n`,
    "utf8",
  );
  const histDir = join(dir, "history");
  ensureDir(histDir);
  writeFileSync(join(histDir, `${stamp.replace(/[:.]/g, "-")}-${id}.json`), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function startClaudeJob(task) {
  const id = randomUUID().slice(0, 8);
  const log = [];
  const job = {
    id,
    status: "running",
    title: task.title,
    started_at: new Date().toISOString(),
    log,
    exit_code: null,
  };
  jobs.set(id, job);

  const args = [
    "-p",
    task.prompt,
    "--output-format",
    "text",
    "--permission-mode",
    "acceptEdits",
    "--add-dir",
    ROOT,
  ];
  const child = spawn(whichClaude(), args, {
    cwd: ROOT,
    shell: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  job.pid = child.pid;
  const push = (chunk, stream) => {
    const text = chunk.toString("utf8");
    log.push({ t: Date.now(), stream, text });
    if (log.length > 400) log.splice(0, log.length - 400);
  };
  child.stdout.on("data", (d) => push(d, "stdout"));
  child.stderr.on("data", (d) => push(d, "stderr"));
  child.on("error", (err) => {
    job.status = "error";
    job.error = String(err.message || err);
    push(Buffer.from(job.error), "stderr");
  });
  child.on("close", (code) => {
    job.exit_code = code;
    job.status = code === 0 ? "done" : "error";
    job.finished_at = new Date().toISOString();
  });
  return job;
}

function startDashboard() {
  const script = join(ROOT, "skills", "story", "scripts", "dashboard-server.mjs");
  if (!existsSync(script)) throw new Error("未找到 dashboard-server.mjs，请确认 writing/skills 已部署");
  if (dashboardProc && !dashboardProc.killed) {
    return { already: true, url: "http://127.0.0.1:43110/" };
  }
  dashboardProc = spawn(process.execPath, [script, "--root", ROOT, "--open"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
  });
  dashboardProc.unref();
  return { already: false, url: "http://127.0.0.1:43110/" };
}

function contentType(file) {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = join(PUBLIC_DIR, rel.replace(/^\/+/, ""));
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType(file) });
  createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/status") {
    return sendJson(res, 200, {
      root: ROOT,
      activeBook: readActiveBook(),
      books: listBooks(),
      deploy: deployStatus(),
      claudeAvailable: true,
      jobs: [...jobs.values()].map((j) => ({
        id: j.id,
        status: j.status,
        title: j.title,
        started_at: j.started_at,
        finished_at: j.finished_at,
        exit_code: j.exit_code,
        error: j.error,
      })),
    });
  }

  if (req.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const id = pathname.slice("/api/jobs/".length);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: "job not found" });
    return sendJson(res, 200, job);
  }

  if (req.method === "POST" && pathname === "/api/active-book") {
    const body = await readBody(req);
    const book = safeBookName(body.book);
    if (!existsSync(join(ROOT, book))) return sendJson(res, 400, { error: "书目不存在" });
    writeActiveBook(book);
    return sendJson(res, 200, { ok: true, activeBook: book });
  }

  if (req.method === "POST" && pathname === "/api/scaffold") {
    try {
      const body = await readBody(req);
      const result = scaffoldBook({ book: body.book, kind: body.kind === "short" ? "short" : "long" });
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      return sendJson(res, 400, { error: String(err.message || err) });
    }
  }

  if (req.method === "POST" && pathname === "/api/dashboard") {
    try {
      return sendJson(res, 200, { ok: true, ...startDashboard() });
    } catch (err) {
      return sendJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (req.method === "POST" && pathname === "/api/run") {
    try {
      const body = await readBody(req);
      const action = ACTIONS[body.action];
      if (!action) return sendJson(res, 400, { error: "未知动作" });

      let book = (body.book || "").trim() || readActiveBook();
      if (action.needBook && !body.book) return sendJson(res, 400, { error: "请填写书名" });
      if (action.needActive && !book) return sendJson(res, 400, { error: "请先选择或创建一本书" });
      if (body.book) book = safeBookName(body.book);

      const mode = body.mode === "claude" ? "claude" : "queue";
      const prompt = action.prompt({
        book,
        chapter: body.chapter,
        note: body.note,
      });
      const task = writeTask({
        title: action.title,
        skill: action.skill,
        action: body.action,
        book,
        chapter: body.chapter || "",
        note: body.note || "",
        mode,
        prompt,
      });

      if (mode === "queue") {
        return sendJson(res, 200, {
          ok: true,
          mode,
          task,
          hint: "任务已写入 writing/.console/current-task.md。回到 Cursor Agent，直接说：执行当前写作任务",
        });
      }

      const job = startClaudeJob(task);
      return sendJson(res, 200, { ok: true, mode, task, job: { id: job.id, status: job.status } });
    } catch (err) {
      return sendJson(res, 400, { error: String(err.message || err) });
    }
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    sendJson(res, 500, { error: String(err.message || err) });
  }
});

ensureDir(ROOT);
ensureDir(join(ROOT, "拆文库"));
ensureDir(consoleDir());

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`写作操作台：${url}`);
  console.log(`写作根目录：${ROOT}`);
  if (process.argv.includes("--open")) {
    const opener =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            stdio: "ignore",
            detached: true,
          });
    opener.unref();
  }
});
