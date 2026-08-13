import { diffLines, diffArrays } from 'diff';
import { el, btn, copyBtn, textarea, toast, escapeHtml } from '../ui/helpers.js';

function normalizeJson(text) {
  const v = JSON.parse(text);
  return JSON.stringify(v, null, 2);
}

function prepare(left, right, asJson) {
  if (!asJson) return { left, right };
  try {
    return { left: normalizeJson(left), right: normalizeJson(right) };
  } catch (e) {
    throw new Error('JSON 无效：' + (e.message || e));
  }
}

function statsFromParts(parts) {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    const n = p.count ?? (p.value.match(/\n/g) || []).length || (p.value ? 1 : 0);
    if (p.added) added += n;
    else if (p.removed) removed += n;
  }
  return { added, removed };
}

function toUnifiedText(parts) {
  return parts.map((p) => {
    const mark = p.added ? '+' : p.removed ? '-' : ' ';
    const lines = p.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.map((l) => mark + l).join('\n') + (p.value.endsWith('\n') ? '\n' : '');
  }).join('');
}

function renderUnified(host, left, right) {
  const parts = diffLines(left, right);
  const { added, removed } = statsFromParts(parts);
  const frag = document.createDocumentFragment();
  let ln = 0;
  for (const p of parts) {
    const lines = p.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      ln += 1;
      const cls = p.added ? 'add' : p.removed ? 'del' : 'same';
      const mark = p.added ? '+' : p.removed ? '-' : ' ';
      frag.append(el('div', { class: `diff-line ${cls}` }, [
        el('span', { class: 'diff-gutter', text: String(ln) }),
        el('span', { class: 'diff-mark', text: mark }),
        el('span', { class: 'diff-code', html: escapeHtml(line) || ' ' }),
      ]));
    }
  }
  host.innerHTML = '';
  host.append(
    el('div', { class: 'diff-meta', text: `+${added}  −${removed}` }),
    el('div', { class: 'diff-body' }, [frag]),
  );
  return { added, removed, text: toUnifiedText(parts) };
}

function renderSideBySide(host, left, right) {
  const L = left.split('\n');
  const R = right.split('\n');
  if (L.length && L[L.length - 1] === '' && left.endsWith('\n')) L.pop();
  if (R.length && R[R.length - 1] === '' && right.endsWith('\n')) R.pop();

  const parts = diffArrays(L, R);
  let added = 0;
  let removed = 0;
  const rows = el('div', { class: 'diff-side' });
  let li = 0;
  let ri = 0;

  for (const p of parts) {
    if (p.removed) {
      removed += p.value.length;
      for (const line of p.value) {
        li += 1;
        rows.append(el('div', { class: 'diff-row del' }, [
          el('span', { class: 'diff-gutter', text: String(li) }),
          el('span', { class: 'diff-code', html: escapeHtml(line) || ' ' }),
          el('span', { class: 'diff-gutter', text: '' }),
          el('span', { class: 'diff-code empty', text: '' }),
        ]));
      }
    } else if (p.added) {
      added += p.value.length;
      for (const line of p.value) {
        ri += 1;
        rows.append(el('div', { class: 'diff-row add' }, [
          el('span', { class: 'diff-gutter', text: '' }),
          el('span', { class: 'diff-code empty', text: '' }),
          el('span', { class: 'diff-gutter', text: String(ri) }),
          el('span', { class: 'diff-code', html: escapeHtml(line) || ' ' }),
        ]));
      }
    } else {
      for (const line of p.value) {
        li += 1;
        ri += 1;
        rows.append(el('div', { class: 'diff-row same' }, [
          el('span', { class: 'diff-gutter', text: String(li) }),
          el('span', { class: 'diff-code', html: escapeHtml(line) || ' ' }),
          el('span', { class: 'diff-gutter', text: String(ri) }),
          el('span', { class: 'diff-code', html: escapeHtml(line) || ' ' }),
        ]));
      }
    }
  }

  host.innerHTML = '';
  host.append(
    el('div', { class: 'diff-meta', text: `+${added}  −${removed}　左 ${L.length} 行 / 右 ${R.length} 行` }),
    el('div', { class: 'diff-side-head' }, [
      el('span', { text: '左侧' }),
      el('span', { text: '右侧' }),
    ]),
    el('div', { class: 'diff-body' }, [rows]),
  );
  return { added, removed, text: toUnifiedText(diffLines(left, right)) };
}

function joinPath(root, rel) {
  const a = String(root || '').replace(/[/\\]+$/, '');
  const b = String(rel || '').replace(/^[/\\]+/, '').replace(/\//g, '\\');
  return `${a}\\${b}`;
}

function formatSize(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}

function compareFolderMaps(leftMap, rightMap) {
  const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
  const rows = [];
  for (const path of [...keys].sort((a, b) => a.localeCompare(b))) {
    const L = leftMap.get(path);
    const R = rightMap.get(path);
    if (L && !R) rows.push({ path, status: 'left', left: L, right: null });
    else if (!L && R) rows.push({ path, status: 'right', left: null, right: R });
    else if (L.size === R.size && L.mtime === R.mtime) rows.push({ path, status: 'same', left: L, right: R });
    else rows.push({ path, status: 'changed', left: L, right: R });
  }
  return rows;
}

export const diffTool = {
  id: 'diff',
  name: 'Diff 对比',
  category: '文本',
  icon: '≠',
  keywords: 'diff compare text json folder directory 对比 差异 文件夹',
  desc: '文本 / JSON / 文件夹 Diff',
  render(container) {
    const tabs = ['文本', 'JSON', '文件夹'];
    let mode = '文本';
    let view = 'unified';
    let lastCopy = '';
    let folderFilter = 'diff';
    let folderRows = [];
    let leftDir = '';
    let rightDir = '';
    let selectedRel = '';

    const tabBar = el('div', { class: 'tabs' });
    const bodyWrap = el('div', { class: 'diff-app' });
    const textEditors = el('div', { class: 'diff-inputs' });
    const folderPanel = el('div', { class: 'diff-folder', hidden: true });
    const result = el('div', { class: 'diff-result' });
    result.append(el('div', { class: 'diff-meta', text: '对比结果将显示在这里' }));

    const left = textarea('左侧文本…');
    const right = textarea('右侧文本…');
    const leftPane = el('div', { class: 'pane' }, [
      el('div', { class: 'pane-head', text: '左侧' }),
      left,
    ]);
    const rightPane = el('div', { class: 'pane' }, [
      el('div', { class: 'pane-head', text: '右侧' }),
      right,
    ]);

    const leftPath = el('input', { class: 'input diff-folder-path', type: 'text', placeholder: '左侧文件夹路径…', readonly: true });
    const rightPath = el('input', { class: 'input diff-folder-path', type: 'text', placeholder: '右侧文件夹路径…', readonly: true });
    const folderMeta = el('div', { class: 'diff-meta', text: '用法：选左右文件夹 → 对比 → 左侧点文件看内容差异' });
    const folderList = el('div', { class: 'diff-folder-list' });
    const folderFileDiff = el('div', { class: 'diff-folder-file' });
    folderFileDiff.append(el('div', { class: 'diff-folder-placeholder', text: '在左侧点选文件后，这里显示内容 Diff' }));
    const folderWorkspace = el('div', { class: 'diff-folder-workspace' }, [
      folderMeta,
      el('div', { class: 'diff-folder-main' }, [
        el('div', { class: 'diff-folder-col' }, [
          el('div', { class: 'diff-folder-col-head', text: '文件清单' }),
          folderList,
        ]),
        el('div', { class: 'diff-folder-col' }, [
          el('div', { class: 'diff-folder-col-head', text: '内容 Diff' }),
          folderFileDiff,
        ]),
      ]),
    ]);

    function isFolderMode() {
      return mode === '文件夹';
    }

    function clearTextResult() {
      result.innerHTML = '';
      result.append(el('div', { class: 'diff-meta', text: '对比结果将显示在这里' }));
      bodyWrap.classList.remove('has-result');
      lastCopy = '';
    }

    function clearFolderResult() {
      folderRows = [];
      selectedRel = '';
      lastCopy = '';
      folderMeta.textContent = '用法：选左右文件夹 → 对比 → 左侧点文件看内容差异';
      folderList.innerHTML = '';
      folderFileDiff.innerHTML = '';
      folderFileDiff.append(el('div', { class: 'diff-folder-placeholder', text: '在左侧点选文件后，这里显示内容 Diff' }));
      renderFolderList();
    }

    async function pickDir(side) {
      const tb = window.toolbox;
      const invokePick = () => {
        if (tb?.diffPickDir) return tb.diffPickDir();
        if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('diff_pick_dir');
        return Promise.resolve({ ok: false, error: '当前环境不支持选文件夹' });
      };
      const r = await invokePick();
      if (r?.canceled) return;
      if (!r?.ok || !r.path) {
        toast(r?.error || '选择失败', 'error');
        return;
      }
      if (side === 'left') {
        leftDir = r.path;
        leftPath.value = r.path;
      } else {
        rightDir = r.path;
        rightPath.value = r.path;
      }
    }

    async function scanDir(dir) {
      const tb = window.toolbox;
      const invokeScan = () => {
        if (tb?.diffScanDir) return tb.diffScanDir(dir);
        if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('diff_scan_dir', { dir });
        return Promise.resolve({ ok: false, error: '当前环境不支持扫描目录' });
      };
      const r = await invokeScan();
      if (!r?.ok) throw new Error(r?.error || '扫描失败');
      const map = new Map();
      for (const f of r.files || []) map.set(f.path, f);
      return { map, count: r.count || 0, truncated: !!r.truncated };
    }

    function statusLabel(s) {
      if (s === 'left') return '仅左侧';
      if (s === 'right') return '仅右侧';
      if (s === 'changed') return '有差异';
      return '相同';
    }

    function filteredFolderRows() {
      if (folderFilter === 'all') return folderRows;
      if (folderFilter === 'diff') return folderRows.filter((r) => r.status !== 'same');
      return folderRows.filter((r) => r.status === folderFilter);
    }

    function renderFolderList() {
      const rows = filteredFolderRows();
      folderList.innerHTML = '';
      if (!rows.length) {
        folderList.append(el('div', {
          class: 'diff-folder-empty',
          text: folderRows.length ? '没有匹配的条目' : '先选左右文件夹，再点「对比」',
        }));
        return;
      }
      for (const row of rows) {
        folderList.append(el('button', {
          class: `diff-folder-item status-${row.status}` + (row.path === selectedRel ? ' active' : ''),
          type: 'button',
          onclick: () => openFolderFile(row),
        }, [
          el('span', { class: 'diff-folder-badge', text: statusLabel(row.status) }),
          el('span', { class: 'diff-folder-path-text', text: row.path }),
          el('span', {
            class: 'diff-folder-size',
            text: row.status === 'left'
              ? formatSize(row.left?.size)
              : row.status === 'right'
                ? formatSize(row.right?.size)
                : `${formatSize(row.left?.size)} → ${formatSize(row.right?.size)}`,
          }),
        ]));
      }
    }

    async function openFolderFile(row) {
      selectedRel = row.path;
      renderFolderList();
      if (row.status === 'same') {
        folderFileDiff.innerHTML = '';
        folderFileDiff.append(el('div', { class: 'diff-meta', text: `${row.path}　两端相同（按大小/修改时间）` }));
        return;
      }
      if (row.status === 'left' || row.status === 'right') {
        folderFileDiff.innerHTML = '';
        folderFileDiff.append(el('div', {
          class: 'diff-meta',
          text: `${row.path}　${statusLabel(row.status)}，无对端文件可做内容 Diff`,
        }));
        return;
      }

      folderFileDiff.innerHTML = '';
      folderFileDiff.append(el('div', { class: 'diff-meta', text: `正在读取 ${row.path}…` }));

      const tb = window.toolbox;
      const readOne = (path) => {
        if (tb?.diffReadText) return tb.diffReadText(path);
        if (window.__TAURI__?.core?.invoke) return window.__TAURI__.core.invoke('diff_read_text', { path, maxBytes: null });
        return Promise.resolve({ ok: false, error: '无法读文件' });
      };

      try {
        const [a, b] = await Promise.all([
          readOne(joinPath(leftDir, row.path)),
          readOne(joinPath(rightDir, row.path)),
        ]);
        if (!a?.ok || !b?.ok) {
          folderFileDiff.innerHTML = '';
          folderFileDiff.append(el('div', {
            class: 'diff-meta',
            text: `无法对比内容：${a?.error || b?.error || '未知错误'}`,
          }));
          return;
        }
        const out = view === 'side'
          ? renderSideBySide(folderFileDiff, a.body || '', b.body || '')
          : renderUnified(folderFileDiff, a.body || '', b.body || '');
        lastCopy = out.text;
      } catch (e) {
        folderFileDiff.innerHTML = '';
        folderFileDiff.append(el('div', { class: 'diff-meta', text: String(e.message || e) }));
      }
    }

    async function runFolder() {
      if (!leftDir || !rightDir) {
        toast('请先选择左右两个文件夹', 'warn');
        return;
      }
      toast('正在扫描…');
      try {
        const [L, R] = await Promise.all([scanDir(leftDir), scanDir(rightDir)]);
        folderRows = compareFolderMaps(L.map, R.map);
        const onlyL = folderRows.filter((r) => r.status === 'left').length;
        const onlyR = folderRows.filter((r) => r.status === 'right').length;
        const changed = folderRows.filter((r) => r.status === 'changed').length;
        const same = folderRows.filter((r) => r.status === 'same').length;
        folderMeta.textContent = `仅左 ${onlyL} · 仅右 ${onlyR} · 差异 ${changed} · 相同 ${same}`
          + (L.truncated || R.truncated ? '（已截断，文件过多）' : '');
        selectedRel = '';
        folderFileDiff.innerHTML = '';
        folderFileDiff.append(el('div', { class: 'diff-folder-placeholder', text: '在左侧点选文件后，这里显示内容 Diff' }));
        renderFolderList();
        lastCopy = folderRows
          .filter((r) => r.status !== 'same')
          .map((r) => `${statusLabel(r.status)}\t${r.path}`)
          .join('\n');
        if (onlyL + onlyR + changed === 0) toast('两个文件夹文件清单一致', 'success');
        else toast(`差异文件 ${onlyL + onlyR + changed} 个`, 'success');
      } catch (e) {
        clearFolderResult();
        toast(e.message || String(e), 'error');
      }
    }

    function runText() {
      const a = left.value;
      const b = right.value;
      if (!a.trim() && !b.trim()) { toast('请输入内容', 'warn'); return; }
      try {
        const prepared = prepare(a, b, mode === 'JSON');
        if (mode === 'JSON') {
          left.value = prepared.left;
          right.value = prepared.right;
        }
        const out = view === 'side'
          ? renderSideBySide(result, prepared.left, prepared.right)
          : renderUnified(result, prepared.left, prepared.right);
        lastCopy = out.text;
        bodyWrap.classList.add('has-result');
        if (out.added === 0 && out.removed === 0) toast('两端完全相同', 'success');
        else toast(`差异 +${out.added} −${out.removed}`, 'success');
      } catch (e) {
        clearTextResult();
        toast(e.message, 'error');
      }
    }

    function run() {
      if (isFolderMode()) return runFolder();
      return runText();
    }

    const textActions = el('div', { class: 'action-bar' }, [
      btn('对比', run, { variant: 'primary' }),
      btn('交换', () => {
        const t = left.value;
        left.value = right.value;
        right.value = t;
      }),
      btn('清空', () => {
        left.value = '';
        right.value = '';
        clearTextResult();
      }),
      btn('统一视图', () => {
        view = 'unified';
        if (left.value || right.value) runText();
      }),
      btn('并排视图', () => {
        view = 'side';
        if (left.value || right.value) runText();
      }),
      copyBtn(() => lastCopy || '', '复制 Diff'),
    ]);

    const filterBar = el('div', { class: 'diff-folder-filters' });
    const filters = [
      ['diff', '仅差异'],
      ['all', '全部'],
      ['left', '仅左'],
      ['right', '仅右'],
      ['changed', '有改动'],
      ['same', '相同'],
    ];
    for (const [id, label] of filters) {
      filterBar.append(el('button', {
        class: 'btn' + (folderFilter === id ? ' btn-primary' : ''),
        type: 'button',
        text: label,
        onclick: () => {
          folderFilter = id;
          [...filterBar.children].forEach((c, i) => {
            c.classList.toggle('btn-primary', filters[i][0] === folderFilter);
          });
          renderFolderList();
        },
      }));
    }

    const folderToolbar = el('div', { class: 'diff-folder-toolbar' }, [
      btn('对比', run, { variant: 'primary' }),
      btn('交换', () => {
        const t = leftDir;
        leftDir = rightDir;
        rightDir = t;
        leftPath.value = leftDir;
        rightPath.value = rightDir;
      }),
      btn('清空', () => {
        leftDir = '';
        rightDir = '';
        leftPath.value = '';
        rightPath.value = '';
        clearFolderResult();
      }),
      btn('统一视图', () => {
        view = 'unified';
        const row = folderRows.find((r) => r.path === selectedRel);
        if (row) openFolderFile(row);
      }),
      btn('并排视图', () => {
        view = 'side';
        const row = folderRows.find((r) => r.path === selectedRel);
        if (row) openFolderFile(row);
      }),
      copyBtn(() => lastCopy || '', '复制清单'),
    ]);

    const folderTop = el('div', { class: 'diff-folder-top' }, [
      el('div', { class: 'diff-folder-card' }, [
        el('div', { class: 'pane-head', text: '左侧文件夹' }),
        el('div', { class: 'diff-folder-pick' }, [
          leftPath,
          btn('选择…', () => pickDir('left')),
        ]),
      ]),
      el('div', { class: 'diff-folder-card' }, [
        el('div', { class: 'pane-head', text: '右侧文件夹' }),
        el('div', { class: 'diff-folder-pick' }, [
          rightPath,
          btn('选择…', () => pickDir('right')),
        ]),
      ]),
    ]);

    textEditors.append(leftPane, textActions, rightPane);
    folderPanel.append(folderTop, folderToolbar, filterBar, folderWorkspace);
    renderFolderList();

    function syncModeUi() {
      const folder = isFolderMode();
      textEditors.hidden = folder;
      folderPanel.hidden = !folder;
      result.hidden = folder;
      if (folder) {
        bodyWrap.classList.remove('has-result');
        clearFolderResult();
      } else {
        clearTextResult();
        left.placeholder = mode === 'JSON' ? '左侧 JSON…' : '左侧文本…';
        right.placeholder = mode === 'JSON' ? '右侧 JSON…' : '右侧文本…';
      }
    }

    tabs.forEach((t) => {
      const tab = el('button', {
        class: 'tab' + (t === mode ? ' active' : ''),
        type: 'button',
        text: t,
        onclick: () => {
          mode = t;
          [...tabBar.children].forEach((c) => c.classList.remove('active'));
          tab.classList.add('active');
          syncModeUi();
        },
      });
      tabBar.append(tab);
    });

    bodyWrap.append(textEditors, folderPanel, result);
    container.append(tabBar, bodyWrap);
  },
};
