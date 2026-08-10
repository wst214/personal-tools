// Shared DOM and interaction helpers.

export function el(tag, attrs = {}, ...rest) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else if (k === 'props' && typeof v === 'object') Object.assign(node, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  const kids = rest.flat();
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function textarea(placeholder = '', value = '') {
  const ta = el('textarea', { class: 'tx', placeholder, text: value });
  // 大文本粘贴优化：Chromium 的 execCommand('insertText') 对 >200KB 文本极慢（1s+），
  // 拦截 paste 改用直接赋值（3ms），保留光标位置。
  ta.addEventListener('paste', (e) => {
    const clip = e.clipboardData;
    if (!clip) return;
    const text = clip.getData('text/plain');
    if (text.length < 200 * 1024) return; // 小文本走默认快路径
    e.preventDefault();
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = before + text + after;
    // 光标移到粘贴内容末尾
    const pos = start + text.length;
    try { ta.setSelectionRange(pos, pos); } catch {}
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return ta;
}

export function btn(label, onClick, opts = {}) {
  const b = el('button', {
    class: 'btn' + (opts.variant ? ' btn-' + opts.variant : ''),
    type: 'button',
    onclick: onClick,
    text: label,
  });
  if (opts.title) b.title = opts.title;
  if (opts.disabled) b.disabled = true;
  return b;
}

export function copyBtn(getText, label = '\u590d\u5236') {
  return btn(label, async () => {
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) { toast('\u5185\u5bb9\u4e3a\u7a7a', 'warn'); return; }
    try { await copyText(text); toast('\u5df2\u590d\u5236'); }
    catch { toast('\u590d\u5236\u5931\u8d25', 'error'); }
  });
}

let toastTimer;
export function toast(msg, type = 'info') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host' });
    document.body.appendChild(host);
  }
  host.textContent = msg;
  host.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.className = 'toast ' + type; }, 1600);
}

export async function copyText(text) {
  if (window.toolbox?.writeClipboard) { window.toolbox.writeClipboard(text); return; }
  if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 200) {
  let t;
  let lastArgs;
  const wrapped = (...a) => {
    lastArgs = a;
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => { clearTimeout(t); t = null; lastArgs = null; };
  wrapped.flush = () => {
    if (t == null && lastArgs == null) return;
    clearTimeout(t);
    t = null;
    const args = lastArgs || [];
    lastArgs = null;
    fn(...args);
  };
  return wrapped;
}

export function download(filename, content, type = 'text/plain') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsText(file);
  });
}

export function twoPane(opts = {}) {
  const {
    inputPlaceholder = '\u5728\u6b64\u8f93\u5165\u2026',
    outputPlaceholder = '\u7ed3\u679c\u5c06\u663e\u793a\u5728\u6b64',
    outputReadonly = true,
    actions = [],
    inputLabel = '\u8f93\u5165',
    outputLabel = '\u8f93\u51fa',
  } = opts;
  const input = textarea(inputPlaceholder);
  const output = textarea(outputPlaceholder);
  if (outputReadonly) output.readOnly = true;
  const actionBar = el('div', { class: 'action-bar' }, actions);
  const inBox = el('div', { class: 'pane' }, [el('div', { class: 'pane-head', text: inputLabel }), input]);
  const outBox = el('div', { class: 'pane' }, [el('div', { class: 'pane-head', text: outputLabel }), output]);
  const body = el('div', { class: 'two-pane' }, [inBox, actionBar, outBox]);
  return { body, input, output, actionBar };
}

export function kvRow(k, v) {
  return el('div', { class: 'kv-row' }, [el('span', { class: 'kv-k', text: k }), el('span', { class: 'kv-v', text: String(v) }), copyBtn(() => String(v))]);
}

export function cardTitle(text) {
  return el('div', { class: 'card-title', text });
}

export function field(label, child, opts = {}) {
  return el('div', { class: 'field', style: opts.style || {} }, [el('label', { text: label }), child]);
}

export const isDesktop = () => !!(window.toolbox?.isElectron || window.toolbox?.isTauri);
