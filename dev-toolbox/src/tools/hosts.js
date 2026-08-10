import { el, btn, toast, kvRow } from '../ui/helpers.js';

export const hostsTool = {
  id: 'hosts',
  name: 'Hosts',
  category: '系统',
  icon: '⌗',
  keywords: 'hosts dns 域名解析',
  desc: '编辑系统 hosts',
  render(c) {
    const meta = el('div', { class: 'hosts-meta result-box' });
    const ta = el('textarea', {
      class: 'tx hosts-editor',
      placeholder: 'hosts 文件内容',
    });

    const load = async () => {
      if (!window.toolbox?.hostsRead) {
        meta.innerHTML = '';
        meta.append(el('div', { class: 'err', text: '需在桌面端运行' }));
        return;
      }
      const r = await window.toolbox.hostsRead();
      meta.innerHTML = '';
      if (!r.ok) {
        meta.append(el('div', { class: 'err', text: r.error }));
        return;
      }
      meta.append(kvRow('文件', r.path));
      ta.value = r.content;
    };
    const save = btn('保存', async () => {
      const r = await window.toolbox.hostsWrite(ta.value);
      toast(r.ok ? '已保存（可执行 ipconfig /flushdns 刷新 DNS 缓存）' : r.error, r.ok ? 'success' : 'error');
    }, { variant: 'primary' });

    c.append(el('div', { class: 'card hosts-card' }, [
      el('div', { class: 'form-row hosts-toolbar' }, [
        el('div', { class: 'card-title', text: 'Hosts 管理', style: { flex: '1' } }),
        btn('重新加载', load),
        save,
      ]),
      meta,
      ta,
    ]));
    load();
  },
};
