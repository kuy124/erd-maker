import { expect, test, type Page } from '@playwright/test';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { documentAction, importDocument, inspectSelection, shape, signalingContext } from './actions';

/**
 * Crow's-foot tables.
 *
 * Two behaviours here are about other people rather than about pixels: where a
 * table sits is a local reading of the schema, while what is on it is shared
 * content. Getting that backwards either syncs noise or breaks collaboration.
 *
 * Everything is measured in SVG user units, not screen pixels. Each browser has
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

test.describe('crow tables', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a table moved here does not move for anyone else, and attributes still sync', async ({ browser }) => {
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

      await dragTable(alice, 'Customer', 300, 0);

      // The table moved here...
      expect(await tableX(alice, 'Customer')).toBeGreaterThan(bobBefore + 250);
      // ...and not in the other browser. Position is a local reading of the
      // schema; syncing it would slide the diagram out from under a reader.
      await bob.waitForTimeout(1500);
      expect(await tableX(bob, 'Customer')).toBe(bobBefore);

      // Content still syncs: the whole point of not syncing position.
      await alice.locator('[data-column-id="attribute:note"]').click();
      await inspectSelection(alice);
      await alice.getByLabel('Attribute name').fill('billing_memo');
      // The row is identified by the attribute's id, so the visible proof is
      // the name it now renders.
      await expect(bob.locator('[data-column-id="attribute:note"]')).toHaveAccessibleName('Edit attribute billing_memo');
      // And the position this browser chose survived the remote edit.
      expect(await tableX(bob, 'Customer')).toBe(bobBefore);
    } finally {
      await owner.close();
      await other.close();
    }
  });

  test('a table position survives a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, schema());
    await expect(table(page, 'Customer')).toBeVisible();
    await dragTable(page, 'Customer', 260, 0);
    const moved = await tableX(page, 'Customer');
    expect(moved).not.toBe(120);

    await page.reload();
    await expect(table(page, 'Customer')).toBeVisible();
    // Stored positions are whole pixels, so the drag's fractional end lands on
    // the same pixel it did before the reload.
    expect(await tableX(page, 'Customer')).toBe(Math.round(moved));
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

  test('the Chen view is unaffected by the table layout', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await importDocument(page, schema());
    await expect(table(page, 'Customer')).toBeVisible();
    await dragTable(page, 'Customer', 300, 0);

    await page.getByRole('button', { name: 'Chen', exact: true }).click();
    // Chen draws entities as diamonds at their shared positions, which the
    // table drag never touched.
    await expect(shape(page, 'Entity Customer')).toBeVisible();
    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    await expect(table(page, 'Customer')).toBeVisible();
    // The attribute stayed attached to its owner across the notation change.
    await page.locator('[data-column-id="attribute:note"]').click();
    await inspectSelection(page);
    await expect(page.getByLabel('Attribute name')).toHaveValue('billing_note');
  });
});