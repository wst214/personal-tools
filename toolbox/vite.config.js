import { defineConfig } from 'vite';

// 纯 Web 预览与 Electron 共用同一份渲染层。
// base 用相对路径，便于 Electron 以 file:// 加载打包产物。
export default defineConfig({
  base: './',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
