import { expect, test, type Page, type Download } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { createExample } from '../../src/model/examples';
import { parseShareHash } from '../../src/model/snapshot';
import type { ErdDocument } from '../../src/model/types';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
});
const canvas = (page: Page) => page.getByTestId('canvas');
const properties = (page: Page) => page.getByRole('complementary', { name: 'Properties', exact: true });
const panels = (page: Page) => page.getByRole('navigation', { name: 'Workspace panels' });
async function ready(page: Page) {
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
}
async function importDocument(page: Page, doc: object) {
  await page.locator('input[type=file]').setInputFiles({
    name: 'diagram.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)),
  });
  await ready(page);
}
async function readDownload(file: Download) {
  const stream = await file.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
async function exportDocument(page: Page, format: 'JSON' | 'SVG' | 'PNG' | 'SQL') {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('tab', { name: format, exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ' + format }).click();
  const bytes = await readDownload(await pending);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return bytes;
}
async function json(page: Page): Promise<ErdDocument> {
  return JSON.parse((await exportDocument(page, 'JSON')).toString());
}
async function openOutline(page: Page) {
  if (await panels(page).isVisible()) await panels(page).getByRole('button', { name: 'Diagram', exact: true }).click();
  else await page.getByRole('group', { name: 'Left panel' }).getByRole('button', { name: 'Diagram', exact: true }).click();
}
async function findShape(page: Page, name: string) {
  await openOutline(page);
  await page.getByLabel('Find a shape').fill(name);
  await page.locator('.outline__item').filter({ hasText: name }).first().click();
}

test.describe('phone editing', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('creates a keyed schema, edits cardinality, restores deletion, shares and exports', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await page.getByRole('button', { name: 'Add your first entity' }).tap();
    await expect(page.getByLabel('Entity name')).toBeFocused();
    await page.getByLabel('Entity name').fill('Customer');
    await properties(page).getByRole('button', { name: 'Add attribute', exact: true }).tap();
    await expect(page.getByLabel('Attribute name')).toBeFocused();
    await page.getByLabel('Attribute name').fill('customer_id');
    await properties(page).getByRole('button', { name: 'Key', exact: true }).tap();

    await panels(page).getByRole('button', { name: 'Build', exact: true }).tap();
    await page.getByTestId('add-entity').tap();
    await page.getByLabel('Entity name').fill('Order');
    await properties(page).getByRole('button', { name: 'Add attribute', exact: true }).tap();
    await page.getByLabel('Attribute name').fill('order_id');
    await properties(page).getByRole('button', { name: 'Key', exact: true }).tap();
    await panels(page).getByRole('button', { name: 'Build', exact: true }).tap();
    await page.getByTestId('add-relationship').tap();
    await page.getByLabel('Relationship name').fill('places');
    await page.getByRole('button', { name: 'Add participant' }).tap();
    await page.getByLabel('Entity 1', { exact: true }).selectOption({ label: 'Customer' });
    await page.getByRole('button', { name: 'Add participant' }).tap();
    await page.getByLabel('Entity 2', { exact: true }).selectOption({ label: 'Order' });
    await page.getByLabel('Cardinality at Order').selectOption('M');
    await expect(page.getByTestId('ratio-preview')).toHaveText('Customer (1) : Order (M)');
    await page.getByLabel('Cardinality at Order').selectOption('N');
    await expect(page.getByTestId('ratio-preview')).toHaveText('Customer (1) : Order (N)');

    const orderRow = page.getByTestId('participant-row').nth(1);
    await orderRow.getByText('Minimum / maximum', { exact: true }).tap();
    await orderRow.getByLabel('Maximum').fill('wrong');
    await expect(orderRow.getByLabel('Maximum')).toHaveAttribute('aria-invalid', 'true');
    await orderRow.getByLabel('Maximum').fill('5');
    await orderRow.getByLabel('Minimum').fill('1');
    await orderRow.getByRole('button', { name: 'Required', exact: true }).tap();

    await findShape(page, 'Order');
    await properties(page).getByRole('button', { name: 'Delete entity', exact: true }).tap();
    await expect(page.locator('.feedback')).toContainText('Order deleted.');
    await page.locator('.feedback').getByRole('button', { name: 'Undo', exact: true }).tap();

    await page.getByRole('button', { name: 'Share', exact: true }).tap();
    const link = await page.getByLabel('Share link').inputValue();
    expect(parseShareHash(new URL(link).hash).doc?.entities).toHaveLength(2);
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    const saved = await json(page);
    expect(saved.attributes.filter((attribute) => attribute.kind === 'key')).toHaveLength(2);
    expect(saved.legs.find((leg) => leg.toId === saved.entities.find((entity) => entity.name === 'Order')?.id)?.participation).toEqual({ min: 1, max: 5 });
    const svg = (await exportDocument(page, 'SVG')).toString();
    expect(svg).toContain('Customer');
    expect(svg).not.toMatch(/selection-ring|connect-preview|leg-hit|node--connecting/);
    const png = await exportDocument(page, 'PNG');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect((await exportDocument(page, 'SQL')).toString()).toContain('FOREIGN KEY');
  });
});

test('new diagrams, examples, and legacy imports open separately and Back restores persisted edits and notation', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('add-entity').click();
  await page.getByLabel('Entity name').fill('My diagram');
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  const original = page.url();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await ready(page);
  expect(page.url()).not.toBe(original);
  await expect(page.getByRole('heading', { name: 'Start with an entity' })).toBeVisible();
  await page.getByTestId('add-entity').click();
  await page.getByLabel('Entity name').fill('Second room');
  await page.goBack();
  await ready(page);
  await expect(page.getByTestId('table-My diagram')).toBeVisible();
  await expect(page.getByRole('button', { name: "Crow's-foot", exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goForward();
  await ready(page);
  await expect(canvas(page).getByRole('button', { name: 'Entity Second room', exact: true })).toBeVisible();
  await page.getByTestId('rail').getByRole('button', { name: 'Open an example', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Customer & Order/ }).click();
  await ready(page);
  await expect(page.getByLabel('Diagram name')).toHaveValue('Customer & Order — example');
  await findShape(page, 'Customer');
  await page.getByLabel('Entity name').fill('Edited example');
  const exampleRoom = page.url();
  await importDocument(page, { view: 'crowfoot', name: 'Legacy file', entities: [{ id: 'old', name: 'Legacy entity', x: 9000, y: 8000 }] });
  await expect(page.getByTestId('table-Legacy entity')).toBeVisible();
  expect(page.url()).not.toBe(exampleRoom);
  await page.goBack();
  await ready(page);
  await expect(canvas(page).getByRole('button', { name: 'Entity Edited example', exact: true })).toBeVisible();
});

test('invalid imports explain recovery and keep the current room intact', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByTestId('add-entity').click();
  await page.getByLabel('Entity name').fill('Keep me');
  const url = page.url();
  await importDocument(page, {});
  await expect(page.getByRole('alert')).toContainText('entities array');
  expect(page.url()).toBe(url);
  await expect(canvas(page).getByRole('button', { name: 'Entity Keep me', exact: true })).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{ broken') });
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  expect(page.url()).toBe(url);
});

test('diagram findings open properties and Chen-only concepts remain discoverable from tables', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const doc = createExample('orders');
  doc.attributes.push({ id: 'free', name: 'Unattached', kind: 'simple', ownerId: null, x: 0, y: 300 });
  doc.isas.push({ id: 'subtype', parentId: doc.entities[0]!.id, childIds: [], x: 0, y: 400 });
  await importDocument(page, doc);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await openOutline(page);
  await page.getByRole('button', { name: /Check diagram/ }).click();
  await page.getByRole('button', { name: 'Unattached needs an owner.', exact: true }).click();
  await expect(page.getByLabel('Attribute name')).toHaveValue('Unattached');
  await expect(page.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await findShape(page, 'Specialization');
  await expect(page.getByLabel('Superclass')).toHaveValue(doc.entities[0]!.id);
  await expect(page.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('table rows distinguish editable attributes, generated keys, and inferred types; exports remove highlights', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await importDocument(page, createExample('orders'));
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await canvas(page).getByRole('button', { name: 'Edit attribute customer_id', exact: true }).click();
  await expect(page.getByLabel('Attribute name')).toHaveValue('customer_id');
  await page.getByLabel('Attribute name').fill('customer_number');
  await expect(canvas(page).getByRole('button', { name: 'Edit attribute customer_number', exact: true })).toBeVisible();
  await canvas(page).getByRole('button', { name: /Generated foreign key/ }).click();
  await expect(page.getByLabel('Entity name')).toHaveValue('Order');
  await expect(properties(page)).toContainText('SQL types are inferred');
  const svg = (await exportDocument(page, 'SVG')).toString();
  expect(svg).not.toMatch(/selection-ring|hit-target|crow-link--selected/);
  const doc = await json(page);
  expect(doc.view).toBe('crowfoot');
  expect(doc.attributes.some((attribute) => attribute.name === 'customer_number')).toBe(true);
});

test('relationship participants retain IDs, support incomplete and multi-entity drafts, and undo as one operation', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const source = createExample('orders');
  await importDocument(page, source);
  await findShape(page, 'places');
  await page.getByLabel('Entity 1', { exact: true }).selectOption(source.entities[1]!.id);
  let saved = await json(page);
  expect(saved.legs.map((leg) => leg.id)).toEqual(source.legs.map((leg) => leg.id));
  expect(saved.legs[0]?.toId).toBe(source.entities[1]!.id);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  saved = await json(page);
  expect(saved.legs).toEqual(source.legs);
  await page.getByRole('button', { name: 'Add participant' }).click();
  await page.getByLabel('Entity 3', { exact: true }).selectOption(source.entities[0]!.id);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await findShape(page, 'places');
  await expect(page.getByTestId('participant-row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('participant-row').nth(2).getByRole('button', { name: /Remove/ }).click();
  await page.getByTestId('participant-row').nth(1).getByRole('button', { name: /Remove/ }).click();
  saved = await json(page);
  expect(saved.relationships).toHaveLength(1);
  expect(saved.legs).toHaveLength(1);
});

test('collaborators keep independent views and undo local changes alongside remote work', async ({ browser, page: alice }) => {
  await alice.goto('/');
  await ready(alice);
  await importDocument(alice, createExample('orders'));
  await alice.getByRole('button', { name: 'Share', exact: true }).click();
  const link = await alice.getByLabel('Share link').inputValue();
  await alice.getByRole('button', { name: 'Done', exact: true }).click();
  const other = await browser.newContext();
  await other.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
  const bob = await other.newPage();
  try {
    await bob.goto(link);
    await ready(bob);
    await expect(alice.locator('.collaboration-status')).toContainText('Editing with', { timeout: 30_000 });
    await bob.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    await expect(alice.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await findShape(alice, 'places');
    const row = alice.getByTestId('participant-row').nth(0);
    await row.getByText('Minimum / maximum', { exact: true }).click();
    await row.getByLabel('Maximum').fill('invalid');
    expect((await json(bob)).legs[0]?.participation.max).toBe(1);
    await row.getByLabel('Maximum').fill('4');
    await expect.poll(async () => (await json(bob)).legs[0]?.participation.max).toBe(4);
    await findShape(alice, 'Customer');
    await alice.getByLabel('Entity name').fill('Local name');
    await bob.getByTestId('add-entity').click();
    await bob.getByLabel('Entity name').fill('Remote entity');
    await expect(canvas(alice).getByRole('button', { name: 'Entity Remote entity', exact: true })).toBeVisible();
    await alice.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(canvas(alice).getByRole('button', { name: 'Entity Customer', exact: true })).toBeVisible();
    await expect(canvas(alice).getByRole('button', { name: 'Entity Remote entity', exact: true })).toBeVisible();
    await alice.reload(); await ready(alice);
    await bob.reload(); await ready(bob);
    await expect(alice.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(bob.getByRole('button', { name: "Crow's-foot", exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { await other.close(); }
});

test('clipboard failures offer a selectable share link for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Blocked'); } }, configurable: true });
    document.execCommand = () => false;
  });
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('copy it manually');
  await page.getByLabel('Share link').focus();
  expect(await page.getByLabel('Share link').evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBeGreaterThan(10);
});


for (const colorScheme of ['light', 'dark'] as const) for (const width of [320, 390, 768, 1440]) {
  test('renders ' + colorScheme + ' at ' + width + 'px with long names, focus, and complete controls', async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/'); await ready(page);
    const doc = createExample('orders');
    doc.entities[0]!.name = 'Customer account with a long descriptive name';
    doc.attributes[0]!.name = 'customer_identifier_used_by_the_school';
    await importDocument(page, doc);
    await findShape(page, 'Customer account');
    await page.getByLabel('Entity name').focus();
    await expect(page.getByLabel('Entity name')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width < 1100) {
      const sheet = page.locator('.workspace-panel--right');
      await expect(sheet).toBeVisible();
      const bounds = await sheet.boundingBox();
      const drawing = await canvas(page).boundingBox();
      expect(bounds!.height).toBeLessThanOrEqual(drawing!.height + 1);
      if (width < 768) expect(bounds!.y).toBeGreaterThan(drawing!.y);
      if (width < 768) expect(await page.getByLabel('Entity name').evaluate((node) => getComputedStyle(node).fontSize)).toBe('16px');
    }
    const undersized = await page.locator('.btn, .seg__btn, .shape-btn').evaluateAll((nodes) => nodes
      .filter((node) => node.getClientRects().length > 0)
      .filter((node) => { const rect = node.getBoundingClientRect(); return rect.width < 43.5 || rect.height < 43.5; })
      .map((node) => node.textContent?.trim()));
    expect(undersized).toEqual([]);
    await page.screenshot({ path: 'test-results/shots/workspace-' + colorScheme + '-' + width + '.png' });
    if (width === 320 || width === 1440) {
      const { AxeBuilder } = await import('@axe-core/playwright');
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations.filter((issue) => issue.impact === 'serious' || issue.impact === 'critical')
        .map((issue) => issue.id + ': ' + issue.nodes.map((node) => node.target.join(' ')).join(', '))).toEqual([]);
    }
    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    if (width < 1100) await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const relationAction = page.getByRole('toolbar').getByRole('button', { name: 'Add relationship', exact: true });
    await expect(relationAction).toBeVisible();
    const actionBounds = await relationAction.boundingBox();
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: 'test-results/shots/tables-' + colorScheme + '-' + width + '.png' });
  });
}

test('phone sheets fit above a simulated keyboard and Help remains scrollable at 200% zoom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/'); await ready(page);
  await page.getByRole('button', { name: 'Add your first entity' }).click();
  await page.getByLabel('Entity name').fill('Invoice');
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { get: () => 440, configurable: true });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('.app')).toHaveAttribute('data-keyboard', 'true');
  await expect(page.getByLabel('Entity name')).toBeFocused();
  await expect(page.getByLabel('Entity name')).toBeInViewport();
  await properties(page).getByRole('button', { name: 'Add attribute', exact: true }).click();
  await expect(page.getByLabel('Attribute name')).toBeFocused();
  await expect(page.getByLabel('Attribute name')).toBeInViewport();
  await page.screenshot({ path: 'test-results/shots/phone-keyboard.png' });
  await page.evaluate(() => {
    delete (window.visualViewport as unknown as Record<string, unknown>).height;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.setViewportSize({ width: 720, height: 450 });
  await panels(page).getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Modeling guide' })).toBeVisible();
  await page.getByRole('heading', { name: 'Keyboard shortcuts' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/shots/workspace-200-percent-help.png' });
});


test('crow’s-foot draws two many ends for Student–Course and two one ends for one-to-one', async ({ page }) => {
  await page.goto('/'); await ready(page);
  await importDocument(page, createExample('courses'));
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(page.locator('.layer-links .crow-link')).toHaveCount(1);
  await expect(page.locator('.layer-links [data-cardinality="many"]')).toHaveCount(2);
  await expect(page.locator('.layer-links [data-cardinality="one"]')).toHaveCount(0);
  await expect(page.locator('.crow-link__ratio')).toHaveText('N:M');
  const doc = createExample('orders');
  doc.legs.forEach((leg) => { leg.cardinality = '1'; });
  await importDocument(page, doc);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(page.locator('.layer-links [data-cardinality="many"]')).toHaveCount(0);
  await expect(page.locator('.layer-links [data-cardinality="one"]')).toHaveCount(2);
  await expect(page.locator('.crow-link__ratio')).toHaveText('1:1');
});
