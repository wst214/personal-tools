import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { el } from '../ui/helpers.js';
import { svg } from './base.js';

// 终端窗口图标：描边风，currentColor 取色。
const ICON = svg('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 10l2.5 1.5L7 13M12.5 13h4"/>');
const COPY_ICON = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>');
const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const CONNECT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

// 存储抽象：桌面端走 IPC + safeStorage 加密；纯 Web 预览走 localStorage（终端/SFTP 禁用，仅主机表单可用）。
const electronApi = window.toolbox?.ssh;
const store = electronApi
  ? electronApi
  : {
      _key: 'toolbox-ssh-demo',
      _all() {
        return JSON.parse(localStorage.getItem(this._key) || '[]');
      },
      async list() {
        return this._all().map((h) => ({ ...h, hasPwd: !!h.passwordEnc }));
      },
      async save(host) {
        const arr = this._all();
        const item = { ...host };
        item.passwordEnc = item.password ? 'b64:' + btoa(unescape(encodeURIComponent(item.password))) : '';
        delete item.password;
        if (!item.id) item.id = 'h-' + Date.now();
        item.createdAt = item.createdAt || Date.now();
        const i = arr.findIndex((x) => x.id === item.id);
        if (i >= 0) arr[i] = { ...arr[i], ...item };
        else arr.push(item);
        localStorage.setItem(this._key, JSON.stringify(arr));
        return item.id;
      },
      async delete(id) {
        localStorage.setItem(this._key, JSON.stringify(this._all().filter((h) => h.id !== id)));
        return true;
      },
      async getPwd(id) {
        const h = this._all().find((x) => x.id === id);
        if (!h || !h.passwordEnc) return '';
        return h.passwordEnc.startsWith('b64:')
          ? decodeURIComponent(escape(atob(h.passwordEnc.slice(4))))
          : '';
      },
      async copyCmd(id) {
        const h = this._all().find((x) => x.id === id);
        if (!h) return { ok: false, msg: '主机不存在' };
        const cmd = sshCmd(h);
        try {
          await navigator.clipboard.writeText(cmd);
        } catch {}
        return { ok: true, cmd };
      },
      async genKey() {
        return { ok: false, msg: 'Web 预览不支持' };
      },
      async setupKeyless() {
        return { ok: false, msg: 'Web 预览不支持' };
      },
      async publicKey() {
        return '';
      },
      term: {
        connect: async () => ({ ok: false, msg: 'Web 预览不支持连接，请在桌面端使用' }),
        input() {}, resize() {}, disconnect() {},
        onData() { return () => {}; }, onClosed() { return () => {}; },
      },
      sftp: {
        list: async () => ({ path: '', items: [] }),
        upload() {}, download() {}, mkdir() {},
        onProgress() { return () => {}; },
      },
      local: { list: async () => ({ path: '', items: [] }), pickFile: async () => null, pickDir: async () => null },
    };

function sshCmd(h) {
  const port = h.port && Number(h.port) !== 22 ? ` -p ${h.port}` : '';
  return `ssh ${h.user}@${h.host}${port}`;
}

function blankHost() {
  return { id: '', name: '', host: '', port: 22, user: 'root', auth: 'key', password: '', note: '' };
}

function fmtSize(n) {
  if (!n) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)) + u[i];
}

// 终端配色：深色（catppuccin mocha 风），与浅色 app 区分，像真的终端。
const TERM_THEME = {
  background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
  blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
  brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
  brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
};

export const sshTool = {
  id: 'ssh',
  title: 'SSH 连接',
  icon: ICON,
  state: {
    hosts: [],
    selected: null, // 选中主机 id（编辑表单用）
    form: null, // 编辑缓冲（host 对象 + password 明文）
    query: '',
    mode: 'edit', // 'edit' | 'tabs'：编辑表单 / 终端标签
    tabs: [], // [{ tabId, hostId, name, term, fit }]
    activeTab: null, // 当前 tabId
    subview: 'term', // 'term' | 'files'：当前 tab 的子视图
    _sftpMsg: '',
  },
  // pane 实例单独存，不进 state（重绘不丢）：tabId -> { el, ... }
  _termPanes: new Map(),
  _filesPanes: new Map(),

  async render(container) {
    this.container = container;
    container.innerHTML = '';
    this.root = el('div', { class: 'ssh' });
    container.append(this.root);
    this._unsub = [
      store.term.onData((p) => this.onTermData(p)),
      store.term.onClosed((p) => this.onTermClosed(p)),
      store.sftp.onProgress((p) => this.onSftpProgress(p)),
    ];
    await this.refresh();
    this.paint();
  },

  onLeave() {
    this._unsub?.forEach((u) => u && u());
    this._unsub = null;
    // 断开所有 SSH 连接 + 释放 xterm，避免后台残留。
    for (const t of this.state.tabs) {
      if (t.tabId) store.term.disconnect(t.tabId).catch(() => {});
    }
    for (const [, p] of this._termPanes) {
      try { p.ro?.disconnect(); p.term?.dispose(); } catch {}
    }
    this._termPanes.clear();
    this._filesPanes.clear();
    this.state.tabs = [];
    this.state.activeTab = null;
  },

  async refresh() {
    this.state.hosts = await store.list();
  },

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const toolbar = el(
      'div',
      { class: 'ssh-toolbar' },
      el(
        'div',
        { class: 'search-box' },
        el('span', {
          class: 'search-icon',
          html: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.3 4.3"/></g></svg>',
        }),
        el('input', {
          type: 'text',
          placeholder: '搜索主机…',
          value: this.state.query,
          oninput: (e) => {
            this.state.query = e.target.value;
            this.paintList();
          },
        }),
      ),
      el('button', { class: 'btn', onclick: () => this.newHost() }, '+ 新建主机'),
    );

    this.listEl = el('div', { class: 'ssh-list' });
    this.tabbarEl = el('div', { class: 'ssh-tabbar' });
    this.formPane = el('div', { class: 'ssh-form-pane' });
    this.tabsPane = el('div', { class: 'ssh-tabs-pane' });
    const content = el('div', { class: 'ssh-content' }, this.formPane, this.tabsPane);
    const workspace = el('div', { class: 'ssh-workspace' }, this.tabbarEl, content);
    const body = el('div', { class: 'ssh-body' }, this.listEl, workspace);
    this.toastEl = el('div', { class: 'toast' });
    root.append(toolbar, body, this.toastEl);

    this.paintList();
    this.paintWorkspace();
  },

  paintList() {
    const list = this.listEl;
    list.innerHTML = '';
    const q = this.state.query.trim().toLowerCase();
    const hosts = this.state.hosts.filter(
      (h) =>
        !q ||
        (h.name || '').toLowerCase().includes(q) ||
        (h.host || '').toLowerCase().includes(q) ||
        (h.user || '').toLowerCase().includes(q),
    );
    if (!hosts.length) {
      list.append(el('div', { class: 'empty' }, this.state.query ? '没有匹配的主机' : '还没有主机，点「新建主机」'));
      return;
    }
    for (const h of hosts) {
      const active = h.id === this.state.selected;
      const port = h.port && Number(h.port) !== 22 ? `:${h.port}` : '';
      list.append(
        el(
          'div',
          { class: 'host-row' + (active ? ' active' : '') },
          el(
            'div',
            { class: 'host-main', onclick: () => this.selectHost(h.id) },
            el('div', { class: 'host-name' }, h.name || h.host || '(未命名)'),
            el('div', { class: 'host-meta' }, `${h.user}@${h.host}${port}`),
          ),
          el(
            'div',
            { class: 'host-actions' },
            el('span', { class: 'host-badge' + (h.auth === 'key' ? ' key' : ' pwd') }, h.auth === 'key' ? '免密' : '密码'),
            el('button', { class: 'host-connect', title: '连接', onclick: (e) => { e.stopPropagation(); this.openTab(h.id); }, html: CONNECT_ICON }),
          ),
        ),
      );
    }
  },

  // 右工作区：编辑模式显示表单；终端模式显示标签栏 + 终端/文件面板。
  paintWorkspace() {
    if (this.state.mode === 'edit' || !this.state.tabs.length) {
      this.state.mode = 'edit';
      this.tabbarEl.style.display = 'none';
      this.formPane.style.display = '';
      this.tabsPane.style.display = 'none';
      this.paintForm();
      return;
    }
    this.tabbarEl.style.display = '';
    this.formPane.style.display = 'none';
    this.tabsPane.style.display = '';
    this.paintTabbar();
    this.showPane();
  },

  paintTabbar() {
    const bar = this.tabbarEl;
    bar.innerHTML = '';
    for (const t of this.state.tabs) {
      bar.append(
        el(
          'div',
          { class: 'ssh-tab' + (t.tabId === this.state.activeTab ? ' active' : '') },
          el('span', { class: 'ssh-tab-name', onclick: () => this.switchTab(t.tabId) }, t.name),
          el('button', { class: 'ssh-tab-close', title: '关闭', onclick: (e) => { e.stopPropagation(); this.closeTab(t.tabId); } }, '✕'),
        ),
      );
    }
    bar.append(
      el('div', { class: 'ssh-subtabs' },
        el('button', { class: this.state.subview === 'term' ? 'active' : '', onclick: () => this.switchSubview('term') }, '终端'),
        el('button', { class: this.state.subview === 'files' ? 'active' : '', onclick: () => this.switchSubview('files') }, '文件'),
      ),
    );
  },

  // 切换当前 tab 的子视图 / 切 tab：隐藏所有面板，显示目标的（不存在则创建）。
  async showPane() {
    const tabId = this.state.activeTab;
    const sub = this.state.subview;
    if (!tabId) return;
    for (const [, p] of this._termPanes) p.el.style.display = 'none';
    for (const [, p] of this._filesPanes) p.el.style.display = 'none';

    if (sub === 'term') {
      let p = this._termPanes.get(tabId);
      if (!p) {
        const tab = this.state.tabs.find((t) => t.tabId === tabId);
        const paneEl = el('div', { class: 'term-pane' });
        this.tabsPane.append(paneEl);
        const term = new Terminal({
          fontFamily: 'Consolas, "Courier New", monospace',
          fontSize: 13,
          theme: TERM_THEME,
          cursorBlink: true,
          scrollback: 5000,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(paneEl);
        term.onData((d) => store.term.input(tabId, d));
        term.onResize(({ cols, rows }) => store.term.resize(tabId, cols, rows));
        const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
        ro.observe(paneEl);
        p = { el: paneEl, term, fit, ro };
        this._termPanes.set(tabId, p);
        if (tab) { tab.term = term; tab.fit = fit; }
      }
      p.el.style.display = '';
      requestAnimationFrame(() => { try { p.fit.fit(); p.term.focus(); } catch {} });
    } else {
      let p = this._filesPanes.get(tabId);
      if (!p) {
        const paneEl = el('div', { class: 'sftp-pane' });
        this.tabsPane.append(paneEl);
        p = { el: paneEl, localCwd: '', remoteCwd: '', localItems: [], remoteItems: [] };
        this._filesPanes.set(tabId, p);
        await this.loadLocal(tabId, '');
        await this.loadRemote(tabId, '.');
        return; // loadLocal/loadRemote 会 paintSftpPane
      }
      p.el.style.display = '';
    }
  },

  // ---- 终端数据流 ----
  onTermData({ tabId, data }) {
    const p = this._termPanes.get(tabId);
    if (p) p.term.write(data);
  },
  onTermClosed({ tabId, msg }) {
    const p = this._termPanes.get(tabId);
    if (p) p.term.write('\r\n\x1b[31m[连接已断开' + (msg ? '：' + msg : '') + ']\x1b[0m\r\n');
  },

  // ---- SFTP ----
  async loadLocal(tabId, dir) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    try {
      const r = await store.local.list(dir);
      p.localCwd = r.path;
      p.localItems = r.items;
    } catch (e) {
      this.toast('读取本地目录失败：' + (e.message || e), 'err');
    }
    this.paintSftpPane(tabId);
  },
  async loadRemote(tabId, dir) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    try {
      const r = await store.sftp.list(tabId, dir);
      p.remoteCwd = r.path;
      p.remoteItems = r.items;
    } catch (e) {
      this.toast('读取远程目录失败：' + (e.message || e), 'err');
    }
    this.paintSftpPane(tabId);
  },
  paintSftpPane(tabId) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    const paneEl = p.el;
    paneEl.innerHTML = '';
    const localCol = this.buildFileCol('本地', p.localCwd, p.localItems, {
      onChdir: (d) => this.loadLocal(tabId, d),
      onItemDblClick: (it) => {
        if (it.type === 'dir') this.loadLocal(tabId, p.localCwd + '/' + it.name);
      },
      onDrop: (data) => {
        if (data.kind === 'remote') this.doDownload(tabId, data.path, p.localCwd + '/' + data.name);
      },
      draggableItem: (it) => ({ kind: 'local', name: it.name, path: p.localCwd + '/' + it.name, type: it.type }),
    });
    const remoteCol = this.buildFileCol('远程', p.remoteCwd, p.remoteItems, {
      onChdir: (d) => this.loadRemote(tabId, d),
      onItemDblClick: (it) => {
        if (it.type === 'dir') this.loadRemote(tabId, p.remoteCwd + '/' + it.name);
        else this.doDownload(tabId, p.remoteCwd + '/' + it.name, '');
      },
      onDrop: (data) => {
        if (data.kind === 'local') this.doUpload(tabId, data.path, p.remoteCwd + '/' + data.name);
      },
      draggableItem: (it) => ({ kind: 'remote', name: it.name, path: p.remoteCwd + '/' + it.name, type: it.type }),
    });
    paneEl.append(el('div', { class: 'sftp-cols' }, localCol, remoteCol), el('div', { class: 'sftp-status' }, this.state._sftpMsg || '拖拽文件跨栏上传/下载，双击进入目录或下载文件'));
  },
  buildFileCol(label, cwd, items, opts) {
    const list = el('div', { class: 'file-list' });
    if (!items.length) list.append(el('div', { class: 'file-empty' }, '空'));
    for (const it of items) {
      const row = el(
        'div',
        { class: 'file-row' + (it.type === 'dir' ? ' dir' : ''), draggable: true },
        el('span', { class: 'file-icon', html: it.type === 'dir' ? FOLDER_ICON : FILE_ICON }),
        el('span', { class: 'file-name', text: it.name }),
        el('span', { class: 'file-size', text: it.type === 'dir' ? '' : fmtSize(it.size) }),
      );
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', JSON.stringify(opts.draggableItem(it)));
      });
      row.addEventListener('dblclick', () => opts.onItemDblClick(it));
      list.append(row);
    }
    const col = el(
      'div',
      {
        class: 'file-col',
        ondragover: (e) => { e.preventDefault(); col.classList.add('drop'); },
        ondragleave: () => col.classList.remove('drop'),
        ondrop: (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          const data = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
          opts.onDrop(data);
        },
      },
      el('div', { class: 'file-col-head' },
        el('span', { class: 'file-col-label' }, label),
        el('input', { class: 'file-path', value: cwd, onchange: (e) => opts.onChdir(e.target.value) }),
      ),
      list,
    );
    return col;
  },
  async doUpload(tabId, localPath, remotePath) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    try {
      this.state._sftpMsg = '上传中：' + localPath.split(/[\\/]/).pop();
      this.paintSftpPane(tabId);
      await store.sftp.upload(tabId, localPath, remotePath);
      this.state._sftpMsg = '已上传：' + remotePath.split('/').pop();
      await this.loadRemote(tabId, p.remoteCwd);
    } catch (e) {
      this.toast('上传失败：' + (e.message || e), 'err');
      this.state._sftpMsg = '';
      this.paintSftpPane(tabId);
    }
  },
  async doDownload(tabId, remotePath, localPath) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    if (!localPath) {
      const dir = await store.local.pickDir();
      if (!dir) return;
      localPath = (dir.replace(/[\\/]+$/, '')) + '/' + remotePath.split('/').pop();
    }
    try {
      this.state._sftpMsg = '下载中：' + remotePath.split('/').pop();
      this.paintSftpPane(tabId);
      await store.sftp.download(tabId, remotePath, localPath);
      this.state._sftpMsg = '已下载到：' + localPath;
      await this.loadLocal(tabId, p.localCwd);
    } catch (e) {
      this.toast('下载失败：' + (e.message || e), 'err');
      this.state._sftpMsg = '';
      this.paintSftpPane(tabId);
    }
  },
  onSftpProgress({ tabId, op, transferred, total, name }) {
    const p = this._filesPanes.get(tabId);
    if (!p) return;
    const pct = total ? Math.round((transferred / total) * 100) : 0;
    this.state._sftpMsg = `${op === 'upload' ? '上传' : '下载'} ${name} ${pct}%`;
    const status = p.el.querySelector('.sftp-status');
    if (status) status.textContent = this.state._sftpMsg;
  },

  // ---- 标签 / 子视图切换 ----
  async openTab(hostId) {
    const h = this.state.hosts.find((x) => x.id === hostId);
    if (!h) return;
    if (!h.host) { this.toast('主机地址为空，请先编辑保存', 'err'); return; }
    this.toast('正在连接 ' + (h.name || h.host) + '…');
    const r = await store.term.connect(hostId);
    if (!r.ok) { this.toast(r.msg || '连接失败', 'err'); return; }
    this.state.tabs.push({ tabId: r.tabId, hostId, name: r.name || h.name || h.host });
    this.state.activeTab = r.tabId;
    this.state.mode = 'tabs';
    this.state.subview = 'term';
    this.toast('');
    this.paintWorkspace();
  },
  async closeTab(tabId) {
    store.term.disconnect(tabId).catch(() => {});
    const p = this._termPanes.get(tabId);
    if (p) { try { p.ro.disconnect(); p.term.dispose(); } catch {} this._termPanes.delete(tabId); p.el.remove(); }
    const fp = this._filesPanes.get(tabId);
    if (fp) { this._filesPanes.delete(tabId); fp.el.remove(); }
    const i = this.state.tabs.findIndex((t) => t.tabId === tabId);
    if (i >= 0) this.state.tabs.splice(i, 1);
    if (this.state.activeTab === tabId) {
      this.state.activeTab = this.state.tabs.length ? this.state.tabs[this.state.tabs.length - 1].tabId : null;
    }
    if (!this.state.tabs.length) this.state.mode = 'edit';
    this.paintWorkspace();
  },
  switchTab(tabId) {
    this.state.activeTab = tabId;
    this.paintTabbar();
    this.showPane();
  },
  switchSubview(sub) {
    this.state.subview = sub;
    this.paintTabbar();
    this.showPane();
  },

  // ---- 主机编辑表单 ----
  async selectHost(id) {
    this.state.selected = id;
    this.state.mode = 'edit';
    const h = this.state.hosts.find((x) => x.id === id);
    if (!h) return;
    const password = await store.getPwd(id);
    this.state.form = { ...h, password };
    this.paintList();
    this.paintWorkspace();
  },
  newHost() {
    this.state.selected = null;
    this.state.form = blankHost();
    this.state.mode = 'edit';
    this.paintList();
    this.paintWorkspace();
  },
  paintForm() {
    const ed = this.formPane;
    ed.innerHTML = '';
    const f = this.state.form;
    if (!f) {
      ed.append(el('div', { class: 'empty' }, '选一台主机，或点「新建主机」'));
      return;
    }
    const isNew = !f.id;
    const text = (key, opts = {}) =>
      el('input', {
        type: opts.type || 'text',
        value: f[key] ?? '',
        placeholder: opts.placeholder || '',
        oninput: (e) => { f[key] = e.target.value; },
      });
    const field = (label, inp) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), inp);

    ed.append(
      el('div', { class: 'form-header' }, el('h3', { text: isNew ? '新建主机' : (f.name || f.host) })),
      field('别名', text('name', { placeholder: '如 跳板机' })),
      el('div', { class: 'field-row' },
        field('主机地址', text('host', { placeholder: '1.2.3.4' })),
        field('端口', text('port', { placeholder: '22' })),
      ),
      field('用户名', text('user', { placeholder: 'root' })),
      field('认证方式',
        el('div', { class: 'radio-row' },
          el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'auth', checked: f.auth === 'key' ? '' : null, onchange: () => { f.auth = 'key'; } }), '免密 key'),
          el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'auth', checked: f.auth === 'password' ? '' : null, onchange: () => { f.auth = 'password'; } }), '密码'),
        ),
      ),
      field('密码', el('input', { type: 'password', value: f.password || '', placeholder: '加密存储，忘了能查', oninput: (e) => { f.password = e.target.value; } })),
      field('备注', el('textarea', { class: 'field-area', placeholder: '这台机器是干啥的…', oninput: (e) => { f.note = e.target.value; } }, f.note || '')),
      el('div', { class: 'ssh-actions' },
        el('button', { class: 'btn', onclick: () => this.openTab(f.id) }, '连接'),
        el('button', { class: 'btn ghost', onclick: () => this.copyCmd() }, '复制命令'),
        el('button', { class: 'btn ghost', onclick: () => this.setupKeyless() }, '配置免密'),
        el('button', { class: 'btn primary', onclick: () => this.save() }, '保存'),
        !isNew ? el('button', { class: 'btn danger', onclick: () => this.deleteHost() }, '删除') : null,
      ),
    );
  },

  async save() {
    const f = this.state.form;
    if (!f) return;
    if (!f.host) { this.toast('请填主机地址', 'err'); return; }
    const toSave = { ...f };
    toSave.port = toSave.port ? Number(toSave.port) : 22;
    const id = await store.save(toSave);
    await this.refresh();
    await this.selectHost(id);
    this.toast('已保存');
  },
  async deleteHost() {
    const f = this.state.form;
    if (!f || !f.id) return;
    await store.delete(f.id);
    this.state.selected = null;
    this.state.form = null;
    await this.refresh();
    this.paintList();
    this.paintWorkspace();
    this.toast('已删除');
  },
  async copyCmd() {
    const f = this.state.form;
    if (!f) return;
    if (!f.id) { await this.copyText(sshCmd(f)); return; }
    const r = await store.copyCmd(f.id);
    this.toast(r.ok ? `已复制：${r.cmd}` : r.msg, r.ok ? '' : 'err');
  },
  async setupKeyless() {
    const f = this.state.form;
    if (!f || !f.id) { this.toast('请先保存主机', 'err'); return; }
    const r = await store.setupKeyless(f.id);
    if (r.ok) this.toast('命令已复制，粘到终端执行一次即可免密');
    else this.toast(r.msg || '失败', 'err');
  },

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('已复制');
      return;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        this.toast('已复制');
      } catch {
        this.toast('复制失败', 'err');
      }
    }
  },

  toast(msg, type = '') {
    this.toastEl.textContent = msg;
    this.toastEl.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toastEl.className = 'toast'; }, 2200);
  },
};
