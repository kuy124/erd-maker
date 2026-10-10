/**
 * Smoke test against the deployed site.
 *
 * Unit and end-to-end tests run against the local build, which proves the code
 * works but not that the deployed bundle boots under a subpath, finds its
 * assets, and reaches the network. This checks the thing users actually get.
 *
 * Skipped unless DEPLOY_URL is set, so the normal suite stays hermetic:
 *   DEPLOY_URL=https://kuy124.github.io/erd-maker/ npx playwright test smoke
 */

import { expect, test } from '@playwright/test';

/**
 * Read through `process.env` without importing Node types.
 *
 * The app's tsconfig deliberately excludes `@types/node` so a browser-facing
 * bundle can never reach for a Node global by accident. The test suite shares
 * that config, so the one legitimate Node use here is typed locally rather than
 * by widening `types` for every file.
 */
const DEPLOY_URL = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.DEPLOY_URL;

test.describe('deployed site', () => {
  test.skip(!DEPLOY_URL, 'set DEPLOY_URL to smoke test a deployment');

  test('boots and renders the editor', async ({ page }) => {
    await page.goto(DEPLOY_URL!);
    await expect(page.getByRole('heading', { level: 1, name: /ERD Maker/i })).toBeVisible();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByRole('heading', { name: /start with an entity/i })).toBeVisible();
  });

  test('has no console errors and no failed requests', async ({ page }) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', (req) => {
      // A failed WebRTC signalling connection is expected on a locked-down
      // network and is handled by the app, so it is not a deployment fault.
      const url = req.url();
      if (/signaling|fly\.dev|yjs/i.test(url)) return;
      failedRequests.push(`${url} — ${req.failure()?.errorText}`);
    });

    await page.goto(DEPLOY_URL!);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.getByTestId('add-entity').click();
    await expect(page.getByTestId('canvas').getByRole('button', { name: /Entity New entity/i })).toBeVisible();

    expect(failedRequests, 'requests failed to load').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });

  test('accepts a share link and builds one', async ({ page }) => {
    await page.goto(DEPLOY_URL!);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.getByTestId('add-entity').click();
    await page.getByTestId('inspector-name').fill('Deployed');

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await page.getByLabel('Share link').inputValue();
    expect(link).toContain('#room=');

    // The link must be absolute and point at the deployment, otherwise it is
    // useless to the person it is sent to.
    expect(link.startsWith(DEPLOY_URL!)).toBe(true);

    const fresh = await page.context().newPage();
    await fresh.goto(link);
    await expect(
      fresh.getByTestId('canvas').getByRole('button', { name: /Entity Deployed/i }),
    ).toBeVisible({ timeout: 30_000 });
    await fresh.close();
  });
});
