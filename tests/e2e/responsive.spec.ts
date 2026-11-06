import { expect, test, type Locator } from '@playwright/test';
import { documentAction } from './actions';

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

for (const [width, height] of [[320, 568], [390, 844], [667, 375], [768, 700], [1024, 768], [1280, 800]] as const) {
  test(`workspace controls stay separate at ${width} × ${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    const controls = page.locator('.topbar > .btn, .document-title, .notation, .connection-pill, .file-actions, .viewport-tools, .panel-navigation, .editor-toolbar, .canvas-empty__card');
    const bounds = await controls.evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect();
      return { name: element.className, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }).filter(r => r.width && r.height));
    for (const [index, a] of bounds.entries()) {
      expect(a.x, a.name).toBeGreaterThanOrEqual(0);
      expect(a.y, a.name).toBeGreaterThanOrEqual(0);
      expect(a.right, a.name).toBeLessThanOrEqual(width);
      expect(a.bottom, a.name).toBeLessThanOrEqual(height);
      for (const b of bounds.slice(index + 1)) {
        const overlaps = a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
        expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
    const card = page.locator('.canvas-empty__card');
    await card.getByRole('button', { name: 'Open an example' }).scrollIntoViewIfNeeded();
    await expect(card.getByRole('button', { name: 'Open an example' })).toBeInViewport();

    for (const name of ['Build', 'Properties', 'Diagram', 'Comments', 'Help']) {
      await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name, exact: true }).click();
      // On phones Comments starts pin placement rather than opening a panel.
      if (name === 'Comments' && width < 768) {
        await expect(page.getByRole('button', { name: 'Cancel comment placement' })).toBeVisible();
        await page.keyboard.press('Escape');
        continue;
      }
      const panel = await box(page.locator('.workspace-panel[data-open="true"]'));
      expect(panel.y).toBeGreaterThanOrEqual(0);
      expect(panel.y + panel.height).toBeLessThanOrEqual(height);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    }

    await documentAction(page, 'Share');
    const dialog = page.getByRole('dialog');
    const modal = await box(dialog);
    expect(modal.x).toBeGreaterThanOrEqual(0);
    expect(modal.y).toBeGreaterThanOrEqual(0);
    expect(modal.x + modal.width).toBeLessThanOrEqual(width);
    expect(modal.y + modal.height).toBeLessThanOrEqual(height);
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
