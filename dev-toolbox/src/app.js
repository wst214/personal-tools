import { visibleTools } from './tools/registry.js';
import { el, debounce } from './ui/helpers.js';

// ===== 图标系统：彩色圆角方块 =====
const svg = (content) => `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${content}</g></svg>`;

const TOOL_ICONS = {
  notes: svg('<path d="M7 4.5h8.5L19 8v11.5H7z"/><path d="M15.5 4.5V8H19"/><path d="M10 12h6M10 15h5M10 18h3"/>'),
  json: svg('<path d="M8 7 4 12l4 5M16 7l4 5-4 5"/><path d="m13.5 5-3 14"/>'),
  timestamp: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3.2 2"/>'),
  crypto: svg('<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V8a4 4 0 0 1 8 0v2"/><path d="M12 14v2"/>'),
  base: svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 9.5h.1M8.5 12h.1M8.5 14.5h.1"/><path d="M12.5 9.5h3M12.5 12h3M12.5 14.5h3"/><path d="M15.5 9.5l-6 5"/>'),
  uuid: svg('<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h8M8 14h4.5"/>'),
  sql: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  regex: svg('<path d="M8 4.5v15M16 4.5v15"/><path d="M4.5 8.5c-1 .9-1.5 2-1.5 3.5s.5 2.6 1.5 3.5M19.5 8.5c1 .9 1.5 2 1.5 3.5s-.5 2.6-1.5 3.5"/><path d="M12 8.5v7M9.5 11h5"/>'),
  text: svg('<path d="M5 6h14M12 6v12M9 18h6"/>'),
  qrcode: svg('<rect x="4" y="4" width="5" height="5" rx="1"/><rect x="15" y="4" width="5" height="5" rx="1"/><rect x="4" y="15" width="5" height="5" rx="1"/><path d="M15 15h2v2h3M20 20h-5v-2"/>'),
  cron: svg('<circle cx="12" cy="12" r="8"/><path d="M12 7v5h4"/><path d="M4 4l3 3M20 4l-3 3"/>'),
  translate: svg('<path d="M4 5h9M8.5 5v2.5M6 18l4-9 4 9M7.3 15h5.4"/><path d="M14 6h6M17 6c-.2 3-1.6 5.2-4 6.8M15 10c1.2 1.5 2.8 2.7 5 3.7"/>'),
  http: svg('<path d="M5 8h14M5 16h14"/><path d="m8 5-3 3 3 3M16 13l3 3-3 3"/>'),
  portscan: svg('<circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="7" cy="17" r="2.5"/><path d="M9.5 7h5M7 9.5v5M9 15l6-6"/>'),
  sysinfo: svg('<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M8 9h2M8 12h5"/>'),
  hosts: svg('<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>'),
  deploy: svg('<path d="M12 3c2.5 1.8 4 4.5 4 8l3 3v2l-3.5-1c-.4 1-.9 1.9-1.5 2.7L12 20l-2-2.3c-.6-.8-1.1-1.7-1.5-2.7L5 16v-2l3-3c0-3.5 1.5-6.2 4-8Z"/><path d="M12 3v2M12 13v4M9.5 9.5h5"/>'),
  ssh: svg('<path d="M4 6h16M4 12h16M4 18h10"/><path d="m19 16 2.5 2.5L19 21"/>'),
  diff: svg('<rect x="3.5" y="4" width="7" height="16" rx="1.5"/><rect x="13.5" y="4" width="7" height="16" rx="1.5"/><path d="M6 9h2M6 12h2M6 15h1.5M15.5 9h2M15.5 12h2M15.5 15h1.5"/>'),
  embed: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9h17M8 4.5v15"/>'),
  // 多上游汇聚到中心再转发，契合 API 网关
  newapi: svg('<circle cx="12" cy="12" r="2.8"/><circle cx="5" cy="6.5" r="1.7"/><circle cx="19" cy="6.5" r="1.7"/><circle cx="5" cy="17.5" r="1.7"/><circle cx="19" cy="17.5" r="1.7"/><path d="M6.5 7.6 9.8 10.4M17.5 7.6 14.2 10.4M6.5 16.4 9.8 13.6M17.5 16.4 14.2 13.6"/>'),
};

// 每个工具的图标底色（彩色圆角方块）
const ICON_COLORS = {
  notes: 'linear-gradient(135deg,#f59e0b,#f97316)',
  json: 'linear-gradient(135deg,#6366f1,#4f46e5)',
  timestamp: 'linear-gradient(135deg,#ec4899,#db2777)',
  crypto: 'linear-gradient(135deg,#0e9f6e,#059669)',
  base: 'linear-gradient(135deg,#06b6d4,#0891b2)',
  uuid: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  sql: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  regex: 'linear-gradient(135deg,#f43f5e,#e11d48)',
  text: 'linear-gradient(135deg,#64748b,#475569)',
  qrcode: 'linear-gradient(135deg,#3b82f6,#2563eb)',
  cron: 'linear-gradient(135deg,#f59e0b,#f97316)',
  translate: 'linear-gradient(135deg,#06b6d4,#0891b2)',
  http: 'linear-gradient(135deg,#3b82f6,#2563eb)',
  portscan: 'linear-gradient(135deg,#10b981,#059669)',
  sysinfo: 'linear-gradient(135deg,#64748b,#475569)',
  hosts: 'linear-gradient(135deg,#0e9f6e,#059669)',
  deploy: 'linear-gradient(135deg,#f97316,#ea580c)',
  ssh: 'linear-gradient(135deg,#10b981,#059669)',
  diff: 'linear-gradient(135deg,#14b8a6,#0d9488)',
  embed: 'linear-gradient(135deg,#8b5cf6,#7c3aed)',
  newapi: 'linear-gradient(135deg,#0ea5e9,#0284c8)',
};

// 主图标（对点连线，调细版）
// 界面 logo：直接用 dist/logo.png（public 目录复制），与桌面图标一致
const LOGO_SVG = `<img src="./logo.png" alt="DevTool" style="width:100%;height:100%;display:block;border-radius:9px;object-fit:cover;">`;

const ICONS = {
  search: svg('<circle cx="10.8" cy="10.8" r="6.2"/><path d="m16 16 4.3 4.3"/>'),
  group: svg('<rect x="4" y="5" width="6" height="6" rx="1.5"/><rect x="14" y="5" width="6" height="6" rx="1.5"/><rect x="4" y="15" width="6" height="4" rx="1.4"/><path d="M14 17h6M17 14v6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  pin: svg('<path d="M9 4h6l-.7 5.2 3.7 3.6v1.4h-5.1L12 20l-.9-5.8H6v-1.4l3.7-3.6L9 4Z"/>'),
  pinOn: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-.7 5.2 3.7 3.6v1.4h-5.1L12 20l-.9-5.8H6v-1.4l3.7-3.6L9 4Z" fill="currentColor"/></svg>`,
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.8 12h2M19.2 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>'),
  moon: svg('<path d="M20 15.2A7.7 7.7 0 0 1 8.8 4a8.2 8.2 0 1 0 11.2 11.2Z"/>'),
  setting: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/>'),
};

function toolIconSvg(tool) {
  return TOOL_ICONS[tool.id] || ICONS.search;
}

// ===== 分组管理（保留原逻辑） =====
const PINS_KEY = 'devtool-pins';
const GROUPS_KEY = 'devtool-groups';
const GROUPS_VERSION_KEY = 'devtool-groups-version';
const GROUPS_VERSION = 8;
function loadPins() { try { return JSON.parse(localStorage.getItem(PINS_KEY)) || []; } catch { return []; } }
function savePins(p) { localStorage.setItem(PINS_KEY, JSON.stringify(p)); }

function defaultGroups() {
  const g = (name, ids) => ({ id: 'group-' + name, name, toolIds: ids });
  return [
    g('\u7f16\u7801\u8f6c\u6362', ['json', 'timestamp', 'crypto']),
    g('\u6587\u672c\u5904\u7406', ['sql', 'regex', 'diff']),
    g('\u7f51\u7edc\u5de5\u5177', ['http', 'ssh']),
    g('\u7cfb\u7edf\u5de5\u5177', ['sysinfo', 'hosts', 'deploy', 'embed', 'newapi']),
    g('\u5176\u5b83\u5de5\u5177', ['qrcode', 'cron']),
  ];
}
function loadGroups() {
  try {
    const saved = JSON.parse(localStorage.getItem(GROUPS_KEY));
    const version = Number(localStorage.getItem(GROUPS_VERSION_KEY));
    if (!Array.isArray(saved) || version !== GROUPS_VERSION) {
      const defaults = defaultGroups();
      const merged = mergeGroups(saved, defaults);
      saveGroups(merged);
      localStorage.setItem(GROUPS_VERSION_KEY, String(GROUPS_VERSION));
      return merged;
    }
    return saved;
  } catch { return defaultGroups(); }
}
function mergeGroups(saved, defaults) {
  const base = Array.isArray(saved) && saved.length
    ? saved.map((g) => ({ ...g, toolIds: [...(g.toolIds || [])] }))
    : defaults.map((d) => ({ ...d, toolIds: [...d.toolIds] })); // 无历史数据 → 直接用默认分组
  const baseById = new Map(base.map((g) => [g.id, g]));
  const haveTool = (id) => base.some((g) => g.toolIds.includes(id));
  for (const d of defaults) {
    let existing = baseById.get(d.id);
    if (!existing) {
      // 用户删过默认分组时，把尚未入组的新工具补回该分组
      const ids = d.toolIds.filter((tid) => !haveTool(tid));
      if (!ids.length) continue;
      existing = { id: d.id, name: d.name, toolIds: ids };
      base.push(existing);
      baseById.set(d.id, existing);
      continue;
    }
    for (const tid of d.toolIds) {
      if (!haveTool(tid)) existing.toolIds.push(tid);
    }
  }
  // 兜底：任何仍未入组的可见工具，丢进「其它工具」
  let other = baseById.get('group-\u5176\u5b83\u5de5\u5177');
  if (!other) {
    other = { id: 'group-\u5176\u5b83\u5de5\u5177', name: '\u5176\u5b83\u5de5\u5177', toolIds: [] };
    base.push(other);
    baseById.set(other.id, other);
  }
  for (const t of visibleTools) {
    if (!haveTool(t.id)) other.toolIds.push(t.id);
  }
  return base;
}
function saveGroups(groups) { localStorage.setItem(GROUPS_KEY, JSON.stringify(groups)); }

const CATEGORY_ORDER = ['\u7f16\u7801\u8f6c\u6362', '\u6587\u672c', '\u7f51\u7edc', '\u7cfb\u7edf', '\u5176\u5b83'];

// ===== 配色方案 =====
const THEMES = [
  { id: '1', name: '\u6e05\u723d\u84dd\u767d' },
  { id: '2', name: '\u6696\u6728\u7c73\u8272' },
  { id: '3', name: '\u51b7\u7070\u79d1\u6280' },
  { id: '4', name: '\u8584\u8377\u9752\u7eff' },
];
const THEME_KEY = 'toolbox-ui-theme';
function loadTheme() { try { return localStorage.getItem(THEME_KEY) || '4'; } catch { return '4'; } }
function saveTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch {} }

export function initApp(root) {
  const state = { activeId: visibleTools[0]?.id, cleanup: null, query: '' };
  let pins = loadPins();
  let customGroups = loadGroups();

  // 配色
  document.body.dataset.theme = loadTheme();
  function applyTheme(t) {
    document.body.dataset.theme = t;
    saveTheme(t);
  }

  const sidebar = el('aside', { class: 'sidebar' });
  const main = el('main', { class: 'main' });
  const pageHead = el('div', { class: 'page-head' });
  const pageTitle = el('div', { class: 'page-title' });
  const pageSub = el('div', { class: 'page-sub' });
  const content = el('section', { class: 'content' });
  pageHead.append(pageTitle, pageSub);
  main.append(pageHead, content);
  root.append(el('div', { class: 'shell' }, [sidebar, main]));

  // 搜索（防抖，避免每个按键重建侧栏）
  const renderSidebarSoon = debounce(() => renderSidebar(), 120);
  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: '\u641c\u7d22\u5de5\u5177...',
    oninput: (e) => { state.query = e.target.value.trim().toLowerCase(); renderSidebarSoon(); },
  });

  const nav = el('nav', { class: 'nav' });
  const directoryBtn = el('button', { class: 'sidebar-tool', type: 'button', title: '\u7ba1\u7406\u5206\u7ec4', html: ICONS.group, onclick: openGroupManager });
  const settingsBtn = el('button', { class: 'sidebar-tool', type: 'button', title: '\u8bbe\u7f6e', html: ICONS.setting, onclick: openSettings });

  sidebar.append(
    el('div', { class: 'sb-brand' }, [
      el('span', { class: 'logo-mark', html: LOGO_SVG }),
      el('span', { class: 'logo-text', text: 'DevTool' }),
    ]),
    el('div', { class: 'search-row' }, [search, directoryBtn]),
    nav,
    el('div', { class: 'sidebar-foot' }, [
      el('div', { class: 'foot-brand' }, [
        el('span', { class: 'foot-dot' }),
        el('span', { class: 'foot-text', text: '\u672c\u5730\u5de5\u5177\u7bb1' }),
      ]),
      settingsBtn,
    ]),
  );

  function filtered() {
    if (!state.query) return visibleTools;
    return visibleTools.filter((t) => (t.name + ' ' + (t.keywords || '')).toLowerCase().includes(state.query));
  }

  function togglePin(id) {
    pins = pins.includes(id) ? pins.filter((x) => x !== id) : [...pins, id];
    savePins(pins);
    renderSidebar();
  }

  function navItem(t) {
    const pinned = pins.includes(t.id);
    const children = [
      el('span', { class: 'nav-icon', style: { background: ICON_COLORS[t.id] || 'var(--hover)' }, html: toolIconSvg(t) }),
      el('span', { class: 'nav-label', text: t.name }),
    ];
    children.push(el('span', {
      class: 'nav-pin' + (pinned ? ' on' : ''),
      title: pinned ? '\u53d6\u6d88\u7f6e\u9876' : '\u7f6e\u9876',
      text: pinned ? '\u2605' : '\u2606',
      onclick: (e) => { e.stopPropagation(); togglePin(t.id); },
    }));
    return el('button', {
      class: 'nav-item' + (t.id === state.activeId ? ' active' : ''),
      type: 'button',
      onclick: () => { state.activeId = t.id; renderSidebar(); renderTool(); },
    }, children);
  }

  function groupBy(list) {
    const groups = new Map();
    for (const t of list) {
      const c = t.category || '\u5176\u5b83';
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
    const validToolIds = new Set(visibleTools.map((t) => t.id));
    return (groups || []).filter(validGroup).map((g) => ({
      id: g.id,
      name: String(g.name || '').trim() || '\u672a\u547d\u540d\u5206\u7ec4',
      toolIds: [...new Set(g.toolIds)].filter((id) => validToolIds.has(id)),
    }));
  }

  function renderSidebar() {
    nav.innerHTML = '';
    if (state.query) {
      const groups = groupBy(filtered());
      const ordered = orderedCats(groups);
      if (!ordered.length) { nav.append(el('div', { class: 'nav-empty', text: '\u6ca1\u6709\u627e\u5230\u5de5\u5177' })); return; }
      for (const cat of ordered) {
        nav.append(el('div', { class: 'nav-group-title', text: cat }));
        groups.get(cat).forEach((t) => nav.append(navItem(t)));
      }
      return;
    }
    // 随手记恒置顶 + 用户置顶
    const topIds = ['notes', ...pins.filter((id) => id !== 'notes')];
    const topTools = topIds.map((id) => visibleTools.find((t) => t.id === id)).filter(Boolean);
    if (topTools.length) {
      nav.append(el('div', { class: 'nav-group-title', text: '\u7f6e\u9876' }));
      topTools.forEach((t) => nav.append(navItem(t)));
    }
    const visibleCustomGroups = normalizedGroups(customGroups).filter((g) => g.toolIds.length);
    for (const group of visibleCustomGroups) {
      const groupTools = group.toolIds.map((id) => visibleTools.find((t) => t.id === id)).filter(Boolean);
      if (!groupTools.length) continue;
      nav.append(el('div', { class: 'nav-group-title', text: group.name }));
      groupTools.forEach((t) => nav.append(navItem(t)));
    }
  }

  function openGroupManager() {
    let draft = normalizedGroups(customGroups);
    let activeGroupId = draft[0]?.id || null;
    const overlay = el('div', { class: 'group-modal-overlay' });
    const groupList = el('div', { class: 'group-list' });
    const detail = el('div', { class: 'group-detail' });
    const deleteBtn = el('button', { class: 'btn group-delete-btn', type: 'button', text: '\u5220\u9664\u5206\u7ec4', onclick: deleteActiveGroup });

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
      const group = { id: 'group-' + Date.now().toString(36), name: '\u65b0\u5efa\u5206\u7ec4', toolIds: [] };
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
        el('span', { class: 'group-create-icon', html: ICONS.plus }),
        el('span', { class: 'group-create-text', text: '\u65b0\u5efa\u5206\u7ec4' }),
      ]);
      groupList.append(createBtn);
      if (!draft.length) {
        groupList.append(el('div', { class: 'group-empty-hint', text: '\u8fd8\u6ca1\u6709\u5206\u7ec4\uff0c\u70b9\u51fb\u201c\u65b0\u5efa\u5206\u7ec4\u201d\u5f00\u59cb\u3002' }));
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
          el('span', { class: 'group-list-count', text: `${count} \u4e2a\u5de5\u5177` }),
        ]));
      });
    }

    function renderDetail() {
      detail.innerHTML = '';
      const group = activeGroup();
      deleteBtn.disabled = !group;
      if (!group) {
        detail.append(el('div', { class: 'group-detail-empty', text: '\u9009\u62e9\u5de6\u4fa7\u5206\u7ec4\uff0c\u6216\u70b9\u51fb\u201c\u65b0\u5efa\u5206\u7ec4\u201d\u3002' }));
        return;
      }
      const nameInput = el('input', {
        class: 'input group-name-input',
        value: group.name,
        placeholder: '\u5206\u7ec4\u540d\u79f0',
        oninput: (e) => {
          group.name = e.target.value;
          renderGroupList();
        },
      });
      const toolGrid = el('div', { class: 'group-tool-grid' });
      visibleTools.forEach((tool) => {
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
          el('span', { class: 'group-tool-icon', style: { background: ICON_COLORS[tool.id] || 'var(--hover)' }, html: toolIconSvg(tool) }),
          el('span', { class: 'group-tool-name', text: tool.name }),
          el('span', { class: 'group-tool-cat', text: tool.category || '\u5176\u5b83' }),
        ]));
      });
      detail.append(
        el('div', { class: 'group-detail-form' }, [
          el('label', { class: 'group-field-label', text: '\u5206\u7ec4\u540d\u79f0' }),
          nameInput,
          el('div', { class: 'group-field-label', text: '\u9009\u62e9\u5de5\u5177' }),
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
        el('div', { class: 'group-modal-title-wrap' }, [
          el('div', { class: 'group-modal-mark', html: ICONS.group }),
          el('div', { class: 'group-modal-copy' }, [
            el('div', { class: 'group-modal-title', text: '\u7ba1\u7406\u529f\u80fd\u5206\u7ec4' }),
            el('div', { class: 'group-modal-subtitle', text: '\u81ea\u5b9a\u4e49\u4fa7\u8fb9\u680f\u5206\u7ec4\u4e0e\u5de5\u5177\u6392\u5e8f' }),
          ]),
        ]),
        el('button', { class: 'group-close-btn', type: 'button', text: '\u00d7', onclick: close }),
      ]),
      el('div', { class: 'group-modal-body' }, [
        el('aside', { class: 'group-sidebar' }, [groupList]),
        detail,
      ]),
      el('div', { class: 'group-modal-foot' }, [
        deleteBtn,
        el('span', { class: 'group-foot-spacer' }),
        el('button', { class: 'btn', type: 'button', text: '\u53d6\u6d88', onclick: close }),
        el('button', { class: 'btn btn-primary group-save-btn', type: 'button', text: '\u4fdd\u5b58', onclick: saveAndClose }),
      ]),
    ]));
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    document.body.append(overlay);
    renderManager();
  }

  // ===== 设置面板 =====
  function openSettings() {
    const overlay = el('div', { class: 'settings-overlay', onclick: (e) => { if (e.target === overlay) close(); } });
    const modal = el('div', { class: 'settings-modal', onclick: (e) => e.stopPropagation() });

    const sideItems = [
      { id: 'appearance', name: '\u5916\u89c2', icon: 'palette' },
      { id: 'about', name: '\u5173\u4e8e', icon: 'info' },
    ];
    let activeItem = 'appearance';

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) { if (e.key === 'Escape') close(); }

    function renderItemList() {
      listEl.innerHTML = '';
      sideItems.forEach((it) => {
        listEl.append(el('button', {
          class: 'settings-nav-item' + (it.id === activeItem ? ' active' : ''),
          type: 'button',
          onclick: () => { activeItem = it.id; renderItemList(); renderDetail(); },
        }, [
          el('span', { class: 'settings-nav-icon', text: it.icon === 'palette' ? '\u25cf' : 'i' }),
          el('span', { text: it.name }),
        ]));
      });
    }

    function renderDetail() {
      detailEl.innerHTML = '';
      if (activeItem === 'appearance') {
        // 外观：配色选择（色块）
        const themeColors = {
          '1': ['#2563eb', '#eef2f7'],
          '2': ['#d97706', '#f7f3ec'],
          '3': ['#4f46e5', '#e9ecf1'],
          '4': ['#0d9488', '#eef6f2'],
        };
        detailEl.append(
          el('div', { class: 'settings-detail-title', text: '\u5916\u89c2' }),
          el('div', { class: 'settings-detail-sub', text: '\u9009\u62e9\u754c\u9762\u914d\u8272\u4e3b\u9898' }),
          el('div', { class: 'settings-section-title', text: '\u914d\u8272\u4e3b\u9898' }),
          el('div', { class: 'theme-picker' }, THEMES.map((t) => {
            const c = themeColors[t.id] || ['#888', '#eee'];
            return el('div', {
              class: 'theme-option' + (t.id === loadTheme() ? ' active' : ''),
              dataset: { t: t.id },
              onclick: (e) => {
                applyTheme(e.currentTarget.dataset.t);
                [...e.currentTarget.parentElement.children].forEach((o) => o.classList.toggle('active', o === e.currentTarget));
              },
            }, [
              el('div', { class: 'theme-swatch', style: { background: 'linear-gradient(135deg,' + c[0] + ',' + c[1] + ')' } }),
              el('div', { class: 'theme-name', text: t.name }),
            ]);
          })),
        );
      } else {
        detailEl.append(
          el('div', { class: 'settings-detail-title', text: '\u5173\u4e8e' }),
          el('div', { class: 'settings-detail-sub', text: 'DevTool \u5f00\u53d1\u8005\u5de5\u5177\u7bb1 v0.1' }),
          el('div', { class: 'settings-section-title', text: '\u7248\u672c' }),
          el('div', { class: 'settings-about', text: '\u57fa\u4e8e Electron + Vite \u7684\u672c\u5730\u5f00\u53d1\u5de5\u5177\u96c6' }),
        );
      }
    }

    const listEl = el('div', { class: 'settings-nav' });
    const detailEl = el('div', { class: 'settings-detail' });

    modal.append(
      el('div', { class: 'settings-head' }, [
        el('div', { class: 'settings-title', text: '\u8bbe\u7f6e' }),
        el('button', { class: 'settings-close', type: 'button', text: '\u00d7', onclick: close }),
      ]),
      el('div', { class: 'settings-body' }, [listEl, detailEl]),
    );
    overlay.append(modal);
    document.body.append(overlay);
    document.addEventListener('keydown', onKeydown);
    renderItemList();
    renderDetail();
  }

  function renderTool() {
    if (state.cleanup) { try { state.cleanup(); } catch {} state.cleanup = null; }
    content.innerHTML = '';
    const tool = visibleTools.find((t) => t.id === state.activeId) || visibleTools[0];
    pageTitle.textContent = tool.name;
    pageSub.textContent = tool.desc || '';
    // TestHub 内嵌：去掉标题栏，iframe 占满；New API 用自有页面，保留标题
    const embedIds = new Set(['embed']);
    pageHead.hidden = embedIds.has(tool.id);
    // notes/deploy/ssh/json 等：内容区隐藏外层滚动，工具内部（输入/输出框）自己滚
    const fillTools = new Set(['notes', 'deploy', 'ssh', 'json', 'crypto', 'sql', 'text', 'hosts', 'http', 'sysinfo', 'diff', 'embed', 'newapi']);
    content.className = 'content' + (fillTools.has(tool.id) ? ' content-notes' : '') + (embedIds.has(tool.id) ? ' content-embed' : '');
    const wrap = el('div', { class: 'tool-wrap' });
    content.append(wrap);
    const ret = tool.render(wrap);
    if (ret && typeof ret.then === 'function') {
      ret.then((fn) => { if (typeof fn === 'function') state.cleanup = fn; });
    } else if (typeof ret === 'function') {
      state.cleanup = ret;
    }
  }

  renderSidebar();
  renderTool();
}
