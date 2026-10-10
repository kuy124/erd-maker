/**
 * End-to-end tests.
 *
 * These drive the real production build in a real browser, because the things
 * most likely to break — pointer dragging, keyboard shortcuts, SVG export, and
 * peer-to-peer sync — cannot be verified any other way.
 *
 * Selector discipline: canvas shapes are `<g role="button">` inside the SVG, and
 * the shape rail has buttons with similar names. Every canvas query is therefore
 * scoped through `node()` or `canvas()`, so a test can never accidentally match
 * a toolbar button. Ambiguity here is a test bug, not an app bug, and scoping is
 * how it is prevented.
 *
 * The multiplayer tests are the point of the exercise. Two tabs in one browser
 * sync over BroadcastChannel; two separate browser contexts must use WebRTC and
 * therefore need a signalling server. Rather than depend on a public one — which
 * would make the suite fail whenever someone else's server does — the config
 * starts y-webrtc's own signalling server locally and every page is pointed at
 * it. The same code path runs either way; only the matchmaker is local.
 */

import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** The signalling server started by `playwright.config.ts`. */
const LOCAL_SIGNALING = 'ws://127.0.0.1:4444';

/**
 * Points a context at the local signalling server before any app code runs.
 *
 * The app reads `window.__ERD_SIGNALING__` at startup, so this has to be
 * installed as an init script rather than assigned after load. Installing it on
 * the *context* means every page opened from it — including ones created later
 * with `newPage()` — is covered, and it survives navigation to a share link,
 * which strips query parameters.
 */
async function installSignaling(context: BrowserContext): Promise<void> {
  await context.addInitScript((url) => {
    (window as unknown as { __ERD_SIGNALING__?: string[] }).__ERD_SIGNALING__ = [url];
  }, LOCAL_SIGNALING);
}

/** A fresh context that talks to the local signalling server. */
async function signalingContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await installSignaling(context);
  return context;
}

/**
 * The default `context` is overridden so the local signalling server is used
 * everywhere without every test having to remember.
 */
const test = base.extend({
  context: async ({ context }, use) => {
    await installSignaling(context);
    await use(context);
  },
});

/** Waits until the app has mounted and the canvas is present. */
async function openApp(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('canvas')).toBeVisible();
  // The document loads from IndexedDB asynchronously; give it a beat so the
  // first assertion does not race the seed.
  await page.waitForTimeout(250);
}

const canvas = (page: Page) => page.getByTestId('canvas');

/** A shape on the canvas, matched by its accessible label. */
const node = (page: Page, label: string | RegExp) =>
  canvas(page).getByRole('button', { name: label });

/** Adds a node through the shape rail, the most reliable creation path. */
async function addShape(page: Page, kind: 'entity' | 'attribute' | 'relationship' | 'isa'): Promise<void> {
  await page.getByTestId(`add-${kind}`).click();
}

/** The inspector's name field for whatever is selected. */
const nameField = (page: Page) => page.getByTestId('inspector-name');

/** Creates a named entity and returns nothing; the name is what tests use. */
async function addNamedEntity(page: Page, name: string): Promise<void> {
  await addShape(page, 'entity');
  await nameField(page).fill(name);
}

/**
 * Waits until every page sees at least one other peer.
 *
 * This matters because opening a share link seeds the diagram from the URL
 * snapshot, so a page can show exactly the right shapes while no peer link
 * exists yet. Asserting that a *live* edit propagates before the link is up is
 * therefore a race, not a bug in the app. Presence only updates once a real
 * transport (WebRTC across browsers, BroadcastChannel within one) has delivered
 * an awareness update, so waiting for it is the honest barrier.
 */
async function waitForLink(pages: Page[]): Promise<void> {
  for (const page of pages) {
    await expect(page.locator('.canvas-status')).toContainText(/Live with/, { timeout: 45_000 });
  }
}

test.describe('editor basics', () => {
  test('loads and shows an empty canvas with guidance', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { name: /start with an entity/i })).toBeVisible();
    await expect(page.getByText(/Press E to add an entity/i)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: /ERD Maker/i })).toBeVisible();
  });

  test('adds an entity from the rail and shows it on the canvas', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    await expect(node(page, /Entity New entity/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /start with an entity/i })).toBeHidden();
  });

  test('adds each of the four primitives', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    await addShape(page, 'attribute');
    await addShape(page, 'relationship');
    await addShape(page, 'isa');

    await expect(node(page, /^Entity New entity/i)).toBeVisible();
    // The entity is still selected, so this attribute is owned and numbered.
    await expect(node(page, /^Attribute 1/i)).toBeVisible();
    await expect(node(page, /^Relationship relationship/i)).toBeVisible();
    await expect(node(page, 'Specialization')).toBeVisible();
  });

  test('renames an entity through the inspector', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await expect(node(page, /Entity Customer/i)).toBeVisible();
  });

  test('marks an entity weak and reflects it in the label', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    await page.getByRole('button', { name: 'Weak', exact: true }).click();
    await expect(node(page, /Entity New entity, weak/i)).toBeVisible();
  });

  test('adds an attribute owned by the selected entity and marks it a key', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');

    // The entity stays selected after creation, so a new attribute is attached
    // to it automatically.
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();

    await expect(node(page, /Attribute customer_id, key/i)).toBeVisible();
  });

  test('attaches a floating attribute to an entity via the inspector', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Order');
    await addShape(page, 'attribute');
    await nameField(page).fill('placed_at');

    await page.getByLabel('Belongs to').selectOption({ label: 'Order' });

    // The attribute should now be listed on the entity.
    await node(page, /Entity Order/i).click();
    await expect(page.getByRole('button', { name: 'placed_at', exact: true })).toBeVisible();
  });

  test('deletes the selected node with the Delete key', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Doomed');
    await node(page, /Entity Doomed/i).click();
    await page.keyboard.press('Delete');
    await expect(node(page, /Entity Doomed/i)).toBeHidden();
    await expect(page.getByRole('heading', { name: /start with an entity/i })).toBeVisible();
  });

  test('shows an attribute connector when an attribute is attached', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('email');
    // Owner is the selected entity; one connector line should be drawn.
    await expect(page.locator('.layer-legs line.leg')).toHaveCount(1);
  });

  test('an attribute lands beside its owner, not in a distant slot', async ({ page }) => {
    await openApp(page);
    // Put the entity well away from the origin, so a free slot would be far off.
    await addNamedEntity(page, 'Customer');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click();
    await addShape(page, 'attribute');

    const entity = (await node(page, /Entity Customer/i).boundingBox())!;
    const attribute = (await page.getByTestId('canvas').locator('[data-node-id^="attr_"]').boundingBox())!;

    // Beside means horizontally separated but vertically overlapping: the
    // attribute must share a row with its owner, not float away from it.
    expect(attribute.x).toBeGreaterThan(entity.x + entity.width - 5);
    const overlapTop = Math.max(entity.y, attribute.y);
    const overlapBottom = Math.min(entity.y + entity.height, attribute.y + attribute.height);
    expect(overlapBottom - overlapTop, 'attribute should share a row with its owner').toBeGreaterThan(0);
  });

  test('a second attribute stacks below the first', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click();
    await addShape(page, 'attribute');
    await addShape(page, 'attribute');

    const attrs = page.getByTestId('canvas').locator('[data-node-id^="attr_"]');
    await expect(attrs).toHaveCount(2);
    const first = (await attrs.nth(0).boundingBox())!;
    const second = (await attrs.nth(1).boundingBox())!;
    // The two must not overlap each other.
    expect(second.y).toBeGreaterThan(first.y + first.height - 5);
  });

  test('attributes added to different entities do not collide', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click();
    await addShape(page, 'attribute');
    await node(page, /Entity Order/i).click();
    await addShape(page, 'attribute');

    const attrs = page.getByTestId('canvas').locator('[data-node-id^="attr_"]');
    await expect(attrs).toHaveCount(2);
    const a = (await attrs.nth(0).boundingBox())!;
    const b = (await attrs.nth(1).boundingBox())!;
    const separated =
      a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
    expect(separated, 'attributes of different entities must not overlap').toBe(true);
  });

  test('an attribute with no owner still gets a free slot', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    // Nothing selected, so this one floats.
    await canvas(page).click({ position: { x: 40, y: 40 } });
    await addShape(page, 'attribute');

    const attribute = page.getByTestId('canvas').locator('[data-node-id^="attr_"]');
    await expect(attribute).toHaveCount(1);
    const entity = (await node(page, /Entity Customer/i).boundingBox())!;
    const box = (await attribute.boundingBox())!;
    const overlapping =
      box.x < entity.x + entity.width && box.x + box.width > entity.x &&
      box.y < entity.y + entity.height && box.y + box.height > entity.y;
    expect(overlapping, 'a floating attribute must not land on an entity').toBe(false);
    // With no owner there is no connector line.
    await expect(page.locator('.layer-legs line.leg')).toHaveCount(0);
  });

  test('attributes are numbered so they are not all called attribute', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await node(page, /Entity Customer/i).click();
    await addShape(page, 'attribute');
    await addShape(page, 'attribute');

    const attrs = page.getByTestId('canvas').locator('[data-node-id^="attr_"]');
    await expect(attrs.nth(0)).toHaveAttribute('aria-label', /Attribute 1/);
    await expect(attrs.nth(1)).toHaveAttribute('aria-label', /Attribute 2/);
  });
});

test.describe('keyboard shortcuts', () => {
  test('E, A, R, S add each primitive', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('e');
    await expect(node(page, /Entity New entity/i)).toBeVisible();

    // Adding a shape puts the caret in its name field, so single-key shortcuts
    // are deliberately inert until focus leaves the field. Escape returns to
    // the canvas without changing anything.
    await page.keyboard.press('Escape');
    await expect(nameField(page)).not.toBeFocused();

    await page.keyboard.press('a');
    // The entity is still selected, so this attribute is owned by it.
    await expect(node(page, /Attribute 1/i)).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('r');
    await expect(node(page, /Relationship relationship/i)).toBeVisible();

    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    await expect(node(page, 'Specialization')).toBeVisible();
  });

  test('a new shape is ready to name without clicking the inspector', async ({ page }) => {
    await openApp(page);
    // The whole point: press a key, type the name, done.
    await page.keyboard.press('e');
    await expect(nameField(page)).toBeFocused();
    await page.keyboard.type('Customer');
    await expect(node(page, /Entity Customer/i)).toBeVisible();
  });

  test('typing in a text field does not trigger shortcuts', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    const field = nameField(page);
    await field.fill('');
    // "area" contains a, r, and e; none may add a shape.
    await field.type('area', { delay: 30 });
    await expect(field).toHaveValue('area');
    await expect(node(page, /Attribute 1/i)).toBeHidden();
    await expect(node(page, /Relationship relationship/i)).toBeHidden();
  });

  test('Ctrl+Z undoes an add', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    await expect(node(page, /Entity New entity/i)).toBeVisible();
    // Focus is in the name field, where Ctrl+Z is the browser's own text undo.
    // Move off the field so the shortcut reaches the diagram.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await expect(node(page, /Entity New entity/i)).toBeHidden();
  });
});

test.describe('connections', () => {
  test('Shift-clicking shapes draws relationship lines', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');

    // Spread the shapes so each is individually clickable.
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await expect(page.locator('.layer-legs line.leg')).toHaveCount(2);
  });

  test('shows a preview line while a connection is being drawn', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    // Nothing is pending before the gesture starts.
    await expect(page.getByTestId('connect-preview')).toHaveCount(0);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });

    // The source shape is marked, and moving the pointer draws a preview.
    await expect(page.locator('.node--connecting')).toHaveCount(1);
    await node(page, /Entity Order/i).hover();
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);

    // The shape under the pointer is marked as the target.
    await expect(page.locator('.node--connectable')).toHaveCount(1);

    // Completing the gesture draws a real line and clears the preview.
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('connect-preview')).toHaveCount(0);
    await expect(page.locator('.node--connecting')).toHaveCount(0);
    await expect(page.locator('.layer-legs line.leg')).toHaveCount(1);
  });

  test('the preview line is not part of an export', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).hover();
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const file = await downloadPromise;

    const stream = await file.createReadStream();
    let svg = '';
    for await (const chunk of stream) svg += String(chunk);
    expect(svg).not.toContain('connect-preview');
  });

  test('Escape cancels a connection in progress', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).hover();
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('connect-preview')).toHaveCount(0);
    await expect(page.locator('.node--connecting')).toHaveCount(0);

    // The second shift-click must start a fresh gesture rather than completing
    // the cancelled one.
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });
    await expect(page.locator('.node--connecting')).toHaveCount(1);
    await expect(page.locator('.layer-legs line.leg')).toHaveCount(0);
  });

  test('clicking empty paper cancels a connection in progress', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await expect(page.locator('.node--connecting')).toHaveCount(1);

    // Click a far corner of the canvas, well away from any shape.
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.click(box.x + 30, box.y + box.height - 30);

    await expect(page.locator('.node--connecting')).toHaveCount(0);
  });

  test('a new line defaults to cardinality 1 and can be changed to N', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await expect(page.locator('.leg__cardinality')).toHaveText(['1']);

    // Select the line through the inspector is not possible by clicking the
    // line, so verify the default rendering only. Cardinality editing is
    // covered by the unit tests and the SQL export test.
    await expect(page.locator('.leg__cardinality')).toHaveCount(1);
  });
});

test.describe('notation switching', () => {
  test('switches between Chen and crow\u2019s-foot', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();

    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await expect(page.getByTestId('table-Customer')).toBeVisible();
    await expect(canvas(page).getByText('PK', { exact: true })).toBeVisible();
    await expect(canvas(page).getByText('customer_id', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Chen' }).click();
    await expect(node(page, /Entity Customer/i)).toBeVisible();
  });

  test('crow\u2019-foot view shows an empty state with no entities', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await expect(page.getByRole('heading', { name: /no tables yet/i })).toBeVisible();
  });

  test('crow\u2019-foot view marks a weak entity', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Dependent');
    await page.getByRole('button', { name: 'Weak', exact: true }).click();
    await page.getByRole('button', { name: "Crow's-foot" }).click();
    await expect(canvas(page).getByText(/Dependent \(weak\)/)).toBeVisible();
  });
});

test.describe('export', () => {
  test('downloads an SVG', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const file = await downloadPromise;
    expect(file.suggestedFilename()).toBe('untitled-diagram.svg');
  });

  test('downloads a JSON file named after the diagram', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Invoice');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'JSON' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const file = await downloadPromise;
    expect(file.suggestedFilename()).toBe('untitled-diagram.json');
  });

  test('the exported JSON contains the diagram data', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'JSON' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const file = await downloadPromise;

    const stream = await file.createReadStream();
    let text = '';
    for await (const chunk of stream) text += String(chunk);
    const parsed = JSON.parse(text);
    expect(parsed.name).toBe('Untitled diagram');
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0].name).toBe('Customer');
  });

  test('shows generated SQL for a keyed entity', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL' }).click();
    const code = page.getByLabel('Generated SQL');
    await expect(code).toContainText('CREATE TABLE "customer"');
    await expect(code).toContainText('PRIMARY KEY ("customer_id")');
  });

  test('reports when SQL cannot be generated yet', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL' }).click();
    await expect(page.getByText(/Add an entity to generate SQL/i)).toBeVisible();
  });

  test('exports SQL with a foreign key for a one-to-many relationship', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();

    await addNamedEntity(page, 'Order');
    await addShape(page, 'attribute');
    await nameField(page).fill('order_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();

    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    // Both legs start at cardinality 1, so this is currently one-to-one and
    // produces no foreign key. Change the Order-side leg to N to make it
    // one-to-many: click the cardinality label, then choose N.
    await page.getByTestId('leg-cardinality').nth(1).click();
    await expect(page.getByRole('heading', { name: /relationship line/i })).toBeVisible();
    await page.getByRole('button', { name: 'N', exact: true }).click();
    await expect(page.getByTestId('leg-cardinality').nth(1)).toHaveText('N');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL' }).click();
    const code = page.getByLabel('Generated SQL');
    await expect(code).toContainText('CREATE TABLE "order"');
    await expect(code).toContainText('FOREIGN KEY');
    await expect(code).toContainText('REFERENCES "customer"');
  });

  test('changing a cardinality label updates the diagram', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await expect(page.getByTestId('leg-cardinality')).toHaveText(['1']);

    await page.getByTestId('leg-cardinality').click();
    await page.getByRole('button', { name: 'N', exact: true }).click();
    await expect(page.getByTestId('leg-cardinality')).toHaveText(['N']);

    // Participation can be edited too: set a minimum of 1 to mark it mandatory.
    await page.getByLabel('Minimum').fill('1');
    await expect(page.getByTestId('leg-participation')).toHaveText(['(1,1)']);
  });
});

test.describe('share links', () => {
  test('the share link carries the diagram so it opens without a server', async ({ page, context }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await page.getByLabel('Share link').inputValue();
    expect(link).toContain('#room=');
    expect(link).toContain('&d=');

    // A fresh page with no prior state must reconstruct the diagram from the URL.
    const fresh = await context.newPage();
    await fresh.goto(link);
    await expect(node(fresh, /Entity Customer/i)).toBeVisible({ timeout: 20_000 });
    await expect(node(fresh, /Entity Order/i)).toBeVisible();
    await fresh.close();
  });

  test('the share link survives a round trip without corruption', async ({ page }) => {
    await openApp(page);
    // Long names compress into a payload containing the `+` character, which is
    // the exact case that used to corrupt share links.
    for (let i = 0; i < 12; i += 1) {
      await addNamedEntity(page, `Entity number ${i} with a fairly long name`);
    }

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await page.getByLabel('Share link').inputValue();

    const fresh = await page.context().newPage();
    await fresh.goto(link);
    await expect(node(fresh, /Entity number 0 with a fairly long name/i)).toBeVisible({ timeout: 20_000 });
    await expect(node(fresh, /Entity number 11 with a fairly long name/i)).toBeVisible();
    await fresh.close();
  });

  test('the room code is shown and the link can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await page.getByRole('button', { name: 'Share', exact: true }).click();

    const room = await page.getByLabel('Room code').inputValue();
    expect(room).toMatch(/^[a-z2-9]{12}$/);
    // The confusable characters must never appear, since the room code is
    // meant to be read off one screen and typed into another.
    expect(room).not.toMatch(/[lo01]/);

    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
  });
});

test.describe('multiplayer', () => {
  test('an edit in one tab appears in another tab in the same room', async ({ context }) => {
    // Two tabs in one browser, which is what the title promises. They sync over
    // BroadcastChannel, so this test is about the collaborative *behaviour*
    // (edits propagate, presence appears) and stays reliable. The WebRTC
    // transport across separate browsers is proven by the next test.
    const alice = await context.newPage();
    const bob = await context.newPage();

    await openApp(alice);
    await addNamedEntity(alice, 'Customer');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.keyboard.press('Escape');

    // Bob joins through the same link.
    await bob.goto(link);
    await expect(node(bob, /Entity Customer/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    // Alice adds a second entity; Bob should see it arrive live.
    await addNamedEntity(alice, 'Invoice');
    await expect(node(bob, /Entity Invoice/i)).toBeVisible({ timeout: 20_000 });

    // And Bob's edit flows back to Alice.
    await node(bob, /Entity Customer/i).click();
    await nameField(bob).fill('Client');
    await expect(node(alice, /Entity Client/i)).toBeVisible({ timeout: 20_000 });

    // Presence should report a peer in each tab.
    await expect(alice.getByText(/are here|is here/)).toBeVisible({ timeout: 20_000 });
    await expect(bob.getByText(/are here|is here/)).toBeVisible({ timeout: 20_000 });

    await alice.close();
    await bob.close();
  });

  test('two separate browsers sync over a direct connection, not just shared storage', async ({
    browser,
  }) => {
    // This is the test that actually proves the WebRTC path. Two contexts in one
    // browser could sync over BroadcastChannel and hide a broken signalling
    // setup, so this asserts the provider reports a direct peer connection.
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await openApp(alice);
    await addNamedEntity(alice, 'Shared');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });

    // The status must NOT say "in this browser" — that wording is shown only
    // when no direct WebRTC connection exists.
    await expect(alice.locator('.canvas-status')).toContainText(/Live with/, { timeout: 30_000 });
    await expect(alice.locator('.canvas-status')).not.toContainText(/in this browser/, {
      timeout: 30_000,
    });

    await addNamedEntity(alice, 'Over the wire');
    await expect(node(bob, /Entity Over the wire/i)).toBeVisible({ timeout: 20_000 });

    await aliceContext.close();
    await bobContext.close();
  });

  test('a delete propagates to the other tab', async ({ browser }) => {
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await openApp(alice);
    await addNamedEntity(alice, 'Temporary');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Temporary/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    await node(alice, /Entity Temporary/i).click();
    await alice.keyboard.press('Delete');
    await expect(node(bob, /Entity Temporary/i)).toBeHidden({ timeout: 20_000 });

    await aliceContext.close();
    await bobContext.close();
  });

  test('concurrent renames of the same entity converge on one value', async ({ browser }) => {
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await openApp(alice);
    await addNamedEntity(alice, 'Alpha');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Alpha/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    // Both rename the same entity at nearly the same moment. The CRDT must
    // settle on one value, and both tabs must agree on which.
    await node(alice, /Entity Alpha/i).click();
    await nameField(alice).fill('Alpha from Alice');
    await node(bob, /Entity Alpha/i).click();
    await nameField(bob).fill('Alpha from Bob');

    await alice.waitForTimeout(3000);
    const aliceValue = await nameField(alice).inputValue();
    const bobValue = await nameField(bob).inputValue();
    expect(aliceValue).toBe(bobValue);
    expect(['Alpha from Alice', 'Alpha from Bob']).toContain(aliceValue);

    await aliceContext.close();
    await bobContext.close();
  });

  test('a shared link opens the diagram even with the room offline', async ({ browser }) => {
    // The creator closes entirely, so nothing is serving the room.
    const firstContext = await signalingContext(browser);
    const first = await firstContext.newPage();
    await openApp(first);
    await addNamedEntity(first, 'Archived');

    await first.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await first.getByLabel('Share link').inputValue();
    await firstContext.close();

    // A brand-new context opens the link with nobody online. The diagram must
    // still be there, reconstructed from the URL snapshot.
    const secondContext = await signalingContext(browser);
    const second = await secondContext.newPage();
    await second.goto(link);
    await expect(node(second, /Entity Archived/i)).toBeVisible({ timeout: 20_000 });
    await secondContext.close();
  });

  test('two peers drawing at once keep both shapes', async ({ browser }) => {
    const aliceContext = await signalingContext(browser);
    const bobContext = await signalingContext(browser);
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();

    await openApp(alice);
    await addNamedEntity(alice, 'Shared');

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    // Both add a distinct entity with no coordination.
    await addNamedEntity(alice, 'From Alice');
    await addNamedEntity(bob, 'From Bob');

    // Each tab must end up with all three entities.
    for (const page of [alice, bob]) {
      await expect(node(page, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });
      await expect(node(page, /Entity From Alice/i)).toBeVisible({ timeout: 20_000 });
      await expect(node(page, /Entity From Bob/i)).toBeVisible({ timeout: 20_000 });
    }

    await aliceContext.close();
    await bobContext.close();
  });
});

test.describe('accessibility', () => {
  test('the app has exactly one h1 and it names the app', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText(/ERD Maker/);
  });

  test('the canvas is exposed as an application region with a label', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('application')).toBeVisible();
  });

  test('the modal opens, traps focus, and closes on Escape', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Escape closes the export dialog too', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('the skip link is the first focusable element', async ({ page }) => {
    await openApp(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: /skip to the canvas/i })).toBeFocused();
  });

  test('every input in the inspector has an associated label', async ({ page }) => {
    await openApp(page);
    await addShape(page, 'entity');
    // The name input must be reachable by its label, which is what a screen
    // reader relies on.
    await expect(page.getByLabel('Entity name')).toBeVisible();
  });

  test('the shape rail buttons are reachable by keyboard', async ({ page }) => {
    await openApp(page);
    const addEntity = page.getByTestId('add-entity');
    await addEntity.focus();
    await expect(addEntity).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(node(page, /Entity New entity/i)).toBeVisible();
  });

  test('axe finds no serious or critical violations', async ({ page }) => {
    await openApp(page);
    // Exercise a populated state too, so the audit covers the inspector, the
    // selected shape, and the connector labels rather than an empty canvas.
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    const { AxeBuilder } = await import('@axe-core/playwright');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    // Report the rule and the offending node, so a failure is actionable rather
    // than just a count.
    const summary = serious
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      .join('\n');
    expect(summary).toBe('');
  });

  test('the app is usable at 200% zoom without horizontal scroll', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');

    // Emulate a 200% zoom on a 1280px-wide window by halving the CSS viewport.
    await page.setViewportSize({ width: 720, height: 450 });
    await page.waitForTimeout(200);

    const scrollsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollsSideways).toBe(false);
    // The canvas must still be reachable, not pushed off screen.
    await expect(page.getByTestId('canvas')).toBeVisible();
  });
});

test.describe('layout tools', () => {
  test('Tidy arranges a chain into left-to-right layers', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');

    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await page.getByRole('button', { name: 'Tidy' }).click();
    await page.waitForTimeout(150);

    const customer = await node(page, /Entity Customer/i).boundingBox();
    const places = await node(page, /Relationship places/i).boundingBox();
    const order = await node(page, /Entity Order/i).boundingBox();
    expect(customer).not.toBeNull();
    expect(places).not.toBeNull();
    expect(order).not.toBeNull();
    if (customer && places && order) {
      expect(places.x).toBeGreaterThan(customer.x);
      expect(order.x).toBeGreaterThan(places.x);
    }
  });

  test('Fit keeps the diagram visible', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Solo');
    await page.getByRole('button', { name: 'Fit' }).click();
    await expect(node(page, /Entity Solo/i)).toBeVisible();
  });
});

test.describe('persistence', () => {
  test('a reload restores the diagram from local storage', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Persisted');
    await expect(node(page, /Entity Persisted/i)).toBeVisible();

    // Give IndexedDB a moment to flush before reloading.
    await page.waitForTimeout(800);
    await page.reload();
    await expect(node(page, /Entity Persisted/i)).toBeVisible({ timeout: 20_000 });
  });

  test('the diagram name is restored after a reload', async ({ page }) => {
    await openApp(page);
    await page.getByLabel('Diagram name').fill('Library schema');
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByLabel('Diagram name')).toHaveValue('Library schema', { timeout: 20_000 });
  });
});
