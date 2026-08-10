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

function autoLoginUrl(next = '/console') {
  const { username, password } = loadCreds();
  const hash = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `http://localhost:${NEWAPI_PORT}/auto-login.html?next=${encodeURIComponent(next)}&_t=${Date.now()}#${hash}`;
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

function openUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const newapiTool = {
  id: 'newapi',
  name: 'New API',
  category: '系统',
  icon: '⬡',
  keywords: 'newapi new-api llm 中转 网关 openai 火山 讯飞 统一转发',
  desc: '多上游 LLM 统一转发（本机 New API）',
  render(container) {
    // 不再 iframe 嵌 New API 首页：跨域 iframe 无法自动登录，会一直显示「登录」按钮造成误解
    const app = el('div', { class: 'newapi-home' });
    let current = loadCreds();
    let cancelled = false;
    let busy = false;

    const badge = el('div', { class: 'newapi-badge', text: '检测中…' });
    const title = el('div', { class: 'newapi-title', text: 'New API' });
    const sub = el('div', {
      class: 'newapi-sub',
      text: '统一 API 网关。控制台请在浏览器打开（工具箱内嵌无法保持登录态）。',
    });

    const meta = el('div', { class: 'newapi-meta' });
    const metaUrl = el('div', { class: 'newapi-meta-row', html: `<span>服务</span><code>${newapiUrl()}</code>` });
    const metaClient = el('div', { class: 'newapi-meta-row', html: `<span>客户端 Base URL</span><code>${newapiUrl()}v1</code>` });
    const metaUser = el('div', { class: 'newapi-meta-row', text: '' });
    meta.append(metaUrl, metaClient, metaUser);

    const openBtn = el('button', { class: 'newapi-primary', type: 'button', text: '打开控制台（自动登录）' });
    const startBtn = el('button', { class: 'newapi-secondary', type: 'button', text: '仅启动服务' });
    const credsBtn = el('button', { class: 'newapi-secondary', type: 'button', text: '设置账号' });
    const actions = el('div', { class: 'newapi-actions' }, [openBtn, startBtn, credsBtn]);
    const tip = el('div', { class: 'newapi-tip', text: '' });

    app.append(badge, title, sub, meta, actions, tip);
    container.append(app);

    function syncMeta() {
      metaUser.innerHTML = `<span>账号</span><code>${current.username}</code><span style="margin-left:10px;color:var(--text-mute)">自动登录 ${current.autoLogin ? '开' : '关'}</span>`;
    }

    function setStatus(online, text) {
      badge.textContent = text;
      badge.classList.toggle('is-on', !!online);
      badge.classList.toggle('is-off', !online);
    }

    function editCreds() {
      const username = window.prompt('New API 用户名', current.username);
      if (username == null) return;
      const password = window.prompt('New API 密码（仅本机保存）', current.password);
      if (password == null) return;
      const auto = window.confirm('开启自动登录？\n确定=开启，取消=关闭');
      current = { username: username.trim() || 'admin', password, autoLogin: !!auto };
      saveCreds(current);
      syncMeta();
    }

    async function ensure(openConsole) {
      if (busy || cancelled) return;
      busy = true;
      openBtn.disabled = true;
      startBtn.disabled = true;
      tip.textContent = '';
      setStatus(false, '启动中…');
      try {
        const r = await ensureNewApi();
        if (cancelled) return;
        if (!r?.ok) {
          setStatus(false, '未运行');
          tip.textContent = `启动失败：${r?.message || '未知错误'}`;
          tip.classList.add('is-err');
          return;
        }
        setStatus(true, '服务已连接');
        tip.classList.remove('is-err');
        tip.textContent = openConsole
          ? '已在浏览器打开控制台；若未自动登录，请确认账号密码。'
          : '服务已就绪。点「打开控制台（自动登录）」进入。';
        if (openConsole) {
          openUrl(current.autoLogin ? autoLoginUrl('/console') : `${newapiUrl()}console`);
        }
      } catch (e) {
        setStatus(false, '未运行');
        tip.textContent = `启动失败：${e}`;
        tip.classList.add('is-err');
      } finally {
        busy = false;
        openBtn.disabled = false;
        startBtn.disabled = false;
      }
    }

    openBtn.addEventListener('click', () => ensure(true));
    startBtn.addEventListener('click', () => ensure(false));
    credsBtn.addEventListener('click', editCreds);

    syncMeta();
    (async () => {
      const online = await portReady();
      if (cancelled) return;
      if (online) {
        setStatus(true, '服务已连接');
        // 进入工具时直接打开浏览器控制台并自动登录
        if (current.autoLogin) ensure(true);
        else tip.textContent = '服务已就绪。点上方按钮打开控制台。';
      } else {
        setStatus(false, '服务未运行');
        tip.textContent = '点「打开控制台（自动登录）」会先启动 Docker 再打开浏览器。';
      }
    })();

    return () => { cancelled = true; };
  },
};
