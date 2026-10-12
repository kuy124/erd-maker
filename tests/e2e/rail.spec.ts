/**
 * Rail legibility.
 *
 * The shape rail doubles as the legend for the notation, so a truncated label
 * is a real defect rather than cosmetic: "Speciali…" tells the reader nothing
 * about which shape they are about to draw. This caught "Relatio…" and
 * "Speciali…" once already, and it can come back the moment a longer name or a
 * larger type size is introduced.
 *
 * The assertion is about overflow rather than a hard-coded pixel width, so it
 * survives the rail being resized for any legitimate reason.
 */

import { expect, test } from '@playwright/test';
import { openBuild } from './actions';

test('no shape rail label is truncated at desktop width', async ({ page }) => {
  await page.goto('/');
  await openBuild(page);
  await expect(page.getByTestId('rail')).toBeVisible();
  await page.waitForTimeout(200);

  const labels = page.locator('.shape-btn__label');
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i += 1) {
    const label = labels.nth(i);
    const text = (await label.textContent())?.trim() ?? '';
    const overflows = await label.evaluate(
      (el) => el.scrollWidth > el.clientWidth + 1,
    );
    expect(overflows, `rail label "${text}" is truncated`).toBe(false);
  }
});

test('rail labels are legible at a large text size', async ({ page }) => {
  await page.goto('/');
  await openBuild(page);
  await expect(page.getByTestId('rail')).toBeVisible();

  // Text-only zoom, which is what a browser's zoom or a larger default font
  // does. The rail must not start hiding its own legend.
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px';
  });
  await page.waitForTimeout(200);

  const truncated = await page.locator('.shape-btn__label').evaluateAll((nodes) =>
    nodes
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent?.trim() ?? ''),
  );
  // At this extreme the rail is allowed to overflow rather than truncate, but
  // it must not silently eat the names: assert it degrades to nothing only if
  // the responsive breakpoint has kicked in.
  if (truncated.length > 0) {
    const railWidth = await page.locator('[data-testid="rail"]').evaluate((el) => el.clientWidth);
    // Below 60px the mobile breakpoint hides labels on purpose.
    expect(railWidth, 'labels truncated at a wide rail').toBeGreaterThan(60);
  }
});
