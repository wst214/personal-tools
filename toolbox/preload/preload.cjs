const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// 暴露给渲染进程的安全 API。文件读写走主进程，渲染层不直接碰 fs。
contextBridge.exposeInMainWorld('toolbox', {
  notes: {
    list: () => ipcRenderer.invoke('notes:list'), // 返回 { folders, notes } 树
    save: (name, content, folder) => ipcRenderer.invoke('notes:save', { name, content, folder }),
    delete: (filePath) => ipcRenderer.invoke('notes:delete', filePath),
    openDir: () => ipcRenderer.invoke('notes:openDir'),
    getDir: () => ipcRenderer.invoke('notes:getDir'),
    setDir: () => ipcRenderer.invoke('notes:setDir'),
  },
  ssh: {
    list: () => ipcRenderer.invoke('ssh:list'),
    save: (host) => ipcRenderer.invoke('ssh:save', host),
    delete: (id) => ipcRenderer.invoke('ssh:delete', id),
    copyCmd: (id) => ipcRenderer.invoke('ssh:copyCmd', id),
    getPwd: (id) => ipcRenderer.invoke('ssh:getPwd', id),
    genKey: () => ipcRenderer.invoke('ssh:genKey'),
    setupKeyless: (id) => ipcRenderer.invoke('ssh:setupKeyless', id),
    publicKey: () => ipcRenderer.invoke('ssh:publicKey'),
    // 内嵌终端：每标签一条流，onData 收输出，onClosed 收断开，返回取消订阅函数。
    term: {
      connect: (hostId) => ipcRenderer.invoke('ssh:term:connect', hostId),
      input: (tabId, data) => ipcRenderer.invoke('ssh:term:input', { tabId, data }),
      resize: (tabId, cols, rows) => ipcRenderer.invoke('ssh:term:resize', { tabId, cols, rows }),
      disconnect: (tabId) => ipcRenderer.invoke('ssh:term:disconnect', tabId),
      onData: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('ssh:term:data', h); return () => ipcRenderer.removeListener('ssh:term:data', h); },
      onClosed: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('ssh:term:closed', h); return () => ipcRenderer.removeListener('ssh:term:closed', h); },
    },
    // SFTP：远程列表/上传/下载/建目录，进度走 onProgress。
    sftp: {
      list: (tabId, remotePath) => ipcRenderer.invoke('ssh:sftp:list', { tabId, remotePath }),
      upload: (tabId, localPath, remotePath) => ipcRenderer.invoke('ssh:sftp:upload', { tabId, localPath, remotePath }),
      download: (tabId, remotePath, localPath) => ipcRenderer.invoke('ssh:sftp:download', { tabId, remotePath, localPath }),
      mkdir: (tabId, remotePath) => ipcRenderer.invoke('ssh:sftp:mkdir', { tabId, remotePath }),
      onProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('ssh:sftp:progress', h); return () => ipcRenderer.removeListener('ssh:sftp:progress', h); },
    },
    // 本地文件浏览（SFTP 左栏 + 选保存位置）。
    local: {
      list: (dir) => ipcRenderer.invoke('ssh:local:list', dir),
      pickFile: () => ipcRenderer.invoke('ssh:local:pickFile'),
      pickDir: () => ipcRenderer.invoke('ssh:local:pickDir'),
    },
  },
  json: {
    openFile: () => ipcRenderer.invoke('json:openFile'),
  },
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
  // 全局快捷键唤起后：新建一条笔记并进入编辑
  onQuickCapture: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('quick-capture', handler);
    return () => ipcRenderer.removeListener('quick-capture', handler);
  },
  platform: process.platform,
  // 本地路径：供部署任务的 {{toolbox}} 占位符解析脚本位置。
  // 开发版指向 toolbox 根（源码 scripts/），打包版指向 resources/（extraResources 把 scripts/leidian 放那，PowerShell 才能直接 -File 跑）。
  paths: {
    toolboxRoot: __dirname.includes('app.asar')
      ? path.join(__dirname, '..', '..')
      : path.join(__dirname, '..'),
  },
});
