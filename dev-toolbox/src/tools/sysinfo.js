import { el, btn, kvRow, isDesktop } from '../ui/helpers.js';

export const sysInfoTool = {
  id: 'sysinfo',
  name: '系统信息',
  category: '系统',
  icon: '▣',
  keywords: 'system cpu memory os info 系统信息',
  desc: '本机系统信息',
  render(c) {
    const out = el('div', { class: 'kv-grid kv-grid-2' });
    const load = async () => {
      out.innerHTML = '';
      if (!isDesktop()) { out.append(el('div', { class: 'err', text: '需在桌面端运行' })); return; }
      const s = await window.toolbox.sysInfo();
      const gb = (b) => (b / 1073741824).toFixed(2) + ' GB';
      const used = s.totalmem - s.freemem;
      const upH = Math.floor(s.uptime / 3600);
      const upM = Math.floor((s.uptime % 3600) / 60);
      const rows = [
        ['系统', s.platform], ['架构', s.arch], ['主机名', s.hostname],
        ['CPU', s.cpuModel], ['核心数', s.cpuCores], ['频率', s.cpuSpeed + ' MHz'],
        ['总内存', gb(s.totalmem)], ['已用', `${gb(used)} (${((used / s.totalmem) * 100).toFixed(0)}%)`], ['可用', gb(s.freemem)],
        ['运行时长', `${upH}h ${upM}m`], ['主目录', s.homedir],
        ['Node', s.nodeVersion], ['Electron', s.electronVersion], ['Chromium', s.chromeVersion],
      ];
      rows.forEach(([k, v]) => out.append(kvRow(k, v)));
      s.network.forEach((n) => n.addrs.forEach((a) => out.append(kvRow(`${n.name} ${a.family}`, a.address))));
    };
    c.append(el('div', { class: 'card sysinfo-card' }, [
      el('div', { class: 'form-row', style: { flexShrink: '0' } }, [
        el('div', { class: 'card-title', text: '系统信息', style: { flex: '1' } }),
        btn('刷新', load),
      ]),
      out,
    ]));
    load();
  },
};
