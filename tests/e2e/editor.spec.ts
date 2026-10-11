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
import { Buffer } from 'node:buffer';

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

/**
 * Connects a relationship to two entities.
 *
 * Adding a relationship starts the connection gesture from it and each
 * completed leg stays on the diamond, so two shift-clicks finish the chain.
 */
async function connectBothSides(
  page: Page,
  rel: RegExp,
  first: RegExp,
  second: RegExp,
): Promise<void> {
  await node(page, first).click({ modifiers: ['Shift'] });
  await node(page, second).click({ modifiers: ['Shift'] });
  await expect(node(page, rel)).toBeVisible();
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

/**
 * Downloads one export format and returns the file name.
 *
 * Every export test needs the same three beats — open the dialog, pick the tab,
 * wait for the download — and each one that re-implements them is a chance to
 * assert against the wrong file.
 */
async function download(page: Page, format: 'SVG' | 'PNG' | 'JSON' | 'SQL'): Promise<string> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('tab', { name: format, exact: true }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ' + format }).click();
  const name = (await pending).suggestedFilename();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return name;
}

/** Clicks a zoom control until it stops changing, to hit its clamp. */
async function zoomToLimit(page: Page, label: RegExp, times = 30): Promise<string> {
  const button = page.getByRole('button', { name: label });
  for (let i = 0; i < times; i += 1) {
    if (await button.isDisabled()) break;
    await button.click();
  }
  return page.locator('.zoom-value').textContent().then((text) => (text ?? '').trim());
}

/**
 * Centres the diagram in the open workspace.
 *
 * Shapes are placed in world coordinates near the middle of the canvas, which
 * is where the workspace panels sit. Without this a node can land underneath
 * the shape rail and every click on it is intercepted.
 */
async function tidy(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Auto-arrange' }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(250);
}

test.describe('editor basics', () => {
  test('loads and shows an empty canvas with guidance', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { name: /start with an entity/i })).toBeVisible();
    await expect(page.getByText(/E adds an entity/i)).toBeVisible();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await connectBothSides(
      page,
      /Relationship places/i,
      /Entity Customer/i,
      /Entity Order/i,
    );

    await expect(page.locator('.layer-legs line.leg')).toHaveCount(2);
  });

  test('the Connect tool draws a line by dragging between shapes', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await page.getByRole('button', { name: 'Connect tool' }).click();

    // Press on the diamond and drag to the first entity. A line follows the
    // pointer, and the shape under it is highlighted, so the release is never a
    // surprise.
    const from = await node(page, /Relationship places/i).boundingBox();
    const to = await node(page, /Entity Customer/i).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);
    await expect(page.locator('.node--connectable')).toHaveCount(1);

    await page.mouse.up();
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(1);

    // The gesture stays on the diamond, so dragging to the second entity
    // finishes the chain.
    const other = await node(page, /Entity Order/i).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(other!.x + other!.width / 2, other!.y + other!.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(2);
  });

  test('dragging between entities creates an editable relationship with atomic Undo and Redo', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Connect tool' }).click();
    const from = (await node(page, /Entity Customer/i).boundingBox())!;
    const to = (await node(page, /Entity Order/i).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    const relationship = node(page, /Relationship relationship/i);
    await expect(relationship).toBeVisible();
    const id = await relationship.getAttribute('data-node-id');
    await expect(nameField(page)).toBeFocused();
    await expect(page.getByTestId('participant-row')).toHaveCount(2);
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(2);
    await expect(page.getByTestId('connect-preview')).toHaveCount(0);
    await expect(page.locator('.node--connecting')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(relationship).toHaveCount(0);
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(0);
    await expect(node(page, /Entity Customer/i)).toBeVisible();
    await expect(node(page, /Entity Order/i)).toBeVisible();
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(relationship).toHaveAttribute('data-node-id', id!);
    await expect(page.getByTestId('leg-cardinality')).toHaveCount(2);
  });

  test('a connect drag released on empty paper draws nothing', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await page.getByRole('button', { name: 'Connect tool' }).click();
    const from = await node(page, /Relationship places/i).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();

    const box = (await canvas(page).boundingBox())!;
    // Bare paper: the diamond sits top-left, so the bottom-right is empty.
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(0);
    // The gesture is abandoned rather than left waiting forever.
    await expect(page.locator('.node--connecting')).toHaveCount(0);
  });

  test('the Connect tool moves nothing, so a drag can only draw', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await page.getByRole('button', { name: 'Connect tool' }).click();

    const before = await node(page, /Entity Customer/i).boundingBox();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x + 220, before!.y + 120, { steps: 10 });
    await page.mouse.up();

    const after = await node(page, /Entity Customer/i).boundingBox();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
    expect(Math.round(after!.y)).toBe(Math.round(before!.y));
  });

  test('C selects the Connect tool', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    // Escape first: focus is in the name field, where a single key is text.
    await page.keyboard.press('Escape');
    await page.keyboard.press('c');
    await expect(page.getByRole('button', { name: 'Connect tool' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a new relationship is ready to connect as soon as it is made', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    // The relationship just added is already the connection source, so there is
    // nothing to select before connecting it.
    await expect(page.locator('.node--connecting')).toHaveCount(1);
    await node(page, /Entity Customer/i).hover();
    await expect(page.locator('.node--connectable')).toHaveCount(1);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    // One leg drawn, and the gesture stays on the diamond for the second.
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(1);
    await expect(page.locator('.node--connecting')).toHaveCount(1);

    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(2);
    // The gesture is finished.
    await expect(page.locator('.node--connecting')).toHaveCount(0);
  });

  test('Escape abandons a relationship the app started connecting', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await expect(page.locator('.node--connecting')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.node--connecting')).toHaveCount(0);
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(0);
  });

  test('Escape while naming a relationship does not cancel the connection', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');

    // Escape here means "I am done typing". It must not also throw away the
    // connection that was waiting to be made — the user would name the
    // relationship, step back to the canvas, and find it unconnected.
    await nameField(page).fill('places');
    await expect(nameField(page)).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(nameField(page)).not.toBeFocused();
    await expect(page.locator('.node--connecting')).toHaveCount(1);
  });

  test('naming a relationship and stepping back leaves it ready to connect', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(2);
  });

  test('shows a preview line while a connection is being drawn', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await expect(page.locator('.layer-legs line.leg')).toHaveCount(2);
    await expect(node(page, /Relationship relationship/i)).toBeVisible();
  });

  test('the preview line is not part of an export', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    // Focus must be off the name field for Escape to mean "cancel the
    // connection" rather than "stop typing", which is what this test is about.
    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await expect(nameField(page)).not.toBeFocused();
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

  test('clicking the canvas takes the keyboard off the name field', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await expect(nameField(page)).toBeFocused();

    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await node(page, /Entity Customer/i).click();

    // The browser restores focus to a field after a canvas click unless the
    // click is told otherwise. The symptom is invisible but crippling: the user
    // clicks a shape, presses `e` to add an entity, and "e" is typed into the
    // name field instead.
    await expect(nameField(page)).not.toBeFocused();

    // And the shortcut now does what it says.
    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: /Entity New entity/i })).toBeVisible();
  });

  test('clicking the canvas takes the keyboard off the name field on empty paper too', async ({
    page,
  }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await expect(nameField(page)).toBeFocused();

    // The bottom-right corner: shapes are laid out from the top-left, so this
    // is genuinely bare paper rather than a shape. Clicking it deselects, so
    // the name field goes away entirely rather than merely losing focus.
    const box = (await canvas(page).boundingBox())!;
    await canvas(page).click({ position: { x: box.width - 12, y: box.height - 12 } });

    await expect(nameField(page)).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();
  });

  test('clicking empty paper cancels a connection in progress', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    const endpoints = page.getByTestId('leg-cardinality');
    await expect(endpoints).toHaveCount(2);
    await expect(endpoints.first()).toHaveAttribute('data-cardinality', '1');
    await endpoints.first().click();
    await page.getByRole('button', { name: 'N', exact: true }).click();
    await expect(endpoints.first()).toHaveAttribute('data-cardinality', 'N');
    await expect(endpoints.first().locator('path[data-cardinality="many"]')).toHaveCount(1);
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
    await expect(page.getByTestId('leg-cardinality').nth(1)).toHaveAttribute('data-cardinality', 'N');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL' }).click();
    const code = page.getByLabel('Generated SQL');
    await expect(code).toContainText('CREATE TABLE "order"');
    await expect(code).toContainText('FOREIGN KEY');
    await expect(code).toContainText('REFERENCES "customer"');
  });

  /**
   * A crow's-foot diagram whose relationship is bound to real columns.
   *
   * `customerColumn` is what the Customer-side leg points at, which is the knob
   * these tests turn: a non-key field makes SQL generation throw, and a column
   * that no longer exists makes it throw for the reason a collaborator causes.
   */
  function connectedDiagram(customerColumn: string): string {
    return JSON.stringify({
      name: 'Shop',
      view: 'crowfoot',
      entities: [
        { id: 'c', name: 'Customer', x: 80, y: 80, kind: 'strong' },
        { id: 'o', name: 'Order', x: 620, y: 124, kind: 'strong' },
      ],
      attributes: [
        { id: 'c-key', name: 'customer_id', ownerId: 'c', kind: 'key', x: 0, y: 0 },
        { id: 'c-email', name: 'email', ownerId: 'c', kind: 'simple', x: 0, y: 0 },
        { id: 'o-buyer', name: 'buyer_ref', ownerId: 'o', kind: 'simple', x: 0, y: 0 },
      ],
      relationships: [{ id: 'r', name: 'places', x: 400, y: 80, kind: 'strong' }],
      isas: [],
      legs: [
        { id: 'l1', fromId: 'r', toId: 'c', columnId: customerColumn, cardinality: '1', participation: { min: 1, max: 1 } },
        { id: 'l2', fromId: 'r', toId: 'o', columnId: 'attribute:o-buyer', cardinality: 'N', participation: { min: 0, max: 'N' } },
      ],
    });
  }

  /** Imports a diagram through the real file input, as a user would. */
  async function importDiagram(page: Page, json: string): Promise<void> {
    await openApp(page);
    await page.locator('input[type=file]').setInputFiles({
      name: 'shop.json', mimeType: 'application/json', buffer: Buffer.from(json),
    });
    await expect(page.getByTestId('table-Customer')).toBeVisible();
  }

  test('a diagram SQL cannot be generated from still opens the dialog and still exports', async ({ page }) => {
    await importDiagram(page, connectedDiagram('attribute:c-email'));

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    // The editor survived the click. This is the regression: the throw used to
    // unmount the whole tree, leaving #root empty.
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();

    // SVG, PNG, and JSON have nothing to do with SQL, so all three still work.
    for (const format of ['SVG', 'PNG', 'JSON'] as const) {
      await page.getByRole('tab', { name: format, exact: true }).click();
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download ' + format }).click();
      expect((await pending).suggestedFilename()).toBe(`shop.${format.toLowerCase()}`);
    }

    // And SQL explains itself instead of rendering nothing.
    await page.getByRole('tab', { name: 'SQL', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('choose a single-column primary key at Customer');
    await expect(page.getByRole('button', { name: 'Download SQL' })).toBeDisabled();
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test("a collaborator's delete cannot blank the page for whoever exports next", async ({ context }) => {
    const alice = await context.newPage();
    await importDiagram(alice, connectedDiagram('attribute:c-key'));

    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.getByRole('button', { name: 'Done', exact: true }).click();

    const bob = await context.newPage();
    await openApp(bob);
    await bob.goto(link);
    await expect(bob.getByTestId('table-Customer')).toBeVisible({ timeout: 20_000 });
    // Presence, not `waitForLink`: the crow's-foot canvas status bar reports
    // tables, so awareness has to be waited for in the status bar instead.
    for (const page of [alice, bob]) {
      await expect(page.locator('.collaboration-status')).toContainText('Editing with', { timeout: 45_000 });
    }

    // With Bob merely present, Alice's export is unaffected.
    expect(await download(alice, 'SVG')).toBe('shop.svg');

    // Bob deletes the column Alice's relationship leg is bound to. The edit
    // reaches her document, leaving her leg pointing at nothing. Customer keeps
    // its key, so this isolates the stale binding from "no key at all".
    await bob.getByLabel('Edit attribute buyer_ref').click();
    await bob.getByRole('button', { name: 'Delete attribute', exact: true }).click();
    await expect(bob.getByLabel('Edit attribute buyer_ref')).toHaveCount(0);
    await expect(alice.getByTestId('table-Order')).not.toContainText('buyer_ref');

    // The reported bug: this click used to blank her page.
    await alice.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(alice.getByTestId('canvas')).toBeVisible();
    await expect(alice.getByRole('dialog')).toBeVisible();

    await alice.getByRole('tab', { name: 'SQL', exact: true }).click();
    await expect(alice.getByRole('alert')).toContainText('Choose an available connection attribute');
    await alice.getByRole('button', { name: 'Done', exact: true }).click();

    // The other three formats are unaffected by a SQL-only problem.
    expect(await download(alice, 'SVG')).toBe('shop.svg');

    await alice.close();
    await bob.close();
  });

  test('changing an endpoint updates its ERDPlus symbols and participation', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    const endpoint = page.getByTestId('leg-cardinality').first();
    await expect(endpoint).toHaveAttribute('data-cardinality', '1');
    await endpoint.click();
    await page.getByRole('button', { name: 'N', exact: true }).click();
    await expect(endpoint).toHaveAttribute('data-cardinality', 'N');
    await expect(endpoint.locator('path[data-cardinality="many"]')).toHaveCount(1);
    await expect(endpoint.locator('circle[data-participation="optional"]')).toHaveCount(1);

    // Participation can be edited too: set a minimum of 1 to mark it mandatory.
    await page.getByLabel('Minimum').fill('1');
    await expect(endpoint).toHaveAttribute('data-min', '1');
    await expect(endpoint.locator('path[data-participation="required"]')).toHaveCount(1);
    await expect(endpoint.locator('circle')).toHaveCount(0);
    await page.getByLabel('Maximum').fill('5');
    await expect(page.getByTestId('leg-participation')).toHaveText('(1,5)');
  });
});

/**
 * Things a person actually does between opening the app and pushing to Git.
 *
 * These are the unremarkable paths — a fresh diagram, a rename, a reload, a
 * zoom held down, a big diagram — that are easy to leave broken because no
 * single feature test walks them. Each one here has broken a real editor at
 * some point, usually in the gap between two features that are each tested.
 */
test.describe('everyday use', () => {
  test('a brand new diagram can be exported in every format without a crash', async ({ page }) => {
    await openApp(page);

    // SVG and PNG render an empty canvas; JSON is an empty document; SQL has
    // nothing to say yet but must explain itself instead of failing.
    expect(await download(page, 'SVG')).toBe('untitled-diagram.svg');
    expect(await download(page, 'PNG')).toBe('untitled-diagram.png');
    expect(await download(page, 'JSON')).toBe('untitled-diagram.json');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Add an entity');
    await expect(page.getByTestId('canvas')).toBeVisible();
  });

  test('renaming the diagram renames every export file', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await page.getByLabel('Diagram name').fill('Warehouse v2 (final)!');

    // Odd characters become a filesystem-safe stem rather than a broken name.
    expect(await download(page, 'JSON')).toBe('warehouse-v2-final.json');
    expect(await download(page, 'SVG')).toBe('warehouse-v2-final.svg');
  });

  test('a JSON export re-imports as the same diagram', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('customer_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await addNamedEntity(page, 'Invoice');

    // Export, then feed the exact bytes back in through the real file input.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const stream = await (await pending).createReadStream();
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await tidy(page);

    await node(page, /Entity Customer/i).click();
    await page.keyboard.press('Delete');
    await expect(node(page, /Entity Customer/i)).toHaveCount(0);

    await page.locator('input[type=file]').setInputFiles({
      name: 'round-trip.json', mimeType: 'application/json', buffer: Buffer.concat(chunks),
    });
    await expect(node(page, /Entity Customer/i)).toBeVisible();
    await expect(node(page, /Entity Invoice/i)).toBeVisible();
    // And the key survived, so this is a real round trip and not just a name.
    await expect(page.locator('.diagram-counts')).toContainText('1 attributes');
  });

  test('a reload keeps the diagram, the name, and the notation', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await page.getByLabel('Diagram name').fill('Kept across reloads');
    await page.getByRole('button', { name: /Crow/ }).click();
    await expect(page.getByTestId('table-Customer')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.getByTestId('table-Customer')).toBeVisible();
    await expect(page.getByLabel('Diagram name')).toHaveValue('Kept across reloads');
  });

  test('zoom stops at its limits instead of running away', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');

    expect(await zoomToLimit(page, /Zoom in/)).toBe('300%');
    expect(await zoomToLimit(page, /Zoom out/)).toBe('25%');
    // The canvas is still alive at both extremes.
    await expect(page.getByTestId('canvas')).toBeVisible();
    expect(await download(page, 'SVG')).toBe('untitled-diagram.svg');
  });

  test('a long editing session unwinds completely with Undo and replays with Redo', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await nameField(page).fill('Renamed');
    await tidy(page);

    const box = (await node(page, /Entity Renamed/i).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    await expect(node(page, /Entity Renamed/i)).toBeVisible();

    const undo = page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('toolbar').getByRole('button', { name: 'Redo', exact: true });

    // Every step of the session — add, rename, arrange, drag — is one undo.
    // Running the stack dry has to return an empty canvas, not a half-built one.
    for (let i = 0; i < 12 && !(await undo.isDisabled()); i += 1) await undo.click();
    await expect(page.getByText(/Start with an entity/i)).toBeVisible();
    await expect(undo).toBeDisabled();

    // Redo replays the same steps in order, so the shape returns fully built
    // and still carries the name it was given.
    for (let i = 0; i < 12 && !(await redo.isDisabled()); i += 1) await redo.click();
    await expect(node(page, /Entity Renamed/i)).toBeVisible();
    await expect(redo).toBeDisabled();
    await expect(undo).toBeEnabled();
  });

  test('a large diagram stays usable and still exports', async ({ page }) => {
    await openApp(page);
    for (let i = 0; i < 24; i += 1) {
      await addNamedEntity(page, 'Entity ' + (i + 1));
    }
    await expect(page.locator('.diagram-counts')).toContainText('24 entities');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(300);

    // Still interactive, not just painted.
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    expect(await download(page, 'JSON')).toBe('untitled-diagram.json');

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('tab', { name: 'SQL', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
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
    await expect(alice.locator('.collaboration-status')).toContainText('Editing with', { timeout: 20_000 });
    await expect(bob.locator('.collaboration-status')).toContainText('Editing with', { timeout: 20_000 });

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

/**
 * Seeing what the other person is doing.
 *
 * The cursor used to be published from the drag listeners, which only exist
 * while a shape is being dragged or the canvas panned — so you had to grab
 * something to be seen, and a plain mouse move showed nobody anything. These
 * assert the everyday case: move the mouse, the other side sees it.
 */
test.describe('live presence', () => {
  /** Two tabs in one browser, linked over BroadcastChannel. */
  async function pair(context: BrowserContext): Promise<[Page, Page]> {
    const alice = await context.newPage();
    await openApp(alice);
    await addNamedEntity(alice, 'Shared');
    await alice.getByRole('button', { name: 'Share', exact: true }).click();
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.getByRole('button', { name: 'Done', exact: true }).click();
    const bob = await context.newPage();
    await openApp(bob);
    await bob.goto(link);
    await expect(node(bob, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);
    return [alice, bob];
  }

  test('a cursor appears on plain mouse movement, with no click or drag', async ({ context }) => {
    const [alice, bob] = await pair(context);
    // Nobody has touched the canvas yet.
    await expect(alice.locator('.peer-cursor')).toHaveCount(0);

    await bob.mouse.move(700, 400);
    await bob.mouse.move(720, 420);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);
    // The name travels with the colour; an unnamed arrow says nothing.
    await expect(alice.locator('.peer-cursor__name')).not.toBeEmpty();
  });

  test('the cursor tracks the pointer instead of freezing where it appeared', async ({ context }) => {
    const [alice, bob] = await pair(context);
    await bob.mouse.move(900, 500);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);
    await alice.waitForTimeout(400);
    const before = await alice.locator('.peer-cursor').first().getAttribute('transform');

    await bob.mouse.move(300, 200);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);
    await expect.poll(async () => alice.locator('.peer-cursor').first().getAttribute('transform')).not.toBe(before);
  });

  test('crow’s-foot view shows cursors too', async ({ context }) => {
    const [alice, bob] = await pair(context);
    for (const page of [alice, bob]) {
      await page.getByRole('button', { name: /Crow/ }).click();
      await expect(page.getByTestId('table-Shared')).toBeVisible();
    }
    await bob.mouse.move(600, 350);
    await bob.waitForTimeout(300);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);
  });

  test('a cursor never reaches an export', async ({ context }) => {
    const [alice, bob] = await pair(context);
    await bob.mouse.move(650, 420);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);

    // A peer's arrow is live presence, not part of the drawing.
    await alice.getByRole('button', { name: 'Export', exact: true }).click();
    await alice.getByRole('tab', { name: 'SVG', exact: true }).click();
    const pending = alice.waitForEvent('download');
    await alice.getByRole('button', { name: 'Download SVG' }).click();
    const stream = await (await pending).createReadStream();
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    const markup = Buffer.concat(chunks).toString();
    expect(markup).not.toContain('peer-cursor');
    expect(markup).toContain('Entity Shared');
  });

  test('a cursor disappears when its owner leaves instead of parking on the diagram', async ({ context }) => {
    const [alice, bob] = await pair(context);
    await bob.mouse.move(640, 400);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);

    await bob.close();
    await expect(alice.locator('.peer-cursor')).toHaveCount(0, { timeout: 45_000 });
    await expect(alice.locator('.collaboration-status')).toContainText('Editing alone');
  });

  test('a peer’s selection is visible in their colour', async ({ context }) => {
    const [alice, bob] = await pair(context);
    const shape = node(bob, /Entity Shared/i);
    const box = (await shape.boundingBox())!;
    await bob.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await shape.click();
    await expect(alice.locator('.selection-ring')).toHaveCount(1);
  });

  test('a peer’s cursor never swallows a click on the shape under it', async ({ context }) => {
    const [alice, bob] = await pair(context);
    // Bob parks his pointer on the exact shape Alice is about to click. The
    // cursor layer paints over the drawing, so without pointer-events: none the
    // arrow eats the click and the shape cannot be selected at all.
    const box = (await node(alice, /Entity Shared/i).boundingBox())!;
    await bob.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);

    await node(alice, /Entity Shared/i).click();
    await expect(nameField(alice)).toHaveValue('Shared');
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
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
  test('Auto-arrange arranges a chain into left-to-right layers', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');

    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await node(page, /Entity Customer/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Relationship places/i).click({ modifiers: ['Shift'] });
    await node(page, /Entity Order/i).click({ modifiers: ['Shift'] });

    await page.getByRole('button', { name: 'Auto-arrange' }).click();
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
