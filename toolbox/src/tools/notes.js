import { marked } from 'marked';
import { el } from '../ui/helpers.js';
import { svg } from './base.js';

const ICON = svg(
  '<path d="M7 4.5h8.5L19 8v11.5H7z"/><path d="M15.5 4.5V8H19"/><path d="M10 12h6M10 15h5M10 18h3"/>',
);

// 树形图标（描边风，currentColor 取色，跟随行状态变色）
const FOLDER_ICON = svg(
  '<path d="M3 7.5a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
);
const FOLDER_OPEN_ICON = svg(
  '<path d="M3 8a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v1"/><path d="M3.5 19l2.3-8.2a1.5 1.5 0 0 1 1.4-1.1h13a1.5 1.5 0 0 1 1.5 1.9l-1.8 6.5a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z"/>',
);
const NOTE_ICON = svg(
  '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5V8.5H19"/><path d="M9 13h6M9 16.5h4"/>',
);
const CHEVRON_RIGHT = svg('<path d="M9.5 6l6 6-6 6"/>');
const CHEVRON_DOWN = svg('<path d="M6 9.5l6 6 6-6"/>');

// 存储抽象：Electron 走 IPC + 本地 .md 文件树；纯 Web 预览走 localStorage（扁平，根下）。
const electronApi = window.toolbox?.notes;
const store = electronApi
  ? electronApi
  : {
      _key: 'toolbox-notes-demo',
      async list() {
        const arr = JSON.parse(localStorage.getItem(this._key) || '[]');
        return { folders: [], notes: arr.sort((a, b) => b.mtime - a.mtime) };
      },
      async save(name, content, folder) {
        const arr = JSON.parse(localStorage.getItem(this._key) || '[]');
        const i = arr.findIndex((n) => n.name === name);
        const item = { name, content, mtime: Date.now(), path: 'web://' + name, folder: folder || '' };
        if (i >= 0) arr[i] = item;
        else arr.unshift(item);
        localStorage.setItem(this._key, JSON.stringify(arr));
        return item.path;
      },
      async delete(filePath) {
        const arr = JSON.parse(localStorage.getItem(this._key) || '[]').filter((n) => n.path !== filePath);
        localStorage.setItem(this._key, JSON.stringify(arr));
        return true;
      },
      async openDir() {},
      async getDir() {
        return '(web 预览)';
      },
      async setDir() {
        return null;
      },
    };

function baseName(p) {
  if (!p || typeof p !== 'string') return '根目录';
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '根目录';
}

function findNote(node, path) {
  for (const n of node.notes) if (n.path === path) return n;
  for (const f of node.folders) {
    const r = findNote(f.children, path);
    if (r) return r;
  }
  return null;
}

function flattenNotes(node, folderName = '') {
  const all = node.notes.map((n) => ({ ...n, _folder: folderName }));
  for (const f of node.folders) {
    all.push(...flattenNotes(f.children, f.name));
  }
  return all;
}

// 解析 markdown 标题大纲：返回 [{ level, text, line }]
function parseOutline(content) {
  const lines = content.split('\n');
  const outline = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (m) outline.push({ level: m[1].length, text: m[2].trim(), line: i });
  }
  return outline;
}

export const notesTool = {
  id: 'notes',
  title: '随手记',
  icon: ICON,
  state: {
    tree: { folders: [], notes: [] },
    expanded: new Set(),
    currentFolder: null,
    selected: null,
    query: '',
    mode: 'edit',
    dir: '',
  },

  async render(container) {
    this.container = container;
    container.innerHTML = '';
    this.root = el('div', { class: 'notes' });
    container.append(this.root);
    this.state.dir = await store.getDir();
    this.state.currentFolder = this.state.dir;
    await this.refresh();
    this.paint();
    if (window.toolbox?.onQuickCapture) {
      this._offCapture = window.toolbox.onQuickCapture(() => this.newNote());
    }
  },

  onLeave() {
    if (this._offCapture) this._offCapture();
  },

  async refresh() {
    this.state.tree = await store.list();
  },

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const toolbar = el(
      'div',
      { class: 'notes-toolbar' },
      el(
        'div',
        { class: 'search-box' },
        el('span', {
          class: 'search-icon',
          html: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.3 4.3"/></g></svg>',
        }),
        el('input', {
          type: 'text',
          placeholder: '搜索笔记…',
          value: this.state.query,
          oninput: (e) => {
            this.state.query = e.target.value;
            this.paintTree();
          },
        }),
      ),
      el('button', { class: 'btn', onclick: () => this.newNote() }, '+ 新建'),
      el('button', { class: 'btn ghost', onclick: () => this.setDir() }, '设置文件夹'),
      el('button', { class: 'btn ghost', onclick: () => store.openDir() }, '打开目录'),
    );

    // 三列：左目录树 + 中编辑器 + 右大纲
    this.listEl = el('div', { class: 'note-list' });
    this.editorEl = el('div', { class: 'note-editor' });
    this.outlineEl = el('div', { class: 'outline' });
    const body = el('div', { class: 'notes-body' }, this.listEl, this.editorEl, this.outlineEl);

    root.append(toolbar, body);
    this.paintTree();
    this.paintEditor();
    this.paintOutline();
  },

  paintTree() {
    const list = this.listEl;
    list.innerHTML = '';

    const isRootCurrent = this.state.currentFolder === this.state.dir;
    list.append(
      el(
        'button',
        {
          class: 'tree-row tree-folder' + (isRootCurrent ? ' current' : ''),
          onclick: () => {
            this.state.currentFolder = this.state.dir;
            this.paintTree();
          },
        },
        el('span', { class: 'tree-chevron' }),
        el('span', { class: 'tree-icon', html: FOLDER_OPEN_ICON }),
        el('span', { class: 'tree-label' }, baseName(this.state.dir) || '根目录'),
      ),
    );

    if (this.state.query.trim()) {
      const q = this.state.query.trim().toLowerCase();
      const matched = flattenNotes(this.state.tree).filter(
        (n) => n.content.toLowerCase().includes(q) || n.name.toLowerCase().includes(q),
      );
      if (!matched.length) {
        list.append(el('div', { class: 'empty' }, '没有匹配的笔记'));
        return;
      }
      for (const n of matched) {
        list.append(
          el(
            'button',
            {
              class: 'tree-row tree-note search-hit' + (n.path === this.state.selected ? ' active' : ''),
              onclick: () => this.selectNote(n.path),
            },
            el('span', { class: 'tree-icon note', html: NOTE_ICON }),
            el('span', { class: 'tree-label' }, n.name),
            n._folder ? el('span', { class: 'tree-folder-hint' }, n._folder) : null,
          ),
        );
      }
      return;
    }

    this.paintNode(this.state.tree, 0);
  },

  paintNode(node, depth) {
    for (const folder of node.folders) {
      const isOpen = this.state.expanded.has(folder.path);
      const isCurrent = this.state.currentFolder === folder.path;
      this.listEl.append(
        el(
          'button',
          {
            class: 'tree-row tree-folder' + (isCurrent ? ' current' : ''),
            style: `padding-left:${depth * 16 + 10}px`,
            onclick: () => this.toggleFolder(folder),
          },
          el('span', { class: 'tree-chevron', html: isOpen ? CHEVRON_DOWN : CHEVRON_RIGHT }),
          el('span', { class: 'tree-icon', html: isOpen ? FOLDER_OPEN_ICON : FOLDER_ICON }),
          el('span', { class: 'tree-label' }, folder.name),
        ),
      );
      if (isOpen) this.paintNode(folder.children, depth + 1);
    }
    for (const note of node.notes) {
      this.listEl.append(
        el(
          'button',
          {
            class: 'tree-row tree-note' + (note.path === this.state.selected ? ' active' : ''),
            style: `padding-left:${depth * 16 + 10}px`,
            onclick: () => this.selectNote(note.path),
          },
          el('span', { class: 'tree-icon note', html: NOTE_ICON }),
          el('span', { class: 'tree-label' }, note.name),
        ),
      );
    }
  },

  toggleFolder(folder) {
    const set = this.state.expanded;
    if (set.has(folder.path)) set.delete(folder.path);
    else set.add(folder.path);
    this.state.currentFolder = folder.path;
    this.paintTree();
  },

  selectNote(path) {
    this.state.selected = path;
    this.state.mode = 'edit';
    this.paintTree();
    this.paintEditor();
    this.paintOutline();
  },

  paintEditor() {
    const ed = this.editorEl;
    ed.innerHTML = '';
    const note = this.state.selected ? findNote(this.state.tree, this.state.selected) : null;
    if (!note) {
      ed.append(el('div', { class: 'empty' }, '选一条笔记，或点「新建」'));
      return;
    }

    const header = el(
      'div',
      { class: 'editor-header' },
      el(
        'div',
        { class: 'editor-tabs' },
        el(
          'button',
          { class: 'tab' + (this.state.mode === 'edit' ? ' active' : ''), onclick: () => { this.state.mode = 'edit'; this.paintEditor(); } },
          '编辑',
        ),
        el(
          'button',
          { class: 'tab' + (this.state.mode === 'preview' ? ' active' : ''), onclick: () => { this.state.mode = 'preview'; this.paintEditor(); } },
          '预览',
        ),
      ),
      el('div', { class: 'editor-actions' }, el('button', { class: 'btn danger', onclick: () => this.deleteNote(note) }, '删除')),
    );

    if (this.state.mode === 'edit') {
      const ta = el('textarea', { class: 'editor-textarea', placeholder: '在这里写笔记…' });
      ta.value = note.content;
      let timer;
      ta.addEventListener('input', () => {
        note.content = ta.value;
        this.paintOutline(); // 大纲随内容实时更新
        clearTimeout(timer);
        timer = setTimeout(() => this.saveNote(note), 600);
      });
      ed.append(header, ta);
      ta.focus();
    } else {
      const html = marked.parse(note.content || '*空笔记*', { breaks: true });
      ed.append(header, el('div', { class: 'editor-preview markdown', html }));
    }
  },

  // 右侧大纲：列出当前笔记的标题层级，点击跳转到编辑器对应行
  paintOutline() {
    const ol = this.outlineEl;
    if (!ol) return;
    ol.innerHTML = '';
    const note = this.state.selected ? findNote(this.state.tree, this.state.selected) : null;
    ol.append(el('div', { class: 'outline-label' }, '大纲'));
    if (!note) {
      ol.append(el('div', { class: 'empty' }, '未选笔记'));
      return;
    }
    const outline = parseOutline(note.content);
    if (!outline.length) {
      ol.append(el('div', { class: 'empty' }, '没有标题'));
      return;
    }
    for (const item of outline) {
      ol.append(
        el(
          'button',
          {
            class: 'outline-item',
            style: `padding-left:${(item.level - 1) * 12 + 12}px`,
            onclick: () => this.selectOutline(item.line),
          },
          el('span', { class: 'outline-hash' }, '#'.repeat(item.level)),
          el('span', { text: item.text }),
        ),
      );
    }
  },

  selectOutline(line) {
    const ta = this.editorEl.querySelector('.editor-textarea');
    if (!ta) return;
    // 算该行起始字符位置，定位光标并滚动
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line; i++) pos += (lines[i] || '').length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    // 估算行高滚动（line-height 1.7 × 13.5px ≈ 23px）
    ta.scrollTop = Math.max(0, line * 23 - 60);
  },

  async newNote() {
    const name = 'note-' + Date.now();
    const folder = this.state.currentFolder || this.state.dir;
    const fp = await store.save(name, '', folder);
    await this.refresh();
    this.state.selected = fp;
    this.state.mode = 'edit';
    if (folder && folder !== this.state.dir) this.state.expanded.add(folder);
    this.paintTree();
    this.paintEditor();
    this.paintOutline();
  },

  async saveNote(note) {
    await store.save(note.name, note.content, note.folder);
    await this.refresh();
    this.paintTree();
  },

  async deleteNote(note) {
    await store.delete(note.path);
    if (this.state.selected === note.path) this.state.selected = null;
    await this.refresh();
    this.paintTree();
    this.paintEditor();
    this.paintOutline();
  },

  async setDir() {
    const dir = await store.setDir();
    if (dir) {
      this.state.dir = dir;
      this.state.currentFolder = dir;
      this.state.expanded = new Set();
      this.state.selected = null;
      await this.refresh();
      this.paint();
    }
  },
};
