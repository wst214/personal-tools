import { el } from '../ui/helpers.js';

const STIRLING_PORT = 8090;

function stirlingUrl() {
  return `http://127.0.0.1:${STIRLING_PORT}/`;
}

async function portReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [STIRLING_PORT], 400);
    return (r?.open || []).includes(STIRLING_PORT);
  } catch {
    return false;
  }
}

function explainEnsureResult(r) {
  if (!r || typeof r !== 'object') return '启动失败：未知错误';
  if (r.ok) return r.message || 'ready';
  const code = String(r.code || '');
  const detail = String(r.message || '').trim();
  if (code === 'no_docker' || /Docker not found|no_docker/i.test(detail)) {
    return [
      '未检测到 Docker。',
      '请先安装并启动 Docker Desktop，再点「启动 Stirling-PDF」。',
      '镜像首次拉取可能需要几分钟。',
    ].join('\n');
  }
  if (code === 'timeout' || /timeout|not ready/i.test(detail)) {
    return [
      '已尝试启动，但 90 秒内端口 8090 未就绪。',
      '若是第一次拉取镜像，请在 Docker Desktop 确认 pull 完成后再点重连。',
      detail ? `详情：${detail}` : '',
    ].filter(Boolean).join('\n');
  }
  if (/不支持一键启动|重新打包/.test(detail)) return detail;
  return detail ? `启动失败：${detail}` : '启动失败';
}

async function ensureStirling() {
  if (await portReady()) return { ok: true, code: 'already_running', message: 'already running' };
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.stirlingEnsure) return tb.stirlingEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('stirling_ensure');
    return Promise.resolve({
      ok: false,
      code: 'no_bridge',
      message: '当前版本不支持一键启动，请重新打包 DevToolbox，或手动执行：docker compose -f dev-toolbox/stirling-pdf/docker-compose.yml up -d',
    });
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'ensure timed out after 120s' }), 120000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok || (await portReady())) return r?.ok ? r : { ok: true, code: 'ready', message: 'ready' };
  return r || { ok: false, code: 'unknown', message: 'startup failed' };
}

export const stirlingTool = {
  id: 'stirling',
  name: 'PDF 工具',
  category: '系统',
  icon: '▤',
  keywords: 'stirling pdf merge split compress ocr 合并 拆分 压缩',
  desc: '内嵌本机 Stirling-PDF：合并 / 拆分 / 压缩 / OCR',
  render(container) {
    const app = el('div', { class: 'embed-app' });
    let cancelled = false;
    let busy = false;

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'Stirling-PDF' });
    const msg = el('div', {
      class: 'embed-panel-msg',
      text: '本机 PDF 工具箱（:8090）。需 Docker Desktop。',
    });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 Stirling-PDF' });
    panel.append(title, msg, startBtn);

    const bar = el('div', { class: 'embed-bar', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '' });
    const barOpen = el('button', { class: 'embed-bar-btn', type: 'button', text: '浏览器打开' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '启动/重连' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, barOpen, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'Stirling-PDF', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');

    app.append(panel, bar, frame);
    container.append(app);

    function syncHint(online) {
      barHint.textContent = online
        ? `本机已连接 · ${stirlingUrl()}`
        : `服务未运行 · ${stirlingUrl()}`;
    }

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 Stirling-PDF';
      syncHint(false);
    }

    function showFrame() {
      panel.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      syncHint(true);
      frame.src = `${stirlingUrl()}?_t=${Date.now()}`;
    }

    async function start() {
      if (busy || cancelled) return;
      busy = true;
      startBtn.disabled = true;
      barRestart.disabled = true;
      startBtn.textContent = '启动中…';
      msg.classList.remove('is-err');
      msg.textContent = '正在启动 Stirling-PDF（首次拉取镜像较慢）…';
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      try {
        const r = await ensureStirling();
        if (cancelled) return;
        if (!r?.ok) {
          showPanel(explainEnsureResult(r), true);
          return;
        }
        showFrame();
      } catch (e) {
        if (!cancelled) showPanel(`启动失败：${e}`, true);
      } finally {
        busy = false;
        startBtn.disabled = false;
        barRestart.disabled = false;
        startBtn.textContent = '启动 Stirling-PDF';
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    barReload.addEventListener('click', () => {
      if (!frame.hidden) frame.src = `${stirlingUrl()}?_t=${Date.now()}`;
    });
    barOpen.addEventListener('click', async () => {
      const url = stirlingUrl();
      const tb = window.toolbox;
      if (tb?.openExternal) {
        await tb.openExternal(url);
        return;
      }
      window.open(url, '_blank', 'noopener');
    });

    (async () => {
      const online = await portReady();
      if (cancelled) return;
      if (online) showFrame();
      else showPanel('点击下方按钮启动本机 Stirling-PDF', false);
    })();

    return () => { cancelled = true; };
  },
};
