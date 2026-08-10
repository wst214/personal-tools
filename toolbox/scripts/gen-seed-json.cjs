// 从 electron/seed-deploy-tasks.cjs 生成 public/seed-deploy.json（web 预览用，与桌面端同构）。
// 改完 seed-deploy-tasks.cjs 后跑一次：npm --prefix toolbox run gen-seed
const fs = require('fs');
const path = require('path');

const seed = require(path.join(__dirname, '..', 'electron', 'seed-deploy-tasks.cjs'));
const out = seed.map((t) => ({ ...t, createdAt: t.createdAt || Date.now() }));
const target = path.join(__dirname, '..', 'public', 'seed-deploy.json');

fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`已生成 ${path.relative(process.cwd(), target)}，任务数: ${out.length}`);
