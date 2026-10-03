import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Default stays loopback-only. `pnpm dev:lan` adds --host for M5 L3
    // real-device testing, which is the one case the dev server has to be
    // reachable from the phone on the same network.
    //
    // The device only needs :5173 — vite proxies /api to the API. Note the API
    // itself binds all interfaces unless BIND_HOST is set, so on a dev LAN it
    // is reachable directly on :3000 as well; production puts it behind the
    // reverse proxy with BIND_HOST=127.0.0.1.
    //
    // The proxy rewrites Host to the target, so the API's CSRF origin check
    // (index.ts) can never match host against origin here — dev relies on
    // CSRF_ALLOWED_ORIGINS instead. When testing from a phone, the LAN origin
    // (http://<lan-ip>:5173) must be added there or every POST is 403.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
