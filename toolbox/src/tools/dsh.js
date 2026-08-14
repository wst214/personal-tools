import { el } from '../ui/helpers.js';
import { svg } from './base.js';

// DeepSeek Harness：本机启动 dsh web，浏览器打开本地 Agent 工作台。
const ICON = svg(
  '<circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.2 2.2 4.8-5.2"/>',
);
const FOLDER_ICON = svg(
  '<path d="M3 7.5a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
);
const PLAY_ICON = svg('<path d="M5 4l14 8-14 8z"/>');
const STOP_ICON = svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>');
const LINK_ICON = svg(
  '<path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5.93"/><path d="M14 11a5 5 0 0 0-7.07 0L5.5 12.43a5 5 0 1 0 7.07 7.07L14 18.07"/>',
);

const DEFAULT_DIR = 'D:\\deepseek-ai';
const DEFAULT_URL = 'http://127.0.0.1:3080';

const electronApi = window.toolbox?.dsh;
const electronOnOutput = window.toolbox?.onDshOutput;

const webFallback = {
  async status() {
    return { running: false, ready: false, installDir: DEFAULT_DIR, url: DEFAULT_URL, pid: null };
  },
  async getConfig() {
    return { installDir: DEFAULT_DIR, url: DEFAULT_URL };
  },
  async setInstallDir() {
    return { ok: false, msg: 'Web 预览不支持' };
  },
  async pickDir() {
    return null;
  },
  async start() {
    return { ok: false, msg: '请在桌面端 Toolbox 中启动 DeepSeek Harness' };
  },
  async stop() {
    return { ok: true };
  },
  async open() {
    window.open(DEFAULT_URL, '_blank');
    return true;
  },
  async openInstallDir() {
    return { ok: false, msg: 'Web 预览不支持' };
  },
};

const api = electronApi || webFallback;
const onOutput = electronOnOutput || (() => () => {});

export const dshTool = {
  id: 'dsh',
  title: 'DeepSeek Harness',
  icon: ICON,
  state: {
    installDir: DEFAULT_DIR,
    url: DEFAULT_URL,
    running: false,
    ready: false,
    pid: null,
    output: [],
    hint: '',
  },

  async render(container) {
    this.container = container;
    container.innerHTML = '';
    this.root = el('div', { class: 'dsh' });
    container.append(this.root);
    await this.refresh();
    this.paint();
    this._offOutput = onOutput((msg) => this.onOutput(msg));
  },

  onLeave() {
    if (this._offOutput) this._offOutput();
  },

  async refresh() {
    const [cfg, st] = await Promise.all([api.getConfig(), api.status()]);
    this.state.installDir = cfg.installDir || DEFAULT_DIR;
    this.state.url = cfg.url || DEFAULT_URL;
    this.state.running = !!st.running;
    this.state.ready = !!st.ready;
    this.state.pid = st.pid || null;
  },

  onOutput(msg) {
    if (!msg) return;
    if (msg.type === 'ready') {
      this.state.ready = true;
      this.state.running = true;
      this.state.hint = '服务已就绪';
      this.state.output.push({ type: 'done', text: `就绪：${msg.url || this.state.url}` });
      this.paint();
      return;
    }
    if (msg.type === 'close' || msg.type === 'cancelled') {
      this.state.running = false;
      this.state.ready = false;
      this.state.pid = null;
      this.state.hint = msg.type === 'cancelled' ? '已停止' : `进程退出（code=${msg.code ?? '?'}）`;
      this.state.output.push({
        type: msg.type === 'cancelled' ? 'cancelled' : 'close',
        text: msg.type === 'cancelled' ? '已停止 DeepSeek Harness' : `进程退出 code=${msg.code}`,
      });
      this.paint();
      return;
    }
    const text = msg.text || '';
    if (text) this.state.output.push({ type: msg.type || 'out', text });
    if (this.state.output.length > 400) this.state.output = this.state.output.slice(-300);
    this.paintOutputOnly();
  },

  paintOutputOnly() {
    const box = this.root?.querySelector('.dsh-output');
    if (!box) return;
    box.innerHTML = '';
    if (!this.state.output.length) {
      box.append(el('div', { class: 'output-empty' }, '尚未启动。点击「启动」后日志会出现在这里。'));
      return;
    }
    for (const line of this.state.output) {
      box.append(el('div', { class: `out-line ${line.type || 'out'}` }, line.text));
    }
    box.scrollTop = box.scrollHeight;
  },

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const statusClass = this.state.ready ? 'ok' : this.state.running ? 'run' : 'off';
    const statusText = this.state.ready
      ? '运行中 · 可打开浏览器'
      : this.state.running
        ? '启动中…'
        : '未运行';

    const toolbar = el(
      'div',
      { class: 'dsh-toolbar' },
      el('div', { class: 'dsh-title' }, 'DeepSeek Harness'),
      el('span', { class: `dsh-badge ${statusClass}` }, statusText),
      el('div', { class: 'dsh-spacer' }),
      this.state.running
        ? el(
            'button',
            {
              class: 'btn danger',
              onclick: () => this.stop(),
            },
            el('span', { class: 'btn-ico', html: STOP_ICON }),
            '停止',
          )
        : el(
            'button',
            {
              class: 'btn primary',
              onclick: () => this.start(),
            },
            el('span', { class: 'btn-ico', html: PLAY_ICON }),
            '启动',
          ),
      el(
        'button',
        {
          class: 'btn',
          onclick: () => this.openUi(),
        },
        el('span', { class: 'btn-ico', html: LINK_ICON }),
        '打开 Web UI',
      ),
    );

    const pathRow = el(
      'div',
      { class: 'dsh-path-row' },
      el('label', { class: 'dsh-label' }, '安装目录'),
      el('input', {
        class: 'dsh-path-input',
        value: this.state.installDir,
        readonly: true,
      }),
      el(
        'button',
        {
          class: 'btn icon',
          title: '选择目录',
          onclick: () => this.pickDir(),
        },
        el('span', { html: FOLDER_ICON }),
      ),
      el(
        'button',
        {
          class: 'btn ghost sm',
          onclick: () => this.openInstallDir(),
        },
        '打开目录',
      ),
    );

    const tips = el(
      'div',
      { class: 'dsh-tips' },
      el('p', {}, '本机启动本地 Agent（默认 ', el('code', {}, this.state.url), '）。'),
      el('p', {}, '首次使用：在 Web UI「设置 → 模型」填写 DeepSeek API Key，再选择工作区。'),
      this.state.hint ? el('p', { class: 'dsh-hint' }, this.state.hint) : null,
    );

    const outputWrap = el(
      'div',
      { class: 'dsh-output-wrap' },
      el('div', { class: 'output-label' }, '运行日志'),
      el('div', { class: 'dsh-output deploy-output' }),
    );

    root.append(toolbar, pathRow, tips, outputWrap);
    this.paintOutputOnly();
  },

  async pickDir() {
    const dir = await api.pickDir();
    if (!dir) return;
    const r = await api.setInstallDir(dir);
    if (!r.ok) {
      this.state.hint = r.msg || '保存失败';
      this.paint();
      return;
    }
    this.state.installDir = dir;
    this.state.hint = '已更新安装目录';
    this.paint();
  },

  async openInstallDir() {
    const r = await api.openInstallDir();
    if (!r?.ok) this.state.hint = r?.msg || '无法打开目录';
    this.paint();
  },

  async start() {
    this.state.output = [];
    this.state.hint = '正在启动…';
    this.paint();
    const r = await api.start();
    if (!r.ok) {
      this.state.hint = r.msg || '启动失败';
      this.state.output.push({ type: 'err', text: r.msg || '启动失败' });
      this.paint();
      return;
    }
    this.state.running = true;
    this.state.pid = r.pid || null;
    this.state.hint = '已启动，等待 Web UI 就绪…';
    this.paint();
  },

  async stop() {
    await api.stop();
    this.state.running = false;
    this.state.ready = false;
    this.state.pid = null;
    this.state.hint = '已请求停止';
    this.paint();
  },

  async openUi() {
    await api.open();
  },
};
