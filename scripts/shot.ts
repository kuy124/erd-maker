/**
 * Screenshots a schema in the real app on localhost.
 *
 * Seeds through the app's own `#room=...&d=<snapshot>` link so the canvas shows
 * a real diagram, clicks Arrange, fits the view, and captures the result.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { encodeSnapshot } from '../src/model/snapshot';
import { buildShop } from './shop-schema';
import { emptyDocument } from '../src/model/types';

const which = process.argv[2] ?? 'shop';
const out = process.argv[3] ?? 'output/shot.png';
const arrange = process.argv.includes('--arrange');

const doc = which === 'shop' ? buildShop() : emptyDocument('Blank');
const seed = encodeSnapshot(doc);
const url = `http://localhost:4173/#room=shot${Date.now()}&d=${encodeURIComponent(seed)}`;

const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', 'preview', '--port', '4173', '--strictPort'], { stdio: 'ignore', shell: true });
await new Promise((r) => setTimeout(r, 2500));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  if (arrange) {
    const btn = page.getByRole('button', { name: /arrange/i }).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); }
  }
  await page.keyboard.press('f');
  await page.waitForTimeout(700);
  await page.screenshot({ path: out });
  console.log('saved', out);
} finally {
  await browser.close();
  server.kill();
}
