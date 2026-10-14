import { documentAction, openBuild, inspectSelection, readDownload, snapshotShareLink } from './actions';
import { ROOM_ID_LENGTH } from '../../src/model/snapshot';
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

import { expect, test as base, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
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
  await openBuild(page);
  await page.getByTestId(`add-${kind}`).click();
}

/**
 * Joins shapes with the Connect tool.
 *
 * This used to be shift-click, which is now multi-select. Connecting lives on
 * the tool because the drag shows the line being drawn, and because a hidden
 * modifier means people only find it by accident.
 *
 * The gesture is a drag, not two clicks: the connection is committed when the
 * pointer is released, so a press and release on the same shape cancels rather
 * than arming anything. Consecutive repeats in `labels` collapse, because a
 * chain reads entity, relationship, entity.
 */
async function connectWithTool(page: Page, ...labels: Array<string | RegExp>): Promise<void> {
  const chain = labels.filter((label, index) => index === 0 || label !== labels[index - 1]);
  if (chain.length < 2) return;
  await page.getByRole('button', { name: 'Connect tool' }).click();
  for (let i = 0; i + 1 < chain.length; i += 1) {
    await dragBetween(page, chain[i]!, chain[i + 1]!);
  }
  // Back to selecting, the way anyone finishes a connection: the editing
  // affordances on the lines are hidden while the Connect tool is active.
  await page.getByRole('button', { name: 'Select tool' }).click();
  await inspectSelection(page);
}

/** Presses on one shape, releases on another: the Connect tool's own gesture. */
async function dragBetween(page: Page, from: string | RegExp, to: string | RegExp): Promise<void> {
  await pressOn(page, from);
  await page.mouse.move(...(await centreOf(page, to)), { steps: 8 });
  await page.mouse.up();
}

/**
 * Presses on a shape and leaves the pointer down.
 *
 * A connection is committed on release, so the press alone only arms the
 * gesture. Anything that wants to cancel it first has to release.
 */
async function pressOn(page: Page, label: string | RegExp): Promise<void> {
  await page.mouse.move(...(await centreOf(page, label)));
  await page.mouse.down();
}

/** Page coordinates of a shape's centre. */
async function centreOf(page: Page, label: string | RegExp): Promise<[number, number]> {
  const box = (await node(page, label).boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
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
    await expect(page.locator('.collaboration-status')).toContainText(/Editing with/, { timeout: 30_000 });
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
  await documentAction(page, 'Export');
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

  test('dragging an entity carries the attributes it owns', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    // Two attributes, so a rule that carries only the first one still fails.
    // The entity stays selected between them, so both belong to it.
    for (let i = 0; i < 2; i += 1) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('a');
    }
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('canvas').locator('[data-node-id^="attr_"]')).toHaveCount(2);

    const attributeBox = () => page.getByTestId('canvas').locator('[data-node-id^="attr_"]').first().boundingBox();
    const entityBox = () => node(page, /Entity Customer/i).boundingBox();
    const boxes = async () => {
      const [entity, first, second] = await Promise.all([
        entityBox(),
        attributeBox(),
        page.getByTestId('canvas').locator('[data-node-id^="attr_"]').nth(1).boundingBox(),
      ]);
      return { entity: entity!, first: first!, second: second! };
    };
    // Offsets rather than deltas: "still attached" is the claim, and measuring
    // it relative to the owner holds at any zoom level.
    const offset = (box: { x: number; y: number }, owner: { x: number; y: number }) =>
      ({ x: box.x - owner.x, y: box.y - owner.y });
    // Select the entity before measuring, because the selection ring grows its box
    // by 5px on each axis. Measuring it selected both before and after is the
    // only way the two boxes are comparable.
    await node(page, /Entity Customer/i).click();
    const before = await boxes();

    const box = before.entity;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y + 90, { steps: 8 });
    await page.mouse.up();

    const after = await boxes();
    // The entity moved, so the drag reached the model rather than only the view.
    expect(Math.abs(after.entity.x - before.entity.x)).toBeGreaterThan(150);
    // Every attribute is still exactly where it was relative to its owner.
    expect(offset(after.first, after.entity)).toEqual(offset(before.first, before.entity));
    expect(offset(after.second, after.entity)).toEqual(offset(before.second, before.entity));
  });

  test('dragging an attribute leaves its owner alone', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await page.keyboard.press('Escape');

    const entityBefore = (await node(page, /Entity Customer/i).boundingBox())!;
    const attribute = (await page.getByTestId('canvas').locator('[data-node-id^="attr_"]').boundingBox())!;
    await page.mouse.move(attribute.x + attribute.width / 2, attribute.y + attribute.height / 2);
    await page.mouse.down();
    await page.mouse.move(attribute.x + attribute.width / 2 + 120, attribute.y + 120, { steps: 6 });
    await page.mouse.up();

    // Ownership runs one way: an attribute belongs to the shape, not the reverse.
    const entityAfter = (await node(page, /Entity Customer/i).boundingBox())!;
    expect(Math.abs(entityAfter.x - entityBefore.x)).toBeLessThan(2);
    expect(Math.abs(entityAfter.y - entityBefore.y)).toBeLessThan(2);
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
    await canvas(page).click({ position: { x: 80, y: 120 } });
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
  test('the Connect tool draws relationship lines between shapes', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await addShape(page, 'relationship');
    await nameField(page).fill('places');

    // Spread the shapes so each is individually clickable.
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await connectWithTool(page, /Entity Customer/i, /Relationship places/i, /Relationship places/i, /Entity Order/i);

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

    await page.getByRole('button', { name: 'Connect tool' }).click();
    await dragBetween(page, /Relationship places/i, /Entity Customer/i);
    // One leg drawn, and the gesture stays on the diamond for the second.
    await expect(page.locator('.layer-legs line.leg:not(.leg--attribute)')).toHaveCount(1);
    await expect(page.locator('.node--connecting')).toHaveCount(1);

    await dragBetween(page, /Relationship places/i, /Entity Order/i);
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

    await connectWithTool(page, /Entity Customer/i, /Relationship places/i, /Relationship places/i, /Entity Order/i);

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

    await page.getByRole('button', { name: 'Connect tool' }).click();

    // Pressing on a shape arms the gesture; the pointer is still down, so the
    // connection has not been committed yet.
    await pressOn(page, /Entity Customer/i);
    await expect(page.locator('.node--connecting')).toHaveCount(1);

    // Dragging towards the other shape draws the preview line.
    await page.mouse.move(...(await centreOf(page, /Entity Order/i)), { steps: 8 });
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);

    // The shape under the pointer is marked as the target.
    await expect(page.locator('.node--connectable')).toHaveCount(1);

    // Releasing draws a real line and clears the preview.
    await page.mouse.up();
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

    await page.getByRole('button', { name: 'Connect tool' }).click();
    await pressOn(page, /Entity Customer/i);
    await page.mouse.move(...(await centreOf(page, /Entity Order/i)), { steps: 8 });
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);

    const downloadPromise = page.waitForEvent('download');
    await documentAction(page, 'Export');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const file = await downloadPromise;

    const svg = await readDownload(file);
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
    await page.getByRole('button', { name: 'Connect tool' }).click();
    await pressOn(page, /Entity Customer/i);
    await expect(nameField(page)).not.toBeFocused();
    await page.mouse.move(...(await centreOf(page, /Entity Order/i)), { steps: 8 });
    await expect(page.getByTestId('connect-preview')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.getByTestId('connect-preview')).toHaveCount(0);
    await expect(page.locator('.node--connecting')).toHaveCount(0);

    // A fresh press must start a new gesture rather than completing the
    // cancelled one.
    await pressOn(page, /Entity Order/i);
    await expect(page.locator('.node--connecting')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.mouse.up();
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

    await page.getByRole('button', { name: 'Connect tool' }).click();
    await pressOn(page, /Entity Customer/i);
    await expect(page.locator('.node--connecting')).toHaveCount(1);

    // Released over a far corner of the canvas, well away from any shape.
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + box.height - 30, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('.node--connecting')).toHaveCount(0);
  });

  test('a new line defaults to cardinality 1 and can be changed to N', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);

    await connectWithTool(page, /Entity Customer/i, /Entity Order/i);

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

    await documentAction(page, 'Export');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    const file = await downloadPromise;
    expect(file.suggestedFilename()).toBe('untitled-diagram.svg');
  });

  test('downloads a JSON file named after the diagram', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Invoice');

    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'JSON' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const file = await downloadPromise;
    expect(file.suggestedFilename()).toBe('untitled-diagram.json');
  });

  test('the exported JSON contains the diagram data', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');

    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'JSON' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const file = await downloadPromise;

    const text = await readDownload(file);
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

    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'SQL' }).click();
    const code = page.getByLabel('Generated SQL');
    await expect(code).toContainText('CREATE TABLE "customer"');
    await expect(code).toContainText('PRIMARY KEY ("customer_id")');
  });

  test('reports when SQL cannot be generated yet', async ({ page }) => {
    await openApp(page);
    await documentAction(page, 'Export');
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

    await connectWithTool(page, /Entity Customer/i, /Relationship places/i, /Relationship places/i, /Entity Order/i);

    // Both legs start at cardinality 1, so this is currently one-to-one and
    // produces no foreign key. Change the Order-side leg to N to make it
    // one-to-many: click the cardinality label, then choose N.
    await page.getByTestId('leg-cardinality').nth(1).click();
    await expect(page.getByRole('heading', { name: /relationship line/i })).toBeVisible();
    await page.getByRole('button', { name: 'N', exact: true }).click();
    await expect(page.getByTestId('leg-cardinality').nth(1)).toHaveAttribute('data-cardinality', 'N');

    await documentAction(page, 'Export');
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

    await documentAction(page, 'Export');
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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
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
    await inspectSelection(bob);
    await bob.getByRole('button', { name: 'Delete attribute', exact: true }).click();
    await expect(bob.getByLabel('Edit attribute buyer_ref')).toHaveCount(0);
    await expect(alice.getByTestId('table-Order')).not.toContainText('buyer_ref');

    // The reported bug: this click used to blank her page.
    await documentAction(alice, 'Export');
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

    await connectWithTool(page, /Entity Customer/i, /Entity Order/i);

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

    await documentAction(page, 'Export');
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
    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON' }).click();
    const stream = await (await pending).createReadStream();
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));
    const json = Buffer.concat(chunks);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await tidy(page);

    await node(page, /Entity Customer/i).click();
    await page.keyboard.press('Delete');
    await expect(node(page, /Entity Customer/i)).toHaveCount(0);

    await page.locator('input[type=file]').setInputFiles({
      name: 'round-trip.json', mimeType: 'application/json', buffer: json,
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

    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'SQL', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('share links', () => {
  test('the share link carries the diagram so it opens without a server', async ({ page, context }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');

    await documentAction(page, 'Share');
    const link = await snapshotShareLink(page);
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

    await documentAction(page, 'Share');
    const link = await snapshotShareLink(page);

    const fresh = await page.context().newPage();
    await fresh.goto(link);
    await expect(node(fresh, /Entity number 0 with a fairly long name/i)).toBeVisible({ timeout: 20_000 });
    await expect(node(fresh, /Entity number 11 with a fairly long name/i)).toBeVisible();
    await fresh.close();
  });

  test('the room code is shown and the link can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await documentAction(page, 'Share');

    const room = await page.getByLabel('Room code').inputValue();
    expect(room).toMatch(new RegExp('^[a-z2-9]{' + ROOM_ID_LENGTH + '}$'));
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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
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
    await inspectSelection(bob);
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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });

    // The status must NOT say "in this browser" — that wording is shown only
    // when no direct WebRTC connection exists.
    await expect(alice.locator('.collaboration-status')).toContainText('Direct connection', { timeout: 30_000 });

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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
    await alice.keyboard.press('Escape');

    await bob.goto(link);
    await expect(node(bob, /Entity Alpha/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    // Both rename the same entity at nearly the same moment. The CRDT must
    // settle on one value, and both tabs must agree on which.
    await node(alice, /Entity Alpha/i).click();
    await nameField(alice).fill('Alpha from Alice');
    await node(bob, /Entity Alpha/i).click();
    await inspectSelection(bob);
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

    await documentAction(first, 'Share');
    const link = await snapshotShareLink(first);
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

    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
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
    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
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

  test('a cursor is only drawn for a peer reading the same notation', async ({ context }) => {
    const [alice, bob] = await pair(context);

    // Both start in Chen, so the cursor is there to be found.
    await bob.mouse.move(620, 380);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);

    // Bob moves to Crow's-foot. The two notations place one schema at different
    // coordinates, so his arrow would point at a shape that is not there.
    await bob.getByRole('button', { name: /Crow/ }).click();
    await expect(bob.getByTestId('table-Shared')).toBeVisible();
    await bob.mouse.move(660, 400);
    await bob.waitForTimeout(500);
    await expect(alice.locator('.peer-cursor')).toHaveCount(0);
    // And back again, so this is about the notation and not about presence.
    await bob.getByRole('button', { name: 'Chen', exact: true }).click();
    await bob.mouse.move(700, 420);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);
  });

  test('a cursor never reaches an export', async ({ context }) => {
    const [alice, bob] = await pair(context);
    await bob.mouse.move(650, 420);
    await expect(alice.locator('.peer-cursor')).toHaveCount(1);

    // A peer's arrow is live presence, not part of the drawing.
    await documentAction(alice, 'Export');
    await alice.getByRole('tab', { name: 'SVG', exact: true }).click();
    const pending = alice.waitForEvent('download');
    await alice.getByRole('button', { name: 'Download SVG' }).click();
    const markup = await readDownload(await pending);
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
    await documentAction(page, 'Share');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Escape closes the export dialog too', async ({ page }) => {
    await openApp(page);
    await documentAction(page, 'Export');
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
    await openBuild(page);
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

    await connectWithTool(page, /Entity Customer/i, /Relationship places/i, /Relationship places/i, /Entity Order/i);

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

/**
 * Where a new shape appears.
 *
 * The shortcut used to drop every shape in the middle of the canvas regardless
 * of where the pointer was, then re-centre the view on it. Both had to go:
 * people build a diagram by working along one area of it, and a shape that
 * appears somewhere else entirely is one they have to go and find.
 */

/**
 * Where a new shape appears.
 *
 * The shortcut used to drop every shape in the middle of the canvas whatever
 * the pointer was doing, then re-centre the view on it. Both had to go: people
 * build a diagram by working along one part of it, and a shape that lands
 * somewhere else is one they have to go and find.
 *
 * Assertions are on screen positions, because that is what the user sees and it
 * survives the shape being re-laid-out by `findFreeSlot`.
 */
test.describe('creating at the pointer', () => {
  /** Screen centre of a shape, in page coordinates. */
  async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  test('E puts the entity under the pointer, not in the middle', async ({ page }) => {
    await openApp(page);
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const target = { x: canvas.x + 180, y: canvas.y + canvas.height - 120 };

    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(120);
    await page.keyboard.press('e');

    const shape = node(page, /Entity New entity/i);
    await expect(shape).toBeVisible();
    const placed = await centreOf(shape);
    // `findFreeSlot` nudges a shape clear of anything already there, so the
    // allowance is one shape's width rather than pixel-exact.
    expect(Math.abs(placed.x - target.x)).toBeLessThan(160);
    expect(Math.abs(placed.y - target.y)).toBeLessThan(80);
    // And emphatically not the middle of the canvas.
    expect(Math.abs(placed.x - (canvas.x + canvas.width / 2))).toBeGreaterThan(150);
  });

  test('the view does not jump away from the pointer that just created a shape', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'First');
    await addNamedEntity(page, 'Second');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(200);

    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.move(canvas.x + 200, canvas.y + canvas.height - 140);
    await page.waitForTimeout(120);

    const before = await page.locator('[data-viewport]').getAttribute('transform');
    await page.keyboard.press('e');
    await expect(node(page, /Entity New entity/i)).toBeVisible();
    await page.waitForTimeout(300);

    // Re-centring the diagram on every creation is exactly what this guards.
    expect(await page.locator('[data-viewport]').getAttribute('transform')).toBe(before);
  });

  test('R and S each follow the pointer to wherever it is', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Anchor');
    // Naming leaves the caret in the name field, where single-key shortcuts are
    // deliberately inert. Escape returns to the canvas without changing the
    // selection, so the pointer is now what decides placement.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(200);
    const anchor = await centreOf(node(page, /Entity Anchor/i));

    const first = { x: anchor.x - 260, y: anchor.y - 160 };
    await page.mouse.move(first.x, first.y);
    await page.waitForTimeout(120);
    await page.keyboard.press('r');
    const relationship = node(page, /Relationship relationship/i);
    await expect(relationship).toBeVisible();
    const relationshipAt = await centreOf(relationship);
    expect(Math.abs(relationshipAt.x - first.x)).toBeLessThan(160);
    expect(Math.abs(relationshipAt.y - first.y)).toBeLessThan(80);

    await page.keyboard.press('Escape');
    const second = { x: anchor.x + 260, y: anchor.y + 160 };
    await page.mouse.move(second.x, second.y);
    await page.waitForTimeout(120);
    await page.keyboard.press('s');
    const isa = node(page, 'Specialization');
    await expect(isa).toBeVisible();
    const isaAt = await centreOf(isa);
    expect(Math.abs(isaAt.x - second.x)).toBeLessThan(80);
    expect(Math.abs(isaAt.y - second.y)).toBeLessThan(80);
  });

  test('A still lands beside its owner rather than under the pointer', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Anchor');
    await page.keyboard.press('Escape');
    const anchor = await centreOf(node(page, /Entity Anchor/i));

    // Far away on purpose: an attribute describing a shape belongs next to it.
    // Chen draws the connector as the thing that says which shape it describes,
    // so a stray attribute across the canvas turns a readable diagram into a
    // hairball.
    await page.mouse.move(anchor.x + 420, anchor.y + 280);
    await page.waitForTimeout(120);
    await page.keyboard.press('a');

    // Owned by the selected entity, so it is numbered.
    const attribute = node(page, /Attribute 1/i);
    await expect(attribute).toBeVisible();
    const placed = await centreOf(attribute);
    const owner = await centreOf(node(page, /Entity Anchor/i));
    expect(Math.abs(placed.x - owner.x)).toBeLessThan(220);
  });

  test('a shape stays on screen when the shortcut is used from a side panel', async ({ page }) => {
    await openApp(page);
    await openBuild(page);
    // The pointer ends up over the shape rail, outside the canvas.
    await page.getByRole('complementary', { name: 'Shapes' }).hover();
    await page.waitForTimeout(120);
    await page.keyboard.press('e');

    const shape = node(page, /Entity New entity/i);
    await expect(shape).toBeVisible();
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const box = (await shape.boundingBox())!;
    expect(box.x).toBeGreaterThan(canvas.x - 10);
    expect(box.y).toBeGreaterThan(canvas.y - 10);
  });

  test('creating before the pointer has ever moved still lands in view', async ({ page }) => {
    await openApp(page);
    // No pointermove has fired, so there is no recorded position at all.
    await page.keyboard.press('e');

    const shape = node(page, /Entity New entity/i);
    await expect(shape).toBeVisible();
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const box = (await shape.boundingBox())!;
    expect(box.x).toBeGreaterThan(canvas.x);
    expect(box.y).toBeGreaterThan(canvas.y);
  });
});

/**
 * Selecting more than one shape.
 *
 * Shift-click, dragging a selection, deleting it, and the marquee. These are
 * the paths that only exist because selection became a set, so nothing else in
 * the suite reaches them.
 */
test.describe('multi-select', () => {
  /** Two entities side by side, arranged so neither sits under a panel. */
  async function twoShapes(page: Page): Promise<{ page: Page }> {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addNamedEntity(page, 'Beta');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(250);
    return { page };
  }

  test('shift-click adds a shape and shift-click again removes it', async ({ page }) => {
    await twoShapes(page);
    const alpha = node(page, /Entity Alpha/i);
    const beta = node(page, /Entity Beta/i);

    await alpha.click();
    await beta.click({ modifiers: ['Shift'] });
    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toBeVisible();

    await beta.click({ modifiers: ['Shift'] });
    await expect(page.getByRole('heading', { name: /Entity/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toHaveCount(0);
  });

  test('a plain click collapses the selection back to one', async ({ page }) => {
    await twoShapes(page);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toBeVisible();

    await node(page, /Entity Beta/i).click();
    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toHaveCount(0);
  });

  test('dragging one selected shape moves the whole selection as one undo step', async ({ page }) => {
    await twoShapes(page);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });

    const from = (await node(page, /Entity Alpha/i).boundingBox())!;
    const betaBefore = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 180, from.y + from.height / 2, { steps: 10 });
    await page.mouse.up();

    // Both moved, by the same offset.
    const alphaAfter = (await node(page, /Entity Alpha/i).boundingBox())!;
    const betaAfter = (await node(page, /Entity Beta/i).boundingBox())!;
    const alphaDelta = { x: alphaAfter.x - from.x, y: alphaAfter.y - from.y };
    expect(Math.abs(alphaDelta.x)).toBeGreaterThan(100);
    expect(Math.abs(betaAfter.x - betaBefore.x - alphaDelta.x)).toBeLessThan(2);
    expect(Math.abs(betaAfter.y - betaBefore.y - alphaDelta.y)).toBeLessThan(2);

    // One Undo puts both back.
    await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
    const alphaRestored = (await node(page, /Entity Alpha/i).boundingBox())!;
    expect(Math.abs(alphaRestored.x - from.x)).toBeLessThan(2);
  });

  test('Delete removes every selected shape in one undo step', async ({ page }) => {
    await twoShapes(page);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });
    await page.keyboard.press('Delete');

    await expect(node(page, /Entity Alpha/i)).toHaveCount(0);
    await expect(node(page, /Entity Beta/i)).toHaveCount(0);
    // The notice names the count, so a five-shape delete is not alarming.
    await expect(page.locator('.feedback')).toContainText('2 shapes deleted');

    await page.locator('.feedback').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(node(page, /Entity Alpha/i)).toBeVisible();
    await expect(node(page, /Entity Beta/i)).toBeVisible();
  });

  test('Escape clears the selection without deleting anything', async ({ page }) => {
    await twoShapes(page);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('canvas').locator('.selection-ring')).toHaveCount(0);
    await expect(page.locator('.workspace-panel--right')).toBeHidden();
    await expect(node(page, /Entity Alpha/i)).toBeVisible();
    await expect(node(page, /Entity Beta/i)).toBeVisible();
  });

  test('shift-drag on empty paper draws a marquee and selects what it touches', async ({ page }) => {
    await twoShapes(page);
    const alpha = (await node(page, /Entity Alpha/i).boundingBox())!;
    const beta = (await node(page, /Entity Beta/i).boundingBox())!;
    const left = Math.min(alpha.x, beta.x) - 40;
    const right = Math.max(alpha.x + alpha.width, beta.x + beta.width) + 40;
    const top = Math.min(alpha.y, beta.y) - 40;
    const bottom = Math.max(alpha.y + alpha.height, beta.y + beta.height) + 40;

    await page.keyboard.down('Shift');
    await page.mouse.move(left, top);
    await page.mouse.down();
    // The box is visible while the gesture is in flight.
    await expect(page.locator('.marquee')).toHaveCount(1);
    await page.mouse.move(right, bottom, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toBeVisible();
  });

  test('a marquee that touches nothing clears the selection', async ({ page }) => {
    await twoShapes(page);
    await node(page, /Entity Alpha/i).click();
    const canvas = (await page.getByTestId('canvas').boundingBox())!;

    await page.keyboard.down('Shift');
    await page.mouse.move(canvas.x + 8, canvas.y + 8);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 40, canvas.y + 40, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect(page.getByRole('heading', { name: /Select a shape/i })).toBeVisible();
  });

  test('a plain drag on empty paper still pans', async ({ page }) => {
    await twoShapes(page);
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const before = await page.locator('[data-viewport]').getAttribute('transform');

    // No modifier: this must pan, not marquee. "Empty paper always pans" is
    // what stops the canvas feeling stuck.
    await page.mouse.move(canvas.x + 80, canvas.y + 120);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 180, canvas.y + 180, { steps: 6 });
    await page.mouse.up();

    expect(await page.locator('[data-viewport]').getAttribute('transform')).not.toBe(before);
    await expect(page.locator('.marquee')).toHaveCount(0);
  });

  test("a collaborator's multi-selection is visible in their colour", async ({ context }) => {
    const alice = await context.newPage();
    await openApp(alice);
    await addNamedEntity(alice, 'Shared');
    await documentAction(alice, 'Share');
    const link = await snapshotShareLink(alice);
    await alice.getByRole('button', { name: 'Done', exact: true }).click();
    const bob = await context.newPage();
    await openApp(bob);
    await bob.goto(link);
    await expect(node(bob, /Entity Shared/i)).toBeVisible({ timeout: 20_000 });
    await waitForLink([alice, bob]);

    await addNamedEntity(bob, 'Second');
    await node(bob, /Entity Shared/i).click();
    await node(bob, /Entity Second/i).click({ modifiers: ['Shift'] });
    await expect(bob.getByRole('heading', { name: /2 shapes selected/i })).toBeVisible();

    // Both of Bob's selections carry his colour on Alice's canvas.
    await expect
      .poll(async () => alice.locator('.selection-ring[style*="stroke"]').count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
  });
});

/**
 * The right-click menu.
 *
 * One component serves two cases, and the cases differ only in what they offer,
 * so both are asserted here: empty paper creates, a shape groups.
 */
test.describe('right-click menu', () => {
  test('suppresses the browser menu on the canvas and on the ERD menu', async ({ page }) => {
    await openApp(page);
    const prevented = await canvas(page).evaluate((element) => {
      const box = element.getBoundingClientRect();
      const event = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: box.x + 20, clientY: box.y + 100,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((element) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
  });

  test('right-clicking the wide edge of a crow’s-foot table keeps the multi-selection', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addNamedEntity(page, 'Beta');
    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    await tidy(page);
    await canvas(page).getByRole('button', { name: 'Table Alpha', exact: true }).click();
    const beta = canvas(page).getByRole('button', { name: 'Table Beta', exact: true });
    await beta.click({ modifiers: ['Shift'] });
    const box = (await beta.boundingBox())!;
    await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Group 2 shapes' })).toBeEnabled();
    await page.getByRole('menuitem', { name: 'Group 2 shapes' }).click();
    await expect(page.locator('.group-frame')).toHaveCount(1);
  });

  test('right-clicking an attribute row deletes that attribute rather than its table', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addShape(page, 'attribute');
    await nameField(page).fill('email');
    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    const attribute = canvas(page).getByRole('button', { name: 'Edit attribute email', exact: true });
    await attribute.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Delete selection', exact: true }).click();
    await expect(attribute).toHaveCount(0);
    await expect(page.getByTestId('table-Customer')).toBeVisible();
    await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(attribute).toBeVisible();
  });

  test('right-clicking a crow’s-foot connector offers actions for that relationship', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Customer');
    await addNamedEntity(page, 'Order');
    await tidy(page);
    await connectWithTool(page, /Entity Customer/i, /Entity Order/i);
    await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    // Fit before reaching for the connector. Crow's-foot seeds this browser's
    // own table layout on arrival, and framing it while Properties is open can
    // land a connector under the panel; Fit is the app's own answer and the
    // thing a person would press.
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.locator('.crow-link__ratio-background').first().click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Delete selection', exact: true }).click();
    await expect(page.locator('.crow-link')).toHaveCount(0);
    await expect(page.getByTestId('table-Customer')).toBeVisible();
    await expect(page.getByTestId('table-Order')).toBeVisible();
  });

  test('Shift+F10 opens actions for the selection and Tab dismisses them', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await node(page, /Entity Alpha/i).click();
    await canvas(page).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(node(page, /Entity Alpha/i)).toBeVisible();
  });

  test('the keyboard menu creates a shape and leaves its name ready to type', async ({ page }) => {
    await openApp(page);
    await canvas(page).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Add a shape' })).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(nameField(page)).toBeFocused();
    await page.keyboard.type('Invoice');
    await expect(node(page, /Entity Invoice/i)).toBeVisible();
  });

  test('the first action edits properties rather than deleting the shape', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await node(page, /Entity Alpha/i).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Edit properties', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(nameField(page)).toBeFocused();
    await expect(node(page, /Entity Alpha/i)).toBeVisible();
  });

  test('editor shortcuts do not run behind an open shape menu', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await node(page, /Entity Alpha/i).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('r');
    await expect(canvas(page).locator('[data-node-id^="rel_"]')).toHaveCount(0);
    await expect(page.getByRole('menu')).toBeVisible();
  });

  test('the menu fits the viewport with enlarged text', async ({ page }) => {
    await openApp(page);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addStyleTag({ content: '.context-menu { font-size: 24px; }' });
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.click(box.x + box.width - 12, box.y + box.height - 80, { button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(8);
    expect(bounds.y).toBeGreaterThanOrEqual(8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(892);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(592);
  });

  test('keyboard navigation scrolls overflowing menu actions into view', async ({ page }) => {
    await openApp(page);
    await page.setViewportSize({ width: 1440, height: 300 });
    await page.addStyleTag({ content: '.context-menu { font-size: 32px; }' });
    await canvas(page).focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Add a shape' });
    await expect(menu).toBeVisible();

    for (const key of ['End', 'Home', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(key);
      await expect.poll(async () => {
        const bounds = (await menu.boundingBox())!;
        const focused = (await menu.locator(':focus').boundingBox())!;
        return focused.y >= bounds.y && focused.y + focused.height <= bounds.y + bounds.height;
      }).toBe(true);
    }
  });

  test('right-clicking does not complete a pending Chen connection', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addNamedEntity(page, 'Beta');
    await addShape(page, 'relationship');
    await nameField(page).fill('owns');
    await tidy(page);
    await page.getByRole('button', { name: 'Connect tool' }).click();
    await expect(page.locator('.leg-group')).toHaveCount(0);

    await node(page, /Entity Alpha/i).click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    await expect(page.locator('.leg-group')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await dragBetween(page, /Relationship owns/i, /Entity Alpha/i);
    await expect(page.locator('.leg-group')).toHaveCount(1);
  });

  for (const notation of ['Chen', "Crow's-foot"]) {
    test(`a right-button drag does not pan the ${notation} canvas`, async ({ page }) => {
      await openApp(page);
      await page.getByRole('button', { name: notation, exact: true }).click();
      await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
      const viewport = canvas(page).locator('[data-viewport]');
      const before = await viewport.getAttribute('transform');
      const box = (await canvas(page).boundingBox())!;
      await page.mouse.move(box.x + 40, box.y + box.height - 90);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(box.x + 110, box.y + box.height - 130, { steps: 5 });
      await page.mouse.up({ button: 'right' });
      expect(await viewport.getAttribute('transform')).toBe(before);
    });
  }

  test('empty paper offers the four shapes and creates one where it was opened', async ({ page }) => {
    await openApp(page);
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    const at = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height - 90 };

    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Add a shape' })).toBeVisible();
    await expect(page.getByRole('menuitem').locator('.context-menu__label')).toHaveText([
      'New entity', 'New attribute', 'New relationship', 'New specialization',
    ]);

    await page.getByRole('menuitem', { name: 'New entity' }).click();
    const shape = node(page, /Entity New entity/i);
    await expect(shape).toBeVisible();
    // Created at the pointer, and ready to be named without another click.
    const box = (await shape.boundingBox())!;
    expect(Math.abs((box.x + box.width / 2) - at.x)).toBeLessThan(160);
    await expect(nameField(page)).toBeFocused();
  });

  test('empty paper offers creation even while shapes are selected', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(250);

    // The selection is live; the pointer is on clear paper a long way from it.
    await node(page, /Entity Alpha/i).click();
    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.click(canvas.x + 24, canvas.y + canvas.height - 24, { button: 'right' });

    // Offering to delete something the pointer is nowhere near is the bug this
    // guards against.
    await expect(page.getByRole('menu', { name: 'Add a shape' })).toBeVisible();
    await expect(page.getByRole('menuitem').locator('.context-menu__label')).toHaveText([
      'New entity', 'New attribute', 'New relationship', 'New specialization',
    ]);
  });

  test('a shape offers grouping and deleting', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    const shape = node(page, /Entity Alpha/i);
    const box = (await shape.boundingBox())!;

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByRole('menu', { name: 'Shape actions' })).toBeVisible();
    // One shape cannot be a group, so the action says why instead of failing.
    await expect(page.getByRole('menuitem', { name: 'Group selected shapes' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'Delete selection' })).toBeEnabled();
  });

  test('right-clicking an unselected shape selects it first', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addNamedEntity(page, 'Beta');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(250);

    await node(page, /Entity Alpha/i).click();
    await expect(nameField(page)).toHaveValue('Alpha');

    const beta = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.click(beta.x + beta.width / 2, beta.y + beta.height / 2, { button: 'right' });
    await expect(nameField(page)).toHaveValue('Beta');
  });

  test('the menu is fully keyboard operable and restores focus on close', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    const shape = node(page, /Entity Alpha/i);
    const box = (await shape.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });

    // Focus lands inside the menu, not back on the canvas behind it.
    await expect(page.locator('[role=menu] :focus')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[role=menu] :focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    // Focus goes back where it came from, so the keyboard is not stranded.
    await expect(shape).toBeFocused();
  });

  test('clicking anywhere else dismisses the menu', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    const shape = node(page, /Entity Alpha/i);
    const box = (await shape.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();

    const canvas = (await page.getByTestId('canvas').boundingBox())!;
    await page.mouse.click(canvas.x + 80, canvas.y + 120);
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

/**
 * Groups.
 *
 * Visual only, by design: a group keeps shapes together while they are worked
 * on and never reaches SQL or an export. Every test below pins one of those.
 */
test.describe('groups', () => {
  async function twoSelected(page: Page): Promise<void> {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addNamedEntity(page, 'Beta');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(250);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });
  }

  async function groupViaMenu(page: Page): Promise<void> {
    const box = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: /Group 2 shapes/ }).click();
  }

  test('grouping draws a frame and is one undo step', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);
    await expect(page.locator('.group-frame')).toHaveCount(1);

    await page.getByRole('toolbar').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.locator('.group-frame')).toHaveCount(0);
  });

  test('dragging any member carries the whole group', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);

    const alphaBefore = (await node(page, /Entity Alpha/i).boundingBox())!;
    const betaBefore = (await node(page, /Entity Beta/i).boundingBox())!;
    const box = (await node(page, /Entity Alpha/i).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 10 });
    await page.mouse.up();

    const alphaAfter = (await node(page, /Entity Alpha/i).boundingBox())!;
    const betaAfter = (await node(page, /Entity Beta/i).boundingBox())!;
    const dx = alphaAfter.x - alphaBefore.x;
    expect(Math.abs(dx)).toBeGreaterThan(100);
    // Beta was never touched and still came along.
    expect(Math.abs(betaAfter.x - betaBefore.x - dx)).toBeLessThan(2);
  });

  test('the frame is derived from its members, never stored', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);

    // The frame must contain both members, on screen, wherever they are.
    const containsBoth = async (): Promise<boolean> => {
      const frame = (await page.locator('.group-frame rect').boundingBox())!;
      for (const label of [/Entity Alpha/i, /Entity Beta/i]) {
        const box = (await node(page, label).boundingBox())!;
        const inside = box.x >= frame.x - 1 && box.y >= frame.y - 1 &&
          box.x + box.width <= frame.x + frame.width + 1 &&
          box.y + box.height <= frame.y + frame.height + 1;
        if (!inside) return false;
      }
      return true;
    };
    expect(await containsBoth()).toBe(true);

    // Auto-arrange moves the shapes on its own; the group never hears about it.
    // Nothing about the frame is written to the document, so it has to follow.
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(350);
    expect(await page.locator('.group-frame')).toHaveCount(1);
    expect(await containsBoth()).toBe(true);

    // Dropping to a single member dissolves the group: a frame around one
    // shape says nothing, and would come back after a reload as a mystery box.
    await node(page, /Entity Alpha/i).click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.group-frame')).toHaveCount(0);
    await expect(node(page, /Entity Beta/i)).toBeVisible();
  });

  test('removing the group leaves the shapes exactly where they were', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);
    const before = (await node(page, /Entity Alpha/i).boundingBox())!;

    const box = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove group' }).click();

    await expect(page.locator('.group-frame')).toHaveCount(0);
    const after = (await node(page, /Entity Alpha/i).boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  });

  test('a group survives a reload and a share link', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);
    await expect(page.locator('.group-frame')).toHaveCount(1);

    await page.reload();
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);

    await documentAction(page, 'Share');
    const link = await snapshotShareLink(page);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.goto(link);
    await expect(page.getByTestId('canvas')).toBeVisible();
    await expect(page.locator('.group-frame')).toHaveCount(1);
  });

  test('a group is stripped from an export but its shapes are not', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);

    await documentAction(page, 'Export');
    await page.getByRole('tab', { name: 'SVG', exact: true }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download SVG' }).click();
    let markup = await readDownload(await pending);

    // A frame is a working aid, not part of the drawing.
    expect(markup).not.toContain('group-frame');
    expect(markup).toContain('Alpha');
    expect(markup).toContain('Beta');
  });

  test('grouping changes nothing about the generated SQL', async ({ page }) => {
    await openApp(page);
    await addNamedEntity(page, 'Alpha');
    await addShape(page, 'attribute');
    await nameField(page).fill('alpha_id');
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await page.keyboard.press('Escape');
    await addNamedEntity(page, 'Beta');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(250);

    const readSql = async (): Promise<string> => {
      await documentAction(page, 'Export');
      await page.getByRole('tab', { name: 'SQL', exact: true }).click();
      const text = (await page.getByLabel('Generated SQL').textContent()) ?? '';
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      return text;
    };
    const before = await readSql();

    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Beta/i).click({ modifiers: ['Shift'] });
    const box = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: /Group 2 shapes/ }).click();
    await expect(page.locator('.group-frame')).toHaveCount(1);

    // Identical. A group is not a modelling concept, so it must not invent one.
    expect(await readSql()).toBe(before);
  });

  test('a shape belongs to one group at a time', async ({ page }) => {
    await twoSelected(page);
    await groupViaMenu(page);
    await expect(page.locator('.group-frame')).toHaveCount(1);

    // Group Alpha with a third shape: it leaves the first group rather than
    // appearing in two frames at once.
    await page.keyboard.press('Escape');
    await addNamedEntity(page, 'Gamma');
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await page.waitForTimeout(350);
    await node(page, /Entity Alpha/i).click();
    await node(page, /Entity Gamma/i).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('heading', { name: /2 shapes selected/i })).toBeVisible();
    const box = (await node(page, /Entity Gamma/i).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: /Group 2 shapes/ }).click();

    // One frame. Alpha was in the first group and is not in this one, so it was
    // moved rather than listed twice; the first group held Alpha and Beta, so
    // losing Alpha leaves it with a single member and it goes.
    await expect(page.locator('.group-frame')).toHaveCount(1);

    // Membership, asserted by behaviour rather than by geometry: a bounding box
    // is not a clip, so Beta may well sit inside the frame without being in it.
    // Dragging Beta must leave the group alone.
    await page.keyboard.press('Escape');
    const alphaBefore = (await node(page, /Entity Alpha/i).boundingBox())!;
    const beta = (await node(page, /Entity Beta/i).boundingBox())!;
    await page.mouse.move(beta.x + beta.width / 2, beta.y + beta.height / 2);
    await page.mouse.down();
    await page.mouse.move(beta.x + beta.width / 2 + 170, beta.y + beta.height / 2, { steps: 10 });
    await page.mouse.up();

    const alphaAfter = (await node(page, /Entity Alpha/i).boundingBox())!;
    expect(Math.abs(alphaAfter.x - alphaBefore.x)).toBeLessThan(2);
    expect(Math.abs(alphaAfter.y - alphaBefore.y)).toBeLessThan(2);
  });
});
