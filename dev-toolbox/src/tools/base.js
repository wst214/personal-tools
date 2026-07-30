import { el, btn, copyBtn, kvRow, debounce } from '../ui/helpers.js';

const BASES = [
  ['2', '二进制'],
  ['8', '八进制'],
  ['10', '十进制'],
  ['16', '十六进制'],
];

export const baseTool = {
  id: 'base',
  name: '进制转换',
  category: '编码转换',
  icon: '0x',
  keywords: 'base binary octal decimal hex radix 进制',
  desc: '二/八/十/十六进制互转',
  render(c) {
    const input = el('input', { class: 'input', placeholder: '输入数值', value: '255' });
    const from = el('select', { class: 'select' }, BASES.map(([v, t]) => el('option', { value: v, text: `${t} (基${v})` })));
    from.value = '10';
    const out = el('div', { class: 'kv-grid' });
    const run = () => {
      const raw = input.value.trim();
      out.innerHTML = '';
      if (!raw) return;
      let n;
      try {
        n = parseInt(raw.replace(/0x/i, ''), +from.value);
        if (isNaN(n)) throw new Error();
      } catch {
        out.append(el('div', { class: 'err', text: '无法解析为数值' }));
        return;
      }
      for (const [b, name] of BASES) {
        const v = n.toString(+b).toUpperCase();
        if (+b === +from.value) continue;
        out.append(kvRow(name, v));
      }
      out.append(kvRow('字符', n >= 0 && n <= 0x10ffff ? (String.fromCodePoint(n) || '') : '—'));
    };
    input.addEventListener('input', debounce(run, 150));
    from.addEventListener('change', run);
    c.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'form-row' }, [
          el('div', { class: 'field', style: { flex: '1' } }, [el('label', { text: '数值' }), input]),
          el('div', { class: 'field' }, [el('label', { text: '输入进制' }), from]),
        ]),
        out,
      ]),
    );
    run();
  },
};
