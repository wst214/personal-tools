// 生成应用图标：icon.svg -> icon.png(各尺寸) + icon.ico
import sharp from 'sharp';
import toIco from 'to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = join(here, 'build', 'icon.svg');
const svg = readFileSync(svgPath);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) {
  const buf = await sharp(svg, { density: 384 })
    .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  pngs.push(buf);
}

// 256 作为窗口图标 / favicon
writeFileSync(join(here, 'build', 'icon.png'), pngs[pngs.length - 1]);
// 拷一份到 electron/ 供打包后窗口图标使用
writeFileSync(join(here, 'electron', 'icon.png'), pngs[pngs.length - 1]);

const ico = await toIco(pngs);
writeFileSync(join(here, 'build', 'icon.ico'), ico);

console.log(`生成完成: build/icon.ico (${ico.length}B), build/icon.png + electron/icon.png (${pngs[pngs.length-1].length}B)`);
console.log(`尺寸: ${sizes.join(', ')}`);
