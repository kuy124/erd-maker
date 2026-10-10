/**
 * Guards the accessibility audit against passing vacuously.
 *
 * A zero-violation axe run looks identical whether the interface is clean or
 * the audit never ran — a misconfigured builder, a rule set that excludes
 * everything, or an `AxeBuilder` pointed at the wrong page all produce the same
 * reassuring zero. This test injects a defect axe is known to catch and asserts
 * that it is reported, which is what makes the main audit's silence meaningful.
 */

import { expect, test } from '@playwright/test';

test('the axe audit actually detects defects', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(250);

  const { AxeBuilder } = await import('@axe-core/playwright');

  const before = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const beforeImageAlt = before.violations.some((v) => v.id === 'image-alt');
  expect(beforeImageAlt, 'the app should not already contain an image with no alt').toBe(false);

  // An image with no alt attribute is a guaranteed violation, so if axe does
  // not report it then the audit is not really inspecting the page.
  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    img.id = 'axe-canary';
    document.body.appendChild(img);
  });

  const after = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const caught = after.violations.find((v) => v.id === 'image-alt');
  expect(caught, 'axe should report the injected image-alt violation').toBeDefined();
  expect(caught!.nodes.some((n) => n.target.join(' ').includes('axe-canary'))).toBe(true);
});
