import { el, btn, toast, field, kvRow } from '../ui/helpers.js';

const STORE_KEY = 'mytools-llmprobe';

const PRESETS = [
  {
    id: 'newapi',
    label: '本机 New API',
    baseUrl: 'http://localhost:5780/v1',
    model: 'ark-code-latest',
    hint: '走统一网关；Key 用控制台里的 sk-…',
  },
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '标准 OpenAI / 兼容网关',
  },
  {
    id: 'volc-coding',
    label: '火山方舟 Coding',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'ark-code-latest',
    hint: '直连火山 Coding；Key 填 ark-…',
  },
  {
    id: 'tokenrhythm',
    label: '基元律动',
    baseUrl: 'https://tokenrhythm.studio/v1',
    model: 'deepseek-v4-flash-0731',
    hint: '直连基元律动；Key 填 sk_tr_…',
  },
];

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveStore(data) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // 用户若只填到域名，补 /v1；已带 /v1 或 /chat/completions 则不乱改
  if (!/\/v\d+$/i.test(u) && !/\/chat\/completions$/i.test(u) && !/\/api\/coding\/v\d+$/i.test(u)) {
    // 留给用户控制；这里不强制
  }
  return u;
}

function chatCompletionsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
  if (/\/chat\/completions$/i.test(u)) return u;
  return `${u}/chat/completions`;
}

function modelsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
  if (/\/v\d+$/i.test(u) || /\/api\/coding\/v\d+$/i.test(u)) return `${u}/models`;
  return `${u}/models`;
}

function extractReply(body) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    const c = j?.choices?.[0];
    const text = c?.message?.content ?? c?.text ?? j?.output_text;
    if (typeof text === 'string' && text.trim()) return text.trim();
    if (Array.isArray(text)) {
      return text.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('').trim();
    }
    return '';
  } catch {
    return '';
  }
}

function extractError(body, status) {
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    return j?.error?.message || j?.message || j?.msg || (body ? String(body).slice(0, 300) : `HTTP ${status}`);
  } catch {
    return body ? String(body).slice(0, 300) : `HTTP ${status}`;
  }
}

async function http(opts) {
  if (!window.toolbox?.http) throw new Error('需在桌面端运行');
  return window.toolbox.http({ timeout: 60000, ...opts });
}

export const llmprobeTool = {
  id: 'llmprobe',
  name: '模型测通',
  category: '网络',
  icon: '◎',
  keywords: 'llm model probe test openai 测通 连通性 火山 讯飞 基元 newapi',
  desc: '填 Base URL / Key / 模型，一键检测第三方大模型是否通',
  render(container) {
    const saved = loadStore();

    const presetRow = el('div', { class: 'form-row', style: { gap: '8px' } });
    PRESETS.forEach((p) => {
      presetRow.append(
        btn(p.label, () => {
          baseUrl.value = p.baseUrl;
          model.value = p.model;
          hint.textContent = p.hint;
          toast(`已填入：${p.label}`);
        }),
      );
    });

    const baseUrl = el('input', {
      class: 'input',
      placeholder: 'https://api.example.com/v1',
      value: saved.baseUrl || PRESETS[0].baseUrl,
    });
    const apiKey = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'sk-… / ark-…',
      value: saved.apiKey || '',
    });
    const model = el('input', {
      class: 'input',
      placeholder: '模型名，如 gpt-4o-mini',
      value: saved.model || PRESETS[0].model,
    });
    const prompt = el('input', {
      class: 'input',
      placeholder: '测通提示词',
      value: saved.prompt || '只回复：pong',
    });
    const hint = el('div', {
      class: 'muted',
      style: { fontSize: '12px', color: 'var(--text-mute)' },
      text: PRESETS[0].hint,
    });

    const showKey = el('label', {
      style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-dim)', cursor: 'pointer' },
    }, [
      el('input', { type: 'checkbox' }),
      document.createTextNode('显示密钥'),
    ]);
    showKey.querySelector('input').addEventListener('change', (e) => {
      apiKey.type = e.target.checked ? 'text' : 'password';
    });

    const status = el('div', { class: 'llmprobe-status', text: '填好后点「测通」' });
    const meta = el('div', { class: 'result-box' });
    const resp = el('textarea', {
      class: 'tx',
      placeholder: '响应摘要…',
      style: { minHeight: '160px' },
    });
    resp.readOnly = true;

    function persist() {
      saveStore({
        baseUrl: baseUrl.value.trim(),
        apiKey: apiKey.value,
        model: model.value.trim(),
        prompt: prompt.value.trim(),
      });
    }

    function setStatus(ok, text) {
      status.textContent = text;
      status.classList.toggle('is-ok', ok === true);
      status.classList.toggle('is-err', ok === false);
    }

    async function probeChat() {
      persist();
      const base = normalizeBase(baseUrl.value);
      const key = apiKey.value.trim();
      const modelName = model.value.trim();
      const userPrompt = prompt.value.trim() || '只回复：pong';
      if (!base) { toast('请填写 Base URL', 'warn'); return; }
      if (!key) { toast('请填写 API Key', 'warn'); return; }
      if (!modelName) { toast('请填写模型名', 'warn'); return; }

      setStatus(null, '请求中…');
      meta.innerHTML = '';
      resp.value = '';
      testBtn.disabled = true;
      modelsBtn.disabled = true;

      const url = chatCompletionsUrl(base);
      const body = JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 64,
        temperature: 0,
        stream: false,
      });

      const t0 = Date.now();
      try {
        const r = await http({
          url,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body,
        });
        const ms = Date.now() - t0;
        if (!r.ok) {
          setStatus(false, `失败：${r.error || '未知错误'}`);
          meta.append(kvRow('错误', r.error || '-'), kvRow('耗时', `${ms} ms`));
          return;
        }
        meta.append(
          kvRow('状态', `${r.status} ${r.statusText || ''}`.trim()),
          kvRow('耗时', `${ms} ms`),
          kvRow('URL', url),
        );
        const reply = extractReply(r.body);
        if (r.status >= 200 && r.status < 300 && reply) {
          setStatus(true, `通了 · ${ms} ms`);
          resp.value = reply;
          toast('测通成功');
        } else if (r.status >= 200 && r.status < 300) {
          setStatus(true, `HTTP 成功，但未解析到回复 · ${ms} ms`);
          try { resp.value = JSON.stringify(JSON.parse(r.body), null, 2); }
          catch { resp.value = String(r.body || ''); }
        } else {
          setStatus(false, `不通 · ${extractError(r.body, r.status)}`);
          try { resp.value = JSON.stringify(JSON.parse(r.body), null, 2); }
          catch { resp.value = String(r.body || ''); }
        }
      } catch (e) {
        setStatus(false, `失败：${e.message || e}`);
      } finally {
        testBtn.disabled = false;
        modelsBtn.disabled = false;
      }
    }

    async function probeModels() {
      persist();
      const base = normalizeBase(baseUrl.value);
      const key = apiKey.value.trim();
      if (!base) { toast('请填写 Base URL', 'warn'); return; }
      if (!key) { toast('请填写 API Key', 'warn'); return; }

      setStatus(null, '拉取模型列表…');
      meta.innerHTML = '';
      resp.value = '';
      testBtn.disabled = true;
      modelsBtn.disabled = true;

      const url = modelsUrl(base);
      const t0 = Date.now();
      try {
        const r = await http({
          url,
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
        });
        const ms = Date.now() - t0;
        if (!r.ok) {
          setStatus(false, `失败：${r.error || '未知错误'}`);
          meta.append(kvRow('错误', r.error || '-'), kvRow('耗时', `${ms} ms`));
          return;
        }
        meta.append(
          kvRow('状态', `${r.status} ${r.statusText || ''}`.trim()),
          kvRow('耗时', `${ms} ms`),
          kvRow('URL', url),
        );
        if (r.status >= 200 && r.status < 300) {
          setStatus(true, `模型列表 OK · ${ms} ms`);
          try {
            const j = JSON.parse(r.body);
            const ids = (j.data || []).map((m) => m.id || m.name).filter(Boolean);
            resp.value = ids.length ? ids.join('\n') : JSON.stringify(j, null, 2);
          } catch {
            resp.value = String(r.body || '');
          }
        } else {
          setStatus(false, `失败 · ${extractError(r.body, r.status)}`);
          resp.value = String(r.body || '');
        }
      } catch (e) {
        setStatus(false, `失败：${e.message || e}`);
      } finally {
        testBtn.disabled = false;
        modelsBtn.disabled = false;
      }
    }

    const testBtn = btn('测通（chat）', probeChat, { variant: 'primary' });
    const modelsBtn = btn('拉模型列表', probeModels);
    const clearBtn = btn('清空密钥', () => {
      apiKey.value = '';
      persist();
      toast('已清空本机保存的密钥');
    });

    container.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '快捷预设' }),
        presetRow,
        hint,
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '连接参数' }),
        el('div', { class: 'form-row' }, [field('Base URL', baseUrl)]),
        el('div', { class: 'form-row' }, [
          field('API Key', apiKey),
          field('模型', model),
        ]),
        el('div', { class: 'form-row' }, [field('测通提示词', prompt)]),
        el('div', { class: 'form-row', style: { alignItems: 'center' } }, [showKey, testBtn, modelsBtn, clearBtn]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '结果' }),
        status,
        meta,
        resp,
      ]),
    );
  },
};
