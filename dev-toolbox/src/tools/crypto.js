import CryptoJS from 'crypto-js';
import JSEncrypt from 'jsencrypt';
import { sm2, sm3, sm4 } from 'sm-crypto';
import { twoPane, btn, copyBtn, el, toast, debounce } from '../ui/helpers.js';

const utf8Bytes = (t) => Array.from(new TextEncoder().encode(t));
const fromUtf8 = (arr) => new TextDecoder().decode(new Uint8Array(arr));

// ---- 编码 ----
const encoders = {
  Base64: { enc: (t) => CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(t)), dec: (t) => { try { return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(t.trim())); } catch { throw new Error('Base64 解码失败'); } } },
  URL: { enc: encodeURIComponent, dec: (t) => { try { return decodeURIComponent(t); } catch { throw new Error('URL 解码失败'); } } },
  Hex: { enc: (t) => CryptoJS.enc.Hex.stringify(CryptoJS.enc.Utf8.parse(t)), dec: (t) => { try { return CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Hex.parse(t.trim())); } catch { throw new Error('Hex 解码失败'); } } },
  Unicode: { enc: (t) => t.replace(/[^\0-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), dec: (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) },
  'HTML实体': { enc: (t) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), dec: (t) => { const d = document.createElement('div'); d.innerHTML = t; return d.textContent || ''; } },
  '摩斯码': { enc: toMorse, dec: fromMorse },
  'Native/ASCII': { enc: (t) => t.split('').map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''), dec: (t) => t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) },
};

// ---- 哈希 ----
const hashes = {
  MD5: (t) => CryptoJS.MD5(t).toString(),
  SHA1: (t) => CryptoJS.SHA1(t).toString(),
  SHA224: (t) => CryptoJS.SHA224(t).toString(),
  SHA256: (t) => CryptoJS.SHA256(t).toString(),
  SHA384: (t) => CryptoJS.SHA384(t).toString(),
  SHA512: (t) => CryptoJS.SHA512(t).toString(),
  SHA3: (t) => CryptoJS.SHA3(t, { outputLength: 256 }).toString(),
  RIPEMD160: (t) => CryptoJS.RIPEMD160(t).toString(),
  SM3: (t) => sm3(utf8Bytes(t)),
  'HMAC-MD5': (t, k) => CryptoJS.HmacMD5(t, k).toString(),
  'HMAC-SHA256': (t, k) => CryptoJS.HmacSHA256(t, k).toString(),
};

// ---- 对称 ----
function tryDec(lib, t, k) { try { const o = lib.decrypt(t, k).toString(CryptoJS.enc.Utf8); return o || '(解密失败或密钥错误)'; } catch { throw new Error('解密失败'); } }
const sym = {
  AES: (t, k, enc) => (enc ? CryptoJS.AES.encrypt(t, k).toString() : tryDec(CryptoJS.AES, t, k)),
  DES: (t, k, enc) => (enc ? CryptoJS.DES.encrypt(t, k).toString() : tryDec(CryptoJS.DES, t, k)),
  '3DES': (t, k, enc) => (enc ? CryptoJS.TripleDES.encrypt(t, k).toString() : tryDec(CryptoJS.TripleDES, t, k)),
  RC4: (t, k, enc) => (enc ? CryptoJS.RC4.encrypt(t, k).toString() : tryDec(CryptoJS.RC4, t, k)),
  Rabbit: (t, k, enc) => (enc ? CryptoJS.Rabbit.encrypt(t, k).toString() : tryDec(CryptoJS.Rabbit, t, k)),
  SM4: (t, k, enc) => {
    if (!/^[0-9a-fA-F]{32}$/.test(k || '')) throw new Error('SM4 密钥需为 32 位十六进制（16 字节）');
    // sm-crypto 的 sm4 加密固定输出 hex（outputEncoding 不生效），故解密端按 hex 读
    return enc ? sm4.encrypt(t, k, { inputEncoding: 'utf8', outputEncoding: 'hex' }) : sm4.decrypt(t.trim(), k, { inputEncoding: 'hex', outputEncoding: 'utf8' });
  },
};

// ---- 非对称 ----
const asym = {
  RSA: (t, k, enc) => {
    const js = new JSEncrypt();
    if (enc) { js.setPublicKey(k); const r = js.encrypt(t); if (!r) throw new Error('RSA 加密失败（检查公钥或文本过长）'); return r; }
    js.setPrivateKey(k); const r = js.decrypt(t.trim()); if (!r) throw new Error('RSA 解密失败（检查私钥）'); return r;
  },
  SM2: (t, k, enc) => {
    if (enc) { const r = sm2.doEncrypt(t, k, 1); return typeof r === 'string' ? r : JSON.stringify(r); }
    const r = sm2.doDecrypt(t.trim(), k, 1);
    if (r === false || r == null) throw new Error('SM2 解密失败（检查私钥）');
    return typeof r === 'string' ? r : fromUtf8(r);
  },
};

// ---- 摩斯电码 ----
const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.' };
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
function toMorse(t) { return t.toUpperCase().split('').map((c) => (c === ' ' ? '/' : MORSE[c] || '')).filter(Boolean).join(' '); }
function fromMorse(t) { return t.trim().split(/\s+/).map((s) => (s === '/' ? ' ' : MORSE_REV[s] || '')).join(''); }

const GROUPS = [['编码', encoders], ['哈希', hashes], ['对称', sym], ['非对称', asym]];
const ALL = [...Object.keys(encoders), ...Object.keys(hashes), ...Object.keys(sym), ...Object.keys(asym)];

export const cryptoTool = {
  id: 'crypto',
  name: '加解密编码',
  category: '编码转换',
  icon: '⚿',
  keywords: 'base64 md5 sha aes des rc4 rabbit rsa sm2 sm3 sm4 hmac url hex unicode morse hash encrypt',
  desc: '编码 / 哈希 / 对称 / 非对称 / 国密',
  render(container) {
    const { body, input, output, actionBar } = twoPane({ inputPlaceholder: '输入文本…', outputPlaceholder: '结果…' });
    const op = el('select', { class: 'select' }, GROUPS.map(([g, map]) => el('optgroup', { label: g }, Object.keys(map).map((k) => el('option', { value: k, text: k })))));
    op.value = 'Base64';
    const keyBox = el('textarea', { class: 'tx', placeholder: '密钥 / 口令', style: { minHeight: '60px' } });
    const keyRow = el('div', { class: 'field', style: { display: 'none' } }, [el('label', { text: '密钥' }), keyBox]);
    const encBtn = btn('编码/加密', () => run(true));
    const decBtn = btn('解码/解密', () => run(false));
    actionBar.append(el('div', { class: 'field' }, [el('label', { text: '算法' }), op]), keyRow, encBtn, decBtn, copyBtn(() => output.value));

    const kind = (name) => (encoders[name] ? 'enc' : hashes[name] ? 'hash' : sym[name] ? 'sym' : 'asym');
    function refresh() {
      const k = kind(op.value);
      const needKey = k === 'sym' || k === 'asym' || op.value.startsWith('HMAC');
      keyRow.style.display = needKey ? 'flex' : 'none';
      decBtn.style.display = k === 'hash' ? 'none' : '';
      encBtn.textContent = k === 'hash' ? '计算哈希' : '编码/加密';
      const labels = { RSA: '公钥/私钥 (PEM)', SM2: '公钥/私钥 (hex)', SM4: '密钥 (32 位 hex)' };
      keyRow.querySelector('label').textContent = labels[op.value] || '密钥 / 口令';
    }
    op.addEventListener('change', () => { refresh(); run(true); });

    function run(isEnc) {
      const t = input.value;
      const name = op.value;
      if (!t) { output.value = ''; return; }
      // 大输入异步处理，避免阻塞 UI
      setTimeout(() => {
        try {
          let r;
          if (encoders[name]) r = isEnc ? encoders[name].enc(t) : encoders[name].dec(t);
          else if (hashes[name]) r = hashes[name](t, keyBox.value);
          else if (sym[name]) r = sym[name](t, keyBox.value || '', isEnc);
          else r = asym[name](t, keyBox.value || '', isEnc);
          output.value = r;
        } catch (e) { output.value = ''; toast(e.message, 'error'); }
      }, 0);
    }
    input.addEventListener('input', debounce(() => run(true), 200));
    refresh();
    container.append(body);
  },
};
