import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend-only dev server (see package.json `dev`); API requests proxy to
// `wrangler dev` (package.json `dev:api`, default port 8787) so the two can
// run side by side via `dev:all`. Native Vite `?worker` imports handle the
// esbuild-wasm Worker from Phase 6 — no extra plugin config needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
