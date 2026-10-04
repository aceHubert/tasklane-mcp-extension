import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BRIDGE_HOST = process.env.TASKLANE_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = process.env.TASKLANE_BRIDGE_PORT || '7433';
const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5176,
    proxy: {
      // 连接配置端点（token 模式下 UI 靠它拿到 ?token=）
      '/api': { target: BRIDGE_ORIGIN, changeOrigin: true },
      // WebSocket 代理：changeOrigin 把 Host 重写为回环地址（过 bridge Host 校验），
      // headers 把 Origin 重写为 bridge 自己的源（过同源白名单），
      // 免去为开发代理额外配置 TASKLANE_ALLOWED_ORIGINS。
      '/mcp': {
        target: `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
        headers: { Origin: BRIDGE_ORIGIN },
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // 单文件倾向：bridge 静态托管与 Codex widget（MCP Apps）内联构建共用。
    // scripts/build-plugin.mjs 会把这些产物内联成一个自包含 HTML。
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
