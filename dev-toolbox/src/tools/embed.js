import { el } from '../ui/helpers.js';

function testhubUrl() {
  return 'http://localhost:3001/?dev_auto_login=1';
}

async function portsReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [8000, 3001], 400);
    const open = r?.open || [];
    return open.includes(8000) && open.includes(3001);
  } catch {
    return false;
  }
}

async function ensureTestHub() {
  if (await portsReady()) {
    return { ok: true, message: 'already running' };
  }
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.testhubEnsure) return tb.testhubEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('testhub_ensure');
    return Promise.resolve({ ok: false, message: '当前版本不支持一键启动，请重新打包 DevToolbox' });
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, message: '启动超时（90s），请再点一次启动' }), 90000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok) return r;
  if (await portsReady()) return { ok: true, message: 'ready' };
  return r || { ok: false, message: '启动失败' };
}

export const embedTool = {
  id: 'embed',
  name: 'TestHub',
  category: '系统',
  icon: '▢',
  keywords: 'testhub 测试平台 iframe 内嵌',
  desc: '内嵌本机 TestHub',
  render(container) {
    const app = el('div', { class: 'embed-app' });

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'TestHub' });
    const msg = el('div', { class: 'embed-panel-msg', text: '点击下方按钮启动本机服务' });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 TestHub' });
    panel.append(title, msg, startBtn);

    const bar = el('div', { class: 'embed-bar', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '本机服务已连接' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '重启服务' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'TestHub', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('scrolling', 'no'); // 外层不滚，由 TestHub 内部 el-main 按需滚

    app.append(panel, bar, frame);
    container.append(app);

    let cancelled = false;
    let busy = false;

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      bar.hidden = true;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 TestHub';
    }

    function showFrame() {
      panel.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      frame.src = `${testhubUrl()}&_t=${Date.now()}`;
    }

    async function start() {
      if (busy || cancelled) return;
      busy = true;
      startBtn.disabled = true;
      barRestart.disabled = true;
      startBtn.textContent = '启动中…';
      msg.classList.remove('is-err');
      msg.textContent = '正在启动，请稍候…';
      frame.hidden = true;
      bar.hidden = true;
      panel.hidden = false;
      try {
        const r = await ensureTestHub();
        if (cancelled) return;
        if (!r?.ok) {
          showPanel(`启动失败：${r?.message || '未知错误'}`, true);
          return;
        }
        showFrame();
      } catch (e) {
        if (!cancelled) showPanel(`启动失败：${e}`, true);
      } finally {
        busy = false;
        startBtn.disabled = false;
        barRestart.disabled = false;
        startBtn.textContent = '启动 TestHub';
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    barReload.addEventListener('click', () => {
      frame.src = `${testhubUrl()}&_t=${Date.now()}`;
    });

    start();

    return () => { cancelled = true; };
  },
};
