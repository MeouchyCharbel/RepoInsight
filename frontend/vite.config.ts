import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API is same-origin through the dev proxy, so the SameSite=Strict session cookie works and
// no CORS is needed. Both servers listen on loopback only.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
});
