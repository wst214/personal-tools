import { el, btn, toast, kvRow } from '../ui/helpers.js';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export const httpTool = {
  id: 'http',
  name: 'HTTP 工具',
  category: '网络',
  icon: '⇄',
  keywords: 'http request post get api rest',
  desc: 'HTTP 请求测试',
  render(c) {
    const method = el('select', { class: 'select' }, METHODS.map((m) => el('option', { value: m, text: m })));
    method.value = 'GET';
    const url = el('input', { class: 'input', placeholder: 'https://example.com/api', style: { flex: '1' } });
    const headers = el('textarea', { class: 'tx', placeholder: 'Headers（每行 Key: Value）', style: { minHeight: '64px' } });
    const body = el('textarea', { class: 'tx', placeholder: '请求体 Body', style: { minHeight: '64px' } });
    const resp = el('textarea', { class: 'tx', placeholder: '响应内容…', style: { minHeight: '140px' } });
    resp.readOnly = true;
    const meta = el('div', { class: 'result-box' });

    const send = btn('发送', async () => {
      if (!window.toolbox?.http) { toast('HTTP 工具需在桌面端运行', 'error'); return; }
      if (!url.value.trim()) { toast('请输入 URL', 'warn'); return; }
      const h = {};
      headers.value.split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
      resp.value = '请求中…';
      meta.innerHTML = '';
      const r = await window.toolbox.http({ url: url.value.trim(), method: method.value, headers: h, body: body.value || undefined, timeout: 30000 });
      if (!r.ok) { resp.value = ''; meta.append(el('div', { class: 'err', text: '错误：' + r.error })); return; }
      meta.append(kvRow('状态', `${r.status} ${r.statusText}`), kvRow('耗时', `${r.ms} ms`), kvRow('Content-Type', r.headers['content-type'] || '-'));
      let text = r.body;
      if ((r.headers['content-type'] || '').includes('json')) { try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch {} }
      resp.value = text;
    }, { variant: 'primary' });

    c.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'form-row' }, [method, url, send]),
        headers,
        body,
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '响应' }), meta, resp]),
    );
  },
};
