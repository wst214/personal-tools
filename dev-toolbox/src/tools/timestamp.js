import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { el, btn, toast, copyBtn } from '../ui/helpers.js';

dayjs.extend(utc);
dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const FMT = 'YYYY-MM-DD HH:mm:ss';
const WEEK = '日一二三四五六';

function makeRow(k, v) {
  return el('div', { class: 'kv-row' }, [el('span', { class: 'kv-k', text: k }), el('span', { class: 'kv-v', text: v }), copyBtn(() => v, '复制')]);
}

export const timestampTool = {
  id: 'timestamp',
  name: '时间戳',
  category: '编码转换',
  icon: '◴',
  keywords: 'timestamp date unix time',
  desc: '时间戳与日期互转',
  render(container) {
    const nowVal = el('div', { class: 'now-time', text: '-' });
    const nowTs = el('div', { class: 'now-ts', text: '-' });

    const tsInput = el('input', { class: 'input', placeholder: '输入时间戳（秒或毫秒）…' });
    const tsResult = el('div', { class: 'result-box' });
    const dateInput = el('input', { class: 'input', placeholder: '输入日期 YYYY-MM-DD HH:mm:ss' });
    const dateResult = el('div', { class: 'result-box' });

    function updateNow() {
      const d = dayjs();
      nowVal.textContent = d.format(FMT);
      nowTs.textContent = `${d.unix()} (秒)  /  ${d.valueOf()} (毫秒)`;
    }
    updateNow();
    const timer = setInterval(updateNow, 1000);

    function parseTs(v) {
      v = String(v).trim();
      if (!/^-?\d+$/.test(v)) throw new Error('时间戳应为整数');
      let n = Number(v);
      if (Math.abs(n) < 1e12) n *= 1000;
      return dayjs(n);
    }

    tsInput.addEventListener('input', () => {
      const v = tsInput.value.trim();
      if (!v) { tsResult.innerHTML = ''; return; }
      try {
        const d = parseTs(v);
        tsResult.innerHTML = '';
        for (const [k, val] of [['本地', d.format(FMT)], ['UTC', d.utc().format(FMT)], ['ISO', d.toISOString()], ['相对', d.fromNow()], ['星期', '周' + WEEK[d.day()]]]) tsResult.append(makeRow(k, val));
      } catch (e) { tsResult.innerHTML = ''; tsResult.append(el('div', { class: 'err', text: e.message })); }
    });

    dateInput.addEventListener('input', () => {
      const v = dateInput.value.trim();
      if (!v) { dateResult.innerHTML = ''; return; }
      const d = dayjs(v);
      if (!d.isValid()) { dateResult.innerHTML = ''; dateResult.append(el('div', { class: 'err', text: '无法解析，建议格式 YYYY-MM-DD HH:mm:ss' })); return; }
      dateResult.innerHTML = '';
      for (const [k, val] of [['秒', String(d.unix())], ['毫秒', String(d.valueOf())], ['ISO', d.toISOString()]]) dateResult.append(makeRow(k, val));
    });

    container.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-title', text: '当前时间' }),
        nowVal,
        nowTs,
        el('div', { class: 'form-row' }, [
          btn('复制秒', () => { navigator.clipboard?.writeText(String(dayjs().unix())); toast('已复制'); }),
          btn('复制毫秒', () => { navigator.clipboard?.writeText(String(dayjs().valueOf())); toast('已复制'); }),
        ]),
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '时间戳 → 日期' }), tsInput, tsResult]),
      el('div', { class: 'card' }, [el('div', { class: 'card-title', text: '日期 → 时间戳' }), dateInput, dateResult]),
    );

    return () => clearInterval(timer);
  },
};
