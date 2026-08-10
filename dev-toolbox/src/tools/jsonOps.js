// 纯 JSON 处理函数：无 DOM 依赖，既可在主线程用，也可在 Web Worker 里跑。
// 与 JSON 工具 UI 解耦，方便把大文件解析/格式化放到 worker 避免卡 UI。

export function parseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e }; }
}

export function describeError(text, error) {
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

export function jsonToXml(obj, name = 'root', indent = 0) {
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

export function coerce(s) {
  if (s === '') return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^0\d+/.test(s)) return Number(s);
  return s;
}

export function jsonToCsv(obj) {
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

export function jsonToProperties(obj, prefix = '') {
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

export function classify(s) { return s.charAt(0).toUpperCase() + s.slice(1).replace(/[^A-Za-z0-9]/g, ''); }

export function javaType(v, key) {
  if (v == null) return 'Object';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Long' : 'Double';
  if (typeof v === 'string') return 'String';
  if (Array.isArray(v)) return `List<${v.length ? javaType(v[0], key) : 'Object'}>`;
  return classify(key);
}

export function jsonToJava(obj, name = 'Root') {
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

export function csharpType(v, key) {
  if (v == null) return 'object';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'long' : 'double';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return `List<${v.length ? csharpType(v[0], key) : 'object'}>`;
  return classify(key);
}

export function jsonToCSharp(obj, name = 'Root') {
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