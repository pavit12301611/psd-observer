import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './', plugins: [react(), {
    name: 'dev-refresh-csp', apply: 'serve',
    // Vite injects a development-only inline refresh preamble. Production APK
    // assets retain the strict CSP in index.html; never relax the native build.
    transformIndexHtml: (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
  }],
  css: { postcss: { plugins: [] } },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true,
    proxy: {
      '/bridge': { target: process.env.OBSERVER_BRIDGE_TARGET || 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (p) => p.replace(/^\/bridge/, ''), configure: (proxy) => { proxy.on('proxyReq', (req) => { req.removeHeader('cookie'); req.removeHeader('authorization'); }); } },
      '/release-api': { target: 'https://api.github.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/release-api/, ''), configure: (proxy) => { proxy.on('proxyReq', (req) => { req.removeHeader('cookie'); req.removeHeader('authorization'); req.removeHeader('x-bridge-token'); }); } },
    },
  },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 350 },
});
