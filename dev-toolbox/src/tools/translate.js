import { el, btn, toast, twoPane } from '../ui/helpers.js';

const LANGS = [
  ['auto', '自动检测'], ['zh', '中文'], ['en', '英文'], ['ja', '日文'], ['ko', '韩文'],
  ['fr', '法文'], ['de', '德文'], ['es', '西班牙文'], ['ru', '俄文'], ['ar', '阿拉伯文'],
];

export const translateTool = {
  id: 'translate',
  name: '翻译',
  category: '其它',
  icon: '译',
  keywords: 'translate 翻译',
  desc: '文本翻译',
  render(c) {
    const from = el('select', { class: 'select' }, LANGS.map(([v, t]) => el('option', { value: v, text: t })));
    const to = el('select', { class: 'select' }, LANGS.slice(1).map(([v, t]) => el('option', { value: v, text: t })));
    to.value = 'en';
    const inp = el('textarea', { class: 'tx', placeholder: '输入要翻译的文本', style: { minHeight: '120px' } });
    const out = el('textarea', { class: 'tx', placeholder: '翻译结果', style: { minHeight: '120px' } });
    out.readOnly = true;
    const swap = btn('⇄', () => { const f = from.value; from.value = to.value; to.value = f; }, { variant: 'ghost' });
    const run = btn('翻译', async () => {
      if (!window.toolbox?.translate) { toast('需在桌面端运行', 'error'); return; }
      if (!inp.value.trim()) { toast('请输入文本', 'warn'); return; }
      out.value = '翻译中…';
      const r = await window.toolbox.translate({ text: inp.value, from: from.value, to: to.value });
      out.value = r.ok ? r.text : '错误：' + r.error;
    }, { variant: 'primary' });
    c.append(el('div', { class: 'card' }, [
      el('div', { class: 'form-row' }, [
        el('div', { class: 'field' }, [el('label', { text: '源语言' }), from]),
        swap,
        el('div', { class: 'field' }, [el('label', { text: '目标语言' }), to]),
        run,
      ]),
      el('div', { class: 'two-pane', style: { minHeight: '260px' } }, [
        el('div', { class: 'pane' }, [el('div', { class: 'pane-head', text: '原文' }), inp]),
        el('div', { class: 'pane' }, [el('div', { class: 'pane-head', text: '译文' }), out]),
      ]),
    ]));
  },
};
