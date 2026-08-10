import { el } from '../ui/helpers.js';
import { svg } from './base.js';

// 播放/执行图标。
const ICON = svg(
  '<path d="M5 4l14 8-14 8z"/>',
);
const STOP_ICON = svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>');
const FOLDER_ICON = svg(
  '<path d="M3 7.5a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
);

// ============ 命令模板展开 ============
// 把任务里存的命令模板，按运行时参数值展开成最终命令数组。自实现，不引依赖。
// 占位符：
//   {{key}}                      -> 值；multiselect 默认 join ' '，text/dir 直取
//   {{key|join=,|prefix=services/|suffix=...}} -> multiselect 派生：每项包 prefix/suffix 后按 joiner 拼接
//   {{cwd}} / {{toolbox}}        -> 内置：任务 cwd / toolbox 根
//   {{#each key}} ... {{this}} ... {{/each}}  -> 块展开：每个选中项生成一组命令，块内 {{this}} 引用当前项
function _toArr(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return [v];
}

function _renderLine(s, values, ctx) {
  return s.replace(/\{\{([^}]+)\}\}/g, (m, expr) => {
    const t = expr.trim();
    if (t === 'this') return String(values.this ?? '');
    if (t === 'cwd') return ctx.cwd || '';
    if (t === 'toolbox') return ctx.toolbox || '';
    const [keyPart, ...filters] = t.split('|');
    const key = keyPart.trim();
    let val = values[key];
    if (val == null) val = '';
    if (Array.isArray(val)) {
      let prefix = '', suffix = '', joiner = ' ';
      for (const f of filters) {
        const [fk, ...rest] = f.split('=');
        const fv = rest.join('=').trim();
        if (fk.trim() === 'join') joiner = fv;
        else if (fk.trim() === 'prefix') prefix = fv;
        else if (fk.trim() === 'suffix') suffix = fv;
      }
      return val.map((v) => `${prefix}${v}${suffix}`).join(joiner);
    }
    return String(val);
  });
}

function expandCommands(templateLines, values, ctx) {
  const out = [];
  let i = 0;
  while (i < templateLines.length) {
    const line = templateLines[i];
    const trimmed = line.trim();
    // 多行块：{{#each key}} 独占一行，到 {{/each}} 结束
    const open = trimmed.match(/^\{\{#each\s+(\w+)\}\}$/);
    if (open) {
      const key = open[1];
      const body = [];
      i++;
      while (i < templateLines.length && templateLines[i].trim() !== '{{/each}}') {
        body.push(templateLines[i]);
        i++;
      }
      i++; // 跳过 {{/each}}
      for (const item of _toArr(values[key])) {
        for (const bl of body) {
          const rendered = _renderLine(bl, { ...values, this: item }, ctx).trim();
          if (rendered) out.push(rendered);
        }
      }
      continue;
    }
    // 单行块：{{#each key}}body{{/each}}
    const inline = trimmed.match(/^\{\{#each\s+(\w+)\}\}([\s\S]*)\{\{\/each\}\}$/);
    if (inline) {
      const [, key, body] = inline;
      for (const item of _toArr(values[key])) {
        const rendered = _renderLine(body, { ...values, this: item }, ctx).trim();
        if (rendered) out.push(rendered);
      }
      i++;
      continue;
    }
    const rendered = _renderLine(line, values, ctx).trim();
    if (rendered) out.push(rendered);
    i++;
  }
  return out;
}

// 运行时把参数值里的 {{cwd}}/{{toolbox}} 替换成实际值，
// 让默认值如 '{{cwd}}/exports' 在展开命令时生效。
function _expandCtx(v, ctx) {
  if (typeof v === 'string') return v.replace(/\{\{(cwd|toolbox)\}\}/g, (_, k) => ctx[k] || '');
  if (Array.isArray(v)) return v.map((x) => _expandCtx(x, ctx));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = _expandCtx(val, ctx);
    return out;
  }
  return v;
}

// 桌面端走 IPC 真实 spawn；Web 预览走 localStorage + 模拟输出，便于验证 UI。
const electronDeploy = window.toolbox?.deploy;
const electronOnOutput = window.toolbox?.onDeployOutput;

const webStore = {
  _key: 'toolbox-deploy-demo',
  _seededKey: 'toolbox-deploy-seeded',
  _listeners: [],
  _running: false,
  _all() {
    return JSON.parse(localStorage.getItem(this._key) || '[]');
  },
  // Web 预览首次为空时，从 public/seed-deploy.json 拉一份种子，便于在预览里也看到内置任务。
  // 与桌面端 electron/seed-deploy-tasks.cjs 保持同构；用户删空后不会自动再塞回（靠 _seededKey 标记）。
  async _maybeSeed() {
    if (this._all().length || localStorage.getItem(this._seededKey)) return;
    try {
      const res = await fetch('/seed-deploy.json');
      if (res.ok) {
        const seed = await res.json();
        if (Array.isArray(seed) && seed.length) {
          const arr = seed.map((t) => ({ ...t, createdAt: t.createdAt || Date.now() }));
          localStorage.setItem(this._key, JSON.stringify(arr));
        }
      }
    } catch (e) {
      // 种子可选：拉不到就保持空，不影响主流程。
    }
    localStorage.setItem(this._seededKey, '1');
  },
  async list() {
    await this._maybeSeed();
    return this._all();
  },
  async save(task) {
    const arr = this._all();
    const item = { ...task };
    if (!item.id) item.id = 't-' + Date.now();
    item.createdAt = item.createdAt || Date.now();
    const i = arr.findIndex((x) => x.id === item.id);
    if (i >= 0) arr[i] = { ...arr[i], ...item };
    else arr.push(item);
    localStorage.setItem(this._key, JSON.stringify(arr));
    return item.id;
  },
  async delete(id) {
    localStorage.setItem(this._key, JSON.stringify(this._all().filter((t) => t.id !== id)));
    return true;
  },
  async run(id, overrides) {
    if (this._running) return { ok: false, msg: '已有任务在跑' };
    const t = this._all().find((x) => x.id === id);
    if (!t) return { ok: false, msg: '任务不存在' };
    const cmds = (overrides?.commands ?? t.commands ?? []).filter((c) => c && c.trim());
    this._running = true;
    this._stopped = false;
    this._emit({ id, type: 'start', task: t.name });
    for (const c of cmds) {
      if (this._stopped) break;
      this._emit({ id, type: 'cmd', text: `> ${c}` });
      await new Promise((r) => setTimeout(r, 280));
      if (this._stopped) break;
      this._emit({ id, type: 'out', text: `[Web 模拟] 执行 ${c}\n示例输出第 1 行\n示例输出第 2 行\n` });
    }
    this._running = false;
    if (!this._stopped) this._emit({ id, type: 'done' });
    return { ok: true };
  },
  async stop() {
    if (!this._running) return true;
    this._stopped = true;
    this._running = false;
    this._emit({ type: 'cancelled' });
    return true;
  },
  async pickDir() {
    return null; // web 不支持
  },
  onOutput(cb) {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((x) => x !== cb);
    };
  },
  _emit(msg) {
    this._listeners.forEach((cb) => cb(msg));
  },
};

const store = electronDeploy || webStore;
const onOutput = electronOnOutput || ((cb) => webStore.onOutput(cb));

function blankTask() {
  return { id: '', name: '', cwd: '', commands: '', env: '', params: undefined, paramValues: {} };
}

// 从 params 定义生成默认参数值（multiselect 复制 default 数组，其余取 default）。
function defaultParamValues(params) {
  const v = {};
  for (const p of params || []) {
    if (p.type === 'multiselect') v[p.key] = [...(p.default || [])];
    else v[p.key] = p.default || '';
  }
  return v;
}

export const deployTool = {
  id: 'deploy',
  title: '部署工作台',
  icon: ICON,
  state: {
    tasks: [],
    selected: null,
    form: null,
    output: [], // { type, text }
    running: false,
    query: '',
  },

  async render(container) {
    this.container = container;
    container.innerHTML = '';
    this.root = el('div', { class: 'deploy' });
    container.append(this.root);
    await this.refresh();
    this.paint();
    this._offOutput = onOutput((msg) => this.onOutput(msg));
  },

  onLeave() {
    if (this._offOutput) this._offOutput();
  },

  async refresh() {
    this.state.tasks = await store.list();
  },

  paint() {
    const root = this.root;
    root.innerHTML = '';

    const toolbar = el(
      'div',
      { class: 'deploy-toolbar' },
      el(
        'div',
        { class: 'search-box' },
        el('span', {
          class: 'search-icon',
          html: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.3 4.3"/></g></svg>',
        }),
        el('input', {
          type: 'text',
          placeholder: '搜索任务…',
          value: this.state.query,
          oninput: (e) => {
            this.state.query = e.target.value;
            this.paintList();
          },
        }),
      ),
      el('button', { class: 'btn', onclick: () => this.newTask() }, '+ 新建任务'),
    );

    this.listEl = el('div', { class: 'deploy-list' });
    this.rightEl = el('div', { class: 'deploy-right' });
    const body = el('div', { class: 'deploy-body' }, this.listEl, this.rightEl);
    this.toastEl = el('div', { class: 'toast' });
    root.append(toolbar, body, this.toastEl);

    this.paintList();
    this.paintRight();
  },

  paintList() {
    const list = this.listEl;
    list.innerHTML = '';
    const q = this.state.query.trim().toLowerCase();
    const tasks = this.state.tasks.filter(
      (t) => !q || (t.name || '').toLowerCase().includes(q) || (t.cwd || '').toLowerCase().includes(q),
    );
    if (!tasks.length) {
      list.append(el('div', { class: 'empty' }, this.state.query ? '没有匹配的任务' : '还没有任务，点「新建任务」'));
      return;
    }
    for (const t of tasks) {
      const active = t.id === this.state.selected;
      list.append(
        el(
          'button',
          { class: 'task-row' + (active ? ' active' : ''), onclick: () => this.selectTask(t.id) },
          el('span', { class: 'task-name' }, t.name || '(未命名)'),
          el('span', { class: 'task-meta' }, t.cwd || '（未设工作目录）'),
          el('span', { class: 'task-count' }, (t.commands || []).filter((c) => c.trim()).length + ' 条'),
        ),
      );
    }
  },

  async selectTask(id) {
    this.state.selected = id;
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return;
    // commands 在存储里是数组，编辑时按行拆成文本
    const cmds = Array.isArray(t.commands) ? t.commands.join('\n') : t.commands || '';
    const env = t.env && typeof t.env === 'object' ? Object.entries(t.env).map(([k, v]) => `${k}=${v}`).join('\n') : t.env || '';
    // 参数值：存过的优先，否则用 param.default
    const paramValues = t.paramValues || defaultParamValues(t.params);
    this.state.form = { ...t, commands: cmds, env, paramValues };
    this.state.output = [];
    this.paintList();
    this.paintRight();
  },

  paintRight() {
    const r = this.rightEl;
    r.innerHTML = '';
    const f = this.state.form;
    if (!f) {
      r.append(el('div', { class: 'empty' }, '选一个任务，或点「新建任务」'));
      return;
    }
    const isNew = !f.id;
    const text = (key, opts = {}) =>
      el('input', {
        type: opts.type || 'text',
        value: f[key] ?? '',
        placeholder: opts.placeholder || '',
        oninput: (e) => {
          f[key] = e.target.value;
        },
      });
    const field = (label, inp) => el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), inp);

    // 运行参数（仅 params 存在时显示；值存 form.paramValues，随任务存盘记住上次选择）
    const renderParam = (p) => {
      const vals = f.paramValues || (f.paramValues = {});
      if (p.type === 'multiselect') {
        const cur = new Set(_toArr(vals[p.key]));
        return el(
          'div', { class: 'param param-multiselect' },
          el('span', { class: 'param-label' }, p.label),
          el(
            'div', { class: 'checkbox-group' },
            ...(p.options || []).map((opt) =>
              el(
                'label', { class: 'checkbox-item' },
                el('input', {
                  type: 'checkbox',
                  checked: cur.has(opt),
                  onchange: (e) => {
                    const set = new Set(_toArr(vals[p.key]));
                    if (e.target.checked) set.add(opt); else set.delete(opt);
                    vals[p.key] = [...set];
                  },
                }),
                el('span', { text: opt }),
              ),
            ),
          ),
        );
      }
      if (p.type === 'dir') {
        const raw = vals[p.key] || '';
        const display = raw
          .replace(/\{\{cwd\}\}/g, f.cwd || '')
          .replace(/\{\{toolbox\}\}/g, window.toolbox?.paths?.toolboxRoot || '');
        return el(
          'div', { class: 'param param-dir' },
          el('span', { class: 'param-label' }, p.label),
          el(
            'div', { class: 'cwd-row' },
            el('input', {
              type: 'text',
              value: display,
              placeholder: p.placeholder || '留空用默认 {cwd}/exports',
              oninput: (e) => { vals[p.key] = e.target.value; },
            }),
            el('button', { class: 'btn ghost icon', html: FOLDER_ICON, title: '选择目录', onclick: () => this.pickDirFor(p.key) }),
          ),
        );
      }
      return el(
        'div', { class: 'param param-text' },
        el('span', { class: 'param-label' }, p.label),
        el('input', { type: 'text', value: vals[p.key] || '', placeholder: p.placeholder || '', oninput: (e) => { vals[p.key] = e.target.value; } }),
      );
    };
    const paramField = f.params && f.params.length
      ? field('运行参数', el('div', { class: 'params' }, ...f.params.map(renderParam)))
      : null;

    const form = el(
      'div',
      { class: 'deploy-form' },
      el('div', { class: 'form-header' }, el('h3', { text: isNew ? '新建任务' : f.name || '(未命名)' })),
      field('任务名', text('name', { placeholder: '如 构建并推送镜像' })),
      field(
        '工作目录',
        el(
          'div',
          { class: 'cwd-row' },
          el('input', {
            type: 'text',
            class: 'cwd-input',
            value: f.cwd || '',
            placeholder: 'D:\\project 或 /home/user/app',
            oninput: (e) => {
              f.cwd = e.target.value;
            },
          }),
          el('button', { class: 'btn ghost icon', html: FOLDER_ICON, title: '选择目录', onclick: () => this.pickDir() }),
        ),
      ),
      paramField,
      field(
        '命令（每行一条，顺序执行）',
        el(
          'textarea',
          {
            class: 'field-area commands',
            placeholder: 'npm run build\ndocker build -t myapp .\ndocker push myapp',
            oninput: (e) => {
              f.commands = e.target.value;
            },
          },
          f.commands || '',
        ),
      ),
      field(
        '环境变量（每行 KEY=val）',
        el(
          'textarea',
          {
            class: 'field-area env',
            placeholder: 'NODE_ENV=production\nVERSION=1.0.0',
            oninput: (e) => {
              f.env = e.target.value;
            },
          },
          f.env || '',
        ),
      ),
      el(
        'div',
        { class: 'deploy-actions' },
        this.state.running
          ? el('button', { class: 'btn danger', onclick: () => this.stop() }, '停止')
          : el('button', { class: 'btn primary', onclick: () => this.run() }, '运行'),
        el('button', { class: 'btn ghost', onclick: () => this.save() }, '保存'),
        !isNew ? el('button', { class: 'btn danger ghost', onclick: () => this.deleteTask() }, '删除') : null,
      ),
    );

    this.outputEl = el('div', { class: 'deploy-output' });
    this.paintOutput();

    r.append(form, el('div', { class: 'deploy-output-wrap' }, el('div', { class: 'output-label' }, '输出'), this.outputEl));
  },

  paintOutput() {
    if (!this.outputEl) return;
    this.outputEl.innerHTML = '';
    if (!this.state.output.length) {
      this.outputEl.append(el('div', { class: 'output-empty' }, '点「运行」查看执行输出…'));
      return;
    }
    for (const m of this.state.output) {
      const cls = 'out-line ' + (m.type || 'out');
      this.outputEl.append(el('div', { class: cls, text: m.text }));
    }
    // 自动滚到底
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  },

  onOutput(msg) {
    // start/done/cancelled 切换 running 态并刷按钮
    if (msg.type === 'start') {
      this.state.running = true;
      this.state.output = [];
      this.paintRight();
      return;
    }
    if (msg.type === 'done' || msg.type === 'cancelled') {
      this.state.output.push({ type: msg.type, text: msg.type === 'done' ? '── 完成 ──' : '── 已中止 ──' });
      this.state.running = false;
      this.paintOutput();
      this.paintRight();
      return;
    }
    if (msg.type === 'failed') {
      this.state.output.push({ type: 'err', text: `── 失败（退出码 ${msg.code}）──` });
      this.paintOutput();
      return;
    }
    this.state.output.push(msg);
    // 防爆：保留最近 1500 条
    if (this.state.output.length > 1500) this.state.output = this.state.output.slice(-1500);
    this.paintOutput();
  },

  newTask() {
    this.state.selected = null;
    this.state.form = blankTask();
    this.state.output = [];
    this.paintList();
    this.paintRight();
  },

  async pickDir() {
    const d = await store.pickDir();
    if (d) {
      this.state.form.cwd = d;
      this.paintRight();
    }
  },

  // 给某个 dir 类型参数填目录
  async pickDirFor(key) {
    const d = await store.pickDir();
    if (d) {
      const f = this.state.form;
      f.paramValues = f.paramValues || {};
      f.paramValues[key] = d;
      this.paintRight();
    }
  },

  async save() {
    const f = this.state.form;
    if (!f) return;
    if (!f.name) {
      this.toast('请填任务名', 'err');
      return;
    }
    const toSave = {
      ...f,
      commands: (f.commands || '').split('\n').map((s) => s.trim()).filter(Boolean),
      env: parseEnv(f.env || ''),
      paramValues: f.paramValues || {},
    };
    const id = await store.save(toSave);
    await this.refresh();
    await this.selectTask(id);
    this.toast('已保存');
  },

  async deleteTask() {
    const f = this.state.form;
    if (!f || !f.id) return;
    await store.delete(f.id);
    this.state.selected = null;
    this.state.form = null;
    this.state.output = [];
    await this.refresh();
    this.paintList();
    this.paintRight();
    this.toast('已删除');
  },

  async run() {
    const f = this.state.form;
    if (!f || !f.id) {
      this.toast('请先保存', 'err');
      return;
    }
    // 保存当前编辑内容后再跑（防止改了没存跑旧版）
    await this.save();
    // 重新取存盘后的任务（模板 + params + paramValues）
    const task = this.state.tasks.find((x) => x.id === this.state.selected);
    if (!task) return;
    const ctx = {
      cwd: task.cwd || '',
      toolbox: window.toolbox?.paths?.toolboxRoot || 'D:\\mytools\\toolbox',
    };
    const values = _expandCtx(task.paramValues || {}, ctx);
    // multiselect 至少选一个
    for (const p of task.params || []) {
      if (p.type === 'multiselect' && !_toArr(values[p.key]).length) {
        this.toast(`请至少选一个${p.label}`, 'err');
        return;
      }
    }
    const finalCommands = expandCommands(task.commands || [], values, ctx);
    if (!finalCommands.length) {
      this.toast('没有命令', 'err');
      return;
    }
    const env = parseEnv(f.env || '');
    const r = await store.run(this.state.selected, { commands: finalCommands, env });
    if (!r.ok) this.toast(r.msg || '失败', 'err');
  },

  async stop() {
    await store.stop();
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

function parseEnv(text) {
  const obj = {};
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i > 0) obj[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return obj;
}
