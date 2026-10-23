import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { createExample } from '../../src/model/examples';
import { ROOM_ID_LENGTH } from '../../src/model/snapshot';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
});

async function openDiagram(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'orders.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(createExample('orders'))),
  });
  await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true })).toBeVisible();
}

for (const width of [320, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`the canvas fills the ${width}px ${colorScheme} workspace with panels closed`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await openDiagram(page);
    await expect(page.locator('.workspace-panel--left')).toBeHidden();
    await expect(page.locator('.workspace-panel--right')).toBeHidden();
    const drawing = (await page.getByTestId('canvas').boundingBox())!;
    expect(drawing.x).toBe(0);
    expect(drawing.y).toBe(0);
    expect(drawing.width).toBe(width);
    expect(drawing.height).toBe(900);
    await expect(page.locator('.canvas-status')).toBeHidden();
    await expect(page.locator('.statusbar')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test('selecting a shape stays on the canvas until properties are requested', async ({ page }) => {
  await openDiagram(page);
  const shape = page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true });
  await shape.click();
  await expect(shape.locator('.selection-ring')).toBeVisible();
  await expect(page.locator('.workspace-panel--right')).toBeHidden();
  await shape.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit properties', exact: true }).click();
  await expect(page.getByLabel('Entity name')).toHaveValue('Customer');
  await expect(page.getByLabel('Entity name')).toBeFocused();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(shape.locator('.selection-ring')).toBeVisible();
});

test('selecting after naming a new shape preserves the canvas position', async ({ page }) => {
  await openDiagram(page);
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('e');
  await page.getByLabel('Entity name').fill('Invoice');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const viewport = page.getByTestId('canvas').locator('[data-viewport]');
  const before = await viewport.getAttribute('transform');
  await page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true }).click();
  await expect(page.getByLabel('Entity name')).toHaveValue('Customer');
  await expect(viewport).toHaveAttribute('transform', before!);
});

test('opening Build with the keyboard enters the panel and closing returns focus', async ({ page }) => {
  await openDiagram(page);
  const build = page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Build', exact: true });
  await build.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('add-entity')).toBeFocused();
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(build).toBeFocused();
});

test('the phone starter stays clear of the floating navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  const starter = page.getByRole('button', { name: 'Add your first entity', exact: true });
  await expect(starter).toBeEnabled();
  const card = (await page.locator('.canvas-empty__card').boundingBox())!;
  const nav = (await page.getByRole('navigation', { name: 'Workspace panels' }).boundingBox())!;
  expect(card.x >= nav.x + nav.width + 8 || card.y + card.height <= nav.y - 8 || card.y >= nav.y + nav.height + 8).toBe(true);
  await starter.click();
  await expect(page.getByLabel('Entity name')).toBeFocused();
});

test('opening properties preserves the drawing position', async ({ page }) => {
  await openDiagram(page);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  const table = page.getByTestId('table-Order');
  await table.getByRole('button', { name: 'Table Order', exact: true }).click();
  const viewport = page.getByTestId('canvas').locator('[data-viewport]');
  const before = await viewport.getAttribute('transform');
  await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Properties', exact: true }).click();
  await expect(page.getByLabel('Entity name')).toHaveValue('Order');
  await expect(viewport).toHaveAttribute('transform', before!);
});

for (const size of [{ width: 320, height: 640 }, { width: 667, height: 375 }]) {
  test(`phone editing controls leave drawing room at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await openDiagram(page);
    const nav = page.getByRole('navigation', { name: 'Workspace panels' });
    const bounds = (await nav.boundingBox())!;
    expect(bounds.y).toBeGreaterThan(size.height / 2);
    expect(bounds.width).toBeGreaterThan(bounds.height);
    await nav.getByRole('button', { name: 'Properties', exact: true }).click();
    const panel = (await page.locator('.workspace-panel--right').boundingBox())!;
    expect(panel.height).toBeLessThanOrEqual(size.height * 0.46);
    await expect(page.getByRole('button', { name: 'Select tool', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.locator('.workspace-panel[data-open="true"] .panel-close--phone')).toBeVisible();
    await expect(page.locator('.workspace-panel[data-open="true"] .panel-close--phone')).toHaveText('Done');
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(page.locator('.workspace-panel--right')).toBeHidden();
    await nav.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('button', { name: 'Add entity', exact: true }).click();
    await page.getByLabel('Entity name').fill('Phone entity');
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Phone entity', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    await page.screenshot({ path: `test-results/phone-workspace-${size.width}.png` });
  });
}

test('Focus view hides the controls, preserves the diagram, and exits with Escape', async ({ page }) => {
  await openDiagram(page);
  const viewport = page.getByTestId('canvas').locator('[data-viewport]');
  const before = await viewport.getAttribute('transform');
  await page.getByRole('button', { name: 'Enter Focus view', exact: true }).click();
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Diagram tools' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Workspace panels' })).toBeHidden();
  await expect(page.getByRole('group', { name: 'Canvas navigation' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Exit Focus view', exact: true })).toBeVisible();
  expect(await viewport.getAttribute('transform')).toBe(before);
  await page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true }).click();
  await expect(page.locator('.workspace-panel--right')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('.topbar')).toBeVisible();
  await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Customer', exact: true }).locator('.selection-ring')).toBeVisible();
});

test.describe('touch editing', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 640 } });

  test('controls do not overlap and touch edits survive undo, redo, and reload', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add your first entity', exact: true }).tap();
    await page.getByLabel('Entity name').fill('Touch customer');
    await page.getByRole('button', { name: 'Close panel', exact: true }).tap();
    const canvas = page.getByTestId('canvas');
    const entity = canvas.getByRole('button', { name: 'Entity Touch customer', exact: true });
    await entity.tap();
    const nav = page.getByRole('navigation', { name: 'Workspace panels' });
    await nav.getByRole('button', { name: 'Properties', exact: true }).tap();
    await expect(page.getByLabel('Entity name')).toHaveValue('Touch customer');

    const regions = await Promise.all([
      page.locator('.workspace-panel--right'), nav, page.getByRole('toolbar', { name: 'Diagram tools' }),
    ].map(async (locator) => (await locator.boundingBox())!));
    for (let i = 0; i < regions.length; i++) {
      const a = regions[i]!;
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(320);
      expect(a.y + a.height).toBeLessThanOrEqual(640);
      for (const b of regions.slice(i + 1)) {
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    }
    await page.getByRole('button', { name: 'Connect tool', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Connect tool', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.workspace-panel--right')).toBeHidden();
    await page.getByRole('button', { name: 'Select tool', exact: true }).tap();
    await page.getByRole('button', { name: 'Undo', exact: true }).tap();
    await expect(entity).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).tap();
    await expect(entity).toBeVisible();
    await page.reload();
    await expect(entity).toBeVisible();
    await entity.tap();
    await nav.getByRole('button', { name: 'Properties', exact: true }).tap();
    await expect(page.getByLabel('Entity name')).toHaveValue('Touch customer');
  });
});

test('phone properties stay above a reduced visual viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add your first entity', exact: true }).click();
  await page.getByLabel('Entity name').fill('Keyboard edit');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 400 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.app')).toHaveAttribute('data-keyboard', 'true');
  await expect(page.locator('.panel-navigation')).toBeHidden();
  const sheet = (await page.locator('.workspace-panel--right').boundingBox())!;
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(400);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await expect(page.locator('.workspace-panel--right')).toBeHidden();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 844 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.app')).toHaveAttribute('data-keyboard', 'false');
  await expect(page.getByRole('toolbar', { name: 'Diagram tools' })).toBeVisible();
  await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Keyboard edit', exact: true })).toBeVisible();
});

test('Focus view keeps right-click creation and keyboard editing available', async ({ page }) => {
  await openDiagram(page);
  await page.getByRole('button', { name: 'Enter Focus view', exact: true }).click();
  await page.getByTestId('canvas').press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Add a shape' })).toBeVisible();
  await page.keyboard.press('e');
  await expect(page.getByLabel('Entity name')).toBeFocused();
  await page.keyboard.type('Invoice');
  await expect(page.getByTestId('canvas').getByRole('button', { name: 'Entity Invoice', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enter Focus view', exact: true })).toBeVisible();
  await page.getByLabel('Entity name').fill('Invoice');
  await page.keyboard.press('i');
  await expect(page.getByLabel('Entity name')).toHaveValue('Invoicei');
  await expect(page.locator('.topbar')).toBeVisible();
});

test('document actions remain reachable from the compact phone header', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openDiagram(page);
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Diagram actions' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'New', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Import', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Diagram actions' })).toBeHidden();
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Share link')).toHaveValue(new RegExp('#room=[a-z2-9]{' + ROOM_ID_LENGTH + '}(&d=.+)?$'));
});
