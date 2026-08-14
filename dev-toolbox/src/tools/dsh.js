import { el } from '../ui/helpers.js';

const DSH_PORT = 3080;

function dshUrl() {
  return `http://127.0.0.1:${DSH_PORT}/`;
}

async function portReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [DSH_PORT], 400);
    return (r?.open || []).includes(DSH_PORT);
  } catch {
    return false;
  }
}

function explainEnsureResult(r) {
  if (!r || typeof r !== 'object') return '启动失败：未知错误';
  if (r.ok) return r.message || 'ready';
  const code = String(r.code || '');
  const detail = String(r.message || '').trim();
  if (code === 'not_installed' || /not found|not_installed|install dir missing/i.test(detail)) {
    return [
      '未检测到 DeepSeek Harness。',
      '请确认已安装到 D:\\deepseek-ai：',
      '  cd /d D:\\deepseek-ai',
      '  npm install @deepseek-ai/dsh',
      '或设置环境变量 DSH_INSTALL_DIR 指向安装目录。',
      detail ? `详情：${detail}` : '',
    ].filter(Boolean).join('\n');
  }
  if (code === 'timeout' || /timeout|not ready/i.test(detail)) {
    return [
      '已尝试启动，但 45 秒内端口 3080 未就绪。',
      '可手动执行：D:\\deepseek-ai\\start-web.cmd',
      '确认 http://127.0.0.1:3080 可打开后再点重连。',
      detail ? `详情：${detail}` : '',
    ].filter(Boolean).join('\n');
  }
  if (/不支持一键启动|重新打包/.test(detail)) return detail;
  return detail ? `启动失败：${detail}` : '启动失败';
}

async function ensureDsh() {
  if (await portReady()) return { ok: true, code: 'already_running', message: 'already running' };
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.dshEnsure) return tb.dshEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('dsh_ensure');
    return Promise.resolve({
      ok: false,
      code: 'no_bridge',
      message: '当前版本不支持一键启动，请重新打包 / 重启 DevToolbox（需含 dsh_ensure），或手动运行 D:\\deepseek-ai\\start-web.cmd',
    });
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'ensure timed out after 60s' }), 60000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok || (await portReady())) return r?.ok ? r : { ok: true, code: 'ready', message: 'ready' };
  return r || { ok: false, code: 'unknown', message: 'startup failed' };
}

export const dshTool = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  category: '系统',
  icon: '◆',
  keywords: 'deepseek harness dsh agent coding 智能体 本地 agent web',
  desc: '本机 DeepSeek Harness（dsh web）：本地 Agent 工作台',
  render(container) {
    const app = el('div', { class: 'embed-app embed-app--llm' });
    let cancelled = false;
    let busy = false;

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'DeepSeek Harness' });
    const msg = el('div', {
      class: 'embed-panel-msg',
      text: '本机 Agent 工作台（:3080）。默认安装目录 D:\\deepseek-ai。',
    });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 DeepSeek Harness' });
    panel.append(title, msg, startBtn);

    const bar = el('div', { class: 'embed-bar embed-bar--compact', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '' });
    const barOpen = el('button', { class: 'embed-bar-btn', type: 'button', text: '浏览器' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '重连' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, barOpen, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'DeepSeek Harness', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');

    app.append(panel, bar, frame);
    container.append(app);

    function syncHint(online) {
      barHint.textContent = online
        ? `本机已连接 · ${dshUrl()}`
        : `服务未运行 · ${dshUrl()} · 安装目录 D:\\deepseek-ai`;
    }

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 DeepSeek Harness';
      syncHint(false);
    }

    function showFrame() {
      panel.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      syncHint(true);
      frame.src = `${dshUrl()}?_t=${Date.now()}`;
    }

    async function start() {
      if (busy || cancelled) return;
      busy = true;
      startBtn.disabled = true;
      barRestart.disabled = true;
      startBtn.textContent = '启动中…';
      msg.classList.remove('is-err');
      msg.textContent = '正在启动 DeepSeek Harness…';
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      try {
        const r = await ensureDsh();
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
        startBtn.textContent = '启动 DeepSeek Harness';
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    barReload.addEventListener('click', () => {
      frame.src = `${dshUrl()}?_t=${Date.now()}`;
    });
    barOpen.addEventListener('click', async () => {
      const url = dshUrl();
      const tb = window.toolbox;
      if (tb?.openExternal) {
        await tb.openExternal(url);
        return;
      }
      window.open(url, '_blank', 'noopener');
    });

    (async () => {
      bar.hidden = false;
      const online = await portReady();
      if (cancelled) return;
      if (online) {
        showFrame();
        return;
      }
      showPanel('点击下方按钮启动本机 DeepSeek Harness（dsh web）', false);
    })();

    return () => {
      cancelled = true;
    };
  },
};
