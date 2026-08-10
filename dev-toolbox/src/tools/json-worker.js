// JSON 处理 Web Worker：大文件解析/格式化/转换放到后台线程。
import { parseJson, describeError, jsonToXml, jsonToCsv, jsonToProperties, jsonToJava, jsonToCSharp } from './jsonOps.js';

/** 超过此体积：pretty 不再生成整串，改回折叠树（避免 10MB→30MB 卡死） */
const LARGE = 512 * 1024;
/** 超过此体积：结果用 ArrayBuffer 回传，减少 structured clone 开销 */
const TRANSFER = 256 * 1024;

// 指纹缓存：postMessage 会克隆字符串，不能用 === 判等
let cacheFp = null;
let cacheValue = null;
let lastParsedValue = null;

function fingerprint(text) {
  const n = text.length;
  if (n <= 128) return `${n}:${text}`;
  let h = n;
  // 抽样哈希，够用且极快
  const step = Math.max(1, Math.floor(n / 64));
  for (let i = 0; i < n; i += step) h = (h * 33 + text.charCodeAt(i)) >>> 0;
  h = (h * 33 + text.charCodeAt(0)) >>> 0;
  h = (h * 33 + text.charCodeAt(n - 1)) >>> 0;
  return `${n}:${h}:${text.slice(0, 24)}:${text.slice(-24)}`;
}

function parseCached(text) {
  const fp = fingerprint(text);
  if (cacheFp === fp && cacheValue !== undefined) {
    lastParsedValue = cacheValue;
    return { ok: true, value: cacheValue, cached: true };
  }
  const r = parseJson(text);
  if (r.ok) {
    cacheFp = fp;
    cacheValue = r.value;
    lastParsedValue = r.value;
  } else {
    cacheFp = null;
    cacheValue = null;
    lastParsedValue = null;
  }
  return r;
}

function postOk(id, value, extra = {}) {
  if (typeof value === 'string' && (value.length >= TRANSFER || extra.download)) {
    const bytes = new TextEncoder().encode(value);
    self.postMessage({ id, ok: true, transfer: true, bytes: bytes.buffer, ...extra }, [bytes.buffer]);
    return;
  }
  self.postMessage({ id, ok: true, value, ...extra });
}

self.onmessage = (e) => {
  const { id, op, text, opts, path } = e.data;
  const fail = (msg) => self.postMessage({ id, ok: false, error: msg });
  try {
    if (op === 'children') {
      const children = getChildrenAtPath(lastParsedValue, path);
      if (!children) return fail('路径不存在');
      postOk(id, JSON.stringify(children));
      return;
    }

    const parsed = () => {
      const r = parseCached(text);
      if (!r.ok) {
        fail(describeError(text, r.error));
        return undefined;
      }
      return r.value;
    };

    switch (op) {
      case 'parse': {
        const v = parsed();
        if (v === undefined) return;
        postOk(id, JSON.stringify(buildTree(v, '$')), { view: 'tree' });
        break;
      }
      case 'pretty': {
        const v = parsed();
        if (v === undefined) return;
        // 大文件：只建折叠树，整串 pretty 交给下载（prettyFile）
        if ((text || '').length >= LARGE) {
          postOk(id, JSON.stringify(buildTree(v, '$')), {
            view: 'tree',
            large: true,
            inputBytes: text.length,
            sp: opts?.sp || 2,
          });
          break;
        }
        postOk(id, JSON.stringify(v, null, opts.sp));
        break;
      }
      case 'prettyFile': {
        // 专供下载：生成完整 pretty 文本（不塞 textarea）
        const v = parsed();
        if (v === undefined) return;
        const sp = opts?.sp || 2;
        postOk(id, JSON.stringify(v, null, sp), { download: true, sp });
        break;
      }
      case 'compress': {
        const v = parsed();
        if (v === undefined) return;
        const out = JSON.stringify(v);
        postOk(id, out, {
          large: (text || '').length >= LARGE || out.length >= LARGE,
          inputBytes: (text || '').length,
          outputBytes: out.length,
        });
        break;
      }
      case 'escape':
        postOk(id, JSON.stringify(text));
        break;
      case 'unescape': {
        const v = JSON.parse(text);
        postOk(id, typeof v === 'string' ? v : JSON.stringify(v));
        break;
      }
      case 'xml': {
        const v = parsed();
        if (v === undefined) return;
        postOk(id, jsonToXml(v));
        break;
      }
      case 'csv': {
        const v = parsed();
        if (v === undefined) return;
        postOk(id, jsonToCsv(v));
        break;
      }
      case 'properties': {
        const v = parsed();
        if (v === undefined) return;
        postOk(id, jsonToProperties(v));
        break;
      }
      case 'java': {
        const v = parsed();
        if (v === undefined) return;
        if (Array.isArray(v)) return fail('请粘贴对象而非数组');
        postOk(id, jsonToJava(v, opts.name));
        break;
      }
      case 'csharp': {
        const v = parsed();
        if (v === undefined) return;
        if (Array.isArray(v)) return fail('请粘贴对象而非数组');
        postOk(id, jsonToCSharp(v, opts.name));
        break;
      }
      default:
        return fail('未知操作');
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};

const INLINE_MAX = 40;
const INLINE_DEPTH = 2;

function buildTree(v, key, path = '', depth = 0) {
  const myPath = path ? path + '.' + key : key;
  if (v === null) return { key, type: 'value', preview: 'null', path: myPath };
  if (Array.isArray(v)) {
    const small = v.length <= INLINE_MAX && depth < INLINE_DEPTH;
    return {
      key,
      type: 'array',
      count: v.length,
      path: myPath,
      children: small ? v.map((x, i) => buildTree(x, String(i), myPath, depth + 1)) : undefined,
    };
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    const small = keys.length <= INLINE_MAX && depth < INLINE_DEPTH;
    return {
      key,
      type: 'object',
      count: keys.length,
      path: myPath,
      children: small ? keys.map((k) => buildTree(v[k], k, myPath, depth + 1)) : undefined,
    };
  }
  let preview;
  if (typeof v === 'string') preview = v.length > 40 ? v.slice(0, 40) + '…' : v;
  else preview = String(v);
  return { key, type: 'value', preview, path: myPath };
}

function getChildrenAtPath(root, path) {
  const segs = String(path).split('.').filter(Boolean).filter((s) => s !== '$');
  let cur = root;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else cur = cur[s];
  }
  if (cur === null || cur === undefined) return undefined;
  // 懒加载层：只建一层摘要，深层继续懒加载
  if (Array.isArray(cur)) {
    return cur.map((x, i) => buildTree(x, String(i), path, INLINE_DEPTH));
  }
  if (typeof cur === 'object') {
    return Object.keys(cur).map((k) => buildTree(cur[k], k, path, INLINE_DEPTH));
  }
  return undefined;
}
