const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const net = require('net');
const fs = require('fs');

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
    fs.writeFileSync(file, String(body ?? ''), 'utf-8');
    if (oldPath && path.resolve(oldPath) !== path.resolve(file) && fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch {}
    }
    const st = fs.statSync(file);
    return { ok: true, note: { id: file, path: file, file: path.basename(file), title: path.basename(file, ext), body: String(body ?? ''), ts: st.birthtimeMs || st.ctimeMs, updatedAt: st.mtimeMs } };
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
    fs.writeFileSync(file, '', 'utf-8');
    const st = fs.statSync(file);
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'DevTool',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#f1f2f5',
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
