import { tools } from './tools/registry.js';
import { el } from './ui/helpers.js';

// 与应用图标一致的 logo（层叠方块，蓝紫粉渐变）
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="0.5" stop-color="#a855f7"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#lg)"/><rect x="74" y="74" width="108" height="108" rx="26" fill="#ffffff" opacity="0.5" transform="rotate(15 128 128)"/><rect x="74" y="74" width="108" height="108" rx="26" fill="#ffffff" opacity="0.95" transform="rotate(-15 128 128)"/></svg>`;
const GROUP_ICON_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.75 6.75h5.1l1.55 1.65h9.85v8.85a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V6.75Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.75 9.2h16.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="16.7" cy="15.9" r="2.05" fill="none" stroke="currentColor" stroke-width="1.45"/><path d="M16.7 12.9v1.05m0 3.9v1.05m-2.6-1.5.9-.52m3.4-1.95.9-.52m-5.2.02.9.52m3.4 1.95.9.52" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`;

const PINS_KEY = 'devtool-pins';
const GROUPS_KEY = 'devtool-groups';
function loadPins() { try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; } }
function savePins(p) { localStorage.setItem(PINS_KEY, JSON.stringify(p)); }
function loadGroups() { try { return JSON.parse(localStorage.getItem(GROUPS_KEY)) || []; } catch { return []; } }
function saveGroups(groups) { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); }

// 分类显示顺序（其它类置底）；随手记常驻置顶区，不进分类
const CATEGORY_ORDER = ['编码转换', '文本', '网络', '系统', '其它'];
const ALWAYS_TOP = ['notes'];

export function initApp(root) {
  const state = { activeId: tools[0]?.id, cleanup: null, query: '' };
  let pins = loadPins();
  let customGroups = loadGroups();

  const sidebar = el('aside', { class: 'sidebar' });
  const topbar = el('header', { class: 'topbar' });
  const content = el('section', { class: 'content' });
  const main = el('main', { class: 'main' }, [topbar, content]);
  root.append(el('div', { class: 'shell' }, [sidebar, main]));

  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: '搜索工具...',
    oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); renderSidebar(); },
  });
  const nav = el('nav', { class: 'nav' });
  const directoryBtn = el('button', { class: 'sidebar-tool', type: 'button', title: '管理分组', html: GROUP_ICON_SVG, onclick: openGroupManager });
  sidebar.append(
    el('div', { class: 'sidebar-tools' }, [
      el('button', { class: 'sidebar-tool', type: 'button', title: '折叠菜单', text: '◧' }),
      el('button', { class: 'sidebar-tool', type: 'button', title: '搜索', text: '⌕', onclick: () => search.focus() }),
      directoryBtn,
    ]),
    search,
    nav,
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'foot-brand' }, [
        el('span', { class: 'logo-mark', html: LOGO_SVG }),
        el('span', { class: 'logo-text', text: 'DevTool' }),
      ]),
      el('button', { class: 'sidebar-tool', type: 'button', title: '设置', text: '⚙' }),
    ]),
  );

  const themeBtn = el('button', { class: 'icon-btn', type: 'button', title: '切换主题', onclick: toggleTheme });
  function syncThemeIcon() { themeBtn.textContent = document.documentElement.dataset.theme === 'dark' ? '☾' : '☼'; }
  function toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('toolbox-theme', next); } catch {}
    syncThemeIcon();
  }

  function filtered() {
    if (!state.query) return tools;
    return tools.filter((t) => (t.name + ' ' + (t.keywords || '')).toLowerCase().includes(state.query));
  }

  function togglePin(id) {
    pins = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    savePins(pins);
    renderSidebar();
  }

  function navItem(t) {
    const alwaysTop = ALWAYS_TOP.includes(t.id);
    const pinned = alwaysTop || pins.includes(t.id);
    const children = [el('span', { class: 'nav-icon', text: t.icon || '·' }), el('span', { class: 'nav-label', text: t.name })];
    if (!alwaysTop) {
      children.push(el('span', {
        class: 'nav-pin' + (pinned ? ' on' : ''),
        title: pinned ? '取消置顶' : '置顶',
        text: pinned ? '★' : '☆',
        onclick: (e) => { e.stopPropagation(); togglePin(t.id); },
      }));
    }
    return el('button', {
      class: 'nav-item' + (t.id === state.activeId ? ' active' : ''),
      type: 'button',
      onclick: () => { state.activeId = t.id; renderSidebar(); renderTool(); },
    }, children);
  }

  function groupBy(list) {
    const groups = new Map();
    for (const t of list) {
      const c = t.category || '其它';
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(t);
    }
    return groups;
  }

  function orderedCats(groups) {
    const ordered = CATEGORY_ORDER.filter((c) => groups.has(c));
    [...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).forEach((c) => ordered.push(c));
    return ordered;
  }

  function validGroup(group) {
    return group && group.id && group.name && Array.isArray(group.toolIds);
  }

  function normalizedGroups(groups) {
    const validToolIds = new Set(tools.map((t) => t.id));
    return (groups || []).filter(validGroup).map((g) => ({
      id: g.id,
      name: String(g.name || '').trim() || '未命名分组',
      toolIds: [...new Set(g.toolIds)].filter((id) => validToolIds.has(id)),
    }));
  }

  function renderSidebar() {
    nav.innerHTML = '';
    if (state.query) {
      const groups = groupBy(filtered());
      const ordered = orderedCats(groups);
      if (!ordered.length) { nav.append(el('div', { class: 'nav-empty', text: '无匹配工具' })); return; }
      for (const cat of ordered) {
        nav.append(el('div', { class: 'nav-group-title', text: cat }));
        groups.get(cat).forEach((t) => nav.append(navItem(t)));
      }
      return;
    }
    // 置顶区：随手记（常驻）+ 用户置顶
    const topIds = [...ALWAYS_TOP, ...pins.filter((id) => !ALWAYS_TOP.includes(id))];
    const topTools = topIds.map((id) => tools.find((t) => t.id === id)).filter(Boolean);
    if (topTools.length) {
      nav.append(el('div', { class: 'nav-group-title', text: '置顶' }));
      topTools.forEach((t) => nav.append(navItem(t)));
    }
    const visibleCustomGroups = normalizedGroups(customGroups).filter((g) => g.toolIds.length);
    for (const group of visibleCustomGroups) {
      const groupTools = group.toolIds.map((id) => tools.find((t) => t.id === id)).filter(Boolean);
      if (!groupTools.length) continue;
      nav.append(el('div', { class: 'nav-group-title nav-group-custom', text: group.name }));
      groupTools.forEach((t) => nav.append(navItem(t)));
    }
    // 分类区（排除置顶项）
    const groups = groupBy(tools.filter((t) => !topIds.includes(t.id)));
    for (const cat of orderedCats(groups)) {
      nav.append(el('div', { class: 'nav-group-title', text: cat }));
      groups.get(cat).forEach((t) => nav.append(navItem(t)));
    }
  }

  function openGroupManager() {
    let draft = normalizedGroups(customGroups);
    let activeGroupId = draft[0]?.id || null;
    const overlay = el('div', { class: 'group-modal-overlay' });
    const groupList = el('div', { class: 'group-list' });
    const detail = el('div', { class: 'group-detail' });
    const deleteBtn = el('button', { class: 'btn group-delete-btn', type: 'button', text: '删除分组', onclick: deleteActiveGroup });

    function activeGroup() {
      return draft.find((g) => g.id === activeGroupId);
    }

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }

    function createGroup() {
      const group = {
        id: 'group-' + Date.now().toString(36),
        name: '新建分组',
        toolIds: [],
      };
      draft.push(group);
      activeGroupId = group.id;
      renderManager();
    }

    function deleteActiveGroup() {
      if (!activeGroupId) return;
      draft = draft.filter((g) => g.id !== activeGroupId);
      activeGroupId = draft[0]?.id || null;
      renderManager();
    }

    function saveAndClose() {
      customGroups = normalizedGroups(draft);
      saveGroups(customGroups);
      renderSidebar();
      close();
    }

    function renderGroupList() {
      groupList.innerHTML = '';
      const createBtn = el('button', { class: 'group-create-btn', type: 'button', onclick: createGroup }, [
        el('span', { text: '⊞' }),
        el('span', { text: '新建分组' }),
      ]);
      groupList.append(createBtn);
      if (!draft.length) {
        groupList.append(el('div', { class: 'group-empty-hint', text: '暂无自定义分组，点击“新建分组”开始创建。' }));
        return;
      }
      draft.forEach((group) => {
        const count = group.toolIds.length;
        groupList.append(el('button', {
          class: 'group-list-item' + (group.id === activeGroupId ? ' active' : ''),
          type: 'button',
          onclick: () => { activeGroupId = group.id; renderManager(); },
        }, [
          el('span', { class: 'group-list-name', text: group.name }),
          el('span', { class: 'group-list-count', text: `${count} 项` }),
        ]));
      });
    }

    function renderDetail() {
      detail.innerHTML = '';
      const group = activeGroup();
      deleteBtn.disabled = !group;
      if (!group) {
        detail.append(el('div', { class: 'group-detail-empty', text: '暂无自定义分组，点击“新建分组”开始创建。' }));
        return;
      }
      const nameInput = el('input', {
        class: 'input group-name-input',
        value: group.name,
        placeholder: '分组名称',
        oninput: (e) => {
          group.name = e.target.value;
          renderGroupList();
        },
      });
      const toolGrid = el('div', { class: 'group-tool-grid' });
      tools.forEach((tool) => {
        const checked = group.toolIds.includes(tool.id);
        toolGrid.append(el('label', { class: 'group-tool-check' }, [
          el('input', {
            type: 'checkbox',
            checked: checked ? 'checked' : null,
            onchange: (e) => {
              group.toolIds = e.target.checked
                ? [...new Set([...group.toolIds, tool.id])]
                : group.toolIds.filter((id) => id !== tool.id);
              renderGroupList();
            },
          }),
          el('span', { class: 'group-tool-icon', text: tool.icon || '·' }),
          el('span', { class: 'group-tool-name', text: tool.name }),
          el('span', { class: 'group-tool-cat', text: tool.category || '其它' }),
        ]));
      });
      detail.append(
        el('div', { class: 'group-detail-form' }, [
          el('label', { class: 'group-field-label', text: '分组名称' }),
          nameInput,
          el('div', { class: 'group-field-label', text: '选择工具' }),
          toolGrid,
        ]),
      );
    }

    function renderManager() {
      renderGroupList();
      renderDetail();
    }

    overlay.append(el('div', { class: 'group-modal', onclick: (e) => e.stopPropagation() }, [
      el('div', { class: 'group-modal-head' }, [
        el('div', { class: 'group-modal-title', text: '管理功能分组' }),
        el('button', { class: 'group-close-btn', type: 'button', text: '×', onclick: close }),
      ]),
      el('div', { class: 'group-modal-body' }, [
        el('aside', { class: 'group-sidebar' }, [groupList]),
        detail,
      ]),
      el('div', { class: 'group-modal-foot' }, [
        deleteBtn,
        el('span', { class: 'group-foot-spacer' }),
        el('button', { class: 'btn', type: 'button', text: '取消', onclick: close }),
        el('button', { class: 'btn btn-primary group-save-btn', type: 'button', text: '保存', onclick: saveAndClose }),
      ]),
    ]));
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    document.body.append(overlay);
    renderManager();
  }

  function renderTool() {
    if (state.cleanup) { try { state.cleanup(); } catch {} state.cleanup = null; }
    content.innerHTML = '';
    const tool = tools.find((t) => t.id === state.activeId) || tools[0];
    content.className = 'content' + (tool.id === 'notes' ? ' content-notes' : '');
    topbar.className = 'topbar' + (tool.id === 'notes' ? ' topbar-hidden' : '');
    topbar.innerHTML = '';
    topbar.append(
      el('div', { class: 'crumb' }, [
        el('span', { class: 'crumb-cat', text: tool.category || '其它' }),
        el('span', { class: 'crumb-sep', text: '/' }),
        el('span', { class: 'crumb-name', text: tool.name }),
      ]),
      el('div', { class: 'topbar-right' }, [
        el('span', { class: 'topbar-desc', text: tool.desc || '' }),
        themeBtn,
      ]),
    );
    syncThemeIcon();
    const wrap = el('div', { class: 'tool-wrap' });
    content.append(wrap);
    const ret = tool.render(wrap);
    state.cleanup = typeof ret === 'function' ? ret : null;
  }

  renderSidebar();
  renderTool();
}
