import { addShape, documentAction, inspectSelection } from './actions';
import { expect, test, type Page } from '@playwright/test';

/**
 * Visual capture. Not an assertion suite — this writes screenshots so the
 * interface can actually be looked at, which no amount of green tests replaces.
 */

const shot = (name: string) => `test-results/shots/${name}.png`;
const canvas = (page: Page) => page.getByTestId('canvas');

async function name(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.getByTestId('inspector-name').fill(text);
}

/**
 * Renders an exported SVG back into the page and photographs it.
 *
 * Asserting that the export contains the right strings proves nothing about
 * whether it *looks* right. Rendering the downloaded file is the only way to see
 * what a reader will actually get.
 */
/** Presses on one shape, releases on another: the Connect tool's own gesture. */
async function dragOnto(page: Page, from: RegExp, to: RegExp): Promise<void> {
  const a = (await canvas(page).getByRole('button', { name: from }).boundingBox())!;
  const b = (await canvas(page).getByRole('button', { name: to }).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('capture the exported SVG', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(300);

  await addShape(page, 'entity');
  await page.getByTestId('inspector-name').fill('Customer');
  await page.keyboard.press('Escape');
  await addShape(page, 'attribute');
  await page.getByTestId('inspector-name').fill('customer_id');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await addShape(page, 'entity');
  await page.getByTestId('inspector-name').fill('Order');
  await page.keyboard.press('Escape');
  await addShape(page, 'attribute');
  await page.getByTestId('inspector-name').fill('total');
  await page.keyboard.press('Escape');
  await addShape(page, 'relationship');
  await page.getByTestId('inspector-name').fill('places');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Auto-arrange' }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: 'Connect tool' }).click();
  await dragOnto(page, /Relationship places/i, /Entity Customer/i);
  await dragOnto(page, /Relationship places/i, /Entity Order/i);
  await page.waitForTimeout(150);

  // Zoom and pan hard first: the export must ignore both.
  await page.keyboard.down('Control');
  await page.mouse.move(700, 400);
  for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await page.mouse.move(900, 500);
  await page.mouse.down();
  await page.mouse.move(600, 320, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const downloadPromise = page.waitForEvent('download');
  await documentAction(page, 'Export');
  await page.getByRole('button', { name: 'Download SVG' }).click();
  const file = await downloadPromise;
  const stream = await file.createReadStream();
  let svg = '';
  for await (const chunk of stream) svg += String(chunk);

  const viewer = await page.context().newPage();
  await viewer.setViewportSize({ width: 900, height: 700 });
  await viewer.goto('data:text/html,' + encodeURIComponent(`
    <!doctype html><html><body style="margin:0;background:#888;display:grid;place-items:center;height:100vh">
    <div style="background:#fff;box-shadow:0 0 0 1px #0003">${svg.replace(/<\?xml[^>]*\?>/, '')}</div>
    </body></html>`));
  await viewer.waitForTimeout(500);
  await viewer.screenshot({ path: shot('12-exported-svg') });
  await viewer.close();
});

test('capture the interface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('01-empty-chen') });

  await addShape(page, 'entity');
  await name(page, 'Customer');
  await page.keyboard.press('Escape');
  await addShape(page, 'attribute');
  await name(page, 'customer_id');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await addShape(page, 'entity');
  await name(page, 'Order');
  await page.keyboard.press('Escape');
  await addShape(page, 'attribute');
  await name(page, 'order_id');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await addShape(page, 'relationship');
  await name(page, 'places');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Auto-arrange' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Connect tool' }).click();
  await dragOnto(page, /Relationship places/i, /Entity Customer/i);
  await dragOnto(page, /Relationship places/i, /Entity Order/i);
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('02-chen-diagram') });

  // Crow's foot, with a one-to-many ratio stated on the connector.
  await page.getByTestId('leg-cardinality').nth(1).click();
  await inspectSelection(page);
  await page.getByRole('button', { name: 'N', exact: true }).click();
  await page.getByRole('button', { name: "Crow's-foot" }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('03-crowfoot') });

  await page.getByRole('button', { name: 'Chen' }).click();
  await documentAction(page, 'Export');
  await page.getByRole('tab', { name: 'SQL' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('04-export-sql') });

  await page.keyboard.press('Escape');
  await documentAction(page, 'Share');
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('05-share') });
  await page.keyboard.press('Escape');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('06-dark-chen') });
});
