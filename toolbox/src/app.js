import { tools } from './tools/registry.js';
import { el } from './ui/helpers.js';

// 应用骨架：无边框标题栏 + 左侧工具导航 + 右侧工具区。
export function startApp() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  const titlebar = el(
    'div',
    { class: 'titlebar' },
    el(
      'div',
      { class: 'titlebar-brand' },
      el('span', { class: 'titlebar-dot' }),
      el('span', { class: 'titlebar-title' }, '工具箱'),
    ),
  );

  const sidebar = el('aside', { class: 'sidebar' });
  const main = el('main', { class: 'main' });
  const body = el('div', { class: 'body' }, sidebar, main);

  app.append(titlebar, body);

  let current = tools[0];

  function renderSidebar() {
    sidebar.innerHTML = '';
    sidebar.append(
      el('div', { class: 'sidebar-section-label' }, '工具'),
      ...tools.map((t) =>
        el(
          'button',
          {
            class: 'nav-item' + (t.id === current.id ? ' active' : ''),
            onclick: () => select(t),
          },
          el('span', { class: 'nav-icon', html: t.icon || '' }),
          el('span', { class: 'nav-label' }, t.title),
        ),
      ),
    );
  }

  function renderTool() {
    main.innerHTML = '';
    if (current.render) current.render(main);
  }

  function select(t) {
    if (current === t) return;
    if (current.onLeave) current.onLeave();
    current = t;
    renderSidebar();
    renderTool();
  }

  renderSidebar();
  renderTool();
}
