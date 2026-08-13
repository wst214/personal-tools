import { el, btn, toast, field, copyText, isDesktop } from '../ui/helpers.js';

const STORE_KEY = 'mytools-writing';
const DEFAULT_ROOT = 'D:\\mytools\\writing';

const ACTIONS = [
  { id: 'long-new', group: '创作', title: '开长篇', skill: 'story-long-write', needBook: true },
  { id: 'short-new', group: '创作', title: '开短篇', skill: 'story-short-write', needBook: true },
  { id: 'long-next', group: '创作', title: '写下一章', skill: 'story-long-write', needActive: true },
  { id: 'short-write', group: '创作', title: '写/续写短篇', skill: 'story-short-write', needActive: true },
  { id: 'long-scan', group: '学习', title: '长篇扫榜', skill: 'story-long-scan' },
  { id: 'short-scan', group: '学习', title: '短篇扫榜', skill: 'story-short-scan' },
  { id: 'long-analyze', group: '学习', title: '长篇拆文', skill: 'story-long-analyze' },
  { id: 'short-analyze', group: '学习', title: '短篇拆文', skill: 'story-short-analyze' },
  { id: 'deslop', group: '精修', title: '去 AI 味', skill: 'story-deslop', needActive: true },
  { id: 'review', group: '精修', title: '审查', skill: 'story-review', needActive: true },
  { id: 'cover', group: '精修', title: '生成封面', skill: 'story-cover', needActive: true },
  { id: 'import', group: '精修', title: '导入小说', skill: 'story-import' },
];

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      root: String(raw.root || DEFAULT_ROOT),
      activeBook: String(raw.activeBook || ''),
    };
  } catch {
    return { root: DEFAULT_ROOT, activeBook: '' };
  }
}

function saveStore(data) {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function joinPath(root, ...parts) {
  const sep = root.includes('/') && !root.includes('\\') ? '/' : '\\';
  return [root.replace(/[\\/]+$/, ''), ...parts.map((p) => String(p).replace(/^[\\/]+/, ''))].join(sep);
}

function safeBookName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ');
  if (!cleaned) throw new Error('书名不能为空');
  return cleaned;
}

function tb() {
  return window.toolbox || {};
}

async function listDir(dir) {
  const api = tb().fs?.listDir;
  if (!api) return { ok: false, error: '当前环境无文件列表能力（请用桌面版 DevToolbox）', items: [] };
  return api(dir);
}

async function readTextFile(filePath) {
  const api = tb().fs?.readFile;
  if (!api) return { ok: false, error: '无读文件能力' };
  const r = await api(filePath);
  if (!r?.ok) return r;
  try {
    const text = decodeURIComponent(escape(atob(r.content || '')));
    return { ok: true, content: text };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function writeRawFile(filePath, body) {
  const api = tb().fs?.saveFile;
  if (!api) return { ok: false, error: '无写文件能力（请用桌面版 DevToolbox）' };
  const content = btoa(unescape(encodeURIComponent(body)));
  return api(filePath, content);
}

async function writeTextFile(dir, title, body, oldPath) {
  if (tb().notesSave) {
    return tb().notesSave({ dir, title, body, oldPath: oldPath || undefined });
  }
  return writeRawFile(joinPath(dir, `${title}.md`), body);
}

async function createDir(parent, name) {
  if (tb().notesCreateDir) return tb().notesCreateDir({ parent, name });
  return { ok: false, error: '无创建目录能力（请用桌面版 DevToolbox）' };
}

async function reveal(dir) {
  if (tb().notesReveal) return tb().notesReveal(dir);
  toast('请手动打开：' + dir, 'warn');
  return { ok: false };
}

function buildPrompt(action, { root, book, chapter, note }) {
  const base = `请执行 skill ${action.skill}。\n写作根目录：${root}\n`;
  const noteLine = note ? `补充要求：${note}\n` : '';
  switch (action.id) {
    case 'long-new':
      return `${base}动作：开一本新长篇。\n书名：${book}\n${noteLine}按 oh-story 流程创建大纲/设定/追踪并开始第 1 章准备。直接落盘。`;
    case 'short-new':
      return `${base}动作：开一篇新短篇。\n书名：${book}\n${noteLine}按短篇流程落盘小节大纲与正文骨架。直接写文件。`;
    case 'long-next':
      return `${base}当前书：${book}\n动作：${chapter ? `写第 ${chapter} 章` : '日更 / 写下一章'}\n${noteLine}先读追踪与细纲，再落盘正文并更新追踪。`;
    case 'short-write':
      return `${base}当前书：${book}\n动作：继续写短篇正文并精修。\n${noteLine}直接改项目文件。`;
    case 'deslop':
      return `${base}当前书：${book}\n${noteLine}检测并清除 AI 写作痕迹，改写后写回文件。`;
    case 'review':
      return `${base}当前书：${book}\n${noteLine}做多视角审查；能直接修的硬伤一并修。`;
    case 'cover':
      return `${base}当前书：${book}\n${noteLine}生成封面并保存到项目。`;
    case 'import':
      return `${base}${note ? `导入说明/路径：${note}\n` : '请询问原文位置后导入为标准项目结构。'}`;
    case 'long-scan':
    case 'short-scan':
      return `${base}${noteLine}结果写入拆文库。`;
    case 'long-analyze':
    case 'short-analyze':
      return `${base}${note ? `目标作品/说明：${note}\n` : '请先问我要拆哪部作品，再落盘拆文结果。'}`;
    default:
      return `${base}${noteLine}`;
  }
}

async function detectDeploy(root) {
  try {
    const r = await readTextFile(joinPath(root, '.story-deployed'));
    if (!r?.ok) return { deployed: false };
    const text = r.content || '';
    const pick = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    return {
      deployed: true,
      setup_skill_version: pick('setup_skill_version'),
      agents_version: pick('agents_version'),
      target_cli: pick('target_cli'),
    };
  } catch {
    return { deployed: false };
  }
}

async function listBooks(root) {
  const r = await listDir(root);
  if (!r?.ok) return { ok: false, error: r?.error || '列表失败', books: [] };
  const books = [];
  for (const item of r.items || []) {
    if (!item.isDir) continue;
    const name = item.name;
    if (!name || name.startsWith('.') || name === 'skills' || name === '拆文库' || name === 'node_modules') continue;
    const full = joinPath(root, name);
    const sub = await listDir(full);
    const names = new Set((sub.items || []).map((x) => x.name));
    const longish = ['正文', '大纲', '设定', '追踪'].some((x) => names.has(x));
    const shortish = names.has('正文.md') && (names.has('小节大纲.md') || names.has('设定.md'));
    if (!longish && !shortish) continue;
    books.push({
      name,
      path: name,
      kind: shortish && !names.has('正文') ? 'short' : 'long',
    });
  }
  books.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { ok: true, books };
}

async function readActiveBook(root) {
  const r = await readTextFile(joinPath(root, '.active-book'));
  if (!r?.ok) return '';
  return String(r.content || '').trim();
}

async function writeActiveBook(root, book) {
  // oh-story 认无扩展名的 .active-book；notesSave 会强制加 .md，故走原始写文件
  return writeRawFile(joinPath(root, '.active-book'), `${book}\n`);
}

async function scaffoldBook(root, book, kind) {
  const name = safeBookName(book);
  const dirRes = await createDir(root, name);
  if (!dirRes?.ok) throw new Error(dirRes?.error || '创建书目失败');
  const bookDir = dirRes.path || joinPath(root, name);
  if (kind === 'short') {
    await writeTextFile(bookDir, '正文', `# ${name}\n\n`);
    await writeTextFile(bookDir, '小节大纲', `# ${name} · 小节大纲\n\n`);
    await writeTextFile(bookDir, '设定', `# ${name} · 设定\n\n`);
  } else {
    for (const sub of ['正文', '大纲', '设定', '追踪', '对标']) {
      const r = await createDir(bookDir, sub);
      if (!r?.ok) throw new Error(r?.error || `创建 ${sub} 失败`);
    }
    await writeTextFile(joinPath(bookDir, '追踪'), '质检进度', `# ${name} · 质检进度\n\n`);
  }
  await createDir(root, '拆文库');
  await writeActiveBook(root, name);
  return { book: name, path: bookDir };
}

async function writeTask(root, task) {
  const consoleDirRes = await createDir(root, '.console');
  const consoleDir = consoleDirRes?.path || joinPath(root, '.console');
  const stamp = new Date().toISOString();
  const md = `# 当前写作任务\n\n- 时间：${stamp}\n- 动作：${task.title}\n- Skill：${task.skill}\n- 书名：${task.book || '（无）'}\n\n## 请直接执行\n\n\`\`\`text\n${task.prompt}\n\`\`\`\n`;
  const json = JSON.stringify({ ...task, created_at: stamp }, null, 2);
  await writeTextFile(consoleDir, 'current-task', md);
  // json 也用 md 扩展存不合适；再写一份带 json 名的——notesSave 固定 .md。用正文写进 current-task-json.md
  await writeTextFile(consoleDir, 'current-task-json', json);
  return { consoleDir, md };
}

export const writingTool = {
  id: 'writing',
  name: '开书助手',
  category: '其它',
  icon: '✎',
  keywords: 'writing oh-story 网文 小说 写作 开书 去AI味 story 开书助手',
  desc: '按钮驱动 oh-story：开书 / 续写 / 去AI味 / 审查',
  render(container) {
    const store = loadStore();
    const app = el('div', { class: 'writing-app' });

    const rootInput = el('input', { class: 'input', value: store.root });
    const bookInput = el('input', { class: 'input', placeholder: '书名，例如：古井药方' });
    const kindSelect = el('select', { class: 'select' }, [
      el('option', { value: 'long', text: '长篇' }),
      el('option', { value: 'short', text: '短篇' }),
    ]);
    const chapterInput = el('input', { class: 'input', placeholder: '章节号（可选）' });
    const noteInput = el('textarea', { class: 'tx writing-note', placeholder: '题材、本章重点、参考链接…', rows: '2' });
    const statusLine = el('div', { class: 'writing-status', text: isDesktop() ? '就绪' : '浏览器模式：可复制任务，文件操作需桌面版' });
    const bookList = el('div', { class: 'writing-books' });
    const output = el('pre', { class: 'writing-output', text: '点下方按钮即可。会生成任务并复制提示词；回到 Cursor 说「执行当前写作任务」。' });

    let activeBook = store.activeBook;
    let lastPrompt = '';

    function persist() {
      saveStore({ root: rootInput.value.trim() || DEFAULT_ROOT, activeBook });
    }

    function setOutput(text) {
      output.textContent = text;
    }

    function renderBooks(books) {
      bookList.innerHTML = '';
      if (!books.length) {
        bookList.append(el('span', { class: 'writing-empty', text: '还没有书。填书名后点「新建书目」。' }));
        return;
      }
      for (const b of books) {
        const chip = el('button', {
          type: 'button',
          class: 'writing-chip' + (b.path === activeBook ? ' active' : ''),
          text: `${b.name} · ${b.kind === 'short' ? '短篇' : '长篇'}`,
          onclick: async () => {
            activeBook = b.path;
            bookInput.value = b.name;
            persist();
            try {
              await writeActiveBook(rootInput.value.trim(), b.path);
            } catch {}
            toast('已切换：' + b.name);
            await refresh();
          },
        });
        bookList.append(chip);
      }
    }

    async function refresh() {
      const root = rootInput.value.trim() || DEFAULT_ROOT;
      persist();
      statusLine.textContent = '刷新中…';
      const deploy = await detectDeploy(root);
      const listed = await listBooks(root);
      const diskActive = await readActiveBook(root);
      if (diskActive) activeBook = diskActive;
      if (!bookInput.value && activeBook) bookInput.value = activeBook;
      renderBooks(listed.books || []);
      const deployText = deploy.deployed
        ? `已部署 oh-story v${deploy.setup_skill_version || '?'} · agents ${deploy.agents_version || '?'}`
        : '未检测到 .story-deployed（可先在 writing 目录部署）';
      statusLine.textContent = listed.ok
        ? `${deployText} · 当前书：${activeBook || '未选择'}`
        : `${deployText} · ${listed.error || '无法列出书目'}`;
      return { root, deploy, listed };
    }

    async function onScaffold() {
      try {
        const root = rootInput.value.trim() || DEFAULT_ROOT;
        const r = await scaffoldBook(root, bookInput.value, kindSelect.value);
        activeBook = r.book;
        persist();
        setOutput(`已创建书目：${r.path}\n已设为当前书。\n可继续点「开长篇/开短篇」让 Agent 正式开写。`);
        toast('书目已创建');
        await refresh();
      } catch (e) {
        toast(e.message || String(e), 'error');
        setOutput(String(e.message || e));
      }
    }

    async function onAction(action) {
      try {
        const root = rootInput.value.trim() || DEFAULT_ROOT;
        let book = bookInput.value.trim() || activeBook;
        if (action.needBook && !bookInput.value.trim()) throw new Error('请填写书名');
        if (action.needActive && !book) throw new Error('请先选择或新建一本书');
        if (bookInput.value.trim()) book = safeBookName(bookInput.value.trim());
        const prompt = buildPrompt(action, {
          root,
          book,
          chapter: chapterInput.value.trim(),
          note: noteInput.value.trim(),
        });
        lastPrompt = prompt;
        const task = {
          title: action.title,
          skill: action.skill,
          action: action.id,
          book,
          chapter: chapterInput.value.trim(),
          note: noteInput.value.trim(),
          prompt,
        };
        let fileHint = '';
        try {
          const w = await writeTask(root, task);
          fileHint = `\n任务文件：${joinPath(w.consoleDir, 'current-task.md')}`;
        } catch (e) {
          fileHint = `\n（未能写文件：${e.message || e}，仍已复制提示词）`;
        }
        await copyText(prompt);
        setOutput(`已复制提示词。\n回到 Cursor Agent，直接说：执行当前写作任务\n或粘贴下方内容。${fileHint}\n\n---\n${prompt}`);
        toast('已复制任务提示词');
      } catch (e) {
        toast(e.message || String(e), 'error');
        setOutput(String(e.message || e));
      }
    }

    const actionPanels = ['创作', '学习', '精修'].map((group) => {
      const grid = el('div', { class: 'writing-actions' });
      for (const action of ACTIONS.filter((a) => a.group === group)) {
        grid.append(
          btn(action.title, () => onAction(action), { title: action.skill }),
        );
      }
      return el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: group }),
        grid,
      ]);
    });

    app.append(
      el('div', { class: 'card writing-form' }, [
        el('div', { class: 'card-title', text: '写作根目录' }),
        field('目录', rootInput),
        el('div', { class: 'form-row' }, [
          btn('刷新', () => refresh().catch((e) => toast(e.message, 'error'))),
          btn('打开目录', () => reveal(rootInput.value.trim() || DEFAULT_ROOT)),
          btn('复制上次提示词', async () => {
            if (!lastPrompt) { toast('还没有任务', 'warn'); return; }
            await copyText(lastPrompt);
            toast('已复制');
          }),
        ]),
        statusLine,
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '书目' }),
        el('div', { class: 'form-row' }, [
          field('书名', bookInput),
          field('类型', kindSelect),
        ]),
        el('div', { class: 'form-row' }, [
          btn('新建书目', onScaffold, { variant: 'primary' }),
        ]),
        bookList,
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '补充参数' }),
        field('章节号', chapterInput),
        field('补充要求', noteInput),
      ]),
      ...actionPanels,
      el('div', { class: 'card writing-result' }, [
        el('div', { class: 'card-title', text: '结果' }),
        output,
      ]),
    );

    container.append(app);
    refresh().catch((e) => {
      statusLine.textContent = e.message || String(e);
    });
  },
};
