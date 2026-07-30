import { el, toast, escapeHtml, btn, copyBtn, debounce } from '../ui/helpers.js';

export const regexTool = {
  id: 'regex',
  name: '正则测试',
  category: '文本',
  icon: '.*',
  keywords: 'regex regexp match replace',
  desc: '正则匹配与替换',
  render(container) {
    const pat = el('input', { class: 'input', placeholder: '正则表达式（不含两端的 /）', value: '\\d+' });
    const flags = el('input', { class: 'input', value: 'g', style: { width: '90px' } });
    const count = el('span', { class: 'badge', text: '0' });
    const replaceStr = el('input', { class: 'input', placeholder: '替换为（留空则只匹配）' });
    const sample = el('textarea', { class: 'tx', text: '订单 123 号 456 共 789 元' });
    const highlight = el('div', { class: 'regex-highlight' });
    const matches = el('div', { class: 'match-list' });

    const run = debounce(() => {
      const src = pat.value;
      const text = sample.value;
      highlight.innerHTML = '';
      matches.innerHTML = '';
      if (!src) { highlight.textContent = text || ''; count.textContent = '0'; return; }
      let re;
      try { re = new RegExp(src, flags.value); }
      catch (e) { count.textContent = '✗'; highlight.innerHTML = '<span class="err">无效正则：' + escapeHtml(e.message) + '</span>'; return; }
      const found = [];
      if (re.global) {
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null && guard++ < 99999) {
          found.push(m);
          if (m.index === re.lastIndex) re.lastIndex++;
        }
      } else {
        const m = re.exec(text);
        if (m) found.push(m);
      }
      count.textContent = found.length + ' 处';
      let html = '';
      let last = 0;
      for (const m of found) {
        html += escapeHtml(text.slice(last, m.index));
        html += '<mark>' + escapeHtml(m[0]) + '</mark>';
        last = m.index + m[0].length;
      }
      html += escapeHtml(text.slice(last));
      highlight.innerHTML = html;
      if (replaceStr.value) {
        try { matches.append(el('div', { class: 'match-item replaced' }, [el('span', { class: 'match-no', text: '替换' }), el('span', { text: text.replace(re, replaceStr.value) })])); } catch {}
      }
      found.forEach((m, i) => {
        matches.append(el('div', { class: 'match-item' }, [
          el('span', { class: 'match-no', text: '#' + (i + 1) }),
          el('span', { class: 'match-val', text: m[0] }),
          m.length > 1 ? el('span', { class: 'match-groups', text: m.slice(1).map((g, gi) => `$${gi + 1}="${g ?? ''}"`).join('  ') }) : null,
        ]));
      });
    }, 150);

    [pat, flags, replaceStr, sample].forEach((c) => c.addEventListener('input', run));

    container.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'form-row' }, [
          el('div', { class: 'field', style: { flex: '1' } }, [el('label', { text: '正则' }), pat]),
          el('div', { class: 'field' }, [el('label', { text: '标志' }), flags, count]),
        ]),
        el('div', { class: 'field' }, [el('label', { text: '替换' }), replaceStr]),
      ]),
      el('div', { class: 'pane', style: { minHeight: '120px' } }, [el('div', { class: 'pane-head', text: '待匹配文本' }), sample]),
      el('div', { class: 'pane', style: { minHeight: '90px' } }, [el('div', { class: 'pane-head', text: '高亮结果' }), highlight]),
      el('div', { class: 'pane' }, [el('div', { class: 'pane-head', text: '匹配详情' }), matches]),
    );
    run();
  },
};
