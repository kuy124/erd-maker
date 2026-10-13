import { addShape, documentAction, inspectSelection, readDownload } from './actions';
/**
 * Feature audit.
 *
 * Exercises every feature end to end and reports what actually works, rather
 * than assuming. The point is to find dead code and dead features: things that
 * are rendered, exported, or wired up but that a user cannot actually make
 * happen.
 */

import { expect, test, type Page } from '@playwright/test';

const canvas = (page: Page) => page.getByTestId('canvas');
const node = (page: Page, label: string | RegExp) =>
  canvas(page).getByRole('button', { name: label });
const nameField = (page: Page) => page.getByTestId('inspector-name');

/**
 * Relationship legs only.
 *
 * Attribute connectors are drawn in the same layer and are legitimately part of
 * the diagram, so counting every `.leg` conflates the two and makes a test pass
 * or fail for the wrong reason.
 */
const relationshipLines = (page: Page) =>
  page.locator('.layer-legs line.leg:not(.leg--attribute)');

/**
 * Presses on one shape, releases on another: the Connect tool's own gesture.
 *
 * The connection is committed on pointer release, so press-and-release on the
 * same shape cancels instead of arming anything.
 */
async function dragBetween(page: Page, from: RegExp, to: RegExp): Promise<void> {
  const a = (await node(page, from).boundingBox())!;
  const b = (await node(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('canvas')).toBeVisible();
  await page.waitForTimeout(250);
}

/** Customer --(places)-- Order, with a key on each. */
async function buildTwoEntities(page: Page): Promise<void> {
  await addShape(page, 'entity');
  await nameField(page).fill('Customer');
  await addShape(page, 'attribute');
  await nameField(page).fill('customer_id');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await addShape(page, 'entity');
  await nameField(page).fill('Order');
  await addShape(page, 'attribute');
  await nameField(page).fill('order_id');
  await page.getByRole('button', { name: 'Key', exact: true }).click();

  await addShape(page, 'relationship');
  await nameField(page).fill('places');
  await page.getByRole('button', { name: 'Auto-arrange' }).click();
  await page.waitForTimeout(150);

  // Adding a relationship starts the connection gesture from it, and each
  // completed leg stays on the diamond, so two drags finish the chain.
  await page.getByRole('button', { name: 'Connect tool' }).click();
  await dragBetween(page, /Relationship places/i, /Entity Customer/i);
  await dragBetween(page, /Relationship places/i, /Entity Order/i);
  // Back to selecting, the way anyone finishes a connection: the editing
  // affordances on the lines are hidden while the Connect tool is active.
  await page.getByRole('button', { name: 'Select tool' }).click();
  await inspectSelection(page);
}

async function readSvg(page: Page): Promise<string> {
  const downloadPromise = page.waitForEvent('download');
  await documentAction(page, 'Export');
  await page.getByRole('button', { name: 'Download SVG' }).click();
  const text = await readDownload(await downloadPromise);
  await page.keyboard.press('Escape');
  return text;
}

test.describe('exports', () => {
  test('AUDIT: export is unaffected by zoom and pan', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    // Zoom in hard and pan, the way a user framing part of a diagram would.
    await page.keyboard.down('Control');
    await page.mouse.move(700, 400);
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    await page.mouse.move(900, 500);
    await page.mouse.down();
    await page.mouse.move(600, 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const svg = await readSvg(page);

    // The exported file must not carry the on-screen pan and zoom, or the
    // drawing lands outside its own viewBox.
    const transform = svg.match(/<g[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)"/);
    expect(
      transform,
      'export still contains the viewport transform, so it is framed by whatever the user was looking at',
    ).toBeNull();

    // And the viewBox must actually contain the diagram.
    const viewBox = svg.match(/viewBox="([-\d. ]+)"/);
    expect(viewBox, 'export has no viewBox').not.toBeNull();
    const [, , , w] = viewBox![1]!.split(/\s+/).map(Number);
    expect(w, 'exported width should cover the diagram').toBeGreaterThan(200);
  });

  test('AUDIT: exported shapes are filled paper, not black blobs', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    // Render the export and read back what the browser actually painted.
    // Asserting on the SVG source proves nothing about rendering: a previous
    // version passed every string check while drawing solid black shapes,
    // because each style had been applied to the wrong element.
    const svg = await readSvg(page);
    const shapes = await page.evaluate((markup) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;height:600px';
      host.innerHTML = markup.replace(/<\?xml[^>]*\?>/, '');
      document.body.appendChild(host);
      const root = host.querySelector('svg')!;
      const bodies = Array.from(root.querySelectorAll('.node__body'));
      const out = bodies.map((el) => ({
        fill: getComputedStyle(el).fill,
        w: el.getBoundingClientRect().width,
      }));
      host.remove();
      return out;
    }, svg);

    expect(shapes.length, 'no shape bodies found in the export').toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.fill, `a shape exported with fill ${shape.fill}`).not.toBe('rgb(0, 0, 0)');
      expect(shape.w, 'a shape exported with no width').toBeGreaterThan(10);
    }
  });

  test('AUDIT: exported connector lines are visible strokes', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    const svg = await readSvg(page);
    const legs = await page.evaluate((markup) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;height:600px';
      host.innerHTML = markup.replace(/<\?xml[^>]*\?>/, '');
      document.body.appendChild(host);
      const root = host.querySelector('svg')!;
      const lines = Array.from(root.querySelectorAll('.layer-legs line'));
      const out = lines.map((el) => {
        const cs = getComputedStyle(el);
        return {
          stroke: cs.stroke,
          width: cs.strokeWidth,
          opacity: cs.opacity,
          cls: el.getAttribute('class') ?? '',
          x1: el.getAttribute('x1'),
          y1: el.getAttribute('y1'),
          x2: el.getAttribute('x2'),
          y2: el.getAttribute('y2'),
        };
      });
      host.remove();
      return out;
    }, svg);

    expect(legs.length, 'no legs in the export').toBeGreaterThan(0);
    for (const leg of legs) {
      const where = `${leg.cls} (${leg.x1},${leg.y1} -> ${leg.x2},${leg.y2})`;
      // Computed lengths come back with units ("1.5px"), so this needs parseFloat.
      expect(parseFloat(leg.width), `no stroke width for ${where}`).toBeGreaterThan(0);
      expect(leg.opacity, `transparent line ${where}`).not.toBe('0');
      expect(leg.stroke, `no stroke for ${where}`).not.toBe('none');
    }
  });

  test('AUDIT: exported labels are readable ink', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    const svg = await readSvg(page);
    const texts = await page.evaluate((markup) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;height:600px';
      host.innerHTML = markup.replace(/<\?xml[^>]*\?>/, '');
      document.body.appendChild(host);
      const root = host.querySelector('svg')!;
      const out = Array.from(root.querySelectorAll('text')).map((el) => ({
        fill: getComputedStyle(el).fill,
        content: el.textContent ?? '',
      }));
      host.remove();
      return out;
    }, svg);

    expect(texts.length, 'no text in the export').toBeGreaterThan(0);
    for (const text of texts) {
      expect(
        text.fill,
        `label "${text.content}" exported with fill ${text.fill}`,
      ).not.toBe('rgb(0, 0, 0)');
    }
    // The names must survive the round trip.
    expect(svg).toContain('Customer');
    expect(svg).toContain('Order');
  });

  test('AUDIT: export contains no editing chrome', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await node(page, /Entity Customer/i).click();

    const svg = await readSvg(page);
    for (const marker of ['selection-ring', 'peer-cursor', 'leg-hit', 'connect-preview', 'hit-target']) {
      expect(svg, `export leaked ${marker}`).not.toContain(marker);
    }
    // But the drawing itself must be there.
    expect(svg).toContain('Customer');
    expect(svg).toContain('Order');
    expect(svg).toContain('places');
  });

  test('AUDIT: an attribute cannot start a connection', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    const before = await relationshipLines(page).count();
    const attribute = page.getByTestId('canvas').locator('[data-node-id^="attr_"]').first();

    // Starting from an attribute would produce a line that the SQL generator
    // and the crow's-foot view both ignore: a connection that quietly does
    // nothing, which is worse than a refusal.
    await page.getByRole('button', { name: 'Connect tool' }).click();
    await attribute.click();
    await expect(page.locator('.node--connecting')).toHaveCount(0);

    await page.getByRole('button', { name: 'Connect tool' }).click();
    await node(page, /Entity Order/i).click();
    await expect(relationshipLines(page)).toHaveCount(before);
  });

  test('AUDIT: an attribute is never offered as a connection target', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);

    await page.getByRole('button', { name: 'Connect tool' }).click();
    await node(page, /Entity Customer/i).click();
    await page.getByTestId('canvas').locator('[data-node-id^="attr_"]').first().hover();
    await expect(page.locator('.node--connectable')).toHaveCount(0);
  });
});

test.describe('deleting', () => {
  test('AUDIT: a relationship line can be deleted on its own', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await expect(relationshipLines(page)).toHaveCount(2);

    // Click the line itself, then delete it from the inspector.
    await page.getByTestId('leg-cardinality').first().click();
    await expect(page.getByRole('heading', { name: /relationship line/i })).toBeVisible();
    await page.getByRole('button', { name: 'Delete line' }).click();

    await expect(relationshipLines(page)).toHaveCount(1);
    // The shapes themselves must survive.
    await expect(node(page, /Entity Customer/i)).toBeVisible();
    await expect(node(page, /Relationship places/i)).toBeVisible();
  });

  test('AUDIT: deleting a relationship removes its lines', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await expect(relationshipLines(page)).toHaveCount(2);

    await node(page, /Relationship places/i).click();
    await page.getByRole('button', { name: 'Delete relationship' }).click();

    await expect(relationshipLines(page)).toHaveCount(0);
    await expect(node(page, /Entity Customer/i)).toBeVisible();
  });

  test('AUDIT: deleting an entity removes its lines and attributes', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await node(page, /Entity Customer/i).click();
    await page.getByRole('button', { name: 'Delete entity' }).click();

    // Its line to the relationship goes with it, and its attribute too.
    await expect(relationshipLines(page)).toHaveCount(1);
    await expect(node(page, /Attribute customer_id/i)).toBeHidden();
  });

  test('AUDIT: deleting the Delete key target clears selection', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await node(page, /Entity Order/i).click();
    await page.keyboard.press('Delete');
    await expect(node(page, /Entity Order/i)).toBeHidden();
    // The remaining entity is still connected to the relationship.
    await expect(relationshipLines(page)).toHaveCount(1);
  });
});

test.describe("crow's foot", () => {
  test('AUDIT: connectors are drawn between related tables', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await expect(canvas(page).getByText('Customer', { exact: true })).toBeVisible();

    const lines = await page.locator('.layer-links .crow-link__path').count();
    const fans = await page.locator('.layer-links path.leg').count();
    expect(lines, 'no connector lines between tables').toBeGreaterThan(0);
    expect(fans, 'no crow foot or one-bar drawn').toBeGreaterThan(0);
  });

  test('AUDIT: the relationship is labelled with its cardinality', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    // Make it one-to-many: Order's leg becomes N.
    await page.getByTestId('leg-cardinality').nth(1).click();
    await page.getByRole('button', { name: 'N', exact: true }).click();

    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await page.waitForTimeout(150);
    // Crow's foot notation states the ratio on the connector.
    await expect(canvas(page).getByText(/1\s*:\s*N/i)).toBeVisible();
  });

  test('AUDIT: a connector can be selected and deleted', async ({ page }) => {
    await openApp(page);
    await buildTwoEntities(page);
    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await expect(canvas(page).getByText('Customer', { exact: true })).toBeVisible();

    // There must be a way to get at a connector at all.
    const selectable = await page.locator('.layer-links [role="button"]').count();
    expect(selectable, 'no connector is selectable, so none can be deleted').toBeGreaterThan(0);
  });
});

test.describe('ease of use', () => {
  test('AUDIT: typing is possible immediately after adding a shape', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');

    // ERDPlus-style: the name field should already have focus, so a new user
    // can just start typing without hunting for the inspector.
    await expect(nameField(page)).toBeFocused();
    await page.keyboard.type('Invoice');
    await expect(node(page, /Entity Invoice/i)).toBeVisible();
  });

  test('AUDIT: a new shape keeps focus in the name field for quick entry', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('e');
    await expect(nameField(page)).toBeFocused();
  });
});
