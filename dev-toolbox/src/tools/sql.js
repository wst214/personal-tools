import { format } from 'sql-formatter';
import { twoPane, btn, copyBtn, el, toast } from '../ui/helpers.js';

const LANGS = ['mysql', 'postgresql', 'sql', 'tsql', 'plsql', 'db2', 'sqlite', 'mariadb', 'bigquery', 'redshift', 'snowflake', 'spark', 'trino'];

export const sqlTool = {
  id: 'sql',
  name: 'SQL 格式化',
  category: '文本',
  icon: '▤',
  keywords: 'sql format beautify',
  desc: 'SQL 美化 / 压缩',
  render(container) {
    const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 SQL…', outputPlaceholder: '格式化结果…' });
    const lang = el('select', { class: 'select' }, LANGS.map((l) => el('option', { value: l, text: l })));
    lang.value = 'mysql';
    const kw = el('select', { class: 'select' }, [el('option', { value: 'preserve', text: '保留' }), el('option', { value: 'upper', text: '大写' }), el('option', { value: 'lower', text: '小写' })]);
    const indent = el('select', { class: 'select' }, ['2', '4', 'tab'].map((i) => el('option', { value: i, text: i })));

    const beautify = () => {
      if (!input.value.trim()) { toast('请输入 SQL', 'warn'); return; }
      try {
        output.value = format(input.value, {
          language: lang.value,
          // preserve 时省略该键：sql-formatter 对显式 undefined 的 keywordCase 处理异常会吞掉关键字
          ...(kw.value !== 'preserve' ? { keywordCase: kw.value } : {}),
          tabWidth: indent.value === 'tab' ? 2 : +indent.value,
          useTabs: indent.value === 'tab',
        });
        toast('已美化', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
    const minify = () => {
      if (!input.value.trim()) { toast('请输入 SQL', 'warn'); return; }
      output.value = input.value.replace(/\s+/g, ' ').replace(/\s*([,()])\s*/g, '$1 ').trim();
      toast('已压缩', 'success');
    };

    actionBar.append(
      el('div', { class: 'field' }, [el('label', { text: '方言' }), lang]),
      el('div', { class: 'field' }, [el('label', { text: '关键字' }), kw]),
      el('div', { class: 'field' }, [el('label', { text: '缩进' }), indent]),
      btn('美化', beautify, { variant: 'primary' }),
      btn('压缩', minify),
      copyBtn(() => output.value),
    );
    container.append(body);
  },
};
