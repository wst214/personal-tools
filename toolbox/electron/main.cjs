const { app, BrowserWindow, globalShortcut, ipcMain, shell, dialog, safeStorage, clipboard } = require('electron');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
// ssh2：纯 JS SSH/SFTP（可选原生 cpu-features 装不上时自动降级）；未装时内嵌终端禁用，不影响 app 启动。
let SSHClient = null;
try { SSHClient = require('ssh2').Client; } catch (e) { console.warn('[ssh2] 未安装，内嵌终端不可用：', e.message); }

let win;
// 给渲染层推事件（win 未就绪/已销毁时静默跳过）。
function safeSend(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

// ---- 配置：用户选择的笔记根目录 ----
function configFile() {
  return path.join(app.getPath('userData'), 'config.json');
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeConfig(cfg) {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8');
}
// 笔记根目录：用户设置过就用设置，否则默认 d:/note。
function notesDir() {
  const cfg = readConfig();
  return cfg.notesDir || 'd:/note';
}
async function ensureNotesDir() {
  await fsp.mkdir(notesDir(), { recursive: true });
}
// 把标题转成安全的文件名。
function safeName(name) {
  const cleaned = (name || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100);
  return cleaned || 'untitled';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#f5f6f8',
    // 无边框 + 系统覆盖层：现代感标题栏，窗口按钮由系统绘制在右上角。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f6f8', symbolColor: '#5c6573', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// 软件渲染：规避 Windows 上 GPU 缓存「拒绝访问」可能导致白屏的风险，对工具箱性能无影响。
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await ensureNotesDir();
  seedDeployIfEmpty();
  createWindow();

  // 全局快捷键：唤起窗口并新建一条笔记，直接进入编辑。
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (!win) return;
    if (!win.isVisible()) win.show();
    win.focus();
    win.webContents.send('quick-capture');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // dshChild 在文件后部声明；退出时尽量清掉本地 Harness 进程树。
  try {
    if (typeof killDshProcess === 'function') killDshProcess();
  } catch {}
});

// ---- 树扫描：递归读取目录，返回 { folders, notes } ----
// folders: [{ name, path, children: {folders, notes} }]
// notes:   [{ name, content, mtime, path, folder }]
async function scanTree(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const folders = [];
  const notes = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      folders.push({ name: e.name, path: full, children: await scanTree(full) });
    } else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        const content = await fsp.readFile(full, 'utf8');
        const st = await fsp.stat(full);
        notes.push({ name: e.name.replace(/\.md$/, ''), content, mtime: st.mtimeMs, path: full, folder: dir });
      } catch {
        // 单个文件读失败不影响整体
      }
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  notes.sort((a, b) => b.mtime - a.mtime);
  return { folders, notes };
}

// ---- IPC ----

ipcMain.handle('notes:list', async () => {
  await ensureNotesDir();
  return scanTree(notesDir());
});

// folder 为目标文件夹绝对路径，省略则放根目录。
ipcMain.handle('notes:save', async (_e, { name, content, folder }) => {
  const dir = folder || notesDir();
  await fsp.mkdir(dir, { recursive: true });
  const fp = path.join(dir, safeName(name) + '.md');
  await fsp.writeFile(fp, content, 'utf8');
  return fp;
});

ipcMain.handle('notes:delete', async (_e, filePath) => {
  await fsp.unlink(filePath).catch(() => {});
  return true;
});

ipcMain.handle('notes:openDir', async () => {
  await shell.openPath(notesDir());
});

ipcMain.handle('notes:getDir', async () => {
  return notesDir();
});

// 弹文件夹选择框，设为新的笔记根目录。
ipcMain.handle('notes:setDir', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择笔记根目录',
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  const cfg = readConfig();
  cfg.notesDir = dir;
  writeConfig(cfg);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
});

// ============ SSH 连接管理 ============
// 主机清单存 userData/ssh-hosts.json，密码用 safeStorage（系统钥匙串）加密。

function sshHostsFile() {
  return path.join(app.getPath('userData'), 'ssh-hosts.json');
}
function readHosts() {
  try {
    return JSON.parse(fs.readFileSync(sshHostsFile(), 'utf8'));
  } catch {
    return [];
  }
}
function writeHosts(hosts) {
  fs.writeFileSync(sshHostsFile(), JSON.stringify(hosts, null, 2), 'utf8');
}

// 加密：safeStorage 可用就走系统钥匙串，否则降级 base64（仅混淆，并日志警告）。
function encPwd(plain) {
  if (!plain) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64');
  }
  console.warn('[ssh] safeStorage 不可用，密码仅做 base64 混淆存储');
  return 'b64:' + Buffer.from(plain, 'utf8').toString('base64');
}
function decPwd(enc) {
  if (!enc) return '';
  if (enc.startsWith('b64:')) return Buffer.from(enc.slice(4), 'base64').toString('utf8');
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

// 本机 .ssh 目录与默认密钥路径。
function sshDir() {
  return path.join(app.getPath('home'), '.ssh');
}
function defaultKeyPath() {
  return path.join(sshDir(), 'id_ed25519');
}

// 拼一条 ssh 登录命令（端口非 22 才带 -p）。
function sshCmd(h) {
  const port = h.port && Number(h.port) !== 22 ? ` -p ${h.port}` : '';
  return `ssh ${h.user}@${h.host}${port}`;
}

ipcMain.handle('ssh:list', async () => {
  // 不回密码明文，只回 hasPwd 标记，避免列表泄漏。
  return readHosts().map((h) => {
    const { passwordEnc, ...rest } = h;
    return { ...rest, hasPwd: !!passwordEnc };
  });
});

ipcMain.handle('ssh:save', async (_e, host) => {
  const hosts = readHosts();
  const item = { ...host };
  // 渲染层传明文 password：有值就加密存，空串则清空。
  const pwd = item.password;
  delete item.password;
  item.passwordEnc = pwd ? encPwd(pwd) : '';
  if (!item.id) item.id = crypto.randomUUID();
  item.createdAt = item.createdAt || Date.now();
  item.updatedAt = Date.now();
  const i = hosts.findIndex((x) => x.id === item.id);
  if (i >= 0) hosts[i] = { ...hosts[i], ...item }; else hosts.push(item);
  writeHosts(hosts);
  return item.id;
});

ipcMain.handle('ssh:delete', async (_e, id) => {
  writeHosts(readHosts().filter((h) => h.id !== id));
  return true;
});

ipcMain.handle('ssh:getPwd', async (_e, id) => {
  const h = readHosts().find((x) => x.id === id);
  return h ? decPwd(h.passwordEnc) : '';
});

// ---- 内嵌终端 + SFTP 连接管理 ----
// 每个标签页一条独立 ssh2 连接：{ conn, stream, sftp, hostId, name }。
const sshConns = new Map();

// 由 hostId 取主机配置 + 认证材料（密码走 safeStorage 解密；免密用本机默认 ed25519 私钥）。
function sshCreds(h) {
  const cfg = { host: h.host, port: Number(h.port) || 22, username: h.user };
  if (h.auth === 'password') {
    const pwd = decPwd(h.passwordEnc);
    if (pwd) cfg.password = pwd;
  } else {
    const keyPath = defaultKeyPath();
    if (fs.existsSync(keyPath)) cfg.privateKey = fs.readFileSync(keyPath, 'utf8');
  }
  return cfg;
}

function closeSshTab(tabId) {
  const rec = sshConns.get(tabId);
  if (!rec) return;
  try { if (rec.stream) rec.stream.end(); } catch {}
  try { if (rec.sftp) rec.sftp.end(); } catch {}
  try { rec.conn.end(); } catch {}
  sshConns.delete(tabId);
}

// 取/懒建 sftp 句柄（首次 SFTP 操作时才开第二条通道）。
function getSftp(tabId) {
  return new Promise((resolve, reject) => {
    const rec = sshConns.get(tabId);
    if (!rec) return reject(new Error('连接不存在'));
    if (rec.sftp) return resolve(rec.sftp);
    rec.conn.sftp((err, sftp) => {
      if (err) return reject(err);
      rec.sftp = sftp;
      resolve(sftp);
    });
  });
}

// 开一条内嵌终端：建 conn -> shell channel -> 流式把输出推给渲染层。
ipcMain.handle('ssh:term:connect', async (_e, hostId) => {
  if (!SSHClient) return { ok: false, msg: 'ssh2 未安装，内嵌终端不可用' };
  const h = readHosts().find((x) => x.id === hostId);
  if (!h) return { ok: false, msg: '主机不存在' };
  const creds = sshCreds(h);
  if (h.auth !== 'password' && !creds.privateKey) {
    return { ok: false, msg: '未找到本机私钥，请先「配置免密」或在主机里改用密码认证' };
  }
  const tabId = 't-' + crypto.randomUUID();
  const conn = new SSHClient();
  sshConns.set(tabId, { conn, stream: null, sftp: null, hostId, name: h.name || h.host });

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) { safeSend('ssh:term:closed', { tabId, msg: String(err.message || err) }); return finish(); }
        const rec = sshConns.get(tabId);
        if (rec) rec.stream = stream;
        stream.on('data', (d) => safeSend('ssh:term:data', { tabId, data: d.toString('utf8') }));
        stream.stderr.on('data', (d) => safeSend('ssh:term:data', { tabId, data: d.toString('utf8') }));
        stream.on('close', () => safeSend('ssh:term:closed', { tabId }));
        finish();
      });
    });
    conn.on('error', (err) => { safeSend('ssh:term:closed', { tabId, msg: String(err.message || err) }); finish(); });
    conn.on('close', () => { safeSend('ssh:term:closed', { tabId }); finish(); });
    try { conn.connect(creds); } catch (e) { safeSend('ssh:term:closed', { tabId, msg: String(e.message || e) }); finish(); }
  });

  const rec = sshConns.get(tabId);
  return { ok: !!rec && !!rec.stream, tabId, name: h.name || h.host };
});

ipcMain.handle('ssh:term:input', async (_e, { tabId, data }) => {
  const rec = sshConns.get(tabId);
  if (rec && rec.stream) { try { rec.stream.write(data); } catch {} }
  return true;
});

ipcMain.handle('ssh:term:resize', async (_e, { tabId, cols, rows }) => {
  const rec = sshConns.get(tabId);
  if (rec && rec.stream) { try { rec.stream.setWindow(rows, cols, rows, cols); } catch {} }
  return true;
});

ipcMain.handle('ssh:term:disconnect', async (_e, tabId) => { closeSshTab(tabId); return true; });

// SFTP：列出远程目录，先 realpath 解析成绝对路径（导航用），返回 { path, items }。
ipcMain.handle('ssh:sftp:list', async (_e, { tabId, remotePath }) => {
  const sftp = await getSftp(tabId);
  const absPath = await new Promise((resolve, reject) =>
    sftp.realpath(remotePath, (err, p) => (err ? reject(err) : resolve(p))),
  );
  const items = await new Promise((resolve, reject) => {
    sftp.readdir(absPath, (err, its) => {
      if (err) return reject(err);
      resolve(its.map((it) => ({
        name: it.filename,
        type: it.attrs.isDirectory ? 'dir' : (it.attrs.isSymbolicLink ? 'link' : 'file'),
        size: it.attrs.size,
        mtime: it.attrs.mtime * 1000,
      })));
    });
  });
  return { path: absPath, items };
});

// 上传/下载（fastPut/fastGet 带进度，进度推给渲染层状态条）。
ipcMain.handle('ssh:sftp:upload', async (_e, { tabId, localPath, remotePath }) => {
  const sftp = await getSftp(tabId);
  await new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, {
      step: (transferred, _chunk, total) => safeSend('ssh:sftp:progress', { tabId, op: 'upload', transferred, total, name: path.basename(remotePath) }),
    }, (err) => err ? reject(err) : resolve());
  });
  return true;
});

ipcMain.handle('ssh:sftp:download', async (_e, { tabId, remotePath, localPath }) => {
  const sftp = await getSftp(tabId);
  await new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {
      step: (transferred, _chunk, total) => safeSend('ssh:sftp:progress', { tabId, op: 'download', transferred, total, name: path.basename(remotePath) }),
    }, (err) => err ? reject(err) : resolve());
  });
  return true;
});

ipcMain.handle('ssh:sftp:mkdir', async (_e, { tabId, remotePath }) => {
  const sftp = await getSftp(tabId);
  await new Promise((resolve, reject) => sftp.mkdir(remotePath, (err) => err ? reject(err) : resolve()));
  return true;
});

// 本地文件浏览（SFTP 左栏用，主进程 fs）。dir 为空时回退用户主目录，返回 { path, items }。
ipcMain.handle('ssh:local:list', async (_e, dir) => {
  const os = require('os');
  const target = dir || os.homedir();
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const items = entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: target, items };
});

ipcMain.handle('ssh:local:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择文件', properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('ssh:local:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择目录', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// 把完整 ssh 命令写剪贴板。
ipcMain.handle('ssh:copyCmd', async (_e, id) => {
  const h = readHosts().find((x) => x.id === id);
  if (!h) return { ok: false, msg: '主机不存在' };
  clipboard.writeText(sshCmd(h));
  return { ok: true, cmd: sshCmd(h) };
});

// 生成默认 ed25519 密钥（已存在则跳过）。
ipcMain.handle('ssh:genKey', async () => {
  const keyPath = defaultKeyPath();
  await fsp.mkdir(sshDir(), { recursive: true });
  if (fs.existsSync(keyPath)) return { ok: true, msg: '已存在', keyPath };
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'toolbox'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, msg: (r.stderr || 'ssh-keygen 失败').trim() };
  return { ok: true, msg: '已生成', keyPath };
});

// 读公钥文本（界面展示/复制）。
ipcMain.handle('ssh:publicKey', async () => {
  const pub = defaultKeyPath() + '.pub';
  try {
    return await fsp.readFile(pub, 'utf8');
  } catch {
    return '';
  }
});

// 生成「把公钥推到目标主机」的命令并写剪贴板，引导用户执行一次以配置免密。
ipcMain.handle('ssh:setupKeyless', async (_e, id) => {
  const h = readHosts().find((x) => x.id === id);
  if (!h) return { ok: false, msg: '主机不存在' };
  const keyPath = defaultKeyPath();
  if (!fs.existsSync(keyPath)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'toolbox'], { encoding: 'utf8' });
    if (r.status !== 0) return { ok: false, msg: (r.stderr || 'ssh-keygen 失败').trim() };
  }
  const pubRef = process.platform === 'win32'
    ? `type "${keyPath}.pub"`
    : `cat "${keyPath}.pub"`;
  const port = h.port && Number(h.port) !== 22 ? ` -p ${h.port}` : '';
  // 把公钥追加到远端 authorized_keys，执行时会要求输一次密码，之后免密。
  const cmd = `${pubRef} | ssh ${h.user}@${h.host}${port} "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`;
  clipboard.writeText(cmd);
  return { ok: true, cmd };
});

// ============ JSON 查看器 ============
// 选一个 .json（或任意文本）文件，读回 { name, content, size }。大文件直接读全文。
ipcMain.handle('json:openFile', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择 JSON 文件',
    properties: ['openFile'],
    filters: [{ name: 'JSON / 文本', extensions: ['json', 'txt', 'log', 'ndjson'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const fp = result.filePaths[0];
  try {
    const buf = await fsp.readFile(fp);
    return { name: path.basename(fp), content: buf.toString('utf8'), size: buf.length };
  } catch (e) {
    return { error: String(e.message || e) };
  }
});

// ============ 打包部署工作台 ============
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

// 首次启动：若任务清单不存在，写入个人默认任务（leidian 项目的打包/部署）。
function seedDeployIfEmpty() {
  if (fs.existsSync(deployFile())) return;
  const seed = require('./seed-deploy-tasks.cjs');
  writeTasks(seed.map((t) => ({ ...t, createdAt: Date.now() })));
}

let runningChild = null;
let runCancelled = false;

function deployOut(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('deploy:output', msg);
}

ipcMain.handle('deploy:list', async () => readTasks());

// 选工作目录：返回选中路径或 null。
ipcMain.handle('deploy:pickDir', async () => {
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
        // /T 杀进程树（cmd + docker/mvn/java…），/F 强制
        spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {}
  }
  // 立即通知渲染层已中止，不等 close 事件：进程没杀干净时 close 可能迟迟不来，
  // 会让 UI 卡在"停止"按钮、输出也不再更新。先让 UI 响应，后台尽力清理。
  deployOut({ type: 'cancelled' });
  return true;
});

// ============ DeepSeek Harness (dsh) ============
// 启动本机已安装的 @deepseek-ai/dsh Web UI（默认目录 D:\deepseek-ai）。

const DSH_DEFAULT_DIR = 'D:\\deepseek-ai';
const DSH_DEFAULT_URL = 'http://127.0.0.1:3080';

let dshChild = null;
let dshReady = false;

function dshOut(msg) {
  safeSend('dsh:output', msg);
}

function dshInstallDir() {
  const cfg = readConfig();
  return cfg.dshInstallDir || DSH_DEFAULT_DIR;
}

function dshResolveBin(dir) {
  const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const local = path.join(dir, 'node_modules', '.bin', cmd);
  if (fs.existsSync(local)) return { bin: local, args: ['web'] };
  const startCmd = path.join(dir, 'start-web.cmd');
  if (process.platform === 'win32' && fs.existsSync(startCmd)) return { bin: startCmd, args: [] };
  return null;
}

function dshStatusPayload() {
  return {
    running: !!(dshChild && dshChild.pid),
    ready: dshReady,
    installDir: dshInstallDir(),
    url: DSH_DEFAULT_URL,
    pid: dshChild?.pid || null,
  };
}

function killDshProcess() {
  const child = dshChild;
  dshChild = null;
  dshReady = false;
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

ipcMain.handle('dsh:status', async () => dshStatusPayload());

ipcMain.handle('dsh:getConfig', async () => ({
  installDir: dshInstallDir(),
  url: DSH_DEFAULT_URL,
}));

ipcMain.handle('dsh:setInstallDir', async (_e, dir) => {
  if (!dir || typeof dir !== 'string') return { ok: false, msg: '路径无效' };
  const cfg = readConfig();
  cfg.dshInstallDir = dir;
  writeConfig(cfg);
  return { ok: true, installDir: dir };
});

ipcMain.handle('dsh:pickDir', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: '选择 DeepSeek Harness 安装目录',
    defaultPath: dshInstallDir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('dsh:open', async () => {
  await shell.openExternal(DSH_DEFAULT_URL);
  return true;
});

ipcMain.handle('dsh:openInstallDir', async () => {
  const dir = dshInstallDir();
  if (!fs.existsSync(dir)) return { ok: false, msg: '目录不存在：' + dir };
  await shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('dsh:start', async () => {
  if (dshChild && dshChild.pid) return { ok: false, msg: '已在运行', ...dshStatusPayload() };
  const dir = dshInstallDir();
  if (!fs.existsSync(dir)) return { ok: false, msg: '安装目录不存在：' + dir };
  const resolved = dshResolveBin(dir);
  if (!resolved) {
    return {
      ok: false,
      msg: '未找到 dsh。请确认目录下已执行 npm install @deepseek-ai/dsh',
    };
  }

  dshReady = false;
  dshOut({ type: 'cmd', text: `> ${resolved.bin} ${resolved.args.join(' ')}` });
  dshOut({ type: 'out', text: `cwd: ${dir}\n` });

  try {
    const child = spawn(resolved.bin, resolved.args, {
      cwd: dir,
      env: { ...process.env },
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    dshChild = child;
    child.stdout.on('data', (d) => {
      const text = d.toString();
      dshOut({ type: 'out', text });
      if (!dshReady && /127\.0\.0\.1:3080|localhost:3080/i.test(text)) {
        dshReady = true;
        dshOut({ type: 'ready', url: DSH_DEFAULT_URL });
      }
    });
    child.stderr.on('data', (d) => dshOut({ type: 'err', text: d.toString() }));
    child.on('close', (code) => {
      dshChild = null;
      dshReady = false;
      dshOut({ type: 'close', code });
    });
    child.on('error', (e) => {
      dshChild = null;
      dshReady = false;
      dshOut({ type: 'err', text: String(e.message || e) });
      dshOut({ type: 'close', code: 1 });
    });
  } catch (e) {
    return { ok: false, msg: String(e.message || e) };
  }

  return { ok: true, ...dshStatusPayload() };
});

ipcMain.handle('dsh:stop', async () => {
  if (!dshChild) {
    dshOut({ type: 'cancelled' });
    return { ok: true, ...dshStatusPayload() };
  }
  killDshProcess();
  dshOut({ type: 'cancelled' });
  return { ok: true, ...dshStatusPayload() };
});
