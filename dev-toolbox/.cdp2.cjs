const WS = 'ws://127.0.0.1:9227/devtools/page/AE82968592095A1933D44540265322A6';
const ws = new WebSocket(WS);
let id = 0;
const pend = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const mid = ++id;
    pend.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (e) => {
  const m = JSON.parse(typeof e.data === 'string' ? e.data : e.data.toString());
  if (m.id && pend.has(m.id)) {
    const { res, rej } = pend.get(m.id);
    pend.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
ws.onerror = (e) => { console.log('WS ERROR'); process.exit(1); };
ws.onopen = async () => {
  console.log('WS open, sending Runtime.enable...');
  try {
    await send('Runtime.enable', {});
    console.log('enabled');
    // 简单测试
    const r1 = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
    console.log('1+1 =', r1?.result?.value);
    // 查 toolbox
    const expr = `(async () => {
      const out = {};
      out.hasToolbox = !!window.toolbox;
      out.hasDeploy = !!window.toolbox?.deploy;
      if (window.toolbox?.deploy) {
        try {
          const r = await window.toolbox.deploy.list();
          out.r = JSON.stringify(r).slice(0, 200);
        } catch (e) { out.err = String(e); }
      }
      return JSON.stringify(out);
    })()`;
    const r2 = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    console.log('TOOLBOX:', r2?.result?.value || JSON.stringify(r2).slice(0, 300));
  } catch (e) { console.log('ERR:', e.message); }
  process.exit(0);
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 25000);
