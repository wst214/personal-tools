import { el, btn, toast } from '../ui/helpers.js';

// xterm 按需加载，避免启动时拉入整包
let _xtermMod = null;
async function loadXterm() {
  if (_xtermMod) return _xtermMod;
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  _xtermMod = { Terminal, FitAddon };
  return _xtermMod;
}

// SSH 会话存储：优先写到 Tauri 配置目录（跨壳/重装 WebView 不丢），并回写 localStorage 作缓存。
const LS_KEY = 'devtool-ssh-sessions';
const loadSessionsSync = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } };
async function loadSessions() {
  const api = window.toolbox?.ssh;
  if (api?.sessionsLoad) {
    try {
      const r = await api.sessionsLoad();
      if (r?.ok && Array.isArray(r.sessions)) {
        if (!r.sessions.length) {
          const legacy = loadSessionsSync();
          if (legacy.length) {
            await api.sessionsSave(legacy);
            return legacy;
          }
        }
        localStorage.setItem(LS_KEY, JSON.stringify(r.sessions));
        return r.sessions;
      }
    } catch {}
  }
  return loadSessionsSync();
}
async function saveSessions(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
  try { await window.toolbox?.ssh?.sessionsSave?.(s); } catch {}
}

// xterm 主题：跟随应用深/浅色（读 CSS 变量，取不到用默认深色）。
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => {
    const val = cs.getPropertyValue(name).trim();
    return val || fallback;
  };
  return {
    background: v('--surface', '#151b18'),
    foreground: v('--text', '#e7efe9'),
    cursor: v('--accent', '#34d399'),
    selectionBackground: v('--accent-soft', 'rgba(52,211,153,0.3)'),
  };
}

const svg = (content) => `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${content}</g></svg>`;

export const sshTool = {
  id: 'ssh',
  name: 'SSH 终端',
  category: '网络',
  icon: svg('<path d="M4 6h16M4 12h16M4 18h10"/><path d="m19 16 2.5 2.5L19 21"/>'),
  keywords: 'ssh terminal shell linux 远程 终端',
  desc: 'SSH 远程终端连接（支持多会话）',

  render(container) {
    this.container = container;

    // 切回工具：复用驻留的 DOM + xterm，保留滚动缓冲与连接
    if (this._parked) {
      const parked = this._parked;
      this._parked = null;
      Object.assign(this, parked.refs);
      container.appendChild(parked.root);
      this.root = parked.root;
      if (!this._offOutput && window.toolbox?.onSshOutput) {
        this._offOutput = window.toolbox.onSshOutput((msg) => this.onSshMsg(msg));
      }
      this._reconcileSessions().then(() => {
        const active = this.tabs.find((t) => t.id === this.activeTabId) || this.tabs.find((t) => t.status !== 'closed') || this.tabs[0];
        if (active) {
          this.activateTab(active.id);
          try {
            active.fitAddon?.fit();
            window.toolbox?.ssh?.resize(active.id, active.term.cols, active.term.rows);
            active.term?.focus();
          } catch {}
        }
      });
      return () => this.onLeave();
    }

    container.innerHTML = '';
    this.root = el('div', { class: 'ssh-app' });
    container.append(this.root);

    // 多会话：tabs 数组，每个元素 { id, name, user, host, term, fitAddon, boxEl, cleanup }
    this.tabs = [];
    this.activeTabId = null;
    this.sessions = loadSessionsSync();
    this.selected = null;

    this.paint();
    if (window.toolbox?.onSshOutput) {
      this._offOutput = window.toolbox.onSshOutput((msg) => this.onSshMsg(msg));
    }
    // 从配置文件拉全量保存连接（含从 localStorage 迁移）
    loadSessions().then((sessions) => {
      this.sessions = sessions;
      this.paintListRefresh();
    });
    // 切回工具时恢复存活的 SSH 连接（首次进入或冷启动）
    this.restoreSessions();
    return () => this.onLeave();
  },

  onLeave() {
    // 驻留 UI：不 dispose xterm、不断开 SSH，只从 DOM 卸下
    if (!this.root) return;
    this._parked = {
      root: this.root,
      refs: {
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        sessions: this.sessions,
        selected: this.selected,
        tabsBar: this.tabsBar,
        formEl: this.formEl,
        termWrap: this.termWrap,
        termBoxes: this.termBoxes,
        listEl: this.listEl,
        _fields: this._fields,
        _form: this._form,
        _offOutput: this._offOutput,
      },
    };
    // 保持输出监听，后台仍写入驻留终端缓冲
    if (this.root.parentNode) this.root.remove();
  },

  async _reconcileSessions() {
    if (!window.toolbox?.ssh?.list) return;
    const r = await window.toolbox.ssh.list();
    const alive = new Set((r.ok && r.sessions ? r.sessions : []).map((s) => s.id));
    for (const tab of this.tabs) {
      if (tab.status === 'closed') continue;
      if (!alive.has(tab.id)) {
        tab.status = 'closed';
        this.paintTabStatus(tab, '已断开');
      }
    }
  },

  // 从主进程恢复存活的连接（无驻留态时的冷恢复）
  async restoreSessions() {
    if (!window.toolbox?.ssh?.list) return;
    const r = await window.toolbox.ssh.list();
    if (!r.ok || !r.sessions?.length) return;
    for (const s of r.sessions) {
      if (this.tabs.some((t) => t.id === s.id)) continue;
      const tab = await this.createTab(s.id, s.name || s.host, s.user || '', s.host || '');
      if (tab?.term) {
        tab.term.writeln('\x1b[90m── 会话已恢复（历史输出未缓存；按回车继续）──\x1b[0m');
      }
    }
    if (this.tabs.length) {
      this.activateTab(this.tabs[this.tabs.length - 1].id);
    }
  },

  onSshMsg(msg) {
    // 按 sessionId 分发到对应 tab
    const tab = this.tabs.find((t) => t.id === msg.id);
    if (!tab) return;
    if (msg.type === 'data') {
      tab.term?.write(msg.data);
    } else if (msg.type === 'closed') {
      tab.status = 'closed';
      this.paintTabStatus(tab, '已断开');
    }
  },

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const left = el('div', { class: 'ssh-sidebar' });
    const right = el('div', { class: 'ssh-main' });

    // ---- 左侧：保存的连接列表 ----
    const list = el('div', { class: 'ssh-list' });
    this.listEl = list;

    const newBtn = btn('＋ 新建连接', () => {
      this.selected = null;
      this.fillForm(null);
      this.paintListRefresh();
    }, { variant: 'primary' });

    left.append(
      el('div', { class: 'ssh-sidebar-head', text: '连接' }),
      newBtn,
      list,
    );

    // ---- 右侧：标签栏 + 内容区 ----
    this.tabsBar = el('div', { class: 'ssh-tabs' });
    this.formEl = el('div', { class: 'ssh-form' });
    this.termWrap = el('div', { class: 'ssh-term-wrap' });
    // 内容区：包含所有 tab 的终端盒子（激活的显示，其它隐藏）
    this.termBoxes = el('div', { class: 'ssh-term-boxes' });

    right.append(this.tabsBar, this.formEl, this.termBoxes);
    // 初始无 tab：隐藏终端容器
    this.termBoxes.style.display = 'none';

    root.append(left, right);
    this.paintForm();
    this.paintListRefresh();
    this.paintTabs();
  },

  // ---- 标签栏 ----
  paintTabs() {
    if (!this.tabsBar) return;
    this.tabsBar.innerHTML = '';

    if (!this.tabs.length) {
      this.tabsBar.style.display = 'none';
      return;
    }
    this.tabsBar.style.display = 'flex';

    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeTabId;
      const tabBtn = el('button', {
        class: 'ssh-tab' + (isActive ? ' active' : ''),
        type: 'button',
        onclick: () => this.activateTab(tab.id),
        title: `${tab.user}@${tab.host}`,
      }, [
        el('span', { class: 'ssh-tab-dot' + (tab.status === 'closed' ? ' closed' : '') }),
        el('span', { class: 'ssh-tab-name', text: tab.name }),
        el('span', {
          class: 'ssh-tab-close',
          text: '×',
          onclick: (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
          },
        }),
      ]);
      this.tabsBar.append(tabBtn);
    }

    // 新建连接按钮
    const addBtn = btn('＋', () => {
      this.selected = null;
      this.showForm();
      this.paintListRefresh();
    }, { variant: 'ghost' });
    addBtn.classList.add('ssh-tab-add');
    this.tabsBar.append(addBtn);
  },

  paintTabStatus(tab, text) {
    tab.status = text === 'closed' ? 'closed' : tab.status;
    // 更新 tab 上的状态点
    const bar = this.tabsBar;
    if (!bar) return;
    const btns = bar.querySelectorAll('.ssh-tab');
    for (const b of btns) {
      if (b.title?.includes(`${tab.user}@${tab.host}`)) {
        const dot = b.querySelector('.ssh-tab-dot');
        if (dot) dot.classList.toggle('closed', tab.status === 'closed');
      }
    }
  },

  activateTab(id) {
    this.activeTabId = id;
    // 隐藏表单，显示终端
    this.formEl.style.display = 'none';
    this.termBoxes.style.display = 'flex';
    // 只显示激活 tab 的盒子
    for (const tab of this.tabs) {
      const visible = tab.id === id;
      tab.boxEl.style.display = visible ? 'flex' : 'none';
      if (visible && tab.fitAddon) {
        try {
          tab.fitAddon.fit();
          window.toolbox?.ssh?.resize(tab.id, tab.term.cols, tab.term.rows);
          tab.term.focus();
        } catch {}
      }
    }
    this.paintTabs();
  },

  closeTab(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    try { window.toolbox?.ssh?.disconnect(id); } catch {}
    try { tab.cleanup?.(); } catch {}
    try { tab.term?.dispose(); } catch {}
    tab.boxEl.remove();
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activeTabId = next ? next.id : null;
    }
    if (this.activeTabId) {
      this.activateTab(this.activeTabId);
    } else {
      this.formEl.style.display = '';
      this.termBoxes.style.display = 'none';
    }
    this.paintTabs();
  },

  showForm() {
    this.activeTabId = null;
    this.formEl.style.display = '';
    this.termBoxes.style.display = 'none';
    for (const tab of this.tabs) tab.boxEl.style.display = 'none';
    this.paintTabs();
  },
  // ---- 表单 ----
  formFields() {
    const name = el('input', { class: 'input', placeholder: '服务器名（如 生产环境）', value: this._form?.name || '' });
    const host = el('input', { class: 'input', placeholder: '192.168.1.100', value: this._form?.host || '' });
    const port = el('input', { class: 'input', placeholder: '22', value: this._form?.port || '22', type: 'number' });
    const username = el('input', { class: 'input', placeholder: 'root', value: this._form?.username || '' });
    const password = el('input', { class: 'input', placeholder: '密码（已保存，留空用上次的）', value: this._form?.password || '', type: 'password' });
    const privateKey = el('input', { class: 'input', placeholder: '私钥路径（可选）D:\\keys\\id_rsa', value: this._form?.privateKeyPath || '' });
    this._fields = { name, host, port, username, password, privateKey };
    return this._fields;
  },

  fillForm(s) {
    this._form = s ? { ...s } : null;
    this.paintForm();
    this.showForm();
  },

  paintForm() {
    if (!this.formEl) return;
    this.formEl.innerHTML = '';
    const f = this.formFields();

    const connect = btn('连接', async () => {
      if (!window.toolbox?.ssh) { toast('SSH 需在桌面端运行', 'error'); return; }
      const cfg = {
        name: f.name.value.trim(),
        host: f.host.value.trim(),
        port: f.port.value.trim() || '22',
        username: f.username.value.trim(),
        password: f.password.value,
        privateKeyPath: f.privateKey.value.trim(),
      };
      if (!cfg.host) { toast('请输入主机', 'warn'); return; }
      if (!cfg.username) { toast('请输入用户名', 'warn'); return; }
      if (!cfg.password && !cfg.privateKeyPath) { toast('请输入密码或私钥', 'warn'); return; }
      connect.disabled = true;
      connect.textContent = '连接中…';
      const r = await window.toolbox.ssh.connect(cfg);
      connect.disabled = false;
      connect.textContent = '连接';
      if (!r.ok) { toast('连接失败：' + r.error, 'error'); return; }

      // 保存会话（含密码）
      const name = f.name.value.trim() || f.host.value.trim();
      const existing = this.sessions.find((s) => s.host === cfg.host && s.username === cfg.username && s.port === cfg.port);
      const session = {
        id: existing?.id || 's-' + Date.now(),
        name, host: cfg.host, port: cfg.port, username: cfg.username,
        password: f.password.value, privateKeyPath: cfg.privateKeyPath,
      };
      if (existing) {
        const idx = this.sessions.findIndex((x) => x.id === existing.id);
        if (!session.password) session.password = this.sessions[idx].password || '';
        this.sessions[idx] = { ...this.sessions[idx], ...session };
      } else {
        this.sessions.push(session);
      }
      saveSessions(this.sessions);
      this.selected = session.id;
      this.paintListRefresh();

      // 新建 tab + 终端
      await this.createTab(r.id, name, cfg.username, cfg.host);
    }, { variant: 'primary' });

    const save = btn('保存配置', () => {
      const cfg = {
        name: f.name.value.trim() || f.host.value.trim(),
        host: f.host.value.trim(),
        port: f.port.value.trim() || '22',
        username: f.username.value.trim(),
        password: f.password.value,
        privateKeyPath: f.privateKey.value.trim(),
      };
      if (!cfg.host || !cfg.username) { toast('请填主机和用户名', 'warn'); return; }
      const existing = this.sessions.find((s) => s.host === cfg.host && s.username === cfg.username && s.port === cfg.port);
      if (existing) {
        const idx = this.sessions.findIndex((x) => x.id === existing.id);
        if (!cfg.password) cfg.password = this.sessions[idx].password || '';
        this.sessions[idx] = { ...this.sessions[idx], ...cfg };
      } else {
        this.sessions.push({ id: 's-' + Date.now(), ...cfg });
      }
      saveSessions(this.sessions);
      this.paintListRefresh();
      toast('已保存');
    });

    this.formEl.append(
      el('div', { class: 'ssh-form-title', text: this._form ? '编辑连接' : '新建连接' }),
      el('div', { class: 'ssh-form-grid' }, [
        el('div', { class: 'field', style: { gridColumn: '1 / -1' } }, [el('label', { text: '服务器名' }), f.name]),
        el('div', { class: 'field' }, [el('label', { text: '主机' }), f.host]),
        el('div', { class: 'field' }, [el('label', { text: '端口' }), f.port]),
        el('div', { class: 'field' }, [el('label', { text: '用户名' }), f.username]),
        el('div', { class: 'field' }, [el('label', { text: '密码' }), f.password]),
        el('div', { class: 'field', style: { gridColumn: '1 / -1' } }, [el('label', { text: '私钥路径' }), f.privateKey]),
      ]),
      el('div', { class: 'ssh-form-actions' }, [connect, save]),
    );
  },

  // ---- 左侧列表 ----
  paintListRefresh() {
    const list = this.listEl;
    if (!list) return;
    list.innerHTML = '';
    const sessions = this.sessions;
    if (!sessions.length) {
      list.append(el('div', { class: 'ssh-list-empty', text: '还没有保存的连接' }));
      return;
    }
    sessions.forEach((s) => {
      list.append(el('button', {
        class: 'ssh-item' + (this.selected === s.id ? ' active' : ''),
        type: 'button',
        onclick: () => {
          this.selected = s.id;
          this.paintListRefresh();
          this.fillForm(s);
        },
      }, [
        el('div', { class: 'ssh-item-name', text: s.name || s.host }),
        el('div', { class: 'ssh-item-host', text: `${s.username}@${s.host}:${s.port || 22}` }),
        el('button', {
          class: 'ssh-item-del',
          type: 'button',
          title: '删除',
          text: '×',
          onclick: (e) => {
            e.stopPropagation();
            this.sessions = this.sessions.filter((x) => x.id !== s.id);
            if (this.selected === s.id) { this.selected = null; this.fillForm(null); }
            saveSessions(this.sessions);
            this.paintListRefresh();
          },
        }),
      ]));
    });
  },

  // ---- 创建 tab + 终端 ----
  async createTab(sessionId, name, user, host) {
    const { Terminal, FitAddon } = await loadXterm();
    // 终端盒子
    const sftpBtn = btn('文件', () => this.toggleSftp(sessionId), { variant: 'ghost' });
    const infoBtn = btn('系统信息', () => this.toggleSysInfo(sessionId), { variant: 'ghost' });
    const bar = el('div', { class: 'ssh-term-bar' }, [
      el('div', { class: 'ssh-term-status' }, [
        el('span', { class: 'ssh-term-dot' }),
        el('span', { class: 'ssh-term-status-text', text: `${user}@${host}` }),
      ]),
      el('div', { class: 'ssh-term-host', text: name }),
      infoBtn,
      sftpBtn,
      el('button', { class: 'btn ghost', type: 'button', onclick: () => this.closeTab(sessionId) }, '断开'),
    ]);
    const termBox = el('div', { class: 'ssh-term-box' });
    const infoPanel = el('div', { class: 'ssh-sysinfo' });
    const boxEl = el('div', { class: 'ssh-tab-pane' }, [bar, infoPanel, termBox]);
    this.termBoxes.append(boxEl);

    const tab = { id: sessionId, name, user, host, term: null, fitAddon: null, boxEl, sftpBtn, infoBtn, infoPanel, sftpPath: '/', status: 'connected', cleanup: null };
    this.tabs.push(tab);
    this._curTab = tab;

    // xterm
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: termTheme(),
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termBox);
    fit.fit();

    // 补充 term/fitAddon 到 tab
    tab.term = term;
    tab.fitAddon = fit;

    // 输入 -> IPC
    term.onData((data) => {
      window.toolbox?.ssh?.write(sessionId, data);
    });

    // 窗口 resize 时自适应当前激活 tab
    const onResize = () => {
      if (this.activeTabId === sessionId) {
        try {
          fit.fit();
          window.toolbox.ssh.resize(sessionId, term.cols, term.rows);
        } catch {}
      }
    };
    window.addEventListener('resize', onResize);
    tab.cleanup = () => window.removeEventListener('resize', onResize);

    // 首次同步尺寸
    setTimeout(() => {
      try {
        fit.fit();
        window.toolbox.ssh.resize(sessionId, term.cols, term.rows);
      } catch {}
    }, 300);

    // 激活该 tab
    this.activeTabId = sessionId;
    this.formEl.style.display = 'none';
    this.termBoxes.style.display = 'flex';
    for (const t of this.tabs) t.boxEl.style.display = t.id === sessionId ? 'flex' : 'none';
    this.paintTabs();
    term.focus();
    return tab;
  },

  // ---- SFTP 文件浏览器 ----
  // ---- 服务器系统信息 ----
  toggleSysInfo(sessionId) {
    const tab = this.tabs.find((t) => t.id === sessionId);
    if (!tab) return;
    const visible = tab.infoPanel.classList.contains('open');
    if (visible) {
      tab.infoPanel.classList.remove('open');
      tab.infoPanel.style.display = 'none';
      tab.infoBtn.classList.remove('active');
      this._fitTerm(tab);
    } else {
      tab.infoPanel.classList.add('open');
      tab.infoPanel.style.display = 'block';
      tab.infoBtn.classList.add('active');
      this.renderSysInfo(tab);
    }
  },

  async renderSysInfo(tab) {
    const panel = tab.infoPanel;
    if (!panel) return;
    panel.innerHTML = '';
    panel.append(el('div', { class: 'ssh-sysinfo-loading', text: '正在采集系统信息…' }));
    const r = await window.toolbox?.ssh?.sysinfo(tab.id);
    if (!r?.ok) {
      panel.innerHTML = '';
      panel.append(el('div', { class: 'ssh-sysinfo-empty', text: '采集失败：' + (r?.error || '未知错误') }));
      return;
    }
    const i = r.info;
    panel.innerHTML = '';

    // ---- 顶部：概览卡 ----
    const overview = el('div', { class: 'ssh-sysinfo-overview' }, [
      el('div', { class: 'ssh-sysinfo-host' }, [
        el('div', { class: 'ssh-sysinfo-hostname', text: i.hostname }),
        el('div', { class: 'ssh-sysinfo-os', text: i.os }),
        el('div', { class: 'ssh-sysinfo-sub', text: `${i.kernel} ${i.arch} · IP ${i.ip}` }),
      ]),
      el('div', { class: 'ssh-sysinfo-uptime' }, [
        el('div', { class: 'ssh-sysinfo-uptime-val', text: i.uptime }),
        el('div', { class: 'ssh-sysinfo-uptime-label', text: '运行时长' }),
      ]),
      el('div', { class: 'ssh-sysinfo-load' }, [
        el('div', { class: 'ssh-sysinfo-load-val', text: i.load.split(' ').slice(0, 2).join(' ') }),
        el('div', { class: 'ssh-sysinfo-load-label', text: '负载 (1m 5m)' }),
      ]),
    ]);

    // ---- 指标条卡 ----
    const gauge = (label, pct, color, extra) => el('div', { class: 'ssh-sysinfo-gauge' }, [
      el('div', { class: 'ssh-sysinfo-gauge-head' }, [
        el('span', { class: 'ssh-sysinfo-gauge-label', text: label }),
        el('span', { class: 'ssh-sysinfo-gauge-val', text: extra || (pct + '%') }),
      ]),
      el('div', { class: 'ssh-sysinfo-bar' }, [
        el('div', { class: 'ssh-sysinfo-bar-fill', style: { width: Math.min(100, Math.max(0, pct)) + '%', background: color } }),
      ]),
    ]);

    const gauges = el('div', { class: 'ssh-sysinfo-gauges' }, [
      gauge('CPU 使用率', i.cpuUsage, 'var(--accent-grad)', `${i.cpuUsage}% · ${i.cpuCores} 核`),
      gauge('内存使用', i.mem?.usedPercent || 0, 'linear-gradient(135deg,#f59e0b,#f97316)', this.fmtSize((i.mem?.used || 0) * 1024 * 1024) + ' / ' + this.fmtSize((i.mem?.total || 0) * 1024 * 1024)),
      gauge('磁盘使用', Number(i.disk?.percent) || 0, 'linear-gradient(135deg,#3b82f6,#6366f1)', `${this.fmtSize(Number(i.disk?.used || 0) * 1024)} / ${this.fmtSize(Number(i.disk?.total || 0) * 1024)}`),
    ]);

    // ---- 硬件详情网格 ----
    const details = el('div', { class: 'ssh-sysinfo-grid' }, [
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: 'CPU 型号' }), el('div', { class: 'ssh-sysinfo-cell-val', text: i.cpuModel || '—' })]),
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: 'CPU 核数' }), el('div', { class: 'ssh-sysinfo-cell-val', text: i.cpuCores + ' 核' })]),
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: '内核版本' }), el('div', { class: 'ssh-sysinfo-cell-val', text: i.kernel || '—' })]),
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: '架构' }), el('div', { class: 'ssh-sysinfo-cell-val', text: i.arch || '—' })]),
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: '内存总量' }), el('div', { class: 'ssh-sysinfo-cell-val', text: this.fmtSize((i.mem?.total || 0) * 1024 * 1024) })]),
      el('div', { class: 'ssh-sysinfo-cell' }, [el('div', { class: 'ssh-sysinfo-cell-label', text: '磁盘总量' }), el('div', { class: 'ssh-sysinfo-cell-val', text: this.fmtSize(Number(i.disk?.total || 0) * 1024) })]),
    ]);

    // 刷新按钮
    const refreshBtn = btn('刷新', () => this.renderSysInfo(tab), { variant: 'ghost' });
    refreshBtn.classList.add('ssh-sysinfo-refresh');

    panel.append(overview, gauges, details, refreshBtn);
  },

  getSftpTab() {
    return this.tabs.find((t) => t.id === this._curTab?.id) || this.tabs[0];
  },

  // 打开/关闭 SFTP 浮层（双栏：本地 ↔ 服务器）
  toggleSftp(sessionId) {
    if (this.sftpOverlay) {
      this.closeSftpOverlay();
      return;
    }
    const tab = this.tabs.find((t) => t.id === sessionId);
    if (!tab) return;
    this.sftpTab = tab;
    tab.sftpPath = tab.sftpPath || '/';
    this.sftpLocalPath = this.sftpLocalPath || '';

    // 浮层
    const overlay = el('div', { class: 'sftp-overlay', onclick: (e) => { if (e.target === overlay) this.closeSftpOverlay(); } });
    const modal = el('div', { class: 'sftp-modal', onclick: (e) => e.stopPropagation() });

    // 头部
    const head = el('div', { class: 'sftp-head' }, [
      el('div', { class: 'sftp-title', text: `文件传输 — ${tab.name} (${tab.user}@${tab.host})` }),
      el('button', { class: 'sftp-close', text: '×', onclick: () => this.closeSftpOverlay() }),
    ]);

    // 左：本地
    this.localPane = el('div', { class: 'sftp-pane' });
    // 右：服务器
    this.remotePane = el('div', { class: 'sftp-pane' });
    const body = el('div', { class: 'sftp-body' }, [this.localPane, this.remotePane]);

    this.sftpOverlay = overlay;
    overlay.append(modal);
    modal.append(head, body);
    document.body.appendChild(overlay);

    this.renderLocalPane();
    this.renderRemotePane();

    // Esc 关闭
    this._sftpEsc = (e) => { if (e.key === 'Escape') this.closeSftpOverlay(); };
    document.addEventListener('keydown', this._sftpEsc);
  },

  closeSftpOverlay() {
    if (this.sftpOverlay) {
      this.sftpOverlay.remove();
      this.sftpOverlay = null;
      this.sftpTab = null;
      this.localPane = null;
      this.remotePane = null;
    }
    if (this._sftpEsc) {
      document.removeEventListener('keydown', this._sftpEsc);
      this._sftpEsc = null;
    }
    // 恢复终端 focus
    if (this.activeTabId) {
      const tab = this.tabs.find((t) => t.id === this.activeTabId);
      tab?.term?.focus();
    }
  },

  // 本地目录渲染
  renderLocalPane() {
    const pane = this.localPane;
    if (!pane) return;
    pane.innerHTML = '';
    const tab = this.sftpTab;
    if (!tab) return;

    const pathInput = el('input', { class: 'input sftp-path', value: this.sftpLocalPath || 'C:\\', onkeydown: (e) => { if (e.key === 'Enter') { this.sftpLocalPath = pathInput.value; this.renderLocalPane(); } } });
    const pickBtn = btn('选择目录', async () => {
      const r = await window.toolbox?.fs?.pickDir();
      if (r?.ok) { this.sftpLocalPath = r.path; this.renderLocalPane(); }
    }, { variant: 'ghost' });
    const upBtn = btn('↑', () => {
      this.sftpLocalPath = this.parentPath(this.sftpLocalPath);
      this.renderLocalPane();
    }, { variant: 'ghost' });
    const refreshBtn = btn('刷新', () => this.renderLocalPane(), { variant: 'ghost' });

    const toolbar = el('div', { class: 'sftp-toolbar' }, [upBtn, pathInput, pickBtn, refreshBtn]);
    const listEl = el('div', { class: 'sftp-list' });
    listEl.append(el('div', { class: 'sftp-loading', text: '加载中…' }));
    pane.append(el('div', { class: 'sftp-pane-title', text: '本地' }), toolbar, listEl);

    window.toolbox?.fs?.listDir(this.sftpLocalPath).then((r) => {
      listEl.innerHTML = '';
      if (!r.ok) { listEl.append(el('div', { class: 'sftp-empty', text: '加载失败：' + r.error })); return; }
      this.sftpLocalPath = r.path;
      pathInput.value = r.path;
      if (!r.items.length) { listEl.append(el('div', { class: 'sftp-empty', text: '空目录' })); return; }
      for (const it of r.items) {
        const row = el('div', { class: 'sftp-row' + (it.isDir ? ' dir' : '') }, [
          el('span', { class: 'sftp-icon', text: it.isDir ? '📁' : '📄' }),
          el('span', { class: 'sftp-name', text: it.name, title: it.name }),
          el('span', { class: 'sftp-size', text: it.isDir ? '—' : this.fmtSize(it.size) }),
          el('span', { class: 'sftp-actions' }, [
            it.isDir ? btn('上传目录', () => this.localUploadDir(tab, it.name), { variant: 'ghost' }) : btn('上传', () => this.localUpload(tab, it.name), { variant: 'primary' }),
          ]),
        ]);
        if (it.isDir) {
          row.onclick = (e) => {
            if (e.target.closest('.sftp-actions')) return;
            this.sftpLocalPath = this.joinPath(this.sftpLocalPath, it.name);
            this.renderLocalPane();
          };
        }
        listEl.append(row);
      }
    });
  },

  // 服务器目录渲染
  renderRemotePane() {
    const pane = this.remotePane;
    if (!pane) return;
    pane.innerHTML = '';
    const tab = this.sftpTab;
    if (!tab) return;

    const pathInput = el('input', { class: 'input sftp-path', value: tab.sftpPath, onkeydown: (e) => { if (e.key === 'Enter') { tab.sftpPath = pathInput.value; this.renderRemotePane(); } } });
    const upBtn = btn('↑', () => {
      tab.sftpPath = this.parentPath(tab.sftpPath);
      this.renderRemotePane();
    }, { variant: 'ghost' });
    const refreshBtn = btn('刷新', () => this.renderRemotePane(), { variant: 'ghost' });
    const mkdirBtn = btn('新建文件夹', () => this.sftpMkdir(tab), { variant: 'ghost' });

    const toolbar = el('div', { class: 'sftp-toolbar' }, [upBtn, pathInput, refreshBtn, mkdirBtn]);
    const listEl = el('div', { class: 'sftp-list' });
    listEl.append(el('div', { class: 'sftp-loading', text: '加载中…' }));
    pane.append(el('div', { class: 'sftp-pane-title', text: '服务器' }), toolbar, listEl);

    window.toolbox?.sftp?.list(tab.id, tab.sftpPath).then((r) => {
      listEl.innerHTML = '';
      if (!r.ok) { listEl.append(el('div', { class: 'sftp-empty', text: '加载失败：' + r.error })); return; }
      if (!r.items.length) { listEl.append(el('div', { class: 'sftp-empty', text: '空目录' })); return; }
      for (const it of r.items) {
        const row = el('div', { class: 'sftp-row' + (it.isDir ? ' dir' : '') }, [
          el('span', { class: 'sftp-icon', text: it.isDir ? '📁' : '📄' }),
          el('span', { class: 'sftp-name', text: it.name, title: it.name }),
          el('span', { class: 'sftp-size', text: it.isDir ? '—' : this.fmtSize(it.size) }),
          el('span', { class: 'sftp-actions' }, [
            it.isDir ? null : btn('下载', () => this.sftpDownload(tab, it.name), { variant: 'primary' }),
            it.isDir ? null : btn('删除', () => this.sftpDelete(tab, it.name, false), { variant: 'ghost' }),
            it.isDir ? btn('删除', () => this.sftpDelete(tab, it.name, true), { variant: 'ghost' }) : null,
          ]),
        ]);
        if (it.isDir) {
          row.onclick = (e) => {
            if (e.target.closest('.sftp-actions')) return;
            tab.sftpPath = this.joinPath(tab.sftpPath, it.name);
            this.renderRemotePane();
          };
        }
        listEl.append(row);
      }
    });
  },

  // 路径工具（自动识别 Windows 反斜杠 / Linux 斜杠）
  joinPath(dir, name) {
    if (!dir || dir === '.' || dir === '' || dir === '/') return '/' + name;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  },
  parentPath(p) {
    if (!p || p === '.' || p === '/' || p === 'C:\\' || /^[A-Za-z]:\\?$/.test(p)) return p;
    // Windows 盘符根（如 C:\Users -> C:\）
    const m = p.match(/^([A-Za-z]:)\\([^\\/]*)$/);
    if (m) return m[1] + '\\';
    // Windows 盘符（如 C:\ -> 不变）
    if (/^[A-Za-z]:\\$/.test(p)) return p;
    const cleaned = p.replace(/[\\/]+$/, '');
    const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
    if (idx <= 0) return cleaned[1] === ':' ? cleaned.slice(0, 2) + '\\' : '/';
    return cleaned.slice(0, idx);
  },

  _fitTerm(tab) {
    if (tab.fitAddon) {
      try {
        tab.fitAddon.fit();
        window.toolbox?.ssh?.resize(tab.id, tab.term.cols, tab.term.rows);
      } catch {}
    }
  },

  fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(1) + ' GB';
  },

  fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  },

  // 本地文件上传到服务器
  async localUpload(tab, name) {
    const localPath = this.joinPath(this.sftpLocalPath, name);
    const r = await window.toolbox?.fs?.readFile(localPath);
    if (!r?.ok) { toast('读取失败：' + r.error, 'error'); return; }
    const remotePath = this.joinPath(tab.sftpPath, name);
    const w = await window.toolbox?.sftp?.write(tab.id, remotePath, r.content);
    if (w?.ok) { toast('上传成功'); this.renderRemotePane(); }
    else toast('上传失败：' + (w?.error || ''), 'error');
  },

  // 本地目录上传（逐文件，简单递归）
  async localUploadDir(tab, name) {
    toast('目录上传：请先在左侧进入目录，逐个文件上传', 'warn');
  },

  // 服务器文件下载到本地
  async sftpDownload(tab, name) {
    const remotePath = this.joinPath(tab.sftpPath, name);
    const r = await window.toolbox?.sftp?.read(tab.id, remotePath);
    if (!r?.ok) { toast('下载失败：' + r.error, 'error'); return; }
    // 保存到本地当前目录
    const localPath = this.joinPath(this.sftpLocalPath, name);
    const w = await window.toolbox?.fs?.saveFile(localPath, r.content);
    if (w?.ok) { toast('已下载到 ' + localPath); }
    else toast('保存失败：' + (w?.error || ''), 'error');
  },

  // 自建输入弹窗（Electron 渲染进程不支持 window.prompt）
  promptInput(title, placeholder, onOk) {
    const overlay = el('div', { class: 'sftp-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    const modal = el('div', { class: 'sftp-modal sftp-modal-small', onclick: (e) => e.stopPropagation() });
    const input = el('input', { class: 'input', placeholder, style: { width: '100%' } });
    const cancelBtn = btn('取消', () => overlay.remove(), { variant: 'ghost' });
    const okBtn = btn('确定', () => {
      const v = input.value.trim();
      if (!v) return;
      overlay.remove();
      onOk(v);
    }, { variant: 'primary' });
    const foot = el('div', { class: 'sftp-modal-foot' }, [cancelBtn, okBtn]);
    modal.append(
      el('div', { class: 'sftp-head' }, [el('div', { class: 'sftp-title', text: title }), el('button', { class: 'sftp-close', text: '×', onclick: () => overlay.remove() })]),
      el('div', { class: 'sftp-modal-body' }, [input]),
      foot,
    );
    overlay.append(modal);
    document.body.appendChild(overlay);
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') okBtn.click(); });
  },

  sftpMkdir(tab) {
    this.promptInput('新建文件夹', '文件夹名称', (name) => {
      const path = this.joinPath(tab.sftpPath, name);
      window.toolbox?.sftp?.mkdir(tab.id, path).then((r) => {
        if (r.ok) { toast('已创建'); this.renderRemotePane(); }
        else toast('创建失败：' + r.error, 'error');
      });
    });
  },

  // 自建确认弹窗
  confirmDialog(message, onOk) {
    const overlay = el('div', { class: 'sftp-overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
    const modal = el('div', { class: 'sftp-modal sftp-modal-small', onclick: (e) => e.stopPropagation() });
    const cancelBtn = btn('取消', () => overlay.remove(), { variant: 'ghost' });
    const okBtn = btn('确定', () => { overlay.remove(); onOk(); }, { variant: 'danger' });
    const foot = el('div', { class: 'sftp-modal-foot' }, [cancelBtn, okBtn]);
    modal.append(
      el('div', { class: 'sftp-head' }, [el('div', { class: 'sftp-title', text: '确认' }), el('button', { class: 'sftp-close', text: '×', onclick: () => overlay.remove() })]),
      el('div', { class: 'sftp-modal-body sftp-confirm-msg' }, [el('div', { text: message })]),
      foot,
    );
    overlay.append(modal);
    document.body.appendChild(overlay);
    okBtn.focus();
  },

  sftpDelete(tab, name, isDir) {
    this.confirmDialog(`确定删除「${name}」${isDir ? '目录' : '文件'}？`, () => {
      const path = this.joinPath(tab.sftpPath, name);
      window.toolbox?.sftp?.delete(tab.id, path, isDir).then((r) => {
        if (r.ok) { toast('已删除'); this.renderRemotePane(); }
        else toast('删除失败：' + r.error, 'error');
      });
    });
  },
};
