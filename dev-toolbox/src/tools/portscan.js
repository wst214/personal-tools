import { el, btn, toast, kvRow } from '../ui/helpers.js';

export const portScanTool = {
  id: 'portscan',
  name: '端口扫描',
  category: '网络',
  icon: '⌁',
  keywords: 'port scan 端口 扫描',
  desc: '扫描主机开放端口',
  render(c) {
    const host = el('input', { class: 'input', value: '127.0.0.1', placeholder: '主机 / IP' });
    const start = el('input', { class: 'input', type: 'number', value: '1' });
    const end = el('input', { class: 'input', type: 'number', value: '1024' });
    const out = el('div', { class: 'result-box' });

    const scan = btn('扫描', async () => {
      if (!window.toolbox?.portScan) { toast('需在桌面端运行', 'error'); return; }
      const s = Math.max(1, +start.value || 1);
      const e = Math.min(65535, +end.value || 1024);
      if (e < s) { toast('结束端口需大于起始', 'warn'); return; }
      const ports = [];
      for (let i = s; i <= e; i++) ports.push(i);
      out.innerHTML = '';
      out.append(el('div', { text: `扫描中（${ports.length} 个端口）…`, style: { color: 'var(--text-dim)' } }));
      const r = await window.toolbox.portScan(host.value || '127.0.0.1', ports, 600);
      out.innerHTML = '';
      out.append(kvRow('开放端口', r.open.length ? r.open.join(', ') : '无'));
      out.append(kvRow('扫描总数', r.total));
    }, { variant: 'primary' });

    c.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '端口扫描' }),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'field', style: { flex: '1' } }, [el('label', { text: '主机' }), host]),
        el('div', { class: 'field' }, [el('label', { text: '起始' }), start]),
        el('div', { class: 'field' }, [el('label', { text: '结束' }), end]),
        scan,
      ]),
      out,
    ]));
  },
};
