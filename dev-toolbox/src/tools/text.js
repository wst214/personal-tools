import { twoPane, btn, copyBtn, el, toast } from '../ui/helpers.js';
import * as OpenCC from 'opencc-js';

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

function stats(t) {
  const lines = t.split('\n');
  const chars = t.length;
  const charsNoSpace = t.replace(/\s/g, '').length;
  const words = (t.match(/[一-龥]|[A-Za-z0-9]+/g) || []).length;
  const para = t.split(/\n\s*\n/).filter(Boolean).length;
  return [
    `行数：${lines.length}`,
    `字符数：${chars}`,
    `字符数(不含空白)：${charsNoSpace}`,
    `词数：${words}`,
    `段落：${para}`,
  ].join('\n');
}

export const textTool = {
  id: 'text',
  name: '文本处理',
  category: '文本',
  icon: 'T',
  keywords: 'text dedupe sort count case line',
  desc: '去重 / 排序 / 统计 / 大小写',
  render(container) {
    const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '输入文本（每行一条）…', outputPlaceholder: '处理结果…' });
    const lines = () => input.value.split('\n');
    const ops = [
      ['去重', () => [...new Set(lines())].join('\n')],
      ['升序', () => [...lines()].sort().join('\n')],
      ['降序', () => [...lines()].sort((a, b) => b.localeCompare(a)).join('\n')],
      ['反转行序', () => [...lines()].reverse().join('\n')],
      ['去空行', () => lines().filter((l) => l.trim()).join('\n')],
      ['去首尾空白', () => lines().map((l) => l.trim()).join('\n')],
      ['转大写', () => input.value.toUpperCase()],
      ['转小写', () => input.value.toLowerCase()],
      ['首字母大写', () => input.value.replace(/(^|\s+)([a-z])/g, (_, s, c) => s + c.toUpperCase())],
      ['驼峰→下划线', () => input.value.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toLowerCase()],
      ['下划线→驼峰', () => input.value.replace(/_([a-z])/g, (_, c) => c.toUpperCase())],
      ['加行号', () => lines().map((l, i) => `${i + 1}. ${l}`).join('\n')],
      ['简转繁', () => s2t(input.value)],
      ['繁转简', () => t2s(input.value)],
      ['全角→半角', () => input.value.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ')],
      ['半角→全角', () => input.value.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))],
      ['统计', () => stats(input.value)],
    ];
    // 大文本操作异步执行，避免阻塞 UI
    ops.forEach(([label, fn]) => actionBar.append(btn(label, () => {
      setTimeout(() => {
        output.value = fn();
        toast('完成');
      }, 0);
    })));
    actionBar.append(copyBtn(() => output.value));
    container.append(body);
  },
};
