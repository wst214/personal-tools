import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    // 排除 Rust 编译产物，避免文件监听 EBUSY
    watch: {
      ignored: ['**/src-tauri/target/**', '**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
