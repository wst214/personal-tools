const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1360, height: 860, show: false, webPreferences: { preload: path.join(__dirname, 'electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadURL('http://127.0.0.1:5173/');
  await sleep(2800);
  const out = process.env.TEMP;
  async function shot(name) {
    win.webContents.invalidate(); await sleep(300);
    fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
    console.log('saved', name);
  }
  async function clickNav(text) {
    await win.webContents.executeJavaScript(`(() => { const it=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes(${JSON.stringify(text)})); it && it.click(); return !!it; })()`);
    await sleep(900);
  }
  // 各工具页
  await clickNav('JSON 格式化'); await shot('qc-json.png');
  await clickNav('加解密编码'); await shot('qc-crypto.png');
  await clickNav('SQL 格式化'); await shot('qc-sql.png');
  await clickNav('SSH 终端'); await shot('qc-ssh.png');
  await clickNav('部署工作台'); await shot('qc-deploy.png');
  await clickNav('随手记'); await shot('qc-notes.png');
  // 设置面板
  await win.webContents.executeJavaScript(`(() => { const b=[...document.querySelectorAll('.sidebar-tool')].find(x=>x.title==='设置'); b && b.click(); return !!b; })()`);
  await sleep(600); await shot('qc-settings.png');
  app.exit(0);
});
