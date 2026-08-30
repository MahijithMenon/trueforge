import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console talks to the control plane, never to TrueForge or Postgres
// directly. Proxying in dev keeps that boundary identical to production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.CONSOLE_PORT ?? 5173),
    proxy: {
      '/api': {
        target: process.env.SERVER_URL ?? 'http://127.0.0.1:8800',
        changeOrigin: true,
      },
    },
  },
});
