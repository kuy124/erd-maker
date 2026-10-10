import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // simple-peer (used by y-webrtc) expects a Node-style `global`.
  define: {
    global: 'globalThis',
  },
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
