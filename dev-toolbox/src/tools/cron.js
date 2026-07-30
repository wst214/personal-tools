import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';
import { el, btn, copyBtn, escapeHtml } from '../ui/helpers.js';

const PRESETS = [
  ['每分钟', '* * * * *'],
  ['每小时整点', '0 * * * *'],
  ['每天 0 点', '0 0 * * *'],
  ['每天 9 点', '0 9 * * *'],
  ['每 5 分钟', '*/5 * * * *'],
  ['每 30 分钟', '*/30 * * * *'],
  ['工作日 9 点', '0 9 * * MON-FRI'],
  ['每周一 9 点', '0 9 * * MON'],
  ['每月 1 号', '0 0 1 * *'],
  ['每天 0/12 点', '0 0,12 * * *'],
];

const DAY = { SUN: '日', MON: '一', TUE: '二', WED: '三', THU: '四', FRI: '五', SAT: '六' };
const WEEK = '日一二三四五六';

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 周${WEEK[d.getDay()]}`;
}

function safeCronstrue(v) {
  try { const c = cronstrue.default || cronstrue; return c.toString(v); }
  catch { return ''; }
}

function describeZh(v) {
  const p = v.split(/\s+/);
  if (p.length < 5) throw new Error('至少 5 段：分 时 日 月 周');
  const [m, h, dom, mon, dow] = p;
  const every = (s) => (s.match(/^\*\/(\d+)$/) || [, null])[1];
  let e;
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return '每分钟执行';
  if ((e = every(m)) && h === '*') return `每 ${e} 分钟执行一次`;
  if ((e = every(h)) && m === '0') return `每 ${e} 小时执行一次（整分）`;
  if (m === '0' && h.includes(',') && dom === '*' && mon === '*' && dow === '*') return `每天 ${h.split(',').map((x) => x + ':00').join('、')} 执行`;
  if (m === '0' && h !== '*' && dom === '*' && mon === '*' && dow === '*') return `每天 ${h}:00 执行`;
  if (m === '0' && h !== '*' && dom === '*' && mon === '*' && dow !== '*') {
    let dn = dow.includes('-') ? (() => { const [a, b] = dow.split('-'); return `${DAY[a] || a}至${DAY[b] || b}`; })() : dow.split(',').map((x) => DAY[x] || x).join('、');
    return `每周${dn} ${h}:00 执行`;
  }
  if (m === '0' && h === '0' && dom !== '*' && mon === '*' && dow === '*') return `每月 ${dom} 号 0 点执行`;
  return `分=${m} 时=${h} 日=${dom} 月=${mon} 周=${dow}`;
}

export const cronTool = {
  id: 'cron',
  name: 'Cron',
  category: '其它',
  icon: '◷',
  keywords: 'cron crontab schedule',
  desc: 'Cron 表达式解析',
  render(container) {
    const expr = el('input', { class: 'input', value: '0 9 * * MON-FRI', style: { width: '100%' } });
    const desc = el('div', { class: 'cron-desc' });
    const next = el('div', { class: 'next-list' });
    const fields = el('div', { class: 'field-grid' });

    const run = () => {
      const v = expr.value.trim();
      desc.innerHTML = '';
      next.innerHTML = '';
      fields.innerHTML = '';
      if (!v) return;
      let zh = '';
      try { zh = describeZh(v); }
      catch (e) { desc.innerHTML = '<span class="err">表达式无效：' + escapeHtml(e.message) + '</span>'; return; }
      const en = safeCronstrue(v);
      desc.innerHTML = '<b>' + escapeHtml(zh) + '</b>' + (en ? '<br><span style="color:var(--text-dim)">' + escapeHtml(en) + '</span>' : '');

      const parts = v.split(/\s+/);
      const labels = parts.length === 5 ? ['分', '时', '日', '月', '周'] : ['秒', '分', '时', '日', '月', '周'];
      parts.forEach((pv, i) => fields.append(el('div', { class: 'field-card' }, [el('div', { class: 'field-name', text: labels[i] || '?' }), el('div', { class: 'field-val', text: pv })])));

      try {
        const iter = CronExpressionParser.parse(v, { currentDate: new Date() });
        for (let i = 0; i < 5; i++) {
          const d = iter.next().toDate();
          next.append(el('div', { class: 'next-item' }, [el('span', { class: 'next-no', text: '+' + (i + 1) }), el('span', { text: fmt(d) })]));
        }
      } catch (e) {
        next.append(el('div', { class: 'err', text: e.message }));
      }
    };

    const presets = el('div', { class: 'preset-list' }, PRESETS.map(([n, c]) => btn(n, () => { expr.value = c; run(); }, { variant: 'ghost' })));
    expr.addEventListener('input', run);

    container.append(
      el('div', { class: 'card' }, [el('div', { class: 'card-title', text: 'Cron 表达式' }), expr, presets]),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '描述' }), desc]),
        el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '字段分解' }), fields]),
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '未来 5 次执行' }), next]),
    );
    run();
  },
};
