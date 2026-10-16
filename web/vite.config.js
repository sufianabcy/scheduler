import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

// In development, Vite serves the app on :5173 and forwards /api to the Node server on :3000,
// so the login cookie works exactly as in production (same origin).
export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: {
    outDir: 'dist',
    // Keep the bundle tiny; no source maps shipped to phones.
    sourcemap: false,
  },
});
