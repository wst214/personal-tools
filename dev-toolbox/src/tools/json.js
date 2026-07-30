import { twoPane, btn, copyBtn, el, toast } from '../ui/helpers.js';

function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e }; }
}

function describeError(text, error) {
  const m = /position\s+(\d+)/i.exec(error.message || '');
  if (m) {
    const pos = +m[1];
    const before = text.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    return `第 ${line} 行 第 ${col} 列：${error.message}`;
  }
  return error.message;
}

function jsonToXml(obj, name = 'root', indent = 0) {
  const pad = '  '.repeat(indent);
  if (obj === null) return `${pad}<${name}>null</${name}>`;
  if (Array.isArray(obj)) {
    if (!obj.length) return `${pad}<${name}></${name}>`;
    return obj.map((v) => jsonToXml(v, name, indent)).join('\n');
  }
  if (typeof obj === 'object') {
    const inner = Object.entries(obj).map(([k, v]) => jsonToXml(v, k, indent + 1)).join('\n');
    return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
  }
  return `${pad}<${name}>${String(obj)}</${name}>`;
}

function coerce(s) {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d+/.test(s)) return Number(s);
  return s;
}

function xmlToJson(xmlStr) {
  const dom = new DOMParser().parseFromString(xmlStr, 'text/xml');
  if (dom.querySelector('parsererror')) throw new Error('XML 解析失败');
  function walk(node) {
    const kids = Array.from(node.children);
    if (!kids.length) return coerce(node.textContent.trim());
    const obj = {};
    for (const k of kids) {
      const v = walk(k);
      if (obj[k.nodeName] !== undefined) {
        if (!Array.isArray(obj[k.nodeName])) obj[k.nodeName] = [obj[k.nodeName]];
        obj[k.nodeName].push(v);
      } else obj[k.nodeName] = v;
    }
    return obj;
  }
  const root = dom.documentElement;
  return { [root.nodeName]: walk(root) };
}

function jsonToCsv(obj) {
  let arr;
  if (Array.isArray(obj)) arr = obj;
  else arr = obj?.list || obj?.data || obj?.items;
  if (!Array.isArray(arr)) throw new Error('需要数组，或含 list/data/items 数组的对象');
  if (!arr.length) return '';
  const cols = [...new Set(arr.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(','), ...arr.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

function jsonToProperties(obj, prefix = '') {
  const lines = [];
  const walk = (o, pre) => {
    for (const [k, v] of Object.entries(o)) {
      const key = pre ? `${pre}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
      else if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? walk(x, `${key}[${i}]`) : lines.push(`${key}[${i}]=${x ?? ''}`)));
      else lines.push(`${key}=${v ?? ''}`);
    }
  };
  walk(obj, prefix);
  return lines.join('\n');
}

function classify(s) { return s.charAt(0).toUpperCase() + s.slice(1).replace(/[^A-Za-z0-9]/g, ''); }

function javaType(v, key) {
  if (v == null) return 'Object';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Long' : 'Double';
  if (typeof v === 'string') return 'String';
  if (Array.isArray(v)) return `List<${v.length ? javaType(v[0], key) : 'Object'}>`;
  return classify(key);
}

function jsonToJava(obj, name = 'Root') {
  const blocks = [];
  function gen(o, n) {
    const fields = [];
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) { gen(v, classify(k)); fields.push(`    private ${classify(k)} ${k};`); }
      else fields.push(`    private ${javaType(v, k)} ${k};`);
    }
    blocks.push(`public class ${n} {\n${fields.join('\n')}\n}`);
  }
  gen(obj, name);
  return blocks.join('\n\n');
}

function csharpType(v, key) {
  if (v == null) return 'object';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'long' : 'double';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return `List<${v.length ? csharpType(v[0], key) : 'object'}>`;
  return classify(key);
}

function jsonToCSharp(obj, name = 'Root') {
  const blocks = [];
  function gen(o, n) {
    const fields = [];
    for (const [k, v] of Object.entries(o)) {
      const p = classify(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) { gen(v, p); fields.push(`    public ${p} ${p} { get; set; }`); }
      else fields.push(`    public ${csharpType(v, k)} ${p} { get; set; }`);
    }
    blocks.push(`public class ${n} {\n${fields.join('\n')}\n}`);
  }
  gen(obj, name);
  return 'using System.Collections.Generic;\n\n' + blocks.join('\n\n');
}

export const jsonTool = {
  id: 'json',
  name: 'JSON 格式化',
  category: '编码转换',
  icon: '{}',
  keywords: 'json format compress escape xml csv properties java',
  desc: '格式化 / 压缩 / 转换 / 实体',
  render(container) {
    const tabs = ['格式化', '转换', 'Java 实体', 'C# 实体'];
    let mode = '格式化';
    const tabBar = el('div', { class: 'tabs' });
    const bodyWrap = el('div');
    tabs.forEach((t) => {
      const tab = el('button', {
        class: 'tab' + (t === mode ? ' active' : ''),
        type: 'button',
        onclick: () => {
          mode = t;
          [...tabBar.children].forEach((c) => c.classList.remove('active'));
          tab.classList.add('active');
          bodyWrap.innerHTML = '';
          bodyWrap.append(build());
        },
      }, t);
      tabBar.append(tab);
    });
    container.append(tabBar, bodyWrap);

    function need(v) { if (!v.trim()) { toast('请输入内容', 'warn'); return false; } return true; }

    function build() {
      if (mode === '转换') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: 'JSON 或 XML…', outputPlaceholder: '转换结果…' });
        actionBar.append(
          btn('JSON→XML', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } output.value = jsonToXml(r.value); toast('完成'); }),
          btn('XML→JSON', () => { if (!need(input.value)) return; try { output.value = JSON.stringify(xmlToJson(input.value), null, 2); toast('完成'); } catch (e) { toast(e.message, 'error'); } }),
          btn('JSON→CSV', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } try { output.value = jsonToCsv(r.value); toast('完成'); } catch (e) { toast(e.message, 'error'); } }),
          btn('JSON→Properties', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } output.value = jsonToProperties(r.value); toast('完成'); }),
          copyBtn(() => output.value),
        );
        return body;
      }
      if (mode === 'Java 实体') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 JSON 对象…', outputPlaceholder: 'Java 实体类…' });
        const cls = el('input', { class: 'input', placeholder: '类名', value: 'Root' });
        actionBar.append(
          el('div', { class: 'field' }, [el('label', { text: '类名' }), cls]),
          btn('生成', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } if (Array.isArray(r.value)) { toast('请粘贴对象而非数组', 'warn'); return; } output.value = jsonToJava(r.value, cls.value.trim() || 'Root'); toast('已生成', 'success'); }, { variant: 'primary' }),
          copyBtn(() => output.value),
        );
        return body;
      }
      if (mode === 'C# 实体') {
        const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '粘贴 JSON 对象…', outputPlaceholder: 'C# 实体类…' });
        const cls = el('input', { class: 'input', placeholder: '类名', value: 'Root' });
        actionBar.append(
          el('div', { class: 'field' }, [el('label', { text: '类名' }), cls]),
          btn('生成', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } if (Array.isArray(r.value)) { toast('请粘贴对象而非数组', 'warn'); return; } output.value = jsonToCSharp(r.value, cls.value.trim() || 'Root'); toast('已生成', 'success'); }, { variant: 'primary' }),
          copyBtn(() => output.value),
        );
        return body;
      }
      // 格式化
      const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '在此粘贴 JSON…', outputPlaceholder: '格式化结果…' });
      const pretty = (sp) => () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } output.value = JSON.stringify(r.value, null, sp); toast('已美化', 'success'); };
      actionBar.append(
        btn('美化 2', pretty(2)),
        btn('美化 4', pretty(4)),
        btn('压缩', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (!r.ok) { toast(describeError(input.value, r.error), 'error'); return; } output.value = JSON.stringify(r.value); toast('已压缩', 'success'); }),
        btn('转义', () => { if (!need(input.value)) return; output.value = JSON.stringify(input.value); toast('已转义'); }),
        btn('去转义', () => { if (!need(input.value)) return; try { output.value = JSON.parse(input.value); toast('已去转义', 'success'); } catch (e) { toast('去转义失败：' + e.message, 'error'); } }),
        btn('校验', () => { if (!need(input.value)) return; const r = parseJson(input.value); if (r.ok) toast('✓ 合法 JSON', 'success'); else toast(describeError(input.value, r.error), 'error'); }),
        copyBtn(() => output.value),
      );
      return body;
    }

    bodyWrap.append(build());
  },
};
