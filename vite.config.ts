import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // simple-peer (used by y-webrtc) expects a Node-style `global`.
  define: {
    global: 'globalThis',
  },
  base: './',
  resolve: {
    /**
     * TypeScript first, JavaScript second.
     *
     * Vite's default order puts `.js` ahead of `.ts`, so any stray compiled
     * file — the kind `tsc -b --noEmit false` scatters through the tree — is
     * silently preferred over the source it was generated from. The build then
     * bundles stale JavaScript, byte-identical output after every edit, and no
     * error anywhere to explain it.
     *
     * Putting the sources first makes the shadowing harmless rather than
     * silent. `tests/unit/no-shadowing-js.test.ts` fails the build outright if
     * a stray file ever shows up again.
     */
    extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
