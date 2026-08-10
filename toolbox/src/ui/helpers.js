// 极简 DOM 构造助手：el('div', { class: 'x', onclick: fn }, ...children)
// boolean 属性（checked/disabled/...）必须用 property 赋值，setAttribute('checked', false) 仍会被当成选中。
const BOOL_PROPS = new Set(['checked', 'disabled', 'readonly', 'selected', 'hidden', 'multiple', 'autofocus', 'required', 'indeterminate']);
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (BOOL_PROPS.has(k)) node[k] = !!v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}
