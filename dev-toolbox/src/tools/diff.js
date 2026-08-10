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
  // drop trailing empty from split if both end with newline-ish
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

export const diffTool = {
  id: 'diff',
  name: 'Diff 对比',
  category: '文本',
  icon: '≠',
  keywords: 'diff compare text json 对比 差异',
  desc: '文本 / JSON 左右 Diff',
  render(container) {
    const tabs = ['文本', 'JSON'];
    let mode = '文本';
    let view = 'unified'; // unified | side
    let lastCopy = '';

    const tabBar = el('div', { class: 'tabs' });
    const bodyWrap = el('div', { class: 'diff-app' });

    tabs.forEach((t) => {
      const tab = el('button', {
        class: 'tab' + (t === mode ? ' active' : ''),
        type: 'button',
        onclick: () => {
          mode = t;
          [...tabBar.children].forEach((c) => c.classList.remove('active'));
          tab.classList.add('active');
          left.placeholder = mode === 'JSON' ? '左侧 JSON…' : '左侧文本…';
          right.placeholder = mode === 'JSON' ? '右侧 JSON…' : '右侧文本…';
        },
      }, t);
      tabBar.append(tab);
    });

    const left = textarea(mode === 'JSON' ? '左侧 JSON…' : '左侧文本…');
    const right = textarea(mode === 'JSON' ? '右侧 JSON…' : '右侧文本…');
    const result = el('div', { class: 'diff-result' });
    result.append(el('div', { class: 'diff-meta', text: '对比结果将显示在这里' }));

    const leftPane = el('div', { class: 'pane' }, [
      el('div', { class: 'pane-head', text: '左侧' }),
      left,
    ]);
    const rightPane = el('div', { class: 'pane' }, [
      el('div', { class: 'pane-head', text: '右侧' }),
      right,
    ]);

    function run() {
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
        result.innerHTML = '';
        result.append(el('div', { class: 'diff-meta', text: '对比结果将显示在这里' }));
        bodyWrap.classList.remove('has-result');
        toast(e.message, 'error');
      }
    }

    const actionBar = el('div', { class: 'action-bar' }, [
      btn('对比', run, { variant: 'primary' }),
      btn('交换', () => {
        const t = left.value;
        left.value = right.value;
        right.value = t;
      }),
      btn('清空', () => {
        left.value = '';
        right.value = '';
        result.innerHTML = '';
        result.append(el('div', { class: 'diff-meta', text: '对比结果将显示在这里' }));
        lastCopy = '';
        bodyWrap.classList.remove('has-result');
      }),
      btn('统一视图', () => {
        view = 'unified';
        if (left.value || right.value) run();
      }),
      btn('并排视图', () => {
        view = 'side';
        if (left.value || right.value) run();
      }),
      copyBtn(() => lastCopy || '', '复制 Diff'),
    ]);

    const editors = el('div', { class: 'diff-inputs' }, [leftPane, actionBar, rightPane]);
    bodyWrap.append(editors, result);
    container.append(tabBar, bodyWrap);
  },
};
