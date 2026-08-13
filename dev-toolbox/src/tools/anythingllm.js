import { el } from '../ui/helpers.js';

const ANYTHINGLLM_PORT = 3002;

function anythingllmUrl() {
  return `http://127.0.0.1:${ANYTHINGLLM_PORT}/`;
}

async function portReady() {
  const tb = window.toolbox;
  if (!tb?.portScan) return false;
  try {
    const r = await tb.portScan('127.0.0.1', [ANYTHINGLLM_PORT], 400);
    return (r?.open || []).includes(ANYTHINGLLM_PORT);
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
      '请先安装并启动 Docker Desktop，再点「启动 AnythingLLM」。',
      '镜像首次拉取可能需要几分钟。',
    ].join('\n');
  }
  if (code === 'timeout' || /timeout|not ready/i.test(detail)) {
    return [
      '启动等待超时：镜像可能仍在后台拉取（AnythingLLM 体积较大，首次常需十几分钟）。',
      '请打开 Docker Desktop → Images / 拉取进度，等 mintplexlabs/anythingllm 出现后再点「启动/重连」。',
      '也可在终端执行：docker compose -f d:/mytools/dev-toolbox/anythingllm/docker-compose.yml up -d',
      detail ? `详情：${detail}` : '',
    ].filter(Boolean).join('\n');
  }
  if (/不支持一键启动|重新打包/.test(detail)) return detail;
  return detail ? `启动失败：${detail}` : '启动失败';
}

async function ensureAnythingllm() {
  if (await portReady()) return { ok: true, code: 'already_running', message: 'already running' };
  const tb = window.toolbox;
  const invokeEnsure = () => {
    if (tb?.anythingllmEnsure) return tb.anythingllmEnsure();
    if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('anythingllm_ensure');
    return Promise.resolve({
      ok: false,
      code: 'no_bridge',
      message: '当前版本不支持一键启动，请重新打包 DevToolbox，或手动执行：docker compose -f dev-toolbox/anythingllm/docker-compose.yml up -d',
    });
  };
  // 首次拉镜像很慢；前端先等一会儿，超时后提示去看 Docker，后台 pull 可继续。
  const timeout = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, code: 'timeout', message: 'ensure timed out after 180s' }), 180000);
  });
  const r = await Promise.race([invokeEnsure(), timeout]);
  if (r?.ok || (await portReady())) return r?.ok ? r : { ok: true, code: 'ready', message: 'ready' };
  return r || { ok: false, code: 'unknown', message: 'startup failed' };
}

export const anythingllmTool = {
  id: 'anythingllm',
  name: '知识库',
  category: '系统',
  icon: '▣',
  keywords: 'anythingllm rag 知识库 文档 工作区 llm workspace',
  desc: '内嵌本机 AnythingLLM：文档知识库 + RAG 工作台',
  render(container) {
    const app = el('div', { class: 'embed-app embed-app--llm' });
    let cancelled = false;
    let busy = false;

    const panel = el('div', { class: 'embed-panel' });
    const title = el('div', { class: 'embed-panel-title', text: 'AnythingLLM' });
    const msg = el('div', {
      class: 'embed-panel-msg',
      text: [
        '本机知识库工作台（:3002）。需 Docker。',
        '已预接本地 New API（基元律动 · deepseek-v4-flash-0731）。',
        '上传文档后即可问答；向量嵌入用本地 native 模型。',
      ].join('\n'),
    });
    const startBtn = el('button', { class: 'embed-start-btn', type: 'button', text: '启动 AnythingLLM' });
    panel.append(title, msg, startBtn);

    const bar = el('div', { class: 'embed-bar embed-bar--compact', hidden: true });
    const barHint = el('span', { class: 'embed-bar-hint', text: '' });
    const barOpen = el('button', { class: 'embed-bar-btn', type: 'button', text: '浏览器' });
    const barRestart = el('button', { class: 'embed-bar-btn', type: 'button', text: '重连' });
    const barReload = el('button', { class: 'embed-bar-btn', type: 'button', text: '刷新' });
    bar.append(barHint, barOpen, barRestart, barReload);

    const frame = el('iframe', { class: 'embed-frame', title: 'AnythingLLM', hidden: true });
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');

    app.append(panel, bar, frame);
    container.append(app);

    function syncHint(online) {
      barHint.textContent = online
        ? `已连接 · New API :5780`
        : `未运行 · :${ANYTHINGLLM_PORT}`;
    }

    function showPanel(text, isErr = false) {
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      msg.textContent = text;
      msg.classList.toggle('is-err', !!isErr);
      startBtn.disabled = false;
      startBtn.textContent = '启动 AnythingLLM';
      syncHint(false);
    }

    function showFrame() {
      panel.hidden = true;
      bar.hidden = false;
      frame.hidden = false;
      syncHint(true);
      frame.src = `${anythingllmUrl()}?_skin=notes5&_t=${Date.now()}`;
    }

    async function start() {
      if (busy || cancelled) return;
      busy = true;
      startBtn.disabled = true;
      barRestart.disabled = true;
      startBtn.textContent = '启动中…';
      msg.classList.remove('is-err');
      msg.textContent = '正在启动 AnythingLLM…\n首次需从 Docker Hub 拉镜像（约 1GB+），可能要十几分钟。\n可到 Docker Desktop 查看拉取进度；拉完后点「启动/重连」。';
      frame.hidden = true;
      bar.hidden = false;
      panel.hidden = false;
      try {
        const r = await ensureAnythingllm();
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
        startBtn.textContent = '启动 AnythingLLM';
      }
    }

    startBtn.addEventListener('click', () => start());
    barRestart.addEventListener('click', () => start());
    barReload.addEventListener('click', () => {
      if (!frame.hidden) frame.src = `${anythingllmUrl()}?_skin=notes5&_t=${Date.now()}`;
    });
    barOpen.addEventListener('click', async () => {
      const url = anythingllmUrl();
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
      else {
        showPanel([
          '点击下方按钮启动本机 AnythingLLM。',
          '模型：设置 → LLM → OpenAI 兼容，Base URL = http://host.docker.internal:5780/v1',
        ].join('\n'), false);
      }
    })();

    return () => { cancelled = true; };
  },
};
