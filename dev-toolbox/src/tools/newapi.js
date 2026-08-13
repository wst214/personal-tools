import { el } from '../ui/helpers.js';

const NEWAPI_PORT = 5780;
const CREDS_KEY = 'mytools-newapi-creds';

function newapiUrl() {
  return `http://localhost:${NEWAPI_PORT}/`;
}

function loadCreds() {
  try {
    const j = JSON.parse(localStorage.getItem(CREDS_KEY) || '{}');
    return {
      username: j.username || 'admin',
      password: j.password || 'mytools-admin',
      autoLogin: j.autoLogin !== false,
    };
  } catch {
    return { username: 'admin', password: 'mytools-admin', autoLogin: true };
  }
}

function saveCreds(creds) {
  localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
}

function consoleUrl() {
  const { username, password, autoLogin } = loadCreds();
  if (!autoLogin) return `${newapiUrl()}console`;
  const hash = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `http://localhost:${NEWAPI_PORT}/auto-login.html?next=${encodeURIComponent('/console')}&_t=${Date.now()}#${hash}`;
}

async function portReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [NEWAPI_PORT], 400);
    return (r?.open || []).includes(NEWAPI_PORT);
  } catch {
    return false;
  }
}

async function ensureNewApi() {
  if (await portReady()) return { ok: true, message: 'already running' };
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.newapiEnsure) return tb.newapiEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('newapi_ensure');
    return Promise.resolve({
      ok: false,
      message: '当前版本不支持一键启动，请重新打包 DevToolbox，或手动执行 docker compose up -d mytools-new-api mytools-new-api-gateway',
    });
  };
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, message: '启动超时（90s），请确认 Docker Desktop 已运行' }), 90000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok || (await portReady())) return r?.ok ? r : { ok: true, message: 'ready' };
  return r || { ok: false, message: '启动失败' };
}

export const newapiTool = {
  id: 'newapi',
  name: 'New API',
  category: '系统',
  icon: '⬡',
  keywords: 'newapi new-api llm 中转 网关 openai 火山 讯飞 统一转发',
  desc: '多上游 LLM 统一转发（本机 New API）',
  render(container) {
    const app = el('div', { class: 'embed-app' });
    let current = loadCreds();
    let cancelled = false;
    let busy = false;

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'New API' });
    const msg = el('div', { class: 'embed-panel-msg', text: '正在连接本机服务…' });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 New API' });
    panel.append(title, msg, startBtn);

    const bar = el('div', { class: 'embed-bar', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '' });
    const barAccount = el('button', { class: 'embed-bar-btn', type: 'button', text: '账号' });
    const barCcswitch = el('button', { class: 'embed-bar-btn', type: 'button', text: '接入 Codex' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '重启服务' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, barAccount, barCcswitch, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'New API', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    // 允许同域登录页使用 storage / service worker
    frame.setAttribute('allow', 'fullscreen');

    app.append(panel, bar, frame);
    container.append(app);

    function syncHint(online) {
      const auto = current.autoLogin ? `自动登录：开 · ${current.username}` : `自动登录：关 · ${current.username}`;
      barHint.textContent = online
        ? `本机服务已连接 · ${newapiUrl()} · ${auto}`
        : `服务未运行 · ${auto}`;
    }

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      bar.hidden = true;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 New API';
    }

    function showFrame() {
      panel.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      syncHint(true);
      frame.src = consoleUrl();
    }

    function editCreds() {
      const username = window.prompt('New API 用户名', current.username);
      if (username == null) return;
      const password = window.prompt('New API 密码（仅本机保存）', current.password);
      if (password == null) return;
      const auto = window.confirm('开启自动登录？\n确定=开启，取消=关闭');
      current = { username: username.trim() || 'admin', password, autoLogin: !!auto };
      saveCreds(current);
      syncHint(!frame.hidden);
      if (!frame.hidden) frame.src = consoleUrl();
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
        const r = await ensureNewApi();
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
        startBtn.textContent = '启动 New API';
      }
    }

    async function pushCcswitch() {
      if (busy) return;
      const tb = window.toolbox;
      const invokePush = () => {
        if (tb?.newapiPushCcswitch) return tb.newapiPushCcswitch(null);
        if (window.__TAURI__?.core?.invoke) {
          return window.__TAURI__.core.invoke('newapi_push_ccswitch', { activate: null });
        }
        return Promise.resolve({ ok: false, message: '当前版本不支持，请重新打包 DevToolbox' });
      };
      busy = true;
      barCcswitch.disabled = true;
      const prev = barCcswitch.textContent;
      barCcswitch.textContent = '写入中…';
      try {
        const r = await invokePush();
        if (!r?.ok) {
          window.alert(`接入失败：${r?.message || '未知错误'}`);
          return;
        }
        const names = (r.providers || []).map((p) => `· ${p.name}（${p.action}）`).join('\n');
        window.alert(`${r.message}\n\n${names}\n\n${r.hint || ''}`);
      } catch (e) {
        window.alert(`接入失败：${e}`);
      } finally {
        busy = false;
        barCcswitch.disabled = false;
        barCcswitch.textContent = prev;
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    barReload.addEventListener('click', () => {
      if (!frame.hidden) frame.src = consoleUrl();
    });
    barAccount.addEventListener('click', editCreds);
    barCcswitch.addEventListener('click', () => pushCcswitch());

    start();

    return () => { cancelled = true; };
  },
};
