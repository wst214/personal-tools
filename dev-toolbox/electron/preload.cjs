const { contextBridge, clipboard, ipcRenderer } = require('electron');
const path = require('path');

// 暴露给渲染进程的安全 API。纯前端工具无需这些；HTTP/系统信息/端口/IP/翻译/Hosts 等 Node 类工具使用。
contextBridge.exposeInMainWorld('toolbox', {
  isElectron: true,
  platform: process.platform,
  writeClipboard: (text) => clipboard.writeText(String(text ?? '')),
  readClipboard: () => clipboard.readText(),

  // HTTP 请求：{ url, method, headers, body, timeout } -> { ok, status, statusText, headers, body, ms }
  http: (opts) => ipcRenderer.invoke('http:request', opts),
  // 系统信息
  sysInfo: () => ipcRenderer.invoke('sys:info'),
  // 端口扫描：{ host, ports:[num], timeout }
  portScan: (host, ports, timeout) => ipcRenderer.invoke('port:scan', { host, ports, timeout }),
  // IP 归属地：ip 为空查本机出口 IP
  ipQuery: (ip) => ipcRenderer.invoke('ip:query', ip),
  // 翻译：{ text, from, to }
  translate: (payload) => ipcRenderer.invoke('translate', payload),
  // Hosts 读写
  hostsRead: () => ipcRenderer.invoke('hosts:read'),
  hostsWrite: (content) => ipcRenderer.invoke('hosts:write', content),
  // 随手记（文件夹 + 独立文件，树形结构）
  notesList: () => ipcRenderer.invoke('notes:list'),
  notesPickDir: () => ipcRenderer.invoke('notes:pickDir'),
  notesSetDefault: (dir) => ipcRenderer.invoke('notes:setDefault', dir),
  notesReadFile: (filePath) => ipcRenderer.invoke('notes:readFile', filePath),
  notesSearch: (payload) => ipcRenderer.invoke('notes:search', payload),
  notesSave: (payload) => ipcRenderer.invoke('notes:save', payload),
  notesCreate: (payload) => ipcRenderer.invoke('notes:create', payload),
  notesCreateDir: (payload) => ipcRenderer.invoke('notes:createDir', payload),
  notesDelete: (filePath) => ipcRenderer.invoke('notes:delete', filePath),
  notesRename: (payload) => ipcRenderer.invoke('notes:rename', payload),
  notesReveal: (dir) => ipcRenderer.invoke('notes:reveal', dir),
  notesRead: () => ipcRenderer.invoke('notes:read'),
  // 部署工作台
  deploy: {
    list: () => ipcRenderer.invoke('deploy:list'),
    save: (task) => ipcRenderer.invoke('deploy:save', task),
    delete: (id) => ipcRenderer.invoke('deploy:delete', id),
    run: (id, overrides) => ipcRenderer.invoke('deploy:run', id, overrides),
    stop: () => ipcRenderer.invoke('deploy:stop'),
    pickDir: () => ipcRenderer.invoke('deploy:pickDir'),
  },
  // 任务运行时：流式输出回调，返回取消订阅函数。
  onDeployOutput: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('deploy:output', handler);
    return () => ipcRenderer.removeListener('deploy:output', handler);
  },
  // SSH 终端
  ssh: {
    connect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg),
    write: (id, data) => ipcRenderer.invoke('ssh:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('ssh:resize', id, cols, rows),
    disconnect: (id) => ipcRenderer.invoke('ssh:disconnect', id),
    list: () => ipcRenderer.invoke('ssh:list'),
    sysinfo: (id) => ipcRenderer.invoke('ssh:sysinfo', id),
  },
  // SFTP 文件传输（复用 ssh 会话）
  sftp: {
    list: (id, path) => ipcRenderer.invoke('sftp:list', { id, path }),
    read: (id, path) => ipcRenderer.invoke('sftp:read', { id, path }),
    write: (id, path, content) => ipcRenderer.invoke('sftp:write', { id, path, content }),
    mkdir: (id, path) => ipcRenderer.invoke('sftp:mkdir', { id, path }),
    delete: (id, path, isDir) => ipcRenderer.invoke('sftp:delete', { id, path, isDir }),
    rename: (id, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', { id, oldPath, newPath }),
  },
  // 本地文件系统（SFTP 面板左栏）
  fs: {
    listDir: (dir) => ipcRenderer.invoke('fs:listDir', dir),
    pickDir: () => ipcRenderer.invoke('fs:pickDir'),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    saveFile: (filePath, content) => ipcRenderer.invoke('fs:saveFile', filePath, content),
  },
  // SSH 输出回调：{ id, type: 'data'|'closed', data? } -> 返回取消订阅
  onSshOutput: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('ssh:output', handler);
    return () => ipcRenderer.removeListener('ssh:output', handler);
  },
  // 本地路径：供部署任务的 {{toolbox}} 占位符解析脚本位置。
  paths: {
    toolboxRoot: __dirname.includes('app.asar')
      ? path.join(__dirname, '..', '..')
      : path.join(__dirname, '..'),
  },
});
