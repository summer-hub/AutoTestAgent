import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 独立开发模式（npm run dev，默认 5173）：前端默认 API_BASE='/api'，
    // 这里代理并改写前缀到独立服务器的 /api/autotest（独立服务器默认端口 3280）。
    // 嵌入版构建（build-embed.mjs）传 VITE_API_BASE=/api/autotest 同源直连，不走本代理。
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3280',
        rewrite: (p) => p.replace(/^\/api/, '/api/autotest'),
      },
    },
  },
});
