import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { parseShareHash } from '../../src/model/snapshot';
import { documentAction, inspectSelection, readDownload, snapshotShareLink } from './actions';

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
  const text = await readDownload(await download);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return text;
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
  await page.getByLabel('Data type', { exact: true }).selectOption('VARCHAR');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(255)');
  await page.locator('#attr-type-length').fill('64');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(64)');
  const sql = await exported(page, 'SQL');
  expect(sql).toContain('"customer_id" UUID'); expect(sql).toContain('"buyer_ref" UUID');
  expect(sql).toContain('"contact_email_address" VARCHAR(64)');
  expect(await exported(page, 'SVG')).toContain('VARCHAR(64)');
  await page.getByLabel('Data type', { exact: true }).selectOption('');
  await expect(typeCell(page, 'email')).toHaveText('TEXT');
});

test('types are a base and its numbers, and out-of-range numbers are refused', async ({ page }) => {
  await importDocument(page); await selectAttribute(page, 'email');
  const base = page.getByLabel('Data type', { exact: true });

  // The numbers belong to the base, so the inputs appear with the base and
  // disappear without it.
  await expect(page.locator('#attr-type-length')).toHaveCount(0);
  await base.selectOption('NUMERIC');
  await expect(page.locator('#attr-type-precision')).toHaveValue('10');
  await expect(page.locator('#attr-type-scale')).toHaveValue('2');
  await expect(typeCell(page, 'email')).toHaveText('NUMERIC(10,2)');

  await page.locator('#attr-type-precision').fill('12');
  await page.locator('#attr-type-scale').fill('4');
  await expect(typeCell(page, 'email')).toHaveText('NUMERIC(12,4)');

  // A scale wider than the precision is not a type any database has, so the
  // last good value stands rather than the column becoming something unusable.
  await page.locator('#attr-type-scale').fill('40');
  await expect(typeCell(page, 'email')).toHaveText('NUMERIC(12,4)');

  await base.selectOption('TEXT');
  await expect(page.locator('#attr-type-length')).toHaveCount(0);
  await expect(page.locator('#attr-type-precision')).toHaveCount(0);
  await expect(typeCell(page, 'email')).toHaveText('TEXT');

  await base.selectOption('VARCHAR');
  await page.locator('#attr-type-length').fill('1');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(1)');
  await page.locator('#attr-type-length').fill('0');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(1)');

  // A long name and a long type both have to fit, at any length the model allows.
  await page.locator('#attr-type-length').fill('4000');
  await expect(typeCell(page, 'email')).toHaveText('VARCHAR(4000)');
  expect(await exported(page, 'SQL')).toContain('"contact_email_address" VARCHAR(4000)');
});

test('chosen types survive JSON import, reload, and an offline snapshot link', async ({ page, browser }) => {
  await importDocument(page); await selectAttribute(page, 'price');
  await page.getByLabel('Data type', { exact: true }).selectOption('DECIMAL');
  // Choosing a base gives the usual precision and scale, so the type is usable
  // without a second decision.
  await expect(page.locator('#attr-type-precision')).toHaveValue('10');
  await expect(page.locator('#attr-type-scale')).toHaveValue('2');
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
    await select.selectOption('VARCHAR');
    await expect(select).toHaveValue('VARCHAR');
    // The select takes the full width on a phone, and the length beside it is
    // a full-height tap target rather than a 28px sliver.
    const fits = await select.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
    });
    expect(fits).toBe(true);
    const length = page.locator('#attr-type-length');
    expect(await length.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth;
    })).toBe(true);
    await length.fill('120');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(typeCell(page, 'email')).toHaveText('VARCHAR(120)');
    const separated = await row(page, 'email').evaluate((element) => {
      const name = element.querySelector('.crow-row__name')!.getBoundingClientRect();
      const type = element.querySelector('.crow-row__type')!.getBoundingClientRect();
      return name.right + 2 <= type.left;
    });
    expect(separated).toBe(true);
    expect(JSON.parse(await exported(page, 'JSON')).attributes.find((a: { id: string }) => a.id === 'email').dataType).toBe('VARCHAR(120)');
  });
});

test('adds an ENUM type with a comma-separated list, exports it, and round-trips it', async ({ page }) => {
  await importDocument(page); await selectAttribute(page, 'email');
  await page.getByLabel('Data type', { exact: true }).selectOption('ENUM');
  // Choosing the base gives a usable default so the column is never typeless.
  await expect(typeCell(page, 'email')).toHaveText("ENUM('value')");
  const values = page.locator('#attr-enum-values');
  await expect(values).toBeVisible();
  await values.fill('pending, active, closed');
  await expect(typeCell(page, 'email')).toHaveText("ENUM('pending','active','closed')");
  // Quotes are optional in the field; the exported type always quotes.
  await expect(page.locator('#attr-data-type-help')).toContainText('separated by commas');
  const sql = await exported(page, 'SQL');
  expect(sql).toContain(`"contact_email_address" ENUM('pending','active','closed')`);
  expect(await exported(page, 'SVG')).toContain("ENUM('pending','active','closed')");
  const json = JSON.parse(await exported(page, 'JSON')) as ErdDocument;
  expect(json.attributes.find((a) => a.id === 'email')?.dataType).toBe("ENUM('pending','active','closed')");
  // The JSON is what a reload and a share link both parse, so the value survives.
  await page.reload();
  await expect(typeCell(page, 'email')).toHaveText("ENUM('pending','active','closed')");
});

test('an incomplete enum list keeps the last valid type instead of clearing it', async ({ page }) => {
  await importDocument(page); await selectAttribute(page, 'email');
  await page.getByLabel('Data type', { exact: true }).selectOption('ENUM');
  const values = page.locator('#attr-enum-values');
  await values.fill('draft, review');
  await expect(typeCell(page, 'email')).toHaveText("ENUM('draft','review')");
  // A trailing comma is mid-word, not yet a value: the column must not lapse to
  // something untyped, or to a bogus empty value.
  await values.fill('draft, review, ');
  await expect(typeCell(page, 'email')).toHaveText("ENUM('draft','review')");
  // Finishing the value commits it, and the quoted spelling is accepted too.
  await values.fill("'draft', 'review', 'done'");
  await expect(typeCell(page, 'email')).toHaveText("ENUM('draft','review','done')");
});

test('a value containing a quote is escaped so the SQL stays valid', async ({ page }) => {
  await importDocument(page); await selectAttribute(page, 'email');
  await page.getByLabel('Data type', { exact: true }).selectOption('ENUM');
  await page.locator('#attr-enum-values').fill("owner's, admin");
  await expect(typeCell(page, 'email')).toHaveText("ENUM('owner''s','admin')");
  expect(await exported(page, 'SQL')).toContain(`"contact_email_address" ENUM('owner''s','admin')`);
});
