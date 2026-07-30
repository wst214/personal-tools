const { contextBridge, clipboard, ipcRenderer } = require('electron');

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
  notesReveal: (dir) => ipcRenderer.invoke('notes:reveal', dir),
  notesRead: () => ipcRenderer.invoke('notes:read'),
});
