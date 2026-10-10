import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Tests run against the production build served by `vite preview`, not the dev
 * server, so what is verified is what would be deployed.
 *
 * Two servers are started, and both are load-bearing:
 *
 *   1. `vite preview` serves the built app.
 *   2. `y-webrtc`'s own signalling server introduces peers to each other.
 *
 * The second one matters more than it looks. The app defaults to a public
 * signalling server so it works with no setup, but public servers come and go —
 * the ones that used to ship with y-webrtc are already dead, and the surviving
 * one is not reliable enough to assert against. Running the real signalling
 * protocol locally makes the WebRTC tests deterministic and offline-capable,
 * while still exercising the exact same code path a user would hit.
 *
 * `--strictPort` matters: the multiplayer tests open several browser contexts
 * and all of them must reach the same origin, so the port has to be predictable.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A fixed viewport keeps layout assertions stable.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: [
    {
      command: 'npm run build && npm run preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Defaults to port 4444; the tests point the app at it explicitly.
      command: 'node node_modules/y-webrtc/bin/server.js',
      url: 'http://127.0.0.1:4444',
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
