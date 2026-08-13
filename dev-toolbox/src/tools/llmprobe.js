import { el, btn, toast, field, kvRow, debounce } from '../ui/helpers.js';

const STORE_KEY = 'mytools-llmprobe';

const PRESETS = [
  {
    id: 'newapi',
    label: '本机 New API',
    baseUrl: 'http://localhost:5780/v1',
    model: 'ark-code-latest',
    hint: '走统一网关；Key 用控制台里的 sk-…（本机自动保存）',
  },
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '标准 OpenAI / 兼容网关（本机自动保存）',
  },
  {
    id: 'volc-coding',
    label: '火山方舟 Coding',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'ark-code-latest',
    hint: '直连火山 Coding；Key 填 ark-…（本机自动保存）',
  },
  {
    id: 'tokenrhythm',
    label: '基元律动',
    baseUrl: 'https://tokenrhythm.studio/v1',
    model: 'deepseek-v4-flash-0731',
    hint: '直连基元律动；Key 填 sk_tr_…（本机自动保存）',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hint: '直连 api.deepseek.com；Key 填平台 sk-…（本机自动保存）',
  },
];

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (!raw.profiles && (raw.baseUrl || raw.apiKey)) {
      return {
        activeId: 'newapi',
        profiles: {
          newapi: {
            baseUrl: raw.baseUrl || PRESETS[0].baseUrl,
            apiKey: raw.apiKey || '',
            model: raw.model || PRESETS[0].model,
            models: raw.model ? [raw.model] : [],
            prompt: raw.prompt || '只回复：pong',
          },
        },
      };
    }
    return {
      activeId: raw.activeId || 'newapi',
      profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {},
    };
  } catch {
    return { activeId: 'newapi', profiles: {} };
  }
}

function saveStore(data) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function profileFor(store, id) {
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
  const p = store.profiles[id] || {};
  return {
    baseUrl: p.baseUrl || preset.baseUrl,
    apiKey: p.apiKey || '',
    model: p.model || preset.model,
    models: Array.isArray(p.models) ? p.models : (p.model ? [p.model] : [preset.model]),
    prompt: p.prompt || '只回复：pong',
  };
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function chatCompletionsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
  if (/\/chat\/completions$/i.test(u)) return u;
  return `${u}/chat/completions`;
}

function modelsUrl(baseUrl) {
  const u = normalizeBase(baseUrl);
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
    let store = loadStore();
    let activeId = PRESETS.some((p) => p.id === store.activeId) ? store.activeId : 'newapi';
    let current = profileFor(store, activeId);

    const presetRow = el('div', { class: 'llmprobe-presets' });

    const baseUrl = el('input', { class: 'input', placeholder: 'https://api.example.com/v1' });
    const apiKey = el('input', { class: 'input', type: 'password', placeholder: 'sk-… / ark-…' });
    const model = el('select', { class: 'select', style: { flex: '1', minWidth: '200px' } });
    const modelCustom = el('input', {
      class: 'input',
      placeholder: '或手动输入模型名',
      style: { flex: '1', minWidth: '160px', display: 'none' },
    });
    const prompt = el('input', { class: 'input', placeholder: '测通提示词' });
    const hint = el('div', { class: 'llmprobe-hint' });

    function selectedModel() {
      if (modelCustom.style.display !== 'none' && modelCustom.value.trim()) return modelCustom.value.trim();
      return (model.value || modelCustom.value || '').trim();
    }

    function setModelOptions(ids, preferred) {
      const uniq = [...new Set((ids || []).filter(Boolean))];
      const prefer = preferred || '';
      if (!uniq.length && prefer) uniq.push(prefer);
      model.innerHTML = '';
      if (!uniq.length) {
        model.append(el('option', { value: '', text: '点右侧拉取模型列表' }));
        modelCustom.style.display = '';
        modelCustom.value = prefer;
        return;
      }
      for (const id of uniq) model.append(el('option', { value: id, text: id }));
      model.value = uniq.includes(prefer) ? prefer : uniq[0];
      const needCustom = prefer && !uniq.includes(prefer);
      modelCustom.style.display = needCustom ? '' : 'none';
      modelCustom.value = needCustom ? prefer : '';
    }

    function applyForm(profile, preset) {
      baseUrl.value = profile.baseUrl;
      apiKey.value = profile.apiKey;
      prompt.value = profile.prompt;
      hint.textContent = preset.hint;
      setModelOptions(profile.models || [], profile.model || preset.model);
    }

    function persistNow() {
      const prev = store.profiles[activeId] || {};
      const fromSelect = [...model.options].map((o) => o.value).filter(Boolean);
      store = {
        activeId,
        profiles: {
          ...store.profiles,
          [activeId]: {
            baseUrl: baseUrl.value.trim(),
            apiKey: apiKey.value,
            model: selectedModel(),
            models: fromSelect.length ? fromSelect : (prev.models || []),
            prompt: prompt.value.trim() || '只回复：pong',
          },
        },
      };
      saveStore(store);
    }

    const persistSoon = debounce(persistNow, 200);

    function switchPreset(id) {
      persistNow();
      activeId = id;
      const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
      current = profileFor(store, activeId);
      applyForm(current, preset);
      store.activeId = activeId;
      saveStore(store);
      syncPresetButtons();
      toast(`已切换：${preset.label}${current.apiKey ? '（已恢复密钥）' : ''}`);
    }

    const presetBtns = {};
    function syncPresetButtons() {
      Object.entries(presetBtns).forEach(([id, b]) => {
        b.classList.toggle('btn-primary', id === activeId);
      });
    }

    PRESETS.forEach((p) => {
      const b = btn(p.label, () => switchPreset(p.id));
      presetBtns[p.id] = b;
      presetRow.append(b);
    });

    applyForm(current, PRESETS.find((p) => p.id === activeId) || PRESETS[0]);
    syncPresetButtons();

    [baseUrl, apiKey, modelCustom, prompt].forEach((input) => {
      input.addEventListener('input', persistSoon);
      input.addEventListener('change', persistNow);
      input.addEventListener('blur', persistNow);
    });
    model.addEventListener('change', () => {
      modelCustom.style.display = 'none';
      modelCustom.value = '';
      persistNow();
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

    const status = el('div', {
      class: 'llmprobe-status',
      text: current.apiKey ? '已恢复本机保存的密钥，可直接测通' : '填好后点「测通」',
    });
    const meta = el('div', { class: 'result-box' });
    const resp = el('textarea', {
      class: 'tx llmprobe-resp',
      placeholder: '响应摘要…',
    });
    resp.readOnly = true;

    function setStatus(ok, text) {
      status.textContent = text;
      status.classList.toggle('is-ok', ok === true);
      status.classList.toggle('is-err', ok === false);
    }

    async function probeChat() {
      persistNow();
      const base = normalizeBase(baseUrl.value);
      const key = apiKey.value.trim();
      const modelName = selectedModel();
      const userPrompt = prompt.value.trim() || '只回复：pong';
      if (!base) { toast('请填写 Base URL', 'warn'); return; }
      if (!key) { toast('请填写 API Key', 'warn'); return; }
      if (!modelName) { toast('请选择或输入模型名', 'warn'); return; }

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
          toast('测通成功（密钥已保存）');
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
      persistNow();
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
          try {
            const j = JSON.parse(r.body);
            const ids = (j.data || []).map((m) => m.id || m.name).filter(Boolean);
            if (!ids.length) {
              setStatus(false, `未返回模型列表 · ${ms} ms`);
              resp.value = JSON.stringify(j, null, 2);
              return;
            }
            const keep = selectedModel();
            setModelOptions(ids, keep);
            const prev = store.profiles[activeId] || {};
            store = {
              ...store,
              profiles: {
                ...store.profiles,
                [activeId]: {
                  ...prev,
                  baseUrl: baseUrl.value.trim(),
                  apiKey: apiKey.value,
                  model: selectedModel(),
                  models: ids,
                  prompt: prompt.value.trim() || '只回复：pong',
                },
              },
            };
            saveStore(store);
            setStatus(true, `已拉取 ${ids.length} 个模型 · ${ms} ms，可在上方下拉选择`);
            resp.value = ids.join('\n');
            toast(`已拉取 ${ids.length} 个模型，请在「模型」下拉里选择`);
          } catch {
            setStatus(false, `解析模型列表失败 · ${ms} ms`);
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
    const clearBtn = btn('清空当前密钥', () => {
      apiKey.value = '';
      persistNow();
      setStatus(null, '已清空当前预设的密钥');
      toast('已清空当前预设保存的密钥');
    });

    const modelControls = el('div', {
      style: { display: 'flex', gap: '6px', flex: '1', minWidth: '0', alignItems: 'center' },
    }, [model, modelCustom, modelsBtn]);

    const app = el('div', { class: 'llmprobe-app' }, [
      el('div', { class: 'card llmprobe-form' }, [
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, [
          el('div', { class: 'card-title', text: '连接', style: { flexShrink: '0' } }),
          presetRow,
        ]),
        hint,
        el('div', { class: 'form-row' }, [
          field('Base URL', baseUrl, { style: { flex: '1.4', minWidth: '220px' } }),
          field('API Key', apiKey, { style: { flex: '1', minWidth: '160px' } }),
        ]),
        el('div', { class: 'form-row' }, [
          field('模型', modelControls, { style: { flex: '1.4', minWidth: '220px' } }),
          field('测通提示词', prompt, { style: { flex: '1', minWidth: '140px' } }),
        ]),
        el('div', { class: 'form-row', style: { alignItems: 'center' } }, [showKey, testBtn, clearBtn]),
      ]),
      el('div', { class: 'card llmprobe-result' }, [
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between' } }, [
          el('div', { class: 'card-title', text: '结果' }),
          status,
        ]),
        meta,
        resp,
      ]),
    ]);
    container.append(app);

    return () => {
      persistSoon.flush?.();
      persistNow();
    };
  },
};
