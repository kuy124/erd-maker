import { expect, test, type Page } from '@playwright/test';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { documentAction, importDocument, inspectSelection, readDownload, shape, signalingContext } from './actions';

/**
 * Crow's-foot tables.
 *
 * Two rules, both easy to state and easy to break by accident:
 *
 *   1. Placement syncs. Two people in one room are looking at the same tables,
 *      so a table moved here moves for everybody.
 *   2. Placement is separate from Chen. It is stored in its own fields, so
 *      tidying one notation never rearranges the other, and Chen's arrangement
 *      never becomes Crow's-foot's.
 *
 * Everything is measured in SVG user units, not screen pixels: each browser has
 * its own zoom and pan, so a screen coordinate compares nothing.
 */

function schema(): ErdDocument {
  const doc = emptyDocument('Billing');
  doc.view = 'crowfoot';
  doc.entities = [
    { id: 'c', name: 'Customer', kind: 'strong', x: 120, y: 120 },
    { id: 'i', name: 'Invoice', kind: 'strong', x: 760, y: 120 },
  ];
  doc.attributes = [
    { id: 'id', name: 'customer_id', kind: 'key', ownerId: 'c', x: 0, y: 0 },
    { id: 'note', name: 'billing_note', kind: 'simple', ownerId: 'c', x: 0, y: 0 },
  ];
  return doc;
}

const table = (page: Page, name: string) => page.getByTestId('table-' + name);

/** The table's x in diagram coordinates, read from the transform it renders at. */
async function tableX(page: Page, name: string): Promise<number> {
  const transform = await table(page, name).getAttribute('transform');
  return Number(/translate\(([-\d.]+)/.exec(transform ?? '')?.[1] ?? NaN);
}

/** The rendered width of a table in diagram coordinates. */
async function tableWidth(page: Page, name: string): Promise<number> {
  return Number(await table(page, name).locator('.node__body').getAttribute('width'));
}

/** The same, for a Chen shape, read from the transform it renders at. */
async function nodeX(page: Page, name: string): Promise<number> {
  const transform = await shape(page, name).getAttribute('transform');
  return Number(/translate\(([-\d.]+)/.exec(transform ?? '')?.[1] ?? NaN);
}

/** Presses a table header and drags it, the only way a table is moved. */
async function dragTable(page: Page, name: string, dx: number, dy: number) {
  const box = (await table(page, name).locator('.crow-row__hit').first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

/** Switches to Chen and back, so a view change is exercised. */
async function switchNotation(page: Page) {
  await page.getByRole('button', { name: 'Chen', exact: true }).click();
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
}

test.describe('crow tables', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a table moved here moves for everybody, and content syncs', async ({ browser }) => {
    const owner = await signalingContext(browser);
    const other = await signalingContext(browser);
    const alice = await owner.newPage();
    const bob = await other.newPage();
    try {
      await alice.goto('/');
      await expect(alice.getByLabel('Diagram name')).toBeEnabled();
      await importDocument(alice, schema());
      await expect(table(alice, 'Customer')).toBeVisible();

      await documentAction(alice, 'Share');
      const link = await alice.getByLabel('Share link').inputValue();
      expect(link).toContain('#room=');
      await alice.getByRole('button', { name: 'Done', exact: true }).click();

      await bob.goto(link);
      // The room arrives in whatever notation Bob already uses, so the shapes
      // show up as Chen entities until he asks for tables — notation is each
      // person's own choice, and a short link does not override it.
      await expect(shape(bob, 'Entity Customer')).toBeVisible({ timeout: 30_000 });
      await bob.getByRole('button', { name: "Crow's-foot", exact: true }).click();
      await expect(table(bob, 'Customer')).toBeVisible();
      const bobBefore = await tableX(bob, 'Customer');
      const aliceBefore = await tableX(alice, 'Customer');

      await dragTable(alice, 'Customer', 300, 0);

      // The table moved here...
      expect(await tableX(alice, 'Customer')).toBeGreaterThan(aliceBefore + 200);
      // ...and in the other browser, because both people are looking at the same
      // tables. This is the rule that is easy to get backwards: keeping the
      // arrangement private was what made the room read as out of sync.
      await expect.poll(async () => tableX(bob, 'Customer'), { timeout: 30_000 })
        .toBeGreaterThan(bobBefore + 200);
      expect(await tableX(bob, 'Customer')).toBe(await tableX(alice, 'Customer'));

      // Content keeps syncing too.
      await alice.locator('[data-column-id="attribute:note"]').click();
      await inspectSelection(alice);
      await alice.getByLabel('Attribute name').fill('billing_memo');
      await expect(bob.locator('[data-column-id="attribute:note"]'))
        .toHaveAccessibleName('Edit attribute billing_memo');
    } finally {
      await owner.close();
      await other.close();
    }
  });

  test('a table and its entity sit at different places, and both are shared', async ({ browser }) => {
    const owner = await signalingContext(browser);
    const other = await signalingContext(browser);
    const alice = await owner.newPage();
    const bob = await other.newPage();
    try {
      await alice.goto('/');
      await expect(alice.getByLabel('Diagram name')).toBeEnabled();
      await importDocument(alice, schema());
      await documentAction(alice, 'Share');
      const link = await alice.getByLabel('Share link').inputValue();
      await alice.getByRole('button', { name: 'Done', exact: true }).click();

      await bob.goto(link);
      await bob.getByRole('button', { name: "Crow's-foot", exact: true }).click();
      await expect(table(bob, 'Customer')).toBeVisible();

      // Alice arranges the table.
      await dragTable(alice, 'Customer', 240, 0);
      const crowX = await tableX(alice, 'Customer');

      // Then arranges the very same entity, in Chen, somewhere else entirely.
      await alice.getByRole('button', { name: 'Chen', exact: true }).click();
      await expect(shape(alice, 'Entity Customer')).toBeVisible();
      const entityBox = (await shape(alice, 'Entity Customer').boundingBox())!;
      await alice.mouse.move(entityBox.x + entityBox.width / 2, entityBox.y + entityBox.height / 2);
      await alice.mouse.down();
      await alice.mouse.move(entityBox.x + entityBox.width / 2 - 120, entityBox.y + 200, { steps: 8 });
      await alice.mouse.up();

      // Two different numbers for one entity, and Bob has both.
      await bob.getByRole('button', { name: "Crow's-foot", exact: true }).click();
      await expect(table(bob, 'Customer')).toBeVisible();
      await expect.poll(async () => tableX(bob, 'Customer'), { timeout: 30_000 }).toBe(crowX);

      await bob.getByRole('button', { name: 'Chen', exact: true }).click();
      await expect(shape(bob, 'Entity Customer')).toBeVisible();
      // World coordinates, not screen ones: each browser frames the drawing its
      // own way, so a bounding box compares nothing across two of them.
      await expect.poll(async () => nodeX(bob, 'Entity Customer'), { timeout: 30_000 })
        .toBe(await nodeX(alice, 'Entity Customer'));
    } finally {
      await owner.close();
      await other.close();
    }
  });

  test('arranging Chen does not move the tables, and moving a table does not move Chen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, schema());
    await expect(table(page, 'Customer')).toBeVisible();

    // Crow's-foot placed these itself rather than inheriting the entity's Chen
    // coordinates, which is the carry-over this test exists to catch.
    const arranged = await tableX(page, 'Customer');

    await dragTable(page, 'Customer', 280, 0);
    const dragged = await tableX(page, 'Customer');
    expect(dragged).not.toBe(arranged);

    await page.getByRole('button', { name: 'Chen', exact: true }).click();
    await expect(shape(page, 'Entity Customer')).toBeVisible();
    // Arrange Chen deliberately: dragging there must not reach the tables.
    const entityBox = (await shape(page, 'Entity Customer').boundingBox())!;
    await page.mouse.move(entityBox.x + entityBox.width / 2, entityBox.y + entityBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(entityBox.x + entityBox.width / 2 + 160, entityBox.y + 40, { steps: 6 });
    await page.mouse.up();

    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    await expect(table(page, 'Customer')).toBeVisible();
    expect(await tableX(page, 'Customer')).toBe(dragged);
  });

  test('a table position survives a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, schema());
    await expect(table(page, 'Customer')).toBeVisible();
    await dragTable(page, 'Customer', 260, 0);
    const moved = await tableX(page, 'Customer');

    await page.reload();
    await expect(table(page, 'Customer')).toBeVisible();
    // Shared placement is in the document, so it survives a reload exactly.
    expect(await tableX(page, 'Customer')).toBe(moved);
  });

  test('long names are drawn in full inside a table that grew to hold them', async ({ page }) => {
    const doc = schema();
    const longAttribute = 'subscription_status_history_reference';
    const longEntity = 'Subscription_agreement_template';
    doc.attributes.push({ id: 'long', name: longAttribute, kind: 'simple', ownerId: 'c', x: 0, y: 0 });
    doc.entities.push({ id: 'l', name: longEntity, kind: 'strong', x: 1400, y: 520 });
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, doc);
    await expect(table(page, 'Customer')).toBeVisible();

    // The full text, with nothing cut off.
    await expect(table(page, 'Customer').locator('.crow-row__name', { hasText: longAttribute })).toHaveText(longAttribute);
    await expect(table(page, longEntity).locator('.crow-table__name')).toHaveText(longEntity);
    for (const text of await page.locator('.crow-row__name, .crow-table__name').allTextContents()) {
      expect(text).not.toContain('…');
    }

    // The table is wider than the old fixed 280 for this name...
    expect(await tableWidth(page, 'Customer')).toBeGreaterThan(280);
    // ...and the text still ends inside its own border, in diagram units.
    const inside = await table(page, longEntity).evaluate((group) => {
      const bbox = (selector: string) =>
        (group.querySelector(selector) as SVGGraphicsElement).getBBox();
      const text = bbox('.crow-table__name');
      const body = bbox('.node__body');
      return text.x + text.width <= body.x + body.width;
    });
    expect(inside).toBe(true);

    // A short table keeps the old width, so nothing grew needlessly.
    await expect(table(page, 'Invoice')).toBeVisible();
    expect(await tableWidth(page, 'Invoice')).toBe(280);
  });

  test('switching notation does not lose the attribute or its row', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, schema());
    await expect(table(page, 'Customer')).toBeVisible();

    await switchNotation(page);
    await expect(table(page, 'Customer')).toBeVisible();
    await expect(table(page, 'Customer').locator('.crow-row__name', { hasText: 'billing_note' })).toBeVisible();

    await page.locator('[data-column-id="attribute:note"]').click();
    await inspectSelection(page);
    await expect(page.getByLabel('Attribute name')).toHaveValue('billing_note');
  });

  test('a connector shows only cardinality, never the relationship name', async ({ page }) => {
    const doc = schema();
    doc.relationships = [{ id: 'r', name: 'having', kind: 'strong', x: 440, y: 120 }];
    doc.attributes.push({ id: 'inv_id', name: 'invoice_id', kind: 'key', ownerId: 'i', x: 0, y: 0 });
    doc.legs = [
      { id: 'l1', fromId: 'r', toId: 'c', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'l2', fromId: 'r', toId: 'i', cardinality: 'N', participation: { min: 0, max: 'N' } },
    ];
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, doc);
    await expect(page.getByTestId('crow-link-r')).toBeVisible();

    const link = page.getByTestId('crow-link-r');
    // The cardinality on each end is drawn...
    await expect(link.locator('.crow-link__ratio')).toHaveText(['1', 'N']);
    // ...and the verb label is not: on screen or in the exported drawing.
    await expect(link.locator('.crow-link__label')).toHaveCount(0);
    await expect(page.locator('.layer-links .crow-link__label')).toHaveCount(0);

    const download = page.waitForEvent('download');
    await documentAction(page, 'Export');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const svg = await readDownload(await download);
    await page.keyboard.press('Escape');
    // The name is not drawn anywhere in the export. It may still appear as an
    // accessible name on the connector, which is deliberate; what must be gone
    // is the visible text.
    expect(svg).not.toMatch(/>[^<>]*having[^<>]*</);
    expect(svg).toContain('Customer');
    expect(svg).toContain('N');
  });
});