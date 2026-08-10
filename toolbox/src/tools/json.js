import { el } from '../ui/helpers.js';
import { svg } from './base.js';

// 花括号图标，代表 JSON。
const ICON = svg(
  '<path d="M8 4c-1.5 0-2.5 1-2.5 2.5v1.5c0 1-.5 2-1.5 2 1 0 1.5 1 1.5 2v1.5C5.5 18 6.5 19 8 19"/><path d="M16 4c1.5 0 2.5 1 2.5 2.5v1.5c0 1 .5 2 1.5 2-1 0-1.5 1-1.5 2v1.5c0 1.5-1 2.5-2.5 2.5"/>',
);
const CHEVRON_RIGHT = svg('<path d="M9.5 6l6 6-6 6"/>');
const CHEVRON_DOWN = svg('<path d="M6 9.5l6 6 6-6"/>');
const COPY_ICON = svg(
  '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
);

// 大文件保护：超过此大小不回填文本框（textarea 扛不住），只走树视图。
const MAX_INLINE = 2 * 1024 * 1024;
// 单个容器节点一次渲染的子节点数，避免一次性塞几万个 DOM 卡死。
const BATCH = 500;

const electronApi = window.toolbox?.json;
const store = electronApi
  ? electronApi
  : {
      // web 预览：用 <input type=file> 读文件。
      async openFile() {
        return new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json,.txt,.log,.ndjson,application/json';
          input.onchange = () => {
            const f = input.files && input.files[0];
            if (!f) return resolve(null);
            const r = new FileReader();
            r.onload = () => resolve({ name: f.name, content: String(r.result), size: f.size });
            r.onerror = () => resolve({ error: '读取失败' });
            r.readAsText(f);
          };
          input.click();
        });
      },
    };

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function formatValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return '"' + v + '"';
  return String(v);
}

// 简易 JSONPath：支持 $.a.b[0].c / a.b[0] / $['a']['b']。
function evalPath(root, expr) {
  let s = expr.trim();
  if (s.startsWith('$')) s = s.slice(1);
  let cur = root;
  const re = /\.([^.\[]+)|\[(\d+|'[^']*'|"[^"]*")\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (cur == null || typeof cur !== 'object') {
      return { ok: false, error: '路径无效：' + m[0] };
    }
    let key;
    if (m[1] !== undefined) key = m[1];
    else {
      key = m[2];
      if (key[0] === "'" || key[0] === '"') key = key.slice(1, -1);
    }
    if (!(key in cur) && !(Array.isArray(cur) && key === String(Number(key)) && Number(key) < cur.length)) {
      if (!(key in cur)) return { ok: false, error: '路径不存在：' + m[0] };
    }
    cur = cur[key];
    if (cur === undefined) return { ok: false, error: '路径不存在：' + m[0] };
  }
  return { ok: true, value: cur };
}

export const jsonTool = {
  id: 'json',
  title: 'JSON 查看',
  icon: ICON,
  state: {
    raw: '',
    parsed: null,
    error: null,
    sizeInfo: '',
    bigFileNote: '',
    expanded: new Set(['$']),
    batch: {},
    pathQuery: '',
    pathResult: null,
    search: '',
    matchCount: 0,
  },

  async render(container) {
    this.container = container;
    container.innerHTML = '';
    this.root = el('div', { class: 'json-tool' });
    container.append(this.root);
    this.paint();
  },

  onLeave() {},

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const toolbar = el(
      'div',
      { class: 'json-toolbar' },
      el('button', { class: 'btn', onclick: () => this.openFile() }, '打开文件'),
      el('button', { class: 'btn ghost', onclick: () => this.format() }, '格式化'),
      el('button', { class: 'btn ghost', onclick: () => this.compress() }, '压缩'),
      el('button', { class: 'btn ghost', onclick: () => this.copyAll() }, '复制原文'),
      el('span', { class: 'json-spacer' }),
      el('input', {
        class: 'json-path-input',
        type: 'text',
        placeholder: 'JSONPath 如 $.users[0].name',
        value: this.state.pathQuery,
        oninput: (e) => {
          this.state.pathQuery = e.target.value;
        },
        onkeydown: (e) => {
          if (e.key === 'Enter') this.runPath();
        },
      }),
      el('button', { class: 'btn ghost', onclick: () => this.runPath() }, '查询'),
    );

    this.statusEl = el('div', { class: 'json-status' });

    this.inputEl = el('div', { class: 'json-input' });
    this.treeHeaderEl = el('div', { class: 'json-tree-header' },
      el('span', { class: 'json-tree-label' }, '树视图'),
      el('input', {
        class: 'json-search',
        type: 'text',
        placeholder: '搜索 key/值…',
        value: this.state.search,
        oninput: (e) => {
          this.state.search = e.target.value;
          this.paintTree();
        },
      }),
    );
    this.pathResultEl = el('div', { class: 'json-path-result' });
    this.treeEl = el('div', { class: 'json-tree' });
    const right = el('div', { class: 'json-right' }, this.treeHeaderEl, this.pathResultEl, this.treeEl);

    const body = el('div', { class: 'json-body' }, this.inputEl, right);
    this.toastEl = el('div', { class: 'toast' });
    root.append(toolbar, this.statusEl, body, this.toastEl);

    this.paintInput();
    this.paintStatus();
    this.paintTree();
  },

  paintInput() {
    const wrap = this.inputEl;
    wrap.innerHTML = '';
    if (this.state.bigFileNote) {
      wrap.append(el('div', { class: 'empty' }, this.state.bigFileNote));
      return;
    }
    const ta = el('textarea', {
      class: 'json-textarea',
      placeholder: '粘贴 JSON 到这里…（或点上方「打开文件」）',
    });
    ta.value = this.state.raw;
    let timer;
    ta.addEventListener('input', (e) => {
      this.state.raw = e.target.value;
      this.state.sizeInfo = '';
      clearTimeout(timer);
      timer = setTimeout(() => this.reparse(), 250);
    });
    wrap.append(ta);
  },

  paintStatus() {
    if (!this.statusEl) return;
    const s = this.state;
    let txt;
    if (s.error) txt = '✗ 解析失败：' + s.error;
    else if (s.parsed != null) {
      const t = Array.isArray(s.parsed)
        ? `数组 [${s.parsed.length}]`
        : s.parsed === null
          ? 'null'
          : `对象 {${Object.keys(s.parsed).length}}`;
      txt = '✓ 有效 JSON · ' + t + (s.sizeInfo ? ' · ' + s.sizeInfo : '');
    } else txt = s.sizeInfo ? '文件 ' + s.sizeInfo : '就绪';
    if (s.matchCount) txt += ' · 匹配 ' + s.matchCount + ' 项';
    this.statusEl.textContent = txt;
    this.statusEl.className = 'json-status' + (s.error ? ' err' : ' ok');
  },

  reparse() {
    const t = this.state.raw.trim();
    if (!t) {
      this.state.parsed = null;
      this.state.error = null;
      this.state.expanded = new Set(['$']);
      this.state.batch = {};
      this.paintStatus();
      this.paintTree();
      return;
    }
    const r = tryParse(t);
    if (r.ok) {
      this.state.parsed = r.value;
      this.state.error = null;
    } else {
      this.state.parsed = null;
      this.state.error = r.error;
    }
    this.state.expanded = new Set(['$']);
    this.state.batch = {};
    this.paintStatus();
    this.paintTree();
  },

  async openFile() {
    const r = await store.openFile();
    if (!r) return;
    if (r.error) {
      this.toast(r.error, 'err');
      return;
    }
    this.state.sizeInfo = r.name + ' · ' + formatSize(r.size);
    this.state.pathResult = null;
    if (r.content.length > MAX_INLINE) {
      // 大文件：直接解析，不回填文本框（避免 textarea 卡死）。
      const p = tryParse(r.content);
      if (p.ok) {
        this.state.parsed = p.value;
        this.state.raw = '';
        this.state.bigFileNote = `已加载 ${r.name}（${formatSize(r.size)}），文件较大，仅显示树视图`;
        this.state.error = null;
      } else {
        this.state.parsed = null;
        this.state.error = p.error;
        this.state.bigFileNote = '';
      }
    } else {
      this.state.raw = r.content;
      this.state.bigFileNote = '';
      const p = tryParse(r.content);
      if (p.ok) {
        this.state.parsed = p.value;
        this.state.error = null;
      } else {
        this.state.parsed = null;
        this.state.error = p.error;
      }
    }
    this.state.expanded = new Set(['$']);
    this.state.batch = {};
    this.paint();
  },

  format() {
    if (this.state.parsed == null) {
      this.toast('没有有效 JSON', 'err');
      return;
    }
    const out = JSON.stringify(this.state.parsed, null, 2);
    if (out.length > 5 * 1024 * 1024) {
      this.toast('结果 >5MB，未回填文本框', 'err');
      return;
    }
    this.state.raw = out;
    this.state.bigFileNote = '';
    this.paintInput();
    this.toast('已格式化');
  },

  compress() {
    if (this.state.parsed == null) {
      this.toast('没有有效 JSON', 'err');
      return;
    }
    const out = JSON.stringify(this.state.parsed);
    if (out.length > 5 * 1024 * 1024) {
      this.toast('结果 >5MB，未回填文本框', 'err');
      return;
    }
    this.state.raw = out;
    this.state.bigFileNote = '';
    this.paintInput();
    this.toast('已压缩');
  },

  runPath() {
    const q = this.state.pathQuery.trim();
    if (!q) return;
    if (this.state.parsed == null) {
      this.toast('先填有效 JSON', 'err');
      return;
    }
    const r = evalPath(this.state.parsed, q);
    this.state.pathResult = r.ok ? { expr: q, value: r.value } : null;
    this.paintPathResult();
    if (!r.ok) this.toast(r.error, 'err');
  },

  paintPathResult() {
    const w = this.pathResultEl;
    w.innerHTML = '';
    const pr = this.state.pathResult;
    if (!pr) return;
    const val = pr.value;
    const isObj = val !== null && typeof val === 'object';
    const text = isObj ? JSON.stringify(val, null, 2) : formatValue(val);
    w.append(
      el('div', { class: 'pr-expr' }, '➜ ' + pr.expr),
      el(
        'div',
        { class: 'pr-value' + (isObj ? ' obj' : ' ' + (val === null ? 'null' : typeof val)) },
        text,
      ),
      el(
        'div',
        { class: 'pr-actions' },
        el('button', { class: 'btn ghost sm', onclick: () => this.copyText(text) }, '复制结果'),
        el('button', { class: 'btn ghost sm', onclick: () => this.copyText(pr.expr) }, '复制路径'),
      ),
    );
  },

  paintTree() {
    const t = this.treeEl;
    t.innerHTML = '';
    this.state.matchCount = 0;
    if (this.state.error) {
      t.append(el('div', { class: 'json-error' }, '解析失败：' + this.state.error));
      this.paintStatus();
      return;
    }
    if (this.state.parsed == null) {
      t.append(el('div', { class: 'empty' }, '粘贴 JSON 或打开文件'));
      this.paintStatus();
      return;
    }
    t.append(this.renderNode(this.state.parsed, '$', '$', 0, false));
    this.paintStatus();
  },

  renderNode(value, key, path, depth, isArrayItem) {
    const isObj = value !== null && typeof value === 'object';
    const keyLabel =
      path === '$' ? '$' : isArrayItem ? `[${key}]` : key + ':';

    if (isObj) {
      const isArr = Array.isArray(value);
      const count = isArr ? value.length : Object.keys(value).length;
      const isOpen = this.state.expanded.has(path);
      const node = el('div', { class: 'json-node' });
      const header = el(
        'div',
        {
          class: 'json-row json-toggle' + (isOpen ? ' open' : ''),
          style: `padding-left:${depth * 16 + 6}px`,
          onclick: () => this.toggle(path),
        },
        el('span', { class: 'json-chevron', html: isOpen ? CHEVRON_DOWN : CHEVRON_RIGHT }),
        el('span', { class: 'json-key' + (path === '$' ? ' root' : '') + (isArrayItem ? ' idx' : '') }, keyLabel),
        el('span', { class: 'json-type' }, isArr ? `Array[${count}]` : `Object{${count}}`),
        count === 0 ? el('span', { class: 'json-empty-mark' }, '{}') : null,
        el('button', {
          class: 'json-copy',
          html: COPY_ICON,
          onclick: (e) => {
            e.stopPropagation();
            this.copyText(path);
          },
        }),
      );
      node.append(header);
      if (isOpen && count > 0) {
        const children = el('div', { class: 'json-children' });
        const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
        const shown = this.state.batch[path] || BATCH;
        const slice = entries.slice(0, Math.min(shown, entries.length));
        for (const [k, v] of slice) {
          const childPath = isArr ? `${path}[${k}]` : `${path}.${k}`;
          children.append(this.renderNode(v, k, childPath, depth + 1, isArr));
        }
        if (entries.length > shown) {
          children.append(
            el(
              'button',
              {
                class: 'json-more',
                onclick: () => {
                  this.state.batch[path] = shown + BATCH;
                  this.paintTree();
                },
              },
              `显示更多（剩余 ${entries.length - shown} 项）…`,
            ),
          );
        }
        node.append(children);
      }
      return node;
    }

    // 叶子节点
    const s = this.state.search.trim().toLowerCase();
    const matched = s && (String(key).toLowerCase().includes(s) || String(value).toLowerCase().includes(s));
    if (matched) this.state.matchCount++;
    return el(
      'div',
      {
        class: 'json-row json-leaf' + (matched ? ' match' : ''),
        style: `padding-left:${depth * 16 + 6}px`,
      },
      el('span', { class: 'json-chevron' }),
      el('span', { class: 'json-key' + (isArrayItem ? ' idx' : '') }, keyLabel),
      el('span', { class: 'json-value ' + (value === null ? 'null' : typeof value) }, formatValue(value)),
      el('button', {
        class: 'json-copy',
        html: COPY_ICON,
        onclick: (e) => {
          e.stopPropagation();
          this.copyText(path);
        },
      }),
    );
  },

  toggle(path) {
    const s = this.state.expanded;
    if (s.has(path)) s.delete(path);
    else s.add(path);
    this.paintTree();
  },

  async copyAll() {
    if (!this.state.raw) {
      this.toast('文本框为空', 'err');
      return;
    }
    await this.copyText(this.state.raw);
  },

  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast('已复制');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        this.toast('已复制');
      } catch {
        this.toast('复制失败', 'err');
      }
    }
  },

  toast(msg, type = '') {
    this.toastEl.textContent = msg;
    this.toastEl.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toastEl.className = 'toast';
    }, 2200);
  },
};
