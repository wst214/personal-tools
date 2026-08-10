// Tauri 兼容层：把 Tauri 的 invoke 包装成 window.toolbox 同构 API。
// 让现有前端代码在 Tauri 下也能运行（isElectron=false 走 web 模式时靠 isTauri 识别）。
// 系统能力（SSH/SFTP/部署/Hosts/随手记文件等）由 Rust 命令实现。
// 触发时机：模块执行时立即尝试；若 __TAURI__ 注入较晚，则在 DOMContentLoaded 重试。
(function () {
  function initTauriToolbox() {
    if (!window.__TAURI__ || window.toolbox) return;
    const core = window.__TAURI__.core;
    const invoke = (core && core.invoke) ? core.invoke : async () => { throw new Error('tauri core 不可用'); };

    window.toolbox = {
      isElectron: false,
      isTauri: true,
      platform: 'win32',
      writeClipboard: (text) => {
        try {
          if (window.__TAURI__.clipboard && window.__TAURI__.clipboard.writeText) window.__TAURI__.clipboard.writeText(String(text ?? ''));
        } catch {}
      },
      readClipboard: () => '',
      http: (opts) => invoke('http_request', { url: opts.url, method: opts.method, headers: opts.headers, body: opts.body }).catch((e) => ({ ok: false, error: String(e) })),
      sysInfo: () => invoke('sys_info').catch((e) => ({ ok: false, error: String(e) })),
      portScan: (host, ports, timeout) => invoke('port_scan', { host, ports, timeout }).catch((e) => ({ ok: false, error: String(e) })),
      ipQuery: (ip) => invoke('ip_query', { ip }).catch((e) => ({ ok: false, error: String(e) })),
      translate: (payload) => invoke('translate', { text: payload.text, from: payload.from, to: payload.to }).catch((e) => ({ ok: false, error: String(e) })),
      hostsRead: () => invoke('hosts_read').catch((e) => ({ ok: false, error: String(e) })),
      hostsWrite: (content) => invoke('hosts_write', { content }).catch((e) => ({ ok: false, error: String(e) })),
      testhubEnsure: () => invoke('testhub_ensure').catch((e) => ({ ok: false, message: String(e) })),
      newapiEnsure: () => invoke('newapi_ensure').catch((e) => ({ ok: false, message: String(e) })),
      openExternal: (url) => invoke('open_external_url', { url }).catch((e) => ({ ok: false, error: String(e) })),
      notesList: () => invoke('notes_list').catch((e) => ({ ok: false, error: String(e) })),
      notesPickDir: () => invoke('notes_pick_dir').catch((e) => ({ ok: false, error: String(e) })),
      notesSetDefault: (dir) => invoke('notes_set_default', { dir }).catch((e) => ({ ok: false, error: String(e) })),
      notesReadFile: (filePath) => invoke('notes_read_file', { filePath }).catch((e) => ({ ok: false, error: String(e) })),
      notesSearch: (payload) => invoke('notes_search', { dir: payload.dir, query: payload.query, inBody: payload.inBody }).catch((e) => ({ ok: false, error: String(e), results: [] })),
      notesSave: (payload) => invoke('notes_save', { dir: payload.dir, title: payload.title, body: payload.body, oldPath: payload.oldPath }).catch((e) => ({ ok: false, error: String(e) })),
      notesCreate: (payload) => invoke('notes_create', { dir: payload.dir }).catch((e) => ({ ok: false, error: String(e) })),
      notesCreateDir: (payload) => invoke('notes_create_dir', { parent: payload.parent, name: payload.name }).catch((e) => ({ ok: false, error: String(e) })),
      notesDelete: (filePath) => invoke('notes_delete', { filePath }).catch((e) => ({ ok: false, error: String(e) })),
      notesRename: (payload) => invoke('notes_rename', { oldPath: payload.oldPath, title: payload.title }).catch((e) => ({ ok: false, error: String(e) })),
      notesReveal: (dir) => invoke('notes_reveal', { dir }).catch((e) => ({ ok: false, error: String(e) })),
      notesRead: () => invoke('notes_read').catch((e) => ({ ok: false, error: String(e) })),
      deploy: {
        list: () => invoke('deploy_list').then((r) => (r && r.ok ? r.tasks : [])).catch((e) => ({ ok: false, error: String(e) })),
        save: (task) => invoke('deploy_save', { task }).catch((e) => ({ ok: false, error: String(e) })),
        delete: (id) => invoke('deploy_delete', { id }).catch((e) => ({ ok: false, error: String(e) })),
        run: (id, overrides) => invoke('deploy_run', { id, overrides }).catch((e) => ({ ok: false, error: String(e) })),
        stop: () => invoke('deploy_stop').catch((e) => ({ ok: false, error: String(e) })),
        pickDir: () => invoke('deploy_pick_dir').catch((e) => ({ ok: false, error: String(e) })),
      },
      onDeployOutput: (cb) => {
        const un = window.__TAURI__.event?.listen ? window.__TAURI__.event.listen('deploy-output', (e) => cb(e.payload)) : () => {};
        return un;
      },
      ssh: {
        connect: (cfg) => invoke('ssh_connect', { host: cfg.host, port: cfg.port ? Number(cfg.port) : 22, username: cfg.username, password: cfg.password }).catch((e) => ({ ok: false, error: String(e) })),
        write: (id, data) => invoke('ssh_write', { id, data }).catch((e) => ({ ok: false, error: String(e) })),
        resize: (id, cols, rows) => invoke('ssh_resize', { id, cols: Number(cols) || 100, rows: Number(rows) || 30 }).catch((e) => ({ ok: false, error: String(e) })),
        disconnect: (id) => invoke('ssh_disconnect', { id }).catch((e) => ({ ok: false, error: String(e) })),
        list: () => invoke('ssh_list').catch((e) => ({ ok: false, error: String(e), sessions: [] })),
        sessionsLoad: () => invoke('ssh_sessions_load').catch((e) => ({ ok: false, error: String(e), sessions: [] })),
        sessionsSave: (sessions) => invoke('ssh_sessions_save', { sessions }).catch((e) => ({ ok: false, error: String(e) })),
        sysinfo: (id) => invoke('ssh_sysinfo', { id }).catch((e) => ({ ok: false, error: String(e) })),
      },
      sftp: {
        list: (id, path) => invoke('sftp_list', { id, path }).catch((e) => ({ ok: false, error: String(e) })),
        read: (id, path) => invoke('sftp_read', { id, path }).catch((e) => ({ ok: false, error: String(e) })),
        write: (id, path, content) => invoke('sftp_write', { id, path, content }).catch((e) => ({ ok: false, error: String(e) })),
        mkdir: (id, path) => invoke('sftp_mkdir', { id, path }).catch((e) => ({ ok: false, error: String(e) })),
        delete: (id, path, isDir) => invoke('sftp_delete', { id, path, isDir }).catch((e) => ({ ok: false, error: String(e) })),
        rename: () => Promise.resolve({ ok: false, error: '待实现' }),
      },
      fs: {
        // Tauri 插件：fs + dialog（SFTP 面板本地窗格用）
        listDir: async (dir) => {
          try {
            const f = window.__TAURI__.fs;
            const entries = await f.readDir(dir || '.');
            const items = entries.map((e) => ({
              name: e.name,
              isDir: e.isDirectory === true || e.children != null,
              size: e.size || 0,
              mtime: e.mtime ? new Date(e.mtime).getTime() : 0,
            })).sort((a, b) => (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1));
            return { ok: true, path: dir || '', items };
          } catch (e) { return { ok: false, error: String(e) }; }
        },
        pickDir: async () => {
          try {
            const d = window.__TAURI__.dialog;
            const sel = await d.open({ directory: true });
            if (sel === null) return { ok: false, canceled: true };
            return { ok: true, path: String(sel) };
          } catch (e) { return { ok: false, canceled: true, error: String(e) }; }
        },
        readFile: async (filePath) => {
          try {
            const f = window.__TAURI__.fs;
            const content = await f.readTextFile(filePath);
            return { ok: true, content: btoa(unescape(encodeURIComponent(content))), name: filePath.split(/[\\/]/).pop() };
          } catch (e) { return { ok: false, error: String(e) }; }
        },
        saveFile: async (filePath, content) => {
          try {
            const f = window.__TAURI__.fs;
            const text = decodeURIComponent(escape(atob(content || '')));
            await f.writeTextFile(filePath, text);
            return { ok: true };
          } catch (e) { return { ok: false, error: String(e) }; }
        },
      },
      onSshOutput: (cb) => {
        const un = window.__TAURI__.event?.listen ? window.__TAURI__.event.listen('ssh-output', (e) => cb(e.payload)) : () => {};
        return un;
      },
      paths: { toolboxRoot: '' },
    };
  }

  // 立即尝试 + DOMContentLoaded 兜底
  initTauriToolbox();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTauriToolbox);
  } else {
    initTauriToolbox();
  }
  // 额外兜底：稍后若 __TAURI__ 才出现
  setTimeout(initTauriToolbox, 500);
})();
