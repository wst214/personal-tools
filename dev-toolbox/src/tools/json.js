import { twoPane, btn, copyBtn, el, toast, download } from '../ui/helpers.js';
import { coerce } from './jsonOps.js';

const LARGE = 512 * 1024; // 与 worker 对齐：超过则不把大文本塞进 textarea
const TEXTAREA_CHUNK = 256 * 1024;

// ---- Web Worker ----
const pending = new Map();
let seq = 0;
let worker;
function dispatch(op, payload) {
  return new Promise((resolve) => {
    if (!worker) {
      worker = new Worker(new URL('./json-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const raw = e.data;
        const cb = pending.get(raw.id);
        if (!cb) return;
        pending.delete(raw.id);
        if (raw.transfer && raw.bytes) {
          // 下载场景：直接 Blob，避免主线程再解码一遍超大字符串
          if (raw.download) {
            cb({ ...raw, blob: new Blob([raw.bytes], { type: 'application/json' }), value: null, transfer: false });
          } else {
            const value = new TextDecoder().decode(raw.bytes);
            cb({ ...raw, value, transfer: false });
          }
        } else {
          cb(raw);
        }
      };
    }
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ id, op, ...payload });
  });
}

let busyEl = null;
function setBusy(on, text) {
  if (!busyEl) {
    busyEl = el('div', { class: 'json-busy', text: '处理中…' });
    document.body.append(busyEl);
  }
  if (text) busyEl.textContent = text;
  else busyEl.textContent = '处理中…';
  busyEl.classList.toggle('show', !!on);
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

/** 大内容旁路：不写入 textarea，避免 10MB 级卡顿 */
function bindLargeSource(input) {
  let sourceText = '';
  const getText = () => (input.dataset.large === '1' ? sourceText : input.value);
  const clearLarge = () => {
    sourceText = '';
    delete input.dataset.large;
  };
  const setLarge = (text, label) => {
    sourceText = text;
    input.dataset.large = '1';
    input.value = label || `【已加载大 JSON（${fmtSize(text.length)}），未写入输入框以免卡顿。可直接格式化 / 压缩 / 折叠视图。】`;
  };
  input.addEventListener('input', () => {
    if (input.dataset.large === '1') clearLarge();
  });
  input.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t && t.length >= LARGE) {
      e.preventDefault();
      setLarge(t);
      toast(`已接收大 JSON（${fmtSize(t.length)}），已跳过输入框写入`, 'success');
    }
  });
  return { getText, setLarge, clearLarge };
}

/** 中等结果分块写入，避免一次赋值冻住主线程 */
function setTextareaValue(textarea, text) {
  return new Promise((resolve) => {
    if (!text || text.length <= TEXTAREA_CHUNK) {
      textarea.value = text || '';
      resolve();
      return;
    }
    textarea.value = '';
    let offset = 0;
    const step = () => {
      const end = Math.min(offset + TEXTAREA_CHUNK, text.length);
      // 用 setRangeText 追加，比反复 += 更稳
      const start = textarea.value.length;
      textarea.setRangeText(text.slice(offset, end), start, start, 'end');
      offset = end;
      if (offset < text.length) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

function xmlToJson(xmlStr) {
  const dom = new DOMParser().parseFromString(xmlStr, 'text/xml');
  if (dom.querySelector('parsererror')) throw new Error('XML 解析失败');
  function walk(node) {
    const kids = Array.from(node.children);
    if (!kids.length) return coerce(node.textContent.trim());
    const obj = {};
    for (const k of kids) {
      const v = walk(k);
      if (obj[k.nodeName] !== undefined) {
        if (!Array.isArray(obj[k.nodeName])) obj[k.nodeName] = [obj[k.nodeName]];
        obj[k.nodeName].push(v);
      } else obj[k.nodeName] = v;
    }
    return obj;
  }
  const root = dom.documentElement;
  return { [root.nodeName]: walk(root) };
}

export const jsonTool = {
  id: 'json',
  name: 'JSON 格式化',
  category: '编码转换',
  icon: '{}',
  keywords: 'json format compress escape xml csv properties yaml toml java',
  desc: '格式化 / 压缩 / 转换 / 实体',
  render(container) {
    const tabs = ['格式化', '转换', 'Java 实体', 'C# 实体'];
    let mode = '格式化';
    const tabBar = el('div', { class: 'tabs' });
    const bodyWrap = el('div');
    tabs.forEach((t) => {
      const tab = el('button', {
        class: 'tab' + (t === mode ? ' active' : ''),
        type: 'button',
        onclick: () => {
          mode = t;
          [...tabBar.children].forEach((c) => c.classList.remove('active'));
          tab.classList.add('active');
          bodyWrap.innerHTML = '';
          bodyWrap.append(build());
        },
      }, t);
      tabBar.append(tab);
    });
    container.append(tabBar, bodyWrap);

    function need(text) {
      if (!String(text || '').trim()) { toast('请输入内容', 'warn'); return false; }
      return true;
    }

    function showTree(treeWrap, output, treeJson) {
      const pane = output.closest('.pane');
      output.value = '';
      output.style.display = 'none';
      treeWrap.style.display = 'block';
      treeWrap.innerHTML = '';
      treeWrap.append(buildTreeView(treeJson));
      if (pane) {
        const tx = pane.querySelector('.tx');
        if (tx) tx.style.display = 'none';
      }
    }

    function hideTree(treeWrap, output) {
      if (treeWrap) treeWrap.style.display = 'none';
      output.style.display = '';
      const pane = output.closest('.pane');
      if (pane) {
        const tx = pane.querySelector('.tx');
        if (tx) tx.style.display = '';
      }
    }

    async function applyResult(output, treeWrap, res, onOk) {
      if (!res.ok) { toast(res.error || '处理失败', 'error'); return; }
      if (res.view === 'tree' && treeWrap) {
        showTree(treeWrap, output, res.value);
        const tip = res.large
          ? `大文件（${fmtSize(res.inputBytes || 0)}）已用折叠视图，避免卡顿；可点「下载格式化」导出`
          : '已切换折叠视图';
        toast(tip, 'success');
        onOk && onOk(res);
        return;
      }
      if (treeWrap) hideTree(treeWrap, output);
      // 超大压缩结果：不写 textarea，提示下载
      if (res.large && res.value && res.value.length >= LARGE) {
        output.value = `【结果 ${fmtSize(res.value.length)}，已跳过写入文本框。请用「下载结果」导出。】\n压缩比：${fmtSize(res.inputBytes || 0)} → ${fmtSize(res.outputBytes || res.value.length)}`;
        output._largeResult = res.value;
        toast(`压缩完成（${fmtSize(res.value.length)}），请下载结果`, 'success');
        onOk && onOk(res);
        return;
      }
      output._largeResult = null;
      setBusy(true, '写入结果…');
      await setTextareaValue(output, res.value);
      onOk && onOk(res);
    }

    function run(getText, output, treeWrap, op, opts, onOk) {
      const text = typeof getText === 'function' ? getText() : getText.value;
      if (!need(text)) return;
      setBusy(true, text.length >= LARGE ? `处理大文件（${fmtSize(text.length)}）…` : '处理中…');
      dispatch(op, { text, opts })
        .then((res) => applyResult(output, treeWrap, res, onOk))
        .finally(() => setBusy(false));
    }

    function validate(getText) {
      const text = typeof getText === 'function' ? getText() : getText.value;
      if (!need(text)) return;
      setBusy(true);
      dispatch('compress', { text, opts: {} })
        .then((res) => {
          toast(res.ok ? '✓ 合法 JSON' : res.error, res.ok ? 'success' : 'error');
        })
        .finally(() => setBusy(false));
    }

    function build() {
      if (mode === '转换') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: 'JSON / XML / YAML / TOML…', outputPlaceholder: '转换结果…' });
        const src = bindLargeSource(input);

        async function convertConfig(kind) {
          const t = src.getText();
          if (!need(t)) return;
          setBusy(true, '转换中…');
          try {
            const [{ load, dump }, toml] = await Promise.all([
              import('js-yaml'),
              import('smol-toml'),
            ]);
            let out;
            switch (kind) {
              case 'json2yaml':
                out = dump(JSON.parse(t), { indent: 2, lineWidth: -1 });
                break;
              case 'yaml2json':
                out = JSON.stringify(load(t), null, 2);
                break;
              case 'json2toml':
                out = toml.stringify(JSON.parse(t));
                break;
              case 'toml2json':
                out = JSON.stringify(toml.parse(t), null, 2);
                break;
              case 'yaml2toml':
                out = toml.stringify(load(t));
                break;
              case 'toml2yaml':
                out = dump(toml.parse(t), { indent: 2, lineWidth: -1 });
                break;
              default:
                throw new Error('未知转换');
            }
            await setTextareaValue(output, String(out).replace(/\n$/, '') + '\n');
            toast('完成');
          } catch (e) {
            toast(e.message || String(e), 'error');
          } finally {
            setBusy(false);
          }
        }

        actionBar.append(
          btn('JSON→XML', () => run(src.getText, output, null, 'xml', {})),
          btn('XML→JSON', () => {
            const t = src.getText();
            if (!need(t)) return;
            setBusy(true);
            setTimeout(() => {
              try {
                const out = JSON.stringify(xmlToJson(t), null, 2);
                setTextareaValue(output, out).then(() => toast('完成'));
              } catch (e) { toast(e.message, 'error'); }
              finally { setBusy(false); }
            }, 10);
          }),
          btn('JSON→CSV', () => run(src.getText, output, null, 'csv', {})),
          btn('JSON→Properties', () => run(src.getText, output, null, 'properties', {})),
          btn('JSON→YAML', () => convertConfig('json2yaml')),
          btn('YAML→JSON', () => convertConfig('yaml2json')),
          btn('JSON→TOML', () => convertConfig('json2toml')),
          btn('TOML→JSON', () => convertConfig('toml2json')),
          btn('YAML→TOML', () => convertConfig('yaml2toml')),
          btn('TOML→YAML', () => convertConfig('toml2yaml')),
          copyBtn(() => output._largeResult || output.value),
        );
        return body;
      }
      if (mode === 'Java 实体') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 JSON 对象…', outputPlaceholder: 'Java 实体类…' });
        const cls = el('input', { class: 'input', placeholder: '类名', value: 'Root' });
        const src = bindLargeSource(input);
        actionBar.append(
          el('div', { class: 'field' }, [el('label', { text: '类名' }), cls]),
          btn('生成', () => run(src.getText, output, null, 'java', { name: cls.value.trim() || 'Root' }, () => toast('已生成', 'success')), { variant: 'primary' }),
          copyBtn(() => output.value),
        );
        return body;
      }
      if (mode === 'C# 实体') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 JSON 对象…', outputPlaceholder: 'C# 实体类…' });
        const cls = el('input', { class: 'input', placeholder: '类名', value: 'Root' });
        const src = bindLargeSource(input);
        actionBar.append(
          el('div', { class: 'field' }, [el('label', { text: '类名' }), cls]),
          btn('生成', () => run(src.getText, output, null, 'csharp', { name: cls.value.trim() || 'Root' }, () => toast('已生成', 'success')), { variant: 'primary' }),
          copyBtn(() => output.value),
        );
        return body;
      }

      // ---- 格式化 ----
      const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 JSON…（大文件请用「打开文件」或直接粘贴，会自动旁路输入框）', outputPlaceholder: '格式化结果…' });
      const src = bindLargeSource(input);
      const treeWrap = el('div', { class: 'json-tree-wrap' });
      const outPane = body.children[2];
      if (outPane) outPane.appendChild(treeWrap);

      let lastSp = 2;

      const fileInput = el('input', { type: 'file', accept: '.json,application/json,text/plain,*/*', style: { display: 'none' } });
      fileInput.onchange = async () => {
        const f = fileInput.files?.[0];
        fileInput.value = '';
        if (!f) return;
        setBusy(true, `读取 ${f.name}…`);
        try {
          const text = await f.text();
          if (text.length >= LARGE) {
            src.setLarge(text, `【文件 ${f.name}（${fmtSize(text.length)}）已加载，未写入输入框以免卡顿。】`);
          } else {
            src.clearLarge();
            input.value = text;
          }
          toast(`已加载 ${f.name}（${fmtSize(text.length)}）`, 'success');
        } catch (e) {
          toast(e.message || '读取失败', 'error');
        } finally {
          setBusy(false);
        }
      };

      function renderTree() {
        const text = src.getText();
        if (!need(text)) return;
        setBusy(true, text.length >= LARGE ? `解析大文件（${fmtSize(text.length)}）…` : '解析中…');
        dispatch('parse', { text, opts: {} })
          .then((res) => {
            if (!res.ok) { toast(res.error || '解析失败', 'error'); return; }
            showTree(treeWrap, output, res.value);
            toast('折叠视图已就绪', 'success');
          })
          .finally(() => setBusy(false));
      }

      async function downloadPretty() {
        const text = src.getText();
        if (!need(text)) return;
        setBusy(true, `生成格式化文件（${fmtSize(text.length)}）…`);
        try {
          const res = await dispatch('prettyFile', { text, opts: { sp: lastSp } });
          if (!res.ok) { toast(res.error || '失败', 'error'); return; }
          if (res.blob) {
            download('formatted.json', res.blob, 'application/json');
            toast('已下载格式化文件', 'success');
          } else {
            download('formatted.json', res.value, 'application/json');
            toast(`已下载（${fmtSize(res.value.length)}）`, 'success');
          }
        } finally {
          setBusy(false);
        }
      }

      function downloadResult() {
        const data = output._largeResult || output.value;
        if (!data || data.startsWith('【')) {
          // 折叠视图时走 pretty 下载
          downloadPretty();
          return;
        }
        download('result.json', data, 'application/json');
        toast('已下载', 'success');
      }

      actionBar.append(
        btn('打开文件', () => fileInput.click()),
        fileInput,
        btn('缩进 2 空格', () => {
          lastSp = 2;
          run(src.getText, output, treeWrap, 'pretty', { sp: 2 });
        }),
        btn('缩进 4 空格', () => {
          lastSp = 4;
          run(src.getText, output, treeWrap, 'pretty', { sp: 4 });
        }),
        btn('压缩', () => run(src.getText, output, treeWrap, 'compress', {})),
        btn('转义', () => run(src.getText, output, treeWrap, 'escape', {})),
        btn('去转义', () => run(src.getText, output, treeWrap, 'unescape', {})),
        btn('校验', () => validate(src.getText)),
        btn('折叠视图', () => renderTree()),
        btn('下载格式化', () => downloadPretty()),
        btn('下载结果', () => downloadResult()),
        copyBtn(() => output._largeResult || output.value || ''),
      );
      return body;
    }

    bodyWrap.append(build());
  },
};

// ---- 折叠视图 ----
function buildTreeView(rootNode) {
  const wrap = el('div', { class: 'json-tree' });
  const root = typeof rootNode === 'string' ? JSON.parse(rootNode) : rootNode;
  appendNode(wrap, root, 0, true);
  return wrap;
}

function appendNode(parent, node, depth, isRoot) {
  const row = el('div', { class: 'json-tree-row' + (isRoot ? ' root' : ''), style: { paddingLeft: (depth * 16 + 8) + 'px' } });

  if (node.type === 'object' || node.type === 'array') {
    const hasInline = node.children && node.children.length > 0;
    const canLoad = !hasInline && node.count > 0;
    const open = isRoot ? true : false;
    const caret = el('span', { class: 'json-tree-caret' + (open ? ' open' : ''), text: hasInline ? (open ? '▾' : '▸') : (canLoad ? '▸' : '') });
    const typeLabel = node.type === 'object' ? `{${node.count}}` : `[${node.count}]`;
    const keySpan = el('span', { class: 'json-tree-key', text: node.key === '$' ? 'root' : node.key });
    const childrenWrap = el('div', { class: 'json-tree-children' + (open ? '' : ' hidden') });
    if (hasInline) {
      for (const c of node.children) appendNode(childrenWrap, c, depth + 1, false);
    }

    row.append(caret, keySpan, el('span', { class: 'json-tree-type', text: typeLabel }));
    row.onclick = (e) => {
      if (e.target.closest('.json-tree-row') !== row) return;
      if (!hasInline && canLoad && !childrenWrap.dataset.loaded) {
        caret.textContent = '…';
        dispatch('children', { path: node.path }).then((res) => {
          caret.textContent = '▾';
          caret.classList.add('open');
          childrenWrap.classList.remove('hidden');
          childrenWrap.dataset.loaded = '1';
          if (!res.ok) { caret.textContent = ''; return; }
          const kids = JSON.parse(res.value);
          const BATCH = 200;
          let idx = 0;
          const renderBatch = () => {
            const end = Math.min(idx + BATCH, kids.length);
            for (; idx < end; idx++) appendNode(childrenWrap, kids[idx], depth + 1, false);
            if (idx < kids.length) {
              const more = el('div', { class: 'json-tree-more', text: `加载更多…（${kids.length - idx} 条剩余）` });
              more.onclick = () => { more.remove(); renderBatch(); };
              childrenWrap.appendChild(more);
            }
          };
          renderBatch();
        });
        return;
      }
      caret.classList.toggle('open');
      childrenWrap.classList.toggle('hidden');
    };
    parent.append(row, childrenWrap);
  } else {
    const caret = el('span', { class: 'json-tree-caret', text: '' });
    const keySpan = el('span', { class: 'json-tree-key', text: node.key === '$' ? 'root' : node.key });
    const valSpan = el('span', { class: 'json-tree-val', text: node.preview });
    row.append(caret, keySpan, el('span', { class: 'json-tree-sep', text: ': ' }), valSpan);
    parent.append(row);
  }
}
