import { v1, v4, v7 } from 'uuid';
import { el, btn, copyBtn } from '../ui/helpers.js';

export const uuidTool = {
  id: 'uuid',
  name: 'UUID 生成',
  category: '编码转换',
  icon: 'ID',
  keywords: 'uuid guid',
  desc: '批量生成 UUID',
  render(container) {
    const count = el('input', { class: 'input', type: 'number', value: '10', min: '1', max: '1000' });
    const version = el('select', { class: 'select' }, ['v4', 'v1', 'v7'].map((v) => el('option', { value: v, text: v })));
    const upper = el('input', { type: 'checkbox' });
    const braces = el('input', { type: 'checkbox' });
    const noSep = el('input', { type: 'checkbox' });
    const out = el('textarea', { class: 'tx', placeholder: '生成结果…' });
    out.readOnly = true;

    const gen = () => {
      const n = Math.min(1000, Math.max(1, +count.value || 1));
      const fn = { v1, v4, v7 }[version.value] || v4;
      const lines = [];
      for (let i = 0; i < n; i++) {
        let u = fn();
        if (noSep.checked) u = u.replace(/-/g, '');
        if (upper.checked) u = u.toUpperCase();
        if (braces.checked) u = '{' + u + '}';
        lines.push(u);
      }
      out.value = lines.join('\n');
    };

    container.append(
      el('div', { class: 'form-row' }, [
        el('div', { class: 'field' }, [el('label', { text: '版本' }), version]),
        el('div', { class: 'field' }, [el('label', { text: '数量' }), count]),
      ]),
      el('div', { class: 'form-row check-row' }, [
        el('label', { class: 'check' }, [upper, ' 大写']),
        el('label', { class: 'check' }, [braces, ' 花括号']),
        el('label', { class: 'check' }, [noSep, ' 去横线']),
      ]),
      el('div', { class: 'form-row' }, [btn('生成', gen, { variant: 'primary' }), btn('清空', () => (out.value = '')), copyBtn(() => out.value)]),
      el('div', { class: 'pane', style: { flex: '1', minHeight: '240px' } }, [out]),
    );
    gen();
  },
};
