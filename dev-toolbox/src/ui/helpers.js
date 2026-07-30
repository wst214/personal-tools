// 通用 DOM 与交互辅助，供各工具复用

export function el(tag, attrs = {}, children = []) {
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
  const kids = (Array.isArray(children) ? children : [children]).flat();
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'object' && c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function textarea(placeholder = '', value = '') {
  return el('textarea', { class: 'tx', placeholder, text: value });
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

export function copyBtn(getText, label = '复制') {
  return btn(label, async () => {
    const text = typeof getText === 'function' ? getText() : getText;
    if (!text) { toast('内容为空', 'warn'); return; }
    try { await copyText(text); toast('已复制'); }
    catch { toast('复制失败', 'error'); }
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
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
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

// 标准两栏布局：输入 | 操作条 | 输出
export function twoPane(opts = {}) {
  const {
    inputPlaceholder = '在此输入…',
    outputPlaceholder = '结果将显示在此',
    outputReadonly = true,
    actions = [],
    inputLabel = '输入',
    outputLabel = '输出',
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

export const isDesktop = () => !!window.toolbox?.isElectron;

