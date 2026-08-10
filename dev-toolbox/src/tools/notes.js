import { el, btn, toast, isDesktop, debounce, escapeHtml, copyText } from '../ui/helpers.js';

const svg = (content) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
const ICON_FOLDER = svg('<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>');
const ICON_FILE = svg('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/>');
const ICON_BOLD = svg('<path d="M7 4h6.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 11h7.5a3.5 3.5 0 0 1 0 7H7z"/>');
const ICON_ITALIC = svg('<path d="M10.5 5h7M6.5 19h7M14.5 5 9.5 19"/>');
const ICON_CODE = svg('<path d="m8.5 8-4 4 4 4"/><path d="m15.5 8 4 4-4 4"/><path d="m13.8 5.5-3.6 13"/>');
const ICON_HEADING = svg('<path d="M6 4v16M18 4v16M6 12h12"/>');
const ICON_LIST = svg('<path d="M8.5 6.5H20M8.5 12H20M8.5 17.5H20"/><path d="M4.5 6.2h.1M4.5 11.7h.1M4.5 17.2h.1"/>');
const ICON_COPY = svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>');

const LS_KEY = 'devtool-notes';
const WELCOME_BODY = '# 随手记\n\n每条笔记都是一个独立的本地文本文件，可以用 Git 管理。\n\n- 点「选择文件夹」可以切换笔记目录\n- 新建的笔记会存到当前目录下\n- 支持 Markdown 预览（标题 / 列表 / 代码 / 表格）';

const loadLS = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } };
const saveLS = (n) => localStorage.setItem(LS_KEY, JSON.stringify(n));

function formatNoteTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN');
}

function normalizeNote(n, index = 0) {
  const now = Date.now();
  const body = n?.body == null ? null : String(n.body);
  const tsRaw = Number(n?.ts ?? n?.createdAt ?? n?.updatedAt ?? 0);
  const updatedRaw = Number(n?.updatedAt ?? n?.ts ?? n?.mtime ?? 0);
  const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : now;
  const updatedAt = Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : ts;
  return {
    type: 'file',
    id: n?.id || n?.path || now + index,
    path: n?.path || null,
    title: String(n?.title || (body ? firstTitle(body) : '') || 'Untitled Note'),
    body,
    ts,
    updatedAt,
  };
}

function firstTitle(text) {
  const line = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line ? line.replace(/^#+\s*/, '').slice(0, 48) : '';
}

function filename(note) {
  const name = (note?.title || 'Untitled Note').replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled Note';
  return `${name}.txt`;
}

function plainLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function markdownToHtml(source) {
  const lines = String(source || '').split(/\r?\n/);
  const html = [];
  let inCode = false;
  let codeLines = [];
  let codeLang = '';

  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  const flushCode = () => {
    if (!codeLines.length) { codeLang = ''; return; }
    const code = codeLines.join('\n');
    if (codeLang === 'mermaid') {
      // 转义后放入 .mermaid 容器，由 mermaid.run() 读取 textContent 渲染成 SVG
      html.push(`<div class="mermaid">${escapeHtml(code)}</div>`);
    } else {
      html.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    }
    codeLines = [];
    codeLang = '';
  };

  const isTableRow = (s) => /\|/.test(s) && /^\s*\|?.*\|.*$/.test(s.trim());
  const isTableSep = (s) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(s);
  const splitCells = (s) => {
    let t = s.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      if (!inCode) codeLang = line.trim().replace(/^```/, '').trim().toLowerCase();
      inCode = !inCode;
      if (!inCode) flushCode();
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      html.push('');
      continue;
    }
    // GFM 表格：当前行含 |，下一行是分隔行
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && lines[i].trim()) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      i--;
      const thead = `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${headers.map((_, ci) => `<td>${inline(r[ci] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
      html.push(`<table class="md-table">${thead}${tbody}</table>`);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      html.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      html.push(`<p class="md-bullet">• ${inline(bullet[1])}</p>`);
      continue;
    }
    html.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) flushCode();
  return html.join('\n') || '<p class="note-empty">开始写一点东西...</p>';
}

export const notesTool = {
  id: 'notes',
  name: '随手记',
  category: '其它',
  icon: '▤',
  keywords: 'notes memo 随手记 笔记 markdown',
  desc: '本地 Markdown 快速笔记',
  render(c) {
    let tree = [];          // 目录树：[{type:'dir'|'file', ...}]
    let loaded = false;
    let selectedId = null;   // 当前笔记文件 path
    let activeDir = '';      // 新建目标目录（'' = 根）
    const expanded = new Set(); // 展开的文件夹 path
    let mode = 'preview';
    let query = '';
    let searchBody = true;
    let sortBy = 'updated';
    let notesDir = '';
    let defaultDir = '';

    const title = el('input', { class: 'note-title-input', placeholder: 'Untitled Note' });
    const editor = el('textarea', { class: 'note-textarea', spellcheck: 'false' });
    const preview = el('div', { class: 'note-preview' });
    const noteList = el('div', { class: 'note-list' });
    // 空白区域右键：新建笔记 / 新建文件夹
    noteList.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest('.note-list-item') || ev.target.closest('.note-tree-dir')) return;
      ev.preventDefault();
      showBlankMenu(ev.clientX, ev.clientY);
    });
    const status = el('div', { class: 'note-status', text: '加载中...' });
    const fileLabel = el('div', { class: 'note-file-label', text: '' });
    const dirLabel = el('span', { class: 'note-dir-path', text: '-', title: '' });
    const defaultBadge = el('span', { class: 'note-default-badge', text: '★ 默认' });
    const activeHint = el('span', { class: 'note-active-hint', text: '' });
    const search = el('input', {
      class: 'note-search',
      type: 'search',
      placeholder: '搜索笔记...',
      oninput: (e) => { query = e.target.value.trim().toLowerCase(); runSearchSoon(); },
    });
    const modeBtns = {
      edit: btn('编辑', () => setMode('edit'), { variant: 'ghost' }),
      split: btn('分栏', () => setMode('split'), { variant: 'ghost' }),
      preview: btn('预览', () => setMode('preview'), { variant: 'ghost' }),
    };
    const outlineToggle = btn('结构', toggleOutline, { variant: 'ghost' });
    outlineToggle.classList.add('note-panel-toggle');

    // 拖拽分隔条
    const resizerLib = el('div', { class: 'note-resizer note-resizer-lib', title: '拖动调整宽度' });
    const resizerPaper = el('div', { class: 'note-resizer note-resizer-paper', title: '拖动调整宽度' });
    const resizerOutline = el('div', { class: 'note-resizer note-resizer-outline', title: '拖动调整宽度' });

    // 文档结构大纲
    const outlineBody = el('div', { class: 'note-outline-body' });
    const outlinePanel = el('aside', { class: 'note-outline' }, [
      el('div', { class: 'note-outline-head' }, [
        el('span', { class: 'note-outline-title', text: '文档结构' }),
        el('button', { class: 'note-icon-btn note-outline-close', type: 'button', title: '收起', text: '×', onclick: () => toggleOutline(false) }),
      ]),
      outlineBody,
    ]);

    const noteLibrary = el('aside', { class: 'note-library' }, [
      search,
      noteList,
    ]);
    const notePaper = el('div', { class: 'note-paper' }, [editor, resizerPaper, preview]);

    const noteShell = el('div', { class: 'note-workbench' }, [
      el('div', { class: 'note-dir-bar' }, [
        el('span', { class: 'note-dir-icon', html: ICON_FOLDER }),
        dirLabel,
        defaultBadge,
        activeHint,
        el('span', { class: 'note-dir-spacer' }),
        btn('设为默认', setDefault, { variant: 'ghost' }),
        btn('选择文件夹', pickDir, { variant: 'ghost' }),
        btn('刷新', reloadNotes, { variant: 'ghost' }),
        btn('打开目录', revealDir, { variant: 'ghost' }),
        el('span', { class: 'note-dir-sep' }),
        el('div', { class: 'note-head-controls' }, [
          el('div', { class: 'note-mode-switch' }, [modeBtns.edit, modeBtns.split, modeBtns.preview]),
          outlineToggle,
        ]),
      ]),
      el('div', { class: 'note-workbench-body' }, [
        noteLibrary,
        resizerLib,
        el('section', { class: 'note-editor-shell' }, [
          el('div', { class: 'note-editor-toolbar' }, [
            el('button', { class: 'note-icon-btn', type: 'button', title: '加粗', html: ICON_BOLD, onclick: () => wrapSelection('**') }),
            el('button', { class: 'note-icon-btn', type: 'button', title: '斜体', html: ICON_ITALIC, onclick: () => wrapSelection('*') }),
            el('button', { class: 'note-icon-btn', type: 'button', title: '行内代码', html: ICON_CODE, onclick: () => wrapSelection('`') }),
            el('button', { class: 'note-icon-btn', type: 'button', title: '标题', html: ICON_HEADING, onclick: () => prefixSelection('# ') }),
            el('button', { class: 'note-icon-btn', type: 'button', title: '列表', html: ICON_LIST, onclick: () => prefixSelection('- ') }),
            el('span', { class: 'note-toolbar-spacer' }),
            el('select', { class: 'select note-toolbar-select', disabled: true, title: '仅支持 Markdown' }, [el('option', { text: 'Markdown' })]),
            el('select', { class: 'select note-toolbar-select small', title: '正文字号', onchange: (e) => {
              const px = e.target.value + 'px';
              editor.style.fontSize = px;
              preview.style.fontSize = px;
            } }, [14, 15, 16, 18].map((n) => el('option', { text: String(n), value: String(n), selected: n === 14 ? 'selected' : null })) ),
            el('select', { class: 'select note-toolbar-select small', title: '缩放', onchange: (e) => {
              const s = e.target.value.replace('×', '');
              editor.style.zoom = s;
              preview.style.zoom = s;
            } }, ['1.0×', '1.1×', '1.2×'].map((n) => el('option', { text: n })) ),
            el('button', { class: 'note-icon-btn', type: 'button', title: '复制正文', html: ICON_COPY, onclick: copyCurrent }),
          ]),
          el('div', { class: 'note-title-row' }, [title]),
          notePaper,
          el('div', { class: 'note-editor-foot' }, [fileLabel, status]),
        ]),
        resizerOutline,
        outlinePanel,
      ]),
    ]);

    c.append(noteShell);

    // ---- 列宽拖拽（持久化）----
    const LAYOUT_KEY = 'devtool-notes-layout';
    const loadLayout = () => { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; } };
    const saveLayout = (v) => localStorage.setItem(LAYOUT_KEY, JSON.stringify(v));
    const layout = loadLayout();
    if (layout.lib) noteShell.style.setProperty('--nw-lib', layout.lib);
    if (layout.ed) noteShell.style.setProperty('--nw-ed', layout.ed);

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    function attachColResize(handle, opts) {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handle.classList.add('dragging');
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
        const startX = e.clientX;
        const ctx = opts.onStart ? opts.onStart() : {};
        const move = (ev) => opts.onMove(ev.clientX - startX, ctx);
        const up = () => {
          handle.classList.remove('dragging');
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          if (opts.onEnd) opts.onEnd(ctx);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }
    attachColResize(resizerLib, {
      onStart: () => ({ startW: noteLibrary.getBoundingClientRect().width }),
      onMove: (dx, ctx) => {
        const w = clamp(ctx.startW + dx, 200, 560);
        noteShell.style.setProperty('--nw-lib', w + 'px');
      },
      onEnd: () => { layout.lib = noteShell.style.getPropertyValue('--nw-lib') || layout.lib; saveLayout(layout); },
    });
    attachColResize(resizerPaper, {
      onStart: () => {
        const rect = notePaper.getBoundingClientRect();
        const basis = parseFloat(getComputedStyle(editor).flexBasis);
        return { paperW: rect.width || 1, startEd: isNaN(basis) ? 50 : basis };
      },
      onMove: (dx, ctx) => {
        const pct = clamp(ctx.startEd + (dx / ctx.paperW) * 100, 20, 80);
        noteShell.style.setProperty('--nw-ed', pct + '%');
      },
      onEnd: () => { layout.ed = noteShell.style.getPropertyValue('--nw-ed') || layout.ed; saveLayout(layout); },
    });
    attachColResize(resizerOutline, {
      onStart: () => ({ startW: outlinePanel.getBoundingClientRect().width }),
      onMove: (dx, ctx) => {
        const w = clamp(ctx.startW - dx, 160, 460); // 向右拖=变窄
        noteShell.style.setProperty('--nw-outline', w + 'px');
      },
      onEnd: () => { layout.outline = noteShell.style.getPropertyValue('--nw-outline') || layout.outline; saveLayout(layout); },
    });

    // ---- 文档结构大纲 ----
    if (layout.outline) noteShell.style.setProperty('--nw-outline', layout.outline);
    function toggleOutline(open) {
      const next = typeof open === 'boolean' ? open : noteShell.dataset.outline !== 'open';
      noteShell.dataset.outline = next ? 'open' : 'closed';
      outlineToggle.classList.toggle('active', next);
      layout.outlineOpen = next;
      saveLayout(layout);
    }
    function buildOutline(body) {
      const text = String(body || '');
      const lines = text.split(/\r?\n/);
      const items = [];
      let inCode = false;
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; offset += line.length + 1; continue; }
        if (!inCode) {
          const m = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
          if (m) {
            const level = m[1].length;
            const t = m[2].replace(/[*_`]/g, '').trim();
            if (t) items.push({ level, text: t, offset });
          }
        }
        offset += line.length + 1;
      }
      return items;
    }
    const renderOutlineSoon = debounce(renderOutline, 220);
    function renderOutline() {
      const note = current();
      const items = note ? buildOutline(note.body || editor.value) : [];
      outlineBody.innerHTML = '';
      if (!items.length) {
        outlineBody.append(el('div', { class: 'note-outline-empty', text: '无标题\n输入 # 标题即可生成大纲' }));
        return;
      }
      items.forEach((it) => {
        outlineBody.append(el('button', {
          class: 'note-outline-item note-outline-l' + it.level,
          type: 'button',
          title: it.text,
          onclick: () => jumpTo(it),
        }, [el('span', { text: it.text })]));
      });
    }
    function jumpTo(item) {
      // 编辑器：把光标移到标题处，textarea 自动滚动到可见
      try {
        editor.focus();
        editor.setSelectionRange(item.offset, item.offset);
        editor.blur();
      } catch {}
      // 预览：若可见，滚动到对应标题
      const heads = preview.querySelectorAll('h1, h2, h3');
      for (const h of heads) {
        if ((h.textContent || '').trim().replace(/[*_`]/g, '') === item.text) {
          h.scrollIntoView({ block: 'start', behavior: 'smooth' });
          h.classList.add('note-flash');
          setTimeout(() => h.classList.remove('note-flash'), 1200);
          break;
        }
      }
    }
    // 初始展开状态
    toggleOutline(layout.outlineOpen !== false);

    const saveSoon = debounce(saveActive, 420);

    // 正文编辑：分栏/预览下实时刷预览；纯编辑态延后到切视图时再渲染（见 setMode）
    const renderPreviewSoon = debounce(() => {
      if (noteShell.dataset.mode !== 'edit') renderPreview();
      renderOutline();
    }, 280);
    const renderTreeSoon = debounce(() => renderTree(), 200);
    title.addEventListener('input', () => {
      const note = current();
      if (!note) return;
      note.title = title.value.trim() || 'Untitled Note';
      note.updatedAt = Date.now();
      renderTreeSoon();
      updateFooter();
      saveSoon();
    });
    editor.addEventListener('input', () => {
      const note = current();
      if (!note) return;
      note.body = editor.value;
      if (!title.value.trim()) {
        const next = firstTitle(note.body) || 'Untitled Note';
        note.title = next;
        title.value = next;
        renderTreeSoon();
      }
      note.updatedAt = Date.now();
      renderPreviewSoon();
      updateFooter('保存中...');
      saveSoon();
    });

    // ---- 树操作辅助 ----
    function findNode(pred, nodes = tree) {
      for (const n of nodes) { if (pred(n)) return n; if (n.type === 'dir') { const r = findNode(pred, n.children); if (r) return r; } }
      return null;
    }
    const current = () => findNode((n) => n.type === 'file' && n.id === selectedId);
    function findParentDir(child, nodes = tree) {
      for (const n of nodes) { if (n.type === 'dir') { if (n.children.includes(child)) return n; const r = findParentDir(child, n.children); if (r) return r; } }
      return null;
    }
    const parentPathOf = (node) => findParentDir(node)?.path || '';
    function flatten(nodes = tree, out = []) {
      for (const n of nodes) { if (n.type === 'file') out.push(n); else flatten(n.children, out); }
      return out;
    }
    function dirNode(dirPath) { return dirPath ? findNode((n) => n.type === 'dir' && n.path === dirPath) : null; }
    function insertNode(parentPath, node) {
      const parent = dirNode(parentPath);
      if (parent) { parent.children.unshift(node); expanded.add(parent.path); parent.expanded = true; }
      else tree.unshift(node);
    }
    function removeNode(id) {
      (function walk(nodes) {
        const i = nodes.findIndex((n) => (n.type === 'file' && n.id === id) || (n.type === 'dir' && n.path === id));
        if (i >= 0) { nodes.splice(i, 1); return true; }
        for (const n of nodes) if (n.type === 'dir' && walk(n.children)) return true;
        return false;
      })(tree);
    }
    function updateFileNode(oldPath, note) {
      const node = findNode((n) => n.type === 'file' && n.path === oldPath);
      if (!node) return;
      node.id = note.id; node.path = note.path; node.file = note.file; node.title = note.title; node.body = note.body; node.updatedAt = note.updatedAt;
    }
    function sortFiles(list) {
      list.sort((a, b) => {
        if (sortBy === 'title') return a.title.localeCompare(b.title, 'zh-CN');
        if (sortBy === 'created') return b.ts - a.ts;
        return (b.updatedAt || b.ts) - (a.updatedAt || a.ts);
      });
      return list;
    }

    // 统一 Electron（file/title）与 Tauri（name）两种树节点形状
    function baseName(p) {
      if (!p) return '';
      const parts = String(p).replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] || '';
    }
    function decorateTree(nodes) {
      if (!Array.isArray(nodes)) return [];
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (n.type === 'dir') {
          if (!n.name) n.name = n.title || baseName(n.path) || 'Folder';
          n.title = n.name;
          n.id = n.path || n.name;
          if (n.children) decorateTree(n.children);
        } else {
          if (!n.name) n.name = n.file || (n.title ? `${n.title}.md` : baseName(n.path));
          if (!n.file) n.file = n.name;
          if (!n.title) n.title = String(n.name).replace(/\.(md|markdown|txt)$/i, '') || 'Untitled Note';
          n.id = n.id || n.path || n.name;
          const mtime = Number(n.updatedAt ?? n.ts ?? n.mtime ?? 0);
          n.updatedAt = Number.isFinite(mtime) && mtime > 0 ? mtime : undefined;
          n.ts = n.ts || n.updatedAt;
        }
      }
      return nodes;
    }

    function setDir(dir) {
      notesDir = dir || '';
      dirLabel.textContent = notesDir || (isDesktop() ? '（默认目录）' : '预览模式：浏览器 localStorage');
      dirLabel.title = notesDir;
      updateDefaultBadge();
    }
    // 默认展开顶层文件夹（直接位于根目录下的文件夹），子文件夹保持折叠
    function expandTopLevel() {
      tree.forEach((n) => { if (n.type === 'dir' && n.path) expanded.add(n.path); });
    }
    function updateDefaultBadge() {
      const isDefault = !!notesDir && notesDir === defaultDir;
      defaultBadge.style.display = isDefault ? '' : 'none';
      const setBtn = [...document.querySelectorAll('.note-dir-bar .btn')].find((b) => b.textContent.trim() === '设为默认' || b.textContent.trim() === '已设为默认');
      if (setBtn) {
        setBtn.disabled = isDefault || !isDesktop();
        setBtn.textContent = isDefault ? '已设为默认' : '设为默认';
      }
    }
    async function setDefault() {
      if (!isDesktop()) { toast('仅桌面版支持', 'warn'); return; }
      if (!notesDir) { toast('请先选择文件夹', 'warn'); return; }
      const r = await window.toolbox.notesSetDefault(notesDir);
      if (!r.ok) { toast('设置失败：' + r.error, 'error'); return; }
      defaultDir = r.defaultDir;
      updateDefaultBadge();
      toast('已设为默认文件夹，下次启动自动加载', 'success');
    }
    function setActive(dirPath) {
      activeDir = dirPath || '';
      activeHint.textContent = activeDir ? '→ 新建到此文件夹' : '';
      activeHint.title = activeDir || '';
    }

    // ---- 列表渲染（树形）----
    let searchSeq = 0;
    const runSearchSoon = debounce(runSearch, 180);
    async function runSearch() {
      const q = query;
      if (!q) { renderTree(); return; } // 无搜索词：回到树形
      noteList.innerHTML = '';
      // 标题搜索：本地即时（无需读文件）
      if (!searchBody) {
        const list = flatten().filter((n) => n.title.toLowerCase().includes(q));
        sortFiles(list);
        if (!list.length) { noteList.append(el('div', { class: 'note-list-empty', text: '没有匹配的笔记' })); return; }
        list.forEach((n) => noteList.append(fileRow(n, 0)));
        return;
      }
      // 正文搜索：服务端 grep（命中即停、封顶 300）
      const mySeq = ++searchSeq;
      noteList.append(el('div', { class: 'note-list-empty', text: '搜索中...' }));
      let r = { ok: false, results: [] };
      if (isDesktop()) { try { r = await window.toolbox.notesSearch({ dir: notesDir, query: q, inBody: true }); } catch {} }
      if (mySeq !== searchSeq) return; // 已被新搜索覆盖，丢弃旧结果
      const list = (r.results || []).map(normalizeNote);
      sortFiles(list);
      noteList.innerHTML = '';
      if (!list.length) { noteList.append(el('div', { class: 'note-list-empty', text: '没有匹配的笔记' })); return; }
      list.forEach((n) => noteList.append(fileRow(n, 0)));
    }
    function renderTree() {
      noteList.innerHTML = '';
      if (!loaded) { noteList.append(el('div', { class: 'note-list-empty', text: '加载中...' })); return; }
      if (query) { runSearch(); return; }
      if (!tree.length) { noteList.append(el('div', { class: 'note-list-empty', text: '空文件夹，点「新建笔记」添加' })); return; }
      renderNodes(tree, 0, noteList);
    }
    function renderNodes(nodes, depth, container) {
      for (const n of nodes) container.append(n.type === 'dir' ? dirRow(n, depth) : fileRow(n, depth));
    }
    function dirRow(n, depth) {
      const isOpen = expanded.has(n.path);
      const head = el('button', {
        class: 'note-tree-dir' + (activeDir === n.path ? ' active' : ''),
        type: 'button',
        style: { paddingLeft: 8 + depth * 14 + 'px' },
        onclick: () => { setActive(activeDir === n.path ? '' : n.path); toggleDir(n); },
        oncontextmenu: (ev) => { ev.preventDefault(); showDirMenu(ev.clientX, ev.clientY, n); },
      }, [
        el('span', { class: 'note-tree-twist', text: isOpen ? '▾' : '▸' }),
        el('span', { class: 'note-tree-icon', html: ICON_FOLDER }),
        el('span', { class: 'note-tree-name', text: n.name || n.title || '' }),
        el('span', { class: 'note-tree-add', title: '新建笔记', text: '＋', onclick: (e) => { e.stopPropagation(); setActive(n.path); expanded.add(n.path); createNote(); } }),
      ]);
      const wrap = el('div', { class: 'note-tree-dir-wrap' }, [head]);
      if (isOpen) {
        const kids = el('div', { class: 'note-tree-children' });
        renderNodes(n.children, depth + 1, kids);
        wrap.append(kids);
      }
      return wrap;
    }
    function selectNote(n) {
      selectedId = n.id; setActive(parentPathOf(n)); loadCurrent();
      noteList.querySelectorAll('.note-list-item.active').forEach((el) => el.classList.remove('active'));
      const target = noteList.querySelector('.note-list-item[data-id="' + n.id + '"]');
      if (target) target.classList.add('active');
    }
    function fileRow(n, depth) {
      const row = el('button', {
        class: 'note-list-item' + (n.id === selectedId ? ' active' : ''),
        type: 'button',
        dataset: { id: n.id },
        style: { paddingLeft: 8 + depth * 14 + 'px' },
        onclick: (ev) => {
          selectNote(n);
          ev.currentTarget.classList.add('active');
        },
        oncontextmenu: (ev) => { ev.preventDefault(); showNoteMenu(ev.clientX, ev.clientY, n); },
      }, [
        el('span', { class: 'note-list-icon', text: '▤' }),
        el('span', { class: 'note-list-main' }, [
          el('span', { class: 'note-list-title', text: n.title || 'Untitled Note' }),
          el('span', { class: 'note-list-meta', text: formatNoteTime(n.updatedAt || n.ts) }),
        ]),
      ]);
      return row;
    }
    // 右键菜单（统一实现）
    let ctxMenu = null;
    function closeCtx() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
    function showCtx(x, y, items) {
      closeCtx();
      ctxMenu = el('div', { class: 'note-ctx-menu', style: { left: x + 'px', top: y + 'px' } });
      for (const it of items) {
        ctxMenu.append(el('button', {
          class: 'note-ctx-item' + (it.danger ? ' danger' : ''),
          type: 'button',
          onclick: () => { closeCtx(); it.action(); },
        }, it.label));
      }
      document.body.append(ctxMenu);
      setTimeout(() => document.addEventListener('click', closeCtx, { once: true }), 0);
    }
    function showNoteMenu(x, y, note) {
      showCtx(x, y, [
        { label: '重命名', action: () => renameNote(note) },
        { label: '复制笔记', action: () => { selectNote(note); duplicateNote(); } },
        { label: '删除笔记', danger: true, action: () => { selectNote(note); deleteNote(); } },
      ]);
    }
    function showDirMenu(x, y, dir) {
      showCtx(x, y, [
        { label: '新建笔记', action: () => { setActive(dir.path); expanded.add(dir.path); createNote(); } },
        { label: '新建文件夹', action: () => { setActive(dir.path); expanded.add(dir.path); createDir(); } },
      ]);
    }
    function showBlankMenu(x, y) {
      showCtx(x, y, [
        { label: '新建笔记', action: () => createNote() },
        { label: '新建文件夹', action: () => createDir() },
      ]);
    }

    function toggleDir(n) {
      if (expanded.has(n.path)) expanded.delete(n.path); else expanded.add(n.path);
      renderTree();
    }

    async function loadCurrent() {
      const note = current();
      title.value = note?.title || '';
      editor.value = '';
      // 正文懒加载：仅选中时读取该文件内容
      if (note && note.body == null && isDesktop() && note.path) {
        editor.placeholder = '加载中...';
        const r = await window.toolbox.notesReadFile(note.path);
        if (note !== current()) return; // 选中已切换，丢弃
        note.body = r.ok ? r.body : '';
        editor.placeholder = '';
      }
      editor.value = note?.body || '';
      renderPreview();
      updateFooter();
      renderOutline();
    }
    function renderPreview() {
      preview.innerHTML = markdownToHtml(editor.value);
      renderMermaid();
    }
    // 懒加载 mermaid：仅当预览里存在 .mermaid 块时才动态导入并渲染为 SVG
    let mermaidLoading = null;
    function ensureMermaid() {
      if (!mermaidLoading) {
        mermaidLoading = import('mermaid').then((mod) => {
          const mermaid = mod.default || mod.mermaid;
          // loose：与 Obsidian 一致，允许 <br/> 等 HTML，减少误报语法错误
          mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
          return mermaid;
        });
      }
      return mermaidLoading;
    }
    async function renderMermaid() {
      const pending = Array.from(preview.querySelectorAll('.mermaid')).filter((n) => !n.dataset.rendered && n.isConnected);
      if (!pending.length) return;
      let mermaid;
      try { mermaid = await ensureMermaid(); }
      catch { pending.forEach((n) => { n.dataset.rendered = '1'; n.classList.add('mermaid-error'); n.textContent = 'mermaid 加载失败'; }); return; }
      // 逐个渲染：单张图失败不影响其它图
      for (const node of pending) {
        if (!node.isConnected || node.dataset.rendered) continue;
        node.dataset.rendered = '1';
        const src = node.textContent;
        try {
          await mermaid.run({ nodes: [node] });
          if (!node.querySelector('svg')) throw new Error('未生成图形');
        } catch (err) {
          node.classList.add('mermaid-error');
          node.innerHTML = '';
          node.append(el('div', { class: 'mermaid-err-msg', text: '⚠ 图表语法错误：' + (err?.message || '解析失败') }));
          node.append(el('pre', { class: 'mermaid-src', text: src }));
        }
      }
    }
    function updateFooter(label = '笔记已保存') {
      const note = current();
      fileLabel.textContent = note ? (note.path ? note.path : filename(note)) : '';
      const lines = editor.value ? editor.value.split(/\r?\n/).length : 0;
      status.textContent = note ? `${label}  ${lines} 行 · ${plainLength(editor.value)} 字符` : label;
    }

    // ---- 操作 ----
    async function createNote() {
      const targetDir = activeDir || notesDir;
      if (isDesktop()) {
        const r = await window.toolbox.notesCreate({ dir: targetDir });
        if (!r.ok) { toast('新建失败：' + r.error, 'error'); return; }
        const node = normalizeNote(r.note);
        insertNode(activeDir, node);
        selectedId = node.id;
        loadCurrent(); setMode('edit'); renderTree(); title.focus();
      } else {
        const node = normalizeNote({ title: 'Untitled Note', body: '', ts: Date.now(), updatedAt: Date.now() });
        tree.unshift(node); selectedId = node.id; loadCurrent(); renderTree(); saveActive();
      }
    }
    async function createDir() {
      if (!isDesktop()) { toast('仅桌面版支持新建文件夹', 'warn'); return; }
      const name = window.prompt('文件夹名称', 'New Folder');
      if (!name) return;
      const r = await window.toolbox.notesCreateDir({ parent: activeDir || notesDir, name });
      if (!r.ok) { toast('新建失败：' + r.error, 'error'); return; }
      const seg = String(r.path).split(/[\\/]/).pop();
      insertNode(activeDir, { type: 'dir', name: seg, path: r.path, expanded: true, children: [] });
      expanded.add(r.path);
      setActive(r.path);
      renderTree();
      toast('已新建文件夹', 'success');
    }
    async function duplicateNote() {
      const src = current();
      if (!src) return;
      let body = src.body;
      if (body == null && isDesktop() && src.path) {
        const r = await window.toolbox.notesReadFile(src.path);
        body = r.ok ? r.body : '';
      }
      const dir = parentPathOf(src) || notesDir;
      if (isDesktop()) {
        const r = await window.toolbox.notesSave({ dir, title: `${src.title} Copy`, body });
        if (!r.ok) { toast('复制失败：' + r.error, 'error'); return; }
        const node = normalizeNote(r.note);
        insertNode(parentPathOf(src) || '', node);
        selectedId = node.id; loadCurrent(); renderTree();
        toast('已复制', 'success');
      } else {
        const node = normalizeNote({ title: `${src.title} Copy`, body, ts: Date.now(), updatedAt: Date.now() });
        tree.unshift(node); selectedId = node.id; loadCurrent(); renderTree(); saveActive();
      }
    }
    async function deleteNote() {
      const note = current();
      if (!note) return;
      if (isDesktop() && note.path) {
        const r = await window.toolbox.notesDelete(note.path);
        if (!r.ok) { toast('删除失败：' + r.error, 'error'); return; }
      }
      removeNode(note.id);
      const next = flatten()[0];
      selectedId = next?.id || null;
      if (!selectedId) { await createNote(); }
      else { loadCurrent(); renderTree(); if (!isDesktop()) saveActive(); }
      toast('已删除', 'success');
    }
    async function renameNote(note) {
      if (!note) return;
      const next = window.prompt('重命名笔记', note.title || '');
      if (next == null) return;
      const newTitle = String(next).trim();
      if (!newTitle) { toast('名称不能为空', 'warn'); return; }
      if (newTitle === note.title) return;

      if (isDesktop() && note.path && window.toolbox?.notesRename) {
        const wasSelected = note.id === selectedId || note.path === (current()?.path);
        if (wasSelected) {
          // 取消标题输入触发的防抖保存，先把正文写回旧文件名，再真正改名
          saveSoon.cancel?.();
          note.body = editor.value;
          const stem = String(note.file || note.name || note.path || '')
            .replace(/\.(md|markdown|txt)$/i, '') || note.title;
          note.title = stem;
          await saveActive();
          // saveActive 可能已改 path
          note.path = current()?.path || note.path;
        }
        const oldPath = note.path;
        const r = await window.toolbox.notesRename({ oldPath, title: newTitle });
        if (!r.ok) { toast('重命名失败：' + (r.error || ''), 'error'); return; }
        const updated = normalizeNote({ ...note, ...r.note, body: note.body });
        const node = findNode((n) => n.id === note.id || n.path === oldPath || n.path === note.path);
        if (node) {
          Object.assign(node, {
            id: updated.id,
            path: updated.path,
            file: updated.file,
            name: updated.file,
            title: updated.title,
            ts: updated.ts,
            updatedAt: updated.updatedAt,
          });
        }
        if (wasSelected) {
          selectedId = updated.id;
          title.value = updated.title;
          updateFooter('已重命名');
        }
        renderTree();
        toast('已重命名', 'success');
        return;
      }

      // 浏览器 / 无 rename API：改标题后走保存
      note.title = newTitle;
      if (note.id === selectedId) title.value = newTitle;
      if (isDesktop() && note.path) {
        await saveActive();
      } else {
        saveActive();
      }
      renderTree();
      toast('已重命名', 'success');
    }
    async function pickDir() {
      if (!isDesktop()) { toast('仅桌面版支持选择文件夹', 'warn'); return; }
      const r = await window.toolbox.notesPickDir();
      if (r.canceled) return;
      if (!r.ok) { toast('打开失败：' + r.error, 'error'); return; }
      setDir(r.dir); tree = decorateTree(r.tree || []); if (r.defaultDir) defaultDir = r.defaultDir; setActive(''); expanded.clear(); expandTopLevel();
      if (!flatten().length) { await createNote(); return; }
      selectedId = flatten()[0].id;
      loadCurrent(); renderTree();
      toast('已切换目录', 'success');
    }
    // 刷新：重新加载当前目录树（外部新增/删除文件后用），保留展开状态与当前选中
    async function reloadNotes() {
      if (!isDesktop()) { toast('仅桌面版支持刷新', 'warn'); return; }
      const r = await window.toolbox.notesList();
      if (!r.ok) { toast('刷新失败：' + r.error, 'error'); return; }
      const prevExpanded = new Set(expanded);
      const prevSelected = selectedId;
      tree = decorateTree(r.tree || []);
      // 保留之前展开过的文件夹（若仍存在）；再补顶层展开
      expanded.clear();
      flatten().forEach(() => {});
      // 重建 expanded：只保留仍存在的目录，并确保顶层展开
      const allDirs = [];
      (function walk(nodes) { for (const n of nodes) { if (n.type === 'dir') { allDirs.push(n.path); walk(n.children); } } })(tree);
      allDirs.forEach((p) => { if (prevExpanded.has(p)) expanded.add(p); });
      expandTopLevel();
      // 选中之前那条；若已不在，回退到第一条
      if (!flatten().some((n) => n.id === prevSelected)) selectedId = flatten()[0]?.id || null;
      loadCurrent(); renderTree();
      toast('已刷新', 'success');
    }
    async function revealDir() {
      if (!isDesktop()) { toast('仅桌面版支持', 'warn'); return; }
      await window.toolbox.notesReveal(notesDir);
    }

    function setMode(next) {
      const note = current();
      if (note) {
        note.body = editor.value;
        note.title = title.value.trim() || note.title || 'Untitled Note';
      }
      mode = next;
      noteShell.dataset.mode = mode;
      Object.entries(modeBtns).forEach(([key, b]) => b.classList.toggle('active', key === mode));
      // 编辑态为省性能不实时刷预览；切到分栏/预览时立刻用当前编辑器内容重渲染
      if (mode !== 'edit') {
        renderPreviewSoon.cancel?.();
        renderPreview();
        renderOutline();
      }
      // 切视图时立刻落盘，避免只停在「保存中…」
      saveSoon.flush?.();
      if (mode === 'edit') editor.focus();
    }

    function wrapSelection(mark) {
      const start = editor.selectionStart, end = editor.selectionEnd;
      const text = editor.value.slice(start, end) || 'text';
      editor.setRangeText(mark + text + mark, start, end, 'select');
      editor.dispatchEvent(new Event('input')); editor.focus();
    }
    function prefixSelection(prefix) {
      const start = editor.selectionStart, end = editor.selectionEnd;
      const text = editor.value.slice(start, end) || '';
      const next = text.split(/\r?\n/).map((line) => prefix + line).join('\n');
      editor.setRangeText(next, start, end, 'select');
      editor.dispatchEvent(new Event('input')); editor.focus();
    }
    async function copyCurrent() {
      const note = current();
      if (!note?.body) { toast('内容为空', 'warn'); return; }
      await copyText(note.body);
      toast('已复制', 'success');
    }

    async function saveActive() {
      if (!loaded) return;
      const note = current();
      if (!note) return;
      if (isDesktop()) {
        const oldPath = note.path;
        const r = await window.toolbox.notesSave({ dir: notesDir, title: note.title, body: note.body, oldPath });
        if (!r.ok) { updateFooter('保存失败'); toast('保存失败：' + r.error, 'error'); return; }
        updateFileNode(oldPath, r.note);
        if (selectedId !== r.note.id) selectedId = r.note.id;
        fileLabel.textContent = r.note.path;
      } else {
        saveLS(flatten());
      }
      updateFooter('笔记已保存');
    }

    (async () => {
      try {
        if (isDesktop()) {
          const r = await window.toolbox.notesList();
          if (r.ok) { setDir(r.dir); tree = decorateTree(r.tree || []); if (r.defaultDir) defaultDir = r.defaultDir; expandTopLevel(); }
          else { setDir(''); tree = []; toast('加载笔记失败：' + (r.error || ''), 'error'); }
        } else {
          setDir('');
          tree = loadLS().map((n) => normalizeNote(n));
        }
      } catch (err) {
        setDir(''); tree = [];
        toast('加载笔记失败：' + (err?.message || err), 'error');
      }
      loaded = true;
      setMode('preview');
      if (!flatten().length) {
        if (isDesktop()) {
          const r = await window.toolbox.notesSave({ dir: notesDir, title: '欢迎使用随手记', body: WELCOME_BODY });
          tree = r.ok ? [normalizeNote(r.note)] : [normalizeNote({ title: '欢迎使用随手记', body: WELCOME_BODY })];
        } else {
          tree = [normalizeNote({ title: '欢迎使用随手记', body: WELCOME_BODY })];
        }
      }
      selectedId = flatten()[0].id;
      loadCurrent();
      renderTree();
    })();

    return () => {
      try { saveSoon.flush?.(); } catch {}
      try { renderPreviewSoon.flush?.(); } catch {}
      try { renderTreeSoon.flush?.(); } catch {}
    };
  },
};
