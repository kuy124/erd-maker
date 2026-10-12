import { documentAction, inspectSelection } from './actions';
import { expect, test, type Page } from '@playwright/test';
import { Buffer } from 'node:buffer';
import AxeBuilder from '@axe-core/playwright';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { parseShareHash } from '../../src/model/snapshot';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444'];
  });
});

function fields(): ErdDocument {
  const doc = emptyDocument('Connected attributes'); doc.view = 'crowfoot';
  doc.entities = [{ id: 'c', name: 'Customer', x: 80, y: 80, kind: 'strong' },
    { id: 'o', name: 'Order', x: 600, y: 124, kind: 'strong' }];
  doc.attributes = [
    { id: 'c1', name: 'customer_id', ownerId: 'c', kind: 'key', x: 0, y: 0 },
    { id: 'c2', name: 'email', ownerId: 'c', kind: 'simple', x: 0, y: 0 },
    { id: 'o1', name: 'order_id', ownerId: 'o', kind: 'key', x: 0, y: 0 },
    { id: 'o2', name: 'buyer_ref', ownerId: 'o', kind: 'simple', x: 0, y: 0 },
    { id: 'o3', name: 'approver_ref', ownerId: 'o', kind: 'simple', x: 0, y: 0 },
  ];
  return doc;
}
async function open(page: Page, doc = fields()) {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'rows.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(doc)) });
  await expect(page.getByTestId('table-Order')).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
}
const row = (page: Page, entity: string, id: string) => page.locator(`[data-node-id="${entity}"] [data-column-id="${id}"]`);
const properties = (page: Page) => page.getByRole('complementary', { name: 'Properties', exact: true });
const links = (page: Page) => page.locator('.crow-link');
async function connect(page: Page, source = 'attribute:c1', target = 'attribute:o2') {
  await page.getByRole('button', { name: 'Connect tool' }).click();
  await row(page, 'c', source).click(); await row(page, 'o', target).click();
  await expect(page.getByLabel('Relationship name')).toBeFocused();
}
async function exported(page: Page, format: 'JSON' | 'SVG' | 'PNG' | 'SQL') {
  await documentAction(page, 'Export');
  await page.getByRole('tab', { name: format, exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ' + format }).click();
  const file = await pending, stream = await file.createReadStream();
  const chunks: Buffer[] = []; for await (const part of stream) chunks.push(Buffer.from(part));
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return Buffer.concat(chunks);
}
async function json(page: Page): Promise<ErdDocument> { return JSON.parse((await exported(page, 'JSON')).toString()); }
async function anchored(page: Page, source: string, target: string) {
  const link = links(page).first();
  await expect(link).toHaveAttribute('data-from-column', source);
  await expect(link).toHaveAttribute('data-to-column', target);
  const endpoints = await link.locator('.crow-link__path').getAttribute('d');
  expect(endpoints).toMatch(/^M-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? H/);
  const values = await page.evaluate(({ source, target }) => {
    const center = (selector: string) => {
      const field = document.querySelector<SVGGElement>(selector)!;
      const rect = field.querySelector<SVGRectElement>('.crow-row__hit')!;
      const p = new DOMPoint(0, Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2);
      return p.matrixTransform(field.getCTM()!).y;
    };
    const path = document.querySelector<SVGPathElement>('.crow-link__path')!;
    const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength());
    return { sourceY: center(`[data-node-id="c"] [data-column-id="${source}"]`),
      targetY: center(`[data-node-id="o"] [data-column-id="${target}"]`),
      startY: new DOMPoint(start.x, start.y).matrixTransform(path.getCTM()!).y,
      endY: new DOMPoint(end.x, end.y).matrixTransform(path.getCTM()!).y };
  }, { source, target });
  expect(values.startY).toBeCloseTo(values.sourceY, 2); expect(values.endY).toBeCloseTo(values.targetY, 2);
}

test('click connections edit actual fields, retain IDs through cardinality changes, and undo as one action', async ({ page }) => {
  await open(page); await connect(page);
  await anchored(page, 'attribute:c1', 'attribute:o2');
  await expect(page.getByLabel('Connection attribute at Customer')).toHaveValue('attribute:c1');
  await expect(page.getByLabel('Connection attribute at Order')).toHaveValue('attribute:o2');
  await page.getByLabel('Relationship name').fill('places');
  const before = await json(page);
  await page.getByLabel('Cardinality at Order').selectOption('M');
  await page.getByLabel('Connection attribute at Order').selectOption('attribute:o3');
  await anchored(page, 'attribute:c1', 'attribute:o3');
  const after = await json(page);
  expect(after.legs.map((l) => l.id)).toEqual(before.legs.map((l) => l.id));
  expect(after.legs.find((l) => l.toId === 'o')).toMatchObject({ columnId: 'attribute:o3', cardinality: 'M' });
  await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await anchored(page, 'attribute:c1', 'attribute:o2');
  await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Cardinality at Order')).toHaveValue('N');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await row(page, 'o', 'attribute:o2').click(); await inspectSelection(page);
  await page.getByLabel('Attribute name').fill('customer_reference');
  await anchored(page, 'attribute:c1', 'attribute:o2');
  expect((await exported(page, 'SQL')).toString()).toContain('FOREIGN KEY ("customer_reference") REFERENCES "customer" ("customer_id")');
});

test('dragging between rows creates one relationship and lines follow a moved table', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Connect tool' }).click();
  await row(page, 'c', 'attribute:c1').dragTo(row(page, 'o', 'attribute:o2'));
  await expect(links(page)).toHaveCount(1);
  await expect(page.getByLabel('Relationship name')).toBeFocused();
  await anchored(page, 'attribute:c1', 'attribute:o2');
  const old = await links(page).locator('.crow-link__path').getAttribute('d');
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.getByRole('button', { name: 'Select tool', exact: true }).click();
  const header = page.getByRole('button', { name: 'Table Order', exact: true });
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 + 100, { steps: 12 }); await page.mouse.up();
  await expect(links(page).locator('.crow-link__path')).not.toHaveAttribute('d', old!);
  await anchored(page, 'attribute:c1', 'attribute:o2');
});

test('keyboard connection, cancellation, generated columns, and JSON/share restoration work', async ({ page, browser }) => {
  const doc = fields(); doc.attributes = doc.attributes.filter((a) => a.ownerId !== 'c');
  await open(page, doc); await page.getByTestId('canvas').focus(); await page.keyboard.press('c');
  await row(page, 'c', 'key:c').focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cancel connection' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Cancel connection' })).toHaveCount(0);
  await expect(links(page)).toHaveCount(0);
  await row(page, 'c', 'key:c').focus(); await page.keyboard.press('Space');
  await row(page, 'o', 'attribute:o2').focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('Relationship name')).toBeFocused();
  await anchored(page, 'key:c', 'attribute:o2');
  await documentAction(page, 'Share');
  const link = await page.getByLabel('Share link').inputValue();
  expect(parseShareHash(new URL(link).hash).doc?.legs.map((l) => l.columnId)).toEqual(['key:c', 'attribute:o2']);
  const offline = await browser.newContext();
  await offline.addInitScript(() => { (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = []; });
  const restored = await offline.newPage(); await restored.goto(link);
  await anchored(restored, 'key:c', 'attribute:o2');
  await offline.close();
});

test('deletion reports an unavailable endpoint; Undo and reload restore it without losing the relationship', async ({ page }) => {
  await open(page); await connect(page);
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await row(page, 'o', 'attribute:o2').click(); await inspectSelection(page);
  await expect(page.getByLabel('Attribute name')).toHaveValue('buyer_ref');
  await properties(page).getByRole('button', { name: 'Delete attribute', exact: true }).click();
  await expect(links(page)).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('button', { name: 'Check diagram' }).click();
  await expect(page.getByRole('button').filter({ hasText: 'uses an unavailable attribute' })).toBeVisible();
  await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await anchored(page, 'attribute:c1', 'attribute:o2');
  const previous = await json(page); await page.reload();
  await expect(page.getByTestId('table-Order')).toBeVisible();
  await anchored(page, 'attribute:c1', 'attribute:o2');
  expect((await json(page)).legs).toEqual(previous.legs);
});

test('SVG/PNG/SQL exports keep chosen endpoints and omit connection editing overlays', async ({ page }) => {
  await open(page); await connect(page); await page.getByLabel('Relationship name').fill('places');
  await page.getByRole('button', { name: 'Connect tool' }).click(); await row(page, 'c', 'attribute:c1').click();
  await page.mouse.move(700, 300);
  const svg = (await exported(page, 'SVG')).toString();
  expect(svg).toContain('data-from-column="attribute:c1"'); expect(svg).toContain('data-to-column="attribute:o2"');
  for (const overlay of ['connect-preview', 'connection-ports', 'crow-row--connecting', 'crow-row__hit', 'crow-link__hit', 'selection-ring']) expect(svg).not.toContain(overlay);
  const png = await exported(page, 'PNG'); expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const sql = (await exported(page, 'SQL')).toString();
  expect(sql).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("customer_id")');
  expect(sql.match(/"customer_id" INTEGER/g)).toHaveLength(1);
});

test('identifying relationships keep the chosen weak-entity field as an editable PK/FK', async ({ page }) => {
  const doc = fields(); doc.entities[1]!.kind = 'weak';
  await open(page, doc); await connect(page);
  await properties(page).getByRole('button', { name: 'Identifying', exact: true }).click();
  await anchored(page, 'attribute:c1', 'attribute:o2');
  await expect(row(page, 'o', 'attribute:o2')).toHaveAccessibleName('Edit attribute buyer_ref');
  await expect(row(page, 'o', 'attribute:o2')).toContainText('PK/FK');
  const sql = (await exported(page, 'SQL')).toString();
  expect(sql).toContain('PRIMARY KEY ("buyer_ref", "order_id")');
  expect(sql).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("customer_id")');
});

test('collaborators share endpoints while retaining personal views and remote work during Undo', async ({ page: alice, browser }) => {
  await open(alice); await connect(alice); await alice.getByLabel('Relationship name').fill('places');
  await documentAction(alice, 'Share');
  const link = await alice.getByLabel('Share link').inputValue();
  await alice.getByRole('button', { name: 'Done', exact: true }).click();
  const other = await browser.newContext();
  await other.addInitScript(() => { (window as unknown as { __ERD_SIGNALING__: string[] }).__ERD_SIGNALING__ = ['ws://127.0.0.1:4444']; });
  const bob = await other.newPage(); await bob.goto(link); await expect(bob.getByTestId('table-Order')).toBeVisible();
  await expect(alice.locator('.collaboration-status')).toContainText('Editing with', { timeout: 25_000 });
  await bob.getByRole('button', { name: 'Chen', exact: true }).click();
  await expect(alice.getByRole('button', { name: "Crow's-foot", exact: true })).toHaveAttribute('aria-pressed', 'true');
  await alice.getByLabel('Connection attribute at Order').selectOption('attribute:o3');
  await expect.poll(async () => (await json(bob)).legs.find((l) => l.toId === 'o')?.columnId).toBe('attribute:o3');
  await bob.getByRole('button', { name: 'Crow\'s-foot', exact: true }).click();
  await row(bob, 'c', 'attribute:c2').click(); await inspectSelection(bob);
  await bob.getByLabel('Attribute name').fill('contact_email');
  await expect(row(alice, 'c', 'attribute:c2')).toHaveAccessibleName('Edit attribute contact_email');
  await alice.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
  await anchored(alice, 'attribute:c1', 'attribute:o2');
  await expect(row(alice, 'c', 'attribute:c2')).toHaveAccessibleName('Edit attribute contact_email');
  await anchored(bob, 'attribute:c1', 'attribute:o2');
  await other.close();
});

test.describe('phone attribute connections', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('taps row endpoints, changes a binding in a sheet, deletes/undoes and shares', async ({ page }) => {
    const doc = fields(); doc.entities[1]!.x = 80; doc.entities[1]!.y = 280;
    await open(page, doc);
    await page.getByRole('button', { name: 'Connect tool' }).tap();
    await row(page, 'c', 'attribute:c1').tap(); await row(page, 'o', 'attribute:o2').tap();
    await expect(page.getByLabel('Relationship name')).toBeFocused();
    await page.getByLabel('Relationship name').fill('places');
    await page.getByLabel('Connection attribute at Order').selectOption('attribute:o3');
    await page.getByLabel('Cardinality at Order').selectOption('M');
    await properties(page).getByRole('button', { name: 'Delete relationship', exact: true }).tap();
    await expect(links(page)).toHaveCount(0);
    await page.locator('.feedback').getByRole('button', { name: 'Undo', exact: true }).tap();
    await anchored(page, 'attribute:c1', 'attribute:o3');
    await documentAction(page, 'Share');
    expect(parseShareHash(new URL(await page.getByLabel('Share link').inputValue()).hash).doc?.legs.some((l) => l.columnId === 'attribute:o3')).toBe(true);
    await page.getByRole('button', { name: 'Done', exact: true }).tap();
    expect((await json(page)).legs.find((l) => l.toId === 'o')).toMatchObject({ cardinality: 'M', columnId: 'attribute:o3' });
    expect((await exported(page, 'PNG')).byteLength).toBeGreaterThan(500);
  });
});

for (const width of [320, 390, 768, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`connected fields remain usable at ${width}px in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const doc = fields();
      doc.entities[0]!.name = 'Customer accounts with long names';
      doc.attributes[1]!.name = 'preferred_contact_email_address';
      doc.relationships = [{ id: 'r', name: 'places orders through a registered account', x: 400, y: 80, kind: 'strong' }];
      doc.legs = [{ id: 'l1', fromId: 'r', toId: 'c', columnId: 'attribute:c1', cardinality: '1', participation: { min: 1, max: 1 } },
        { id: 'l2', fromId: 'r', toId: 'o', columnId: 'attribute:o2', cardinality: 'N', participation: { min: 0, max: 'N' } }];
      await open(page, doc); await anchored(page, 'attribute:c1', 'attribute:o2');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Connect tool' }).click();
      await row(page, 'c', 'attribute:c1').focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Chen', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => {
        const app = document.querySelector('.app')!;
        const stage = document.querySelector('.canvas-stage')!;
        return [scrollX, app.scrollLeft, stage.scrollLeft];
      })).toEqual([0, 0, 0]);
      const tools = await page.getByRole('toolbar').locator('button').evaluateAll((buttons) => buttons.filter((button) => button.getClientRects().length > 0).map((button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x, right: rect.right, width: rect.width, height: rect.height, textFits: button.scrollWidth <= button.clientWidth + 2 };
      }));
      expect(tools.every((button) => button.x >= 0 && button.right <= width && button.width >= 44 && button.height >= 44 && button.textFits)).toBe(true);
      await page.screenshot({ path: `test-results/shots/column-connect-${width}-${theme}.png` });
      await page.getByRole('button', { name: 'Cancel connection' }).click();
      expect((await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    });
  }
}
