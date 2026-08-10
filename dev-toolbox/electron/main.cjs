const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const isDev = process.env.NODE_ENV === 'development';

function hostsPath() {
  return process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
}

// ---- HTTP 请求 ----
ipcMain.handle('http:request', async (e, opts) => {
  const { url, method = 'GET', headers = {}, body, timeout = 30000 } = opts || {};
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, {
      method,
      headers,
      body: body || undefined,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(t);
    const text = await res.text();
    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { ok: true, status: res.status, statusText: res.statusText, headers: respHeaders, body: text, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - start };
  }
});

// ---- 系统信息 ----
ipcMain.handle('sys:info', () => {
  const cpus = os.cpus() || [];
  const nets = os.networkInterfaces();
  return {
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model || '-',
    cpuCores: cpus.length,
    cpuSpeed: cpus[0]?.speed,
    totalmem: os.totalmem(),
    freemem: os.freemem(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    homedir: os.homedir(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    network: Object.keys(nets).map((name) => ({ name, addrs: (nets[name] || []).filter((a) => !a.internal).map((a) => ({ family: a.family, address: a.address })) })),
  };
});

// ---- 端口扫描 ----
ipcMain.handle('port:scan', async (e, { host, ports, timeout = 800 }) => {
  const open = [];
  await Promise.all((ports || []).map((p) => new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    let done = false;
    const fin = (state) => { if (done) return; done = true; if (state) open.push(p); s.destroy(); resolve(); };
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(p, host); } catch { fin(false); }
  })));
  return { open: open.sort((a, b) => a - b), total: ports.length };
});

// ---- IP 归属地 ----
ipcMain.handle('ip:query', async (e, ip) => {
  try {
    const url = ip ? `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=66846719` : 'http://ip-api.com/json/?lang=zh-CN&fields=66846719';
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return { ok: true, data };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---- 翻译（Google 非官方接口，免 key）----
ipcMain.handle('translate', async (e, { text, from = 'auto', to }) => {
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    const translated = (data[0] || []).map((seg) => seg[0]).join('');
    return { ok: true, text: translated };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---- Hosts 读写 ----
ipcMain.handle('hosts:read', async () => {
  try {
    const content = await fs.promises.readFile(hostsPath(), 'utf-8');
    return { ok: true, path: hostsPath(), content };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('hosts:write', async (e, content) => {
  try {
    await fs.promises.writeFile(hostsPath(), String(content), 'utf-8');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message + '（写 hosts 通常需要以管理员身份运行）' }; }
});

// ---- 随手记（文件夹 + 独立文件）----
const NOTE_EXTS = ['.md', '.markdown', '.txt'];
const notesConfigFile = () => path.join(app.getPath('userData'), 'notes-config.json');
const legacyNotesFile = () => path.join(app.getPath('userData'), 'notes.json');
const defaultNotesDir = () => path.join(app.getPath('documents'), 'DevTool 随手记');

function readNotesConfig() {
  try { return JSON.parse(fs.readFileSync(notesConfigFile(), 'utf-8')) || {}; }
  catch { return {}; }
}
function writeNotesConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(notesConfigFile()), { recursive: true });
    fs.writeFileSync(notesConfigFile(), JSON.stringify(cfg, null, 2), 'utf-8');
  } catch {}
}

function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled Note';
}

// 跳过版本控制与依赖目录：这些可能含海量文件但不会有笔记，避免无谓遍历
const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.cache']);
function isSkippedDir(name) {
  return !name || SKIP_DIRS.has(name);
}

// 从旧的 notes.json 迁移为独立文件（仅执行一次）
function migrateLegacyNotes(dir) {
  try {
    if (!fs.existsSync(legacyNotesFile())) return;
    const arr = JSON.parse(fs.readFileSync(legacyNotesFile(), 'utf-8'));
    if (!Array.isArray(arr) || !arr.length) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const n of arr) {
      let base = sanitizeName(n.title || 'Untitled Note');
      let file = path.join(dir, base + '.md');
      let i = 1;
      while (fs.existsSync(file)) { file = path.join(dir, `${base} (${i++}).md`); }
      fs.writeFileSync(file, String(n.body ?? ''), 'utf-8');
    }
    fs.renameSync(legacyNotesFile(), legacyNotesFile() + '.migrated');
  } catch {}
}

function resolveNotesDir() {
  const cfg = readNotesConfig();
  const saved = cfg.defaultDir || cfg.dir; // 兼容旧 cfg.dir
  let dir = saved && fs.existsSync(saved) ? saved : defaultNotesDir();
  if (!saved) {
    fs.mkdirSync(dir, { recursive: true });
    migrateLegacyNotes(dir);
    writeNotesConfig({ defaultDir: dir });
  }
  return dir;
}
function getDefaultDir() {
  const cfg = readNotesConfig();
  return cfg.defaultDir || cfg.dir || resolveNotesDir();
}

function buildTree(dir, relBase = '') {
  const children = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return children; }
  // 文件夹在前，文件在后；各自按名排序
  const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  for (const ent of dirs) {
    if (isSkippedDir(ent.name)) continue; // 跳过 .git/.obsidian/.trash/node_modules 等
    const full = path.join(dir, ent.name);
    const rel = relBase ? path.join(relBase, ent.name) : ent.name;
    const sub = buildTree(full, rel);
    children.push({ type: 'dir', name: ent.name, path: full, rel, expanded: false, children: sub });
  }
  for (const ent of files) {
    const ext = path.extname(ent.name).toLowerCase();
    if (!NOTE_EXTS.includes(ext)) continue;
    const full = path.join(dir, ent.name);
    const rel = relBase ? path.join(relBase, ent.name) : ent.name;
    // 仅取元数据，正文懒加载（避免启动时读取全部文件内容）
    let st;
    try { st = fs.statSync(full, { throwIfNoEntry: false }); } catch { continue; }
    if (!st) continue;
    children.push({
      type: 'file',
      id: full,
      path: full,
      rel,
      name: ent.name,
      file: ent.name,
      title: path.basename(ent.name, ext),
      body: null, // 懒加载：选中时才读取
      ts: st.birthtimeMs || st.mtimeMs,
      updatedAt: st.mtimeMs,
    });
  }
  return children;
}

// 服务端正文搜索：递归 grep，命中即停，结果封顶（避免读取整个仓库）
async function searchTree(dir, query, inBody, cap = 300) {
  const q = String(query || '').toLowerCase();
  const hits = [];
  if (!q) return hits;
  async function walk(d) {
    if (hits.length >= cap) return;
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (hits.length >= cap) return;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { if (!isSkippedDir(ent.name)) await walk(full); continue; }
      const ext = path.extname(ent.name).toLowerCase();
      if (!NOTE_EXTS.includes(ext)) continue;
      const baseName = path.basename(ent.name, ext);
      let matched = baseName.toLowerCase().includes(q);
      if (!matched && inBody) {
        try {
          const body = await fs.promises.readFile(full, 'utf-8');
          matched = body.toLowerCase().includes(q);
        } catch { matched = false; }
      }
      if (matched) {
        let st; try { st = fs.statSync(full, { throwIfNoEntry: false }); } catch {}
        hits.push({
          type: 'file', id: full, path: full, file: ent.name,
          title: baseName, body: null,
          ts: st?.birthtimeMs || st?.mtimeMs || 0,
          updatedAt: st?.mtimeMs || 0,
        });
        if (hits.length >= cap) return;
      }
    }
  }
  await walk(dir);
  return hits;
}

// 扁平化树为笔记数组（供搜索/兼容）
function flattenTree(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'file') out.push(n);
    else flattenTree(n.children, out);
  }
  return out;
}

// 列出当前目录树
ipcMain.handle('notes:list', async () => {
  try {
    const dir = resolveNotesDir();
    return { ok: true, dir, tree: buildTree(dir), defaultDir: getDefaultDir() };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 选择文件夹并加载（仅浏览，不改变默认）
ipcMain.handle('notes:pickDir', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  const dir = res.filePaths[0];
  return { ok: true, dir, tree: buildTree(dir), defaultDir: getDefaultDir() };
});

// 设为启动默认文件夹
ipcMain.handle('notes:setDefault', async (e, dir) => {
  try {
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: '路径不存在' };
    writeNotesConfig({ defaultDir: dir });
    return { ok: true, defaultDir: dir };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 懒加载：读取单个笔记正文
ipcMain.handle('notes:readFile', async (e, filePath) => {
  try {
    if (!filePath) return { ok: false, error: 'no path' };
    const body = await fs.promises.readFile(filePath, 'utf-8');
    return { ok: true, body };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 服务端搜索：标题(本地)或正文(服务端 grep)，封顶 cap 条
ipcMain.handle('notes:search', async (e, { dir, query, inBody }) => {
  try {
    const base = dir && fs.existsSync(dir) ? dir : resolveNotesDir();
    const results = await searchTree(base, query, !!inBody);
    return { ok: true, results };
  } catch (err) { return { ok: false, error: err.message, results: [] };
  }
});

// 保存/新建一条笔记；oldPath 用于标题改名时删除旧文件。改名时保持在原目录。
ipcMain.handle('notes:save', async (e, { dir, title, body, oldPath }) => {
  try {
    // 改名：保持原文件所在目录；新建：用传入目录或默认目录
    const targetDir = oldPath && fs.existsSync(path.dirname(oldPath))
      ? path.dirname(oldPath)
      : (dir && fs.existsSync(dir) ? dir : resolveNotesDir());
    const base = sanitizeName(title);
    let ext = '.md';
    if (oldPath) { const oe = path.extname(oldPath).toLowerCase(); if (NOTE_EXTS.includes(oe)) ext = oe; }
    let file = path.join(targetDir, base + ext);
    let i = 1;
    while (fs.existsSync(file) && (!oldPath || path.resolve(file) !== path.resolve(oldPath))) {
      file = path.join(targetDir, `${base} (${i++})${ext}`);
    }
    fs.mkdirSync(targetDir, { recursive: true });
    await fs.promises.writeFile(file, String(body ?? ''), 'utf-8');
    if (oldPath && path.resolve(oldPath) !== path.resolve(file) && fs.existsSync(oldPath)) {
      try { await fs.promises.unlink(oldPath); } catch {}
    }
    const st = await fs.promises.stat(file);
    return { ok: true, note: { id: file, path: file, file: path.basename(file), title: path.basename(file, ext), body: String(body ?? ''), ts: st.birthtimeMs || st.ctimeMs, updatedAt: st.mtimeMs } };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 仅重命名文件（保留扩展名与正文，不重写内容）
ipcMain.handle('notes:rename', async (_e, { oldPath, title }) => {
  try {
    if (!oldPath || !fs.existsSync(oldPath)) return { ok: false, error: '文件不存在' };
    const base = sanitizeName(title);
    if (!base) return { ok: false, error: '名称无效' };
    let ext = path.extname(oldPath) || '.md';
    const oe = ext.toLowerCase();
    if (!NOTE_EXTS.includes(oe)) ext = '.md';
    const targetDir = path.dirname(oldPath);
    let file = path.join(targetDir, base + ext);
    let i = 1;
    while (fs.existsSync(file) && path.resolve(file) !== path.resolve(oldPath)) {
      file = path.join(targetDir, `${base} (${i++})${ext}`);
    }
    if (path.resolve(file) !== path.resolve(oldPath)) {
      await fs.promises.rename(oldPath, file);
    }
    const st = await fs.promises.stat(file);
    return {
      ok: true,
      note: {
        id: file,
        path: file,
        file: path.basename(file),
        title: path.basename(file, ext),
        ts: st.birthtimeMs || st.ctimeMs,
        updatedAt: st.mtimeMs,
      },
    };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 新建一条空笔记（自动命名不重复），可指定子目录 dir
ipcMain.handle('notes:create', async (e, { dir }) => {
  try {
    const targetDir = dir && fs.existsSync(dir) ? dir : resolveNotesDir();
    fs.mkdirSync(targetDir, { recursive: true });
    let base = 'Untitled Note';
    let file = path.join(targetDir, base + '.md');
    let i = 1;
    while (fs.existsSync(file)) { file = path.join(targetDir, `${base} (${i++}).md`); }
    await fs.promises.writeFile(file, '', 'utf-8');
    const st = await fs.promises.stat(file);
    return { ok: true, note: { id: file, path: file, file: path.basename(file), title: path.basename(file, '.md'), body: '', ts: st.birthtimeMs || st.ctimeMs, updatedAt: st.mtimeMs } };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 新建子文件夹
ipcMain.handle('notes:createDir', async (e, { parent, name }) => {
  try {
    const baseDir = parent && fs.existsSync(parent) ? parent : resolveNotesDir();
    const safe = sanitizeName(name || 'New Folder');
    let target = path.join(baseDir, safe);
    let i = 1;
    while (fs.existsSync(target)) { target = path.join(baseDir, `${safe} (${i++})`); }
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 删除：文件或空文件夹
ipcMain.handle('notes:delete', async (e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: true };
    const st = fs.statSync(filePath);
    if (st.isDirectory()) {
      const items = fs.readdirSync(filePath);
      if (items.length) return { ok: false, error: '文件夹非空，请先清空' };
      fs.rmdirSync(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 在系统文件管理器中打开目录
ipcMain.handle('notes:reveal', async (e, dir) => {
  try { await shell.openPath(dir || resolveNotesDir()); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 兼容旧接口（浏览器预览态不会用到桌面文件）
ipcMain.handle('notes:read', async () => {
  try {
    const dir = resolveNotesDir();
    return { ok: true, path: dir, dir, tree: buildTree(dir) };
  } catch { return { ok: true, tree: [] }; }
});

// ============ 部署工作台 ============
// 任务清单存 userData/deploy-tasks.json。运行时 spawn 顺序执行命令，流式推送输出到渲染层。
function deployFile() {
  return path.join(app.getPath('userData'), 'deploy-tasks.json');
}
function readTasks() {
  try {
    return JSON.parse(fs.readFileSync(deployFile(), 'utf8'));
  } catch {
    return [];
  }
}
function writeTasks(tasks) {
  fs.writeFileSync(deployFile(), JSON.stringify(tasks, null, 2), 'utf8');
}

// 首次启动：若任务清单不存在，写入通用示例任务。
function seedDeployIfEmpty() {
  if (fs.existsSync(deployFile())) return;
  const seed = require('./seed-deploy-tasks.cjs');
  writeTasks(seed.map((t) => ({ ...t, createdAt: Date.now() })));
}

let runningChild = null;
let runCancelled = false;

function deployOut(msg) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('deploy:output', msg);
}

ipcMain.handle('deploy:list', async () => readTasks());

// 选工作目录：返回选中路径或 null。
ipcMain.handle('deploy:pickDir', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择工作目录',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('deploy:save', async (_e, task) => {
  const tasks = readTasks();
  const item = { ...task };
  if (!item.id) item.id = crypto.randomUUID();
  item.createdAt = item.createdAt || Date.now();
  item.updatedAt = Date.now();
  const i = tasks.findIndex((x) => x.id === item.id);
  if (i >= 0) tasks[i] = { ...tasks[i], ...item };
  else tasks.push(item);
  writeTasks(tasks);
  return item.id;
});

ipcMain.handle('deploy:delete', async (_e, id) => {
  writeTasks(readTasks().filter((t) => t.id !== id));
  return true;
});

// 顺序执行任务里的命令，stdout/stderr 实时推送。某条失败即停止。
// overrides 可传展开后的 commands/env（参数化任务用），不传则回退读任务里存的模板（向后兼容）。
ipcMain.handle('deploy:run', async (_e, id, overrides) => {
  if (runningChild) return { ok: false, msg: '已有任务在运行' };
  const task = readTasks().find((t) => t.id === id);
  if (!task) return { ok: false, msg: '任务不存在' };
  const cmds = (overrides?.commands ?? task.commands ?? []).filter((c) => c && String(c).trim());
  if (!cmds.length) return { ok: false, msg: '没有可执行的命令' };

  runCancelled = false;
  deployOut({ id, type: 'start', task: task.name });
  const env = { ...process.env, ...(overrides?.env ?? task.env ?? {}) };

  const runOne = (cmd) =>
    new Promise((resolve) => {
      const child = spawn(String(cmd), {
        shell: true,
        cwd: task.cwd || undefined,
        env,
        windowsHide: false,
      });
      runningChild = child;
      child.stdout.on('data', (d) => deployOut({ id, type: 'out', text: d.toString() }));
      child.stderr.on('data', (d) => deployOut({ id, type: 'err', text: d.toString() }));
      child.on('close', (code) => {
        runningChild = null;
        deployOut({ id, type: 'close', code });
        resolve(code);
      });
      child.on('error', (e) => {
        runningChild = null;
        deployOut({ id, type: 'err', text: String(e.message) });
        resolve(1);
      });
    });

  let stopped = false;
  let failed = false;
  for (let i = 0; i < cmds.length; i++) {
    if (runCancelled) {
      stopped = true;
      break;
    }
    deployOut({ id, type: 'cmd', text: `> ${cmds[i]}` });
    const code = await runOne(cmds[i]);
    if (runCancelled) {
      stopped = true;
      break;
    }
    if (code !== 0) {
      deployOut({ id, type: 'failed', code });
      failed = true;
      break;
    }
  }
  if (!stopped && !failed) deployOut({ id, type: 'done' });
  return { ok: true };
});

// 中止：Windows 用 taskkill /T /F 杀整棵进程树（cmd + npm + node…）。
ipcMain.handle('deploy:stop', async () => {
  runCancelled = true;
  const child = runningChild;
  runningChild = null;
  if (child && child.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {}
  }
  deployOut({ type: 'cancelled' });
  return true;
});

// ---- SSH 终端 ----
// 纯 JS 的 ssh2 实现 SSH 连接；xterm 在渲染端渲染，数据经 IPC 双向流式传输。
const { Client } = require('ssh2');

const sshSessions = new Map(); // id -> { client, stream }
let sshSeq = 0;

function sshOut(sessionId, msg) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) win.webContents.send('ssh:output', { id: sessionId, ...msg });
}

// 连接：{ host, port, username, password, privateKeyPath } -> { ok, id, error }
// 支持多连接并存：每次连接新建一个独立会话，互不影响。
ipcMain.handle('ssh:connect', async (_e, cfg) => {
  const id = 'ssh-' + (++sshSeq);
  return await new Promise((resolve) => {
    const client = new Client();
    const connectCfg = {
      host: cfg.host,
      port: Number(cfg.port) || 22,
      username: cfg.username,
      readyTimeout: 15000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
    };
    if (cfg.password) connectCfg.password = cfg.password;
    if (cfg.privateKeyPath) {
      try {
        const key = fs.readFileSync(cfg.privateKeyPath, 'utf8');
        connectCfg.privateKey = key;
        if (cfg.passphrase) connectCfg.passphrase = cfg.passphrase;
      } catch (err) {
        resolve({ ok: false, error: '读取私钥失败: ' + err.message });
        return;
      }
    }
    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
        if (err) {
          resolve({ ok: false, error: err.message });
          client.end();
          return;
        }
        stream.on('data', (data) => sshOut(id, { type: 'data', data: data.toString('utf8') }));
        stream.on('close', () => {
          sshOut(id, { type: 'closed' });
          sshSessions.delete(id);
        });
        stream.stderr.on('data', (data) => sshOut(id, { type: 'data', data: data.toString('utf8') }));
        client.on('close', () => {
          sshOut(id, { type: 'closed' });
          sshSessions.delete(id);
        });
        sshSessions.set(id, { client, stream, meta: { name: cfg.name || cfg.host, user: cfg.username, host: cfg.host, port: cfg.port } });
        resolve({ ok: true, id });
      });
    });
    client.on('error', (err) => {
      sshSessions.delete(id);
      resolve({ ok: false, error: err.message });
    });
    client.connect(connectCfg);
  });
});

// 写数据（终端输入）
ipcMain.handle('ssh:write', (_e, id, data) => {
  const s = sshSessions.get(id);
  if (!s || !s.stream) return { ok: false, error: '未连接' };
  try { s.stream.write(data); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 调整终端尺寸（cols x rows）
ipcMain.handle('ssh:resize', (_e, id, cols, rows) => {
  const s = sshSessions.get(id);
  if (!s || !s.stream) return { ok: false, error: '未连接' };
  try {
    s.stream.setWindow(Number(rows) || 30, Number(cols) || 100);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 断开连接
ipcMain.handle('ssh:disconnect', (_e, id) => {
  const s = sshSessions.get(id);
  if (s) {
    try { s.stream?.end(); s.client?.end(); } catch {}
    sshSessions.delete(id);
    sshOut(id, { type: 'closed' });
  }
  return { ok: true };
});

// 查询当前存活的会话列表（用于切回工具时恢复 UI）
ipcMain.handle('ssh:list', () => {
  const out = [];
  for (const [id, s] of sshSessions) {
    out.push({ id, ...(s.meta || {}) });
  }
  return { ok: true, sessions: out };
});

// ---- 服务器系统信息（SSH exec 只读命令采集）----
function execSsh(session, cmd) {
  return new Promise((resolve) => {
    session.client.exec(cmd, (err, stream) => {
      if (err) return resolve('');
      let out = '';
      stream.on('data', (d) => { out += d.toString('utf8'); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => resolve(out.trim()));
    });
  });
}

ipcMain.handle('ssh:sysinfo', async (_e, id) => {
  const s = sshSessions.get(id);
  if (!s || !s.client) return { ok: false, error: '未连接' };
  try {
    // 一次性采集（兼容常见 Linux）：全部只读
    const hostname = await execSsh(s, 'hostname 2>/dev/null');
    const osInfo = await execSsh(s, 'cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|VERSION_ID)=" | cut -d= -f2 | tr -d \'"\'');
    const kernel = await execSsh(s, 'uname -r 2>/dev/null');
    const uptime = await execSsh(s, 'cat /proc/uptime 2>/dev/null | awk \'{print int($1)}\'');
    const cpuModel = await execSsh(s, 'grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2');
    const cpuCores = await execSsh(s, 'nproc 2>/dev/null');
    const cpuUsage = await execSsh(s, `top -bn1 2>/dev/null | grep "Cpu(s)" | awk '{print 100-$8}' | cut -d. -f1`);
    const memInfo = await execSsh(s, `free -m 2>/dev/null | awk '/^Mem:/{printf "%d %d", $2, $7}'`);
    const diskInfo = await execSsh(s, `df -P / 2>/dev/null | awk 'NR==2{printf "%s %s %s", $2, $3, $5}'`);
    const loadAvg = await execSsh(s, `cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}'`);
    const ipInfo = await execSsh(s, `hostname -I 2>/dev/null | awk '{print $1}'`);
    const arch = await execSsh(s, 'uname -m 2>/dev/null');

    // 解析
    const parseMem = (str) => {
      const [total, avail] = String(str).split(/\s+/).map(Number);
      if (!total) return null;
      const used = total - avail;
      return { total, used, usedPercent: Math.round((used / total) * 100) };
    };
    const parseDisk = (str) => {
      const [total, used, pct] = String(str).split(/\s+/);
      if (!total) return null;
      return { total, used, percent: String(pct).replace('%', '') };
    };
    const parseUptime = (sec) => {
      const s2 = Number(sec) || 0;
      const d = Math.floor(s2 / 86400);
      const h = Math.floor((s2 % 86400) / 3600);
      const m = Math.floor((s2 % 3600) / 60);
      return d > 0 ? `${d}天 ${h}时 ${m}分` : `${h}时 ${m}分`;
    };

    return {
      ok: true,
      info: {
        hostname: hostname || 'unknown',
        os: osInfo.split('\n').join(' ') || 'unknown',
        kernel: kernel || '',
        arch: arch || '',
        uptime: parseUptime(uptime),
        cpuModel: cpuModel.trim() || '',
        cpuCores: cpuCores || '0',
        cpuUsage: Math.min(100, Math.max(0, Number(cpuUsage) || 0)),
        mem: parseMem(memInfo),
        disk: parseDisk(diskInfo),
        load: loadAvg || '',
        ip: ipInfo || '',
      },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- 本地目录浏览（SFTP 面板左栏用）----
ipcMain.handle('fs:listDir', async (_e, dir) => {
  try {
    const target = dir || os.homedir();
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const items = entries
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isFile() ? (fs.statSync(path.join(target, e.name)).size || 0) : 0,
        mtime: e.isFile() ? fs.statSync(path.join(target, e.name)).mtimeMs || 0 : 0,
      }))
      .sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
    return { ok: true, path: target, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 选择本地文件夹（SFTP 面板「选择目录」用）
ipcMain.handle('fs:pickDir', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

// 读取本地文件（下载到本地/对比用）：base64
ipcMain.handle('fs:readFile', async (_e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    return { ok: true, content: buf.toString('base64'), name: path.basename(filePath) };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 写入本地文件：{ filePath, content(base64) } -> { ok }
ipcMain.handle('fs:saveFile', async (_e, filePath, content) => {
  try {
    const buf = Buffer.from(content || '', 'base64');
    fs.writeFileSync(filePath, buf);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---- SFTP 文件传输（复用 ssh 会话的 client）----
// 每个操作临时建立 sftp 通道，用完即关，避免长期占用。
async function withSftp(id, fn) {
  const s = sshSessions.get(id);
  if (!s || !s.client) throw new Error('未连接或连接已断开');
  const sftp = await new Promise((resolve, reject) => {
    s.client.sftp((err, sf) => (err ? reject(err) : resolve(sf)));
  });
  try {
    return await fn(sftp);
  } finally {
    sftp.end();
  }
}

// 列目录：{ id, path } -> { ok, items: [{ name, isDir, size, mtime }] }
ipcMain.handle('sftp:list', async (_e, { id, path = '.' }) => {
  try {
    const items = await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      sftp.readdir(path, (err, list) => {
        if (err) return reject(err);
        const out = list.map((x) => ({
          name: x.filename,
          isDir: x.attrs.isDirectory(),
          size: x.attrs.size,
          mtime: x.attrs.mtime ? x.attrs.mtime * 1000 : 0,
        }));
        // 目录在前
        out.sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
        resolve(out);
      });
    }));
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 读取文件内容（下载）：{ id, path } -> { ok, content }（content 为 base64）
ipcMain.handle('sftp:read', async (_e, { id, path }) => {
  try {
    const content = await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      const chunks = [];
      sftp.createReadStream(path)
        .on('data', (d) => chunks.push(d))
        .on('end', () => resolve(Buffer.concat(chunks).toString('base64')))
        .on('error', reject);
    }));
    return { ok: true, content };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 写入文件（上传）：{ id, path, content(base64) } -> { ok }
ipcMain.handle('sftp:write', async (_e, { id, path, content }) => {
  try {
    const buf = Buffer.from(content || '', 'base64');
    await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(path);
      ws.on('close', resolve);
      ws.on('error', reject);
      ws.end(buf);
    }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 新建目录：{ id, path } -> { ok }
ipcMain.handle('sftp:mkdir', async (_e, { id, path }) => {
  try {
    await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()));
    }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 删除：{ id, path, isDir } -> { ok }
ipcMain.handle('sftp:delete', async (_e, { id, path, isDir }) => {
  try {
    await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      if (isDir) sftp.rmdir(path, (err) => (err ? reject(err) : resolve()));
      else sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
    }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 重命名/移动：{ id, oldPath, newPath } -> { ok }
ipcMain.handle('sftp:rename', async (_e, { id, oldPath, newPath }) => {
  try {
    await withSftp(id, (sftp) => new Promise((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
    }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: '开发者工具箱',
    // Windows 任务栏/窗口图标优先用 .ico；png 在部分环境下会回落到默认 Electron 图标
    icon: fs.existsSync(path.join(__dirname, '..', 'build', 'icon.ico'))
      ? path.join(__dirname, '..', 'build', 'icon.ico')
      : path.join(__dirname, 'icon.png'),
    backgroundColor: '#101512',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  seedDeployIfEmpty();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
