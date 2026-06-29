import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 'mpa' disables the SPA history fallback so that requests for missing files
  // (broken images, the /api/featured endpoint) return real 404s instead of
  // being silently rewritten to index.html. The app is a single page anyway.
  appType: 'mpa',
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
  },
});
