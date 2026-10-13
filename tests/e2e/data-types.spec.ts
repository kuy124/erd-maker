import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { parseShareHash } from '../../src/model/snapshot';
import { documentAction, inspectSelection, snapshotShareLink } from './actions';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
});

function schema(): ErdDocument {
  const doc = emptyDocument('Typed customers'); doc.view = 'crowfoot';
  doc.entities = [
    { id: 'c', name: 'Customer', kind: 'strong', x: 80, y: 80 },
    { id: 'o', name: 'Order', kind: 'strong', x: 600, y: 80 },
  ];
  doc.attributes = [
    { id: 'id', name: 'customer_id', kind: 'key', ownerId: 'c', x: 0, y: 0 },
    { id: 'email', name: 'contact_email_address', kind: 'simple', ownerId: 'c', x: 0, y: 0 },
    { id: 'price', name: 'total_price', kind: 'simple', ownerId: 'o', x: 0, y: 0 },
    { id: 'buyer', name: 'buyer_ref', kind: 'simple', ownerId: 'o', x: 0, y: 0 },
  ];
  doc.relationships = [{ id: 'r', name: 'places', kind: 'strong', x: 400, y: 80 }];
  doc.legs = [
    { id: 'l1', fromId: 'r', toId: 'c', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r', toId: 'o', columnId: 'attribute:buyer', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  return doc;
}

const row = (page: Page, id: string) => page.locator(`[data-column-id="attribute:${id}"]`);
const typeCell = (page: Page, id: string) => row(page, id).locator('.crow-row__type');

async function importDocument(page: Page, doc = schema()) {
  await page.goto('/'); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({
    name: 'typed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId('table-Customer')).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
}

async function selectAttribute(page: Page, id: string) {
  const close = page.getByRole('button', { name: 'Close panel', exact: true });
  if (await close.isVisible()) await close.click();
  await row(page, id).click(); await inspectSelection(page);
  await expect(page.getByLabel('Data type', { exact: true })).toBeVisible();
}

async function exported(page: Page, format: 'JSON' | 'SQL' | 'SVG') {
  await documentAction(page, 'Export');
  await page.getByRole('tab', { name: format, exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ' + format }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = []; for await (const part of stream) chunks.push(Buffer.from(part));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return Buffer.concat(chunks).toString();
}

test('edits table and SQL types, inherits FK types, and restores inference with Undo and Automatic', async ({ page }) => {
  await importDocument(page);
  await expect(typeCell(page, 'id')).toHaveText('INT');
  await selectAttribute(page, 'id');
  await page.getByLabel('Data type', { exact: true }).selectOption('UUID');
  await expect(typeCell(page, 'id')).toHaveText('UUID');
  await expect(typeCell(page, 'buyer')).toHaveText('UUID');
  await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(typeCell(page, 'id')).toHaveText('INT');
  await expect(page.getByLabel('Data type', { exact: true })).toHaveValue('');
  await page.getByRole('toolbar').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(typeCell(page, 'buyer')).toHaveText('UUID');
  await selectAttribute(page, 'buyer');
  await expect(page.getByLabel('Data type', { exact: true })).toBeDisabled();
  await expect(page.locator('#attr-data-type-help')).toContainText('Customer.customer_id');
  await selectAttribute(page, 'email');
  await page.getByLabel('Data type', { exact: true }).selectOption('VARCHAR(255)');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(255)');
  const sql = await exported(page, 'SQL');
  expect(sql).toContain('"customer_id" UUID'); expect(sql).toContain('"buyer_ref" UUID');
  expect(sql).toContain('"contact_email_address" VARCHAR(255)');
  expect(await exported(page, 'SVG')).toContain('VARCHAR(255)');
  await page.getByLabel('Data type', { exact: true }).selectOption('');
  await expect(typeCell(page, 'email')).toHaveText('TEXT');
});

test('chosen types survive JSON import, reload, and an offline snapshot link', async ({ page, browser }) => {
  await importDocument(page); await selectAttribute(page, 'price');
  await page.getByLabel('Data type', { exact: true }).selectOption('DECIMAL(10,2)');
  const json = JSON.parse(await exported(page, 'JSON')) as ErdDocument;
  expect(json.attributes.find((a) => a.id === 'price')?.dataType).toBe('DECIMAL(10,2)');
  await page.reload(); await expect(typeCell(page, 'price')).toHaveText('DECIMAL(10,2)');
  await documentAction(page, 'Share'); const link = await snapshotShareLink(page);
  expect(parseShareHash(new URL(link).hash).doc?.attributes.find((a) => a.id === 'price')?.dataType).toBe('DECIMAL(10,2)');
  const offline = await browser.newContext();
  await offline.addInitScript(() => { (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = []; });
  await offline.routeWebSocket('**/*', (socket) => socket.close());
  const restored = await offline.newPage(); await restored.goto(link);
  await expect(typeCell(restored, 'price')).toHaveText('DECIMAL(10,2)');
  await importDocument(restored, json);
  await expect(typeCell(restored, 'price')).toHaveText('DECIMAL(10,2)');
  await offline.close();
});

test('live collaborators receive type changes and local Undo preserves their rename', async ({ page: alice, browser }) => {
  await importDocument(alice); await selectAttribute(alice, 'id');
  await documentAction(alice, 'Share');
  const link = await alice.getByLabel('Share link').inputValue();
  expect(new URLSearchParams(new URL(link).hash.slice(1)).has('d')).toBe(false);
  await alice.getByRole('button', { name: 'Done', exact: true }).click();
  const other = await browser.newContext();
  await other.addInitScript(() => { (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444']; });
  const bob = await other.newPage(); await bob.goto(link);
  await expect(bob.getByLabel('Diagram name')).toHaveValue('Typed customers', { timeout: 25_000 });
  await bob.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(bob.getByTestId('table-Customer')).toBeVisible({ timeout: 25_000 });
  await expect(alice.locator('.collaboration-status')).toContainText('Editing with', { timeout: 25_000 });
  await alice.getByLabel('Data type', { exact: true }).selectOption('UUID');
  await expect(typeCell(bob, 'buyer')).toHaveText('UUID');
  await selectAttribute(bob, 'email'); await bob.getByLabel('Attribute name').fill('billing_email');
  await expect(row(alice, 'email')).toHaveAccessibleName('Edit attribute billing_email');
  await alice.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(typeCell(alice, 'id')).toHaveText('INT');
  await expect(typeCell(bob, 'buyer')).toHaveText('INT');
  await expect(row(alice, 'email')).toHaveAccessibleName('Edit attribute billing_email');
  await other.close();
});

test.describe('phone data types', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('edits a type in Properties without horizontal overflow and exports it', async ({ page }) => {
    const doc = schema(); doc.entities[1]!.x = 80; doc.entities[1]!.y = 320;
    await importDocument(page, doc); await selectAttribute(page, 'email');
    const select = page.getByLabel('Data type', { exact: true });
    await select.selectOption('VARCHAR(255)'); await expect(select).toHaveValue('VARCHAR(255)');
    expect(await select.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(typeCell(page, 'email')).toHaveText('VARCHAR(255)');
    const separated = await row(page, 'email').evaluate((element) => {
      const name = element.querySelector('.crow-row__name')!.getBoundingClientRect();
      const type = element.querySelector('.crow-row__type')!.getBoundingClientRect();
      return name.right + 2 <= type.left;
    });
    expect(separated).toBe(true);
    expect(JSON.parse(await exported(page, 'JSON')).attributes.find((a: { id: string }) => a.id === 'email').dataType).toBe('VARCHAR(255)');
  });
});
