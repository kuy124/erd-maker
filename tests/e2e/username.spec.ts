import { expect, test } from '@playwright/test';
import { documentAction, signalingContext } from './actions';

/**
 * Naming yourself.
 *
 * Two people in one room both get an animal name out of the box, which is fine
 * until nobody can say which arrow is which. The name belongs to the *person*,
 * not the diagram, so it is stored per browser and applies in every room.
 *
 * The field is offered, not focused. Focusing it would swallow E, A, R and S,
 * and adding a shape by pressing one key straight after load is a tested part of
 * this editor — so that half is pinned too.
 */
test('a name can be given before anything is drawn', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();

  const name = page.getByLabel('Your name');
  await expect(name).toBeVisible();
  // A generated name is offered as a starting point, not an empty field.
  await expect(name).toHaveValue(/\S+ \S+/);

  await name.fill('Priya');
  await expect(name).toHaveValue('Priya');

  // It names the person, not the diagram.
  await expect(page.getByLabel('Diagram name')).toHaveValue(/^Untitled diagram$/);

  // Clearing to retype must work, and blurring puts the name back.
  await name.fill('');
  await expect(name).toHaveValue('');
  await name.blur();
  await expect(name).toHaveValue('Priya');
});

for (const view of ['Chen', "Crow's-foot"]) test(`clicking the starter name allows real typing in ${view}`, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByRole('button', { name: view, exact: true }).click();
  const name = page.getByLabel('Your name');
  const viewport = page.locator('[data-viewport]');
  const before = await viewport.getAttribute('transform');
  await name.click();
  await expect(name).toBeFocused();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Budi Satria');
  await expect(name).toHaveValue('Budi Satria');
  await expect(page.getByLabel('Enter Focus view')).toBeVisible();
  await expect(page.locator('[data-node-id]')).toHaveCount(0);
  await expect(viewport).toHaveAttribute('transform', before!);
  // Selecting text with the Pan tool must not start a canvas drag either.
  await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
  await expect(name).toBeFocused();
  await expect(viewport).toHaveAttribute('transform', before!);
  await page.reload();
  await expect(page.getByLabel('Your name')).toHaveValue('Budi Satria');
});

test('the name survives a reload and applies in another room', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByLabel('Your name').fill('Priya');

  await page.reload();
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(page.getByLabel('Your name')).toHaveValue('Priya');

  // A different room, same person: the name is stored per browser, not per room.
  await documentAction(page, 'New');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(page.getByLabel('Your name')).toHaveValue('Priya');
});

test('a collaborator is renamed where they can see it', async ({ browser }) => {
  const owner = await signalingContext(browser);
  const other = await signalingContext(browser);
  const alice = await owner.newPage();
  const bob = await other.newPage();
  try {
    // Alice's room is empty, so the name field is on screen for her. Bob joins
    // that empty room and waits there — navigating Alice away would put her in a
    // different room, which is not what this is about.
    await alice.goto('/');
    await expect(alice.getByLabel('Diagram name')).toBeEnabled();
    await alice.getByLabel('Your name').fill('Priya');

    await documentAction(alice, 'Share');
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.getByRole('button', { name: 'Done', exact: true }).click();

    await bob.goto(link);
    // The link carries a snapshot even of an empty room, so Bob lands in the
    // room straight away instead of waiting for Alice's tab to connect.
    await expect(bob.getByLabel('Your name')).toBeVisible({ timeout: 30_000 });
    // Presence names the person, which is the whole point of asking.
    await expect(bob.locator('.collaboration-status')).toContainText('Priya', { timeout: 30_000 });

    // Renaming reaches them live rather than at their next join.
    await alice.getByLabel('Your name').fill('Robin');
    await expect(bob.locator('.collaboration-status')).toContainText('Robin', { timeout: 30_000 });
    await expect(bob.locator('.collaboration-status')).not.toContainText('Priya');
  } finally {
    await owner.close();
    await other.close();
  }
});

test('the name field does not steal the keyboard from a shortcut', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(page.getByLabel('Your name')).toBeVisible();

  // Not focused: pressing E right away has to add an entity.
  await expect(page.getByLabel('Your name')).not.toBeFocused();
  await page.keyboard.press('e');
  await expect(page.getByTestId('canvas').getByRole('button', { name: /Entity New entity/i })).toBeVisible();
});

test('the name field is reachable by keyboard alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  const name = page.getByLabel('Your name');

  await name.focus();
  await expect(name).toBeFocused();
  await name.fill('Accessible name');
  await expect(name).toHaveValue('Accessible name');

  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await expect(page.getByTestId('canvas').getByRole('button', { name: /Entity New entity/i })).toBeVisible();
});

test('the name field is a usable tap target on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();

  const box = (await page.getByLabel('Your name').boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
