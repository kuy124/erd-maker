import { expect, test, type Page } from '@playwright/test';
import { documentAction, inspectSelection, signalingContext, snapshotShareLink } from './actions';
import { parseShareHash } from '../../src/model/snapshot';

const commentsButton = (page: Page) => page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Comments', exact: true });
const popover = (page: Page) => page.locator('.comment-popover');

test('collaborators reply in one thread, retain drafts and identity, and delete only their own messages', async ({ browser }) => {
  const owner = await signalingContext(browser), guest = await signalingContext(browser);
  try {
    const alice = await owner.newPage();
    await alice.goto('/');
    await expect(alice.getByLabel('Diagram name')).toBeEnabled();
    await rename(alice, 'Ada');
    await commentsButton(alice).click();
    await alice.mouse.click(480, 370);
    await alice.getByLabel('New comment', { exact: true }).fill('Review the customer email key.');
    await alice.getByRole('button', { name: 'Post comment', exact: true }).click();
    const rootId = await alice.locator('.comment-pin').getAttribute('data-comment-id');
    const bob = await guest.newPage();
    await documentAction(alice, 'Share');
    await bob.goto(await snapshotShareLink(alice));
    await alice.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(bob.getByLabel('Diagram name')).toBeEnabled();
    await rename(bob, 'Morgan');
    await bob.locator('.comment-pin').click();
    await expect(popover(bob).getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
    const text = 'Make email unique. <script>alert(1)</script>';
    await bob.getByLabel('Reply', { exact: true }).fill(text);
    await bob.getByLabel('Reply', { exact: true }).press('Control+Enter');
    const remote = alice.locator('.comment-message').filter({ hasText: text });
    await expect(remote).toBeVisible({ timeout: 30_000 });
    await expect(remote.locator('script')).toHaveCount(0);
    await expect(remote.getByRole('button', { name: 'Delete reply', exact: true })).toHaveCount(0);
    const authorId = await remote.getAttribute('data-author-id');
    await expect(alice.locator('.comment-pin')).toHaveCount(1);
    await expect(alice.locator('.comment-pin__reply-count')).toHaveText('1');
    await alice.getByLabel('Reply', { exact: true }).fill('Agreed, and allow a nullable backup email.');
    await bob.getByLabel('Reply', { exact: true }).fill('We should keep the customer ID too.');
    await Promise.all([
      alice.getByRole('button', { name: 'Reply', exact: true }).click(),
      bob.getByRole('button', { name: 'Reply', exact: true }).click(),
    ]);
    await expect(alice.locator('.comment-replies > li')).toHaveCount(3);
    await expect(bob.locator('.comment-replies > li')).toHaveCount(3);

    await bob.getByLabel('Reply', { exact: true }).fill('Draft for the email thread');
    await alice.getByRole('button', { name: 'Comment tool', exact: true }).click();
    await alice.mouse.click(650, 480);
    await alice.getByLabel('New comment', { exact: true }).fill('Review order totals separately.');
    await alice.getByRole('button', { name: 'Post comment', exact: true }).click();
    const second = bob.locator(`.comment-pin:not([data-comment-id="${rootId}"])`);
    await expect(second).toHaveCount(1);
    await bob.getByRole('button', { name: 'Close comment', exact: true }).click();
    await second.click();
    await expect(bob.getByLabel('Reply', { exact: true })).toHaveValue('');
    await bob.getByRole('button', { name: 'Close comment', exact: true }).click();
    await bob.locator(`.comment-pin[data-comment-id="${rootId}"]`).click();
    await expect(bob.getByLabel('Reply', { exact: true })).toHaveValue('Draft for the email thread');

    const anotherDiagram = await guest.newPage();
    await anotherDiagram.goto('/');
    await expect(anotherDiagram.getByLabel('Diagram name')).toBeEnabled();
    await rename(anotherDiagram, 'Ada');
    await alice.getByRole('button', { name: 'Close comment', exact: true }).click();
    await alice.locator(`.comment-pin[data-comment-id="${rootId}"]`).click();
    await expect(remote).toContainText('Posted as Morgan');
    await expect(remote).toHaveAttribute('data-author-id', authorId!);
    await expect(remote.getByRole('button', { name: 'Delete reply', exact: true })).toHaveCount(0);
    await alice.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await alice.getByRole('dialog', { name: 'Delete comment?', exact: true }).getByRole('button', { name: 'Delete comment', exact: true }).click();
    await expect(popover(bob)).toContainText('Comment deleted by its author.');
    await expect(bob.locator('.comment-replies > li')).toHaveCount(3);
    await expect(bob.getByLabel('Reply', { exact: true })).toHaveValue('Draft for the email thread');
    await bob.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(alice.locator('.comment-replies > li')).toHaveCount(4);
    const own = bob.locator('.comment-message').filter({ hasText: text });
    await own.getByRole('button', { name: 'Delete reply', exact: true }).click();
    const modal = bob.getByRole('dialog', { name: 'Delete reply?', exact: true });
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(own).toBeVisible();
    await own.getByRole('button', { name: 'Delete reply', exact: true }).click();
    await modal.getByRole('button', { name: 'Delete reply', exact: true }).click();
    await expect(remote).toHaveCount(0);
    await expect(bob.locator('.comment-replies > li')).toHaveCount(3);
    await bob.reload();
    await expect(bob.getByLabel('Diagram name')).toBeEnabled();
    await bob.locator(`.comment-pin[data-comment-id="${rootId}"]`).click();
    await expect(popover(bob)).toContainText('Draft for the email thread');
    await expect(popover(bob)).toContainText('Comment deleted by its author.');
    await expect(bob.locator('.comment-replies > li')).toHaveCount(3);
  } finally { await Promise.allSettled([owner.close(), guest.close()]); }
});

async function rename(page: Page, name: string) {
  await page.getByRole('button', { name: 'Diagram actions', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Your name:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Your name', exact: true });
  await dialog.getByLabel('Your name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

test('the default comment flow pins feedback and preserves authors through cross-diagram renames', async ({ browser }) => {
  const owner = await signalingContext(browser);
  const other = await signalingContext(browser);
  try {
    const alice = await owner.newPage();
    await alice.goto('/');
    await expect(alice.getByLabel('Diagram name')).toBeEnabled();
    await rename(alice, 'Original name');
    await commentsButton(alice).click();
    await expect(alice.getByRole('button', { name: 'Comment tool', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(alice.getByLabel('New comment', { exact: true })).toHaveCount(0);
    await alice.mouse.click(480, 370);
    const text = '<script>alert(1)</script>\nPlease check the customer key.';
    await alice.getByLabel('New comment', { exact: true }).fill(text);
    await alice.getByRole('button', { name: 'Post comment', exact: true }).click();
    const original = alice.locator('.comment-item').filter({ hasText: text });
    const authorId = await original.getAttribute('data-author-id');
    await expect(alice.locator('.comment-pin:not(.comment-pin--draft)')).toHaveCount(1);
    await expect(popover(alice)).toContainText(text);

    await documentAction(alice, 'Share');
    const link = await alice.getByLabel('Share link').inputValue();
    await alice.getByRole('button', { name: 'Done', exact: true }).click();
    const bob = await other.newPage();
    await bob.goto(link);
    await expect(bob.getByLabel('Diagram name')).toBeEnabled();
    await rename(bob, 'Original name');
    await commentsButton(bob).click();
    const remote = bob.locator('.comment-item').filter({ hasText: text });
    await remote.getByRole('button').click();
    await expect(popover(bob).getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    await expect(popover(bob).locator('script')).toHaveCount(0);

    const anotherDiagram = await owner.newPage();
    await anotherDiagram.goto('/');
    await expect(anotherDiagram.getByLabel('Diagram name')).toBeEnabled();
    await rename(anotherDiagram, 'Renamed in another diagram');
    await expect(original.locator('.comment-author strong')).toHaveText('Renamed in another diagram');
    await expect(remote.locator('.comment-author strong')).toHaveText('Renamed in another diagram', { timeout: 30_000 });
    await expect(remote).toContainText('Posted as Original name');
    await alice.close();
    await rename(anotherDiagram, 'Changed before rejoining');
    const returned = await owner.newPage();
    await returned.goto(link);
    await expect(returned.getByLabel('Diagram name')).toBeEnabled();
    await commentsButton(returned).click();
    const restored = returned.locator('.comment-item').filter({ hasText: text });
    await expect(restored.locator('.comment-author strong')).toHaveText('Changed before rejoining');
    await expect(restored).toHaveAttribute('data-author-id', authorId!);
    await restored.getByRole('button').click();
    await expect(popover(returned)).toContainText('Posted as Original name');
    await rename(bob, 'Changed before rejoining');
    await expect(popover(bob).getByRole('button', { name: 'Delete comment' })).toHaveCount(0);

    const dialogs: string[] = [];
    returned.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await popover(returned).getByRole('button', { name: 'Delete comment', exact: true }).click();
    const confirmation = returned.getByRole('dialog', { name: 'Delete comment?', exact: true });
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await returned.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(restored).toBeVisible();
    await popover(returned).getByRole('button', { name: 'Delete comment', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Delete comment', exact: true }).click();
    await expect(restored).toHaveCount(0);
    await expect(remote).toHaveCount(0);
    expect(dialogs).toEqual([]);
    await returned.reload();
    await expect(returned.locator('.comment-pin:not(.comment-pin--draft)')).toHaveCount(0);
  } finally { await Promise.allSettled([owner.close(), other.close()]); }
});

test('thread controls remain visible at 200% zoom', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByRole('button', { name: 'Comment tool', exact: true }).click();
  await page.keyboard.press('Enter');
  await page.getByLabel('New comment', { exact: true }).fill('Review at a larger text size');
  await page.getByRole('button', { name: 'Post comment', exact: true }).click();
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await expect.poll(async () => {
    const box = (await popover(page).boundingBox())!;
    const size = page.viewportSize()!;
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
  }).toBe(true);
  await page.getByLabel('Reply', { exact: true }).fill('Readable and reachable');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(popover(page).getByText('Readable and reachable', { exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Close comment', exact: true }).click();
  await expect(popover(page)).toHaveCount(0);
});

for (const notation of ['Chen', "Crow's-foot"] as const) {
  test(`${notation} pins keep their coordinates and open an anchored composer`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add your first entity', exact: true }).click();
    await inspectSelection(page);
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.getByRole('button', { name: notation, exact: true }).click();
    const shape = page.locator('[data-node-id]').first();
    const shapeTransform = await shape.getAttribute('transform');
    const box = (await shape.boundingBox())!;
    const point = { x: box.x + 35, y: box.y + 20 };
    await page.getByRole('button', { name: 'Comment tool', exact: true }).click();
    const world = await page.locator('[data-viewport]').evaluate((node, point) => {
      const value = new DOMPoint(point.x, point.y).matrixTransform((node as SVGGElement).getScreenCTM()!.inverse());
      return { x: value.x, y: value.y };
    }, point);
    await page.mouse.click(point.x, point.y);
    const input = page.getByLabel('New comment', { exact: true });
    await expect(input).toBeFocused();
    const composerBox = (await popover(page).boundingBox())!;
    expect(Math.min(Math.abs(composerBox.x - point.x), Math.abs(composerBox.x + composerBox.width - point.x))).toBeLessThan(60);
    expect(composerBox.y).toBeGreaterThanOrEqual(60);
    await expect(shape).toHaveAttribute('transform', shapeTransform!);
    await input.fill(`Review this ${notation} location`);
    await input.press('Control+Enter');
    const pin = page.locator('.comment-pin:not(.comment-pin--draft)');
    await expect(pin).toHaveCount(1);
    const before = await pin.getAttribute('transform');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(pin).not.toHaveAttribute('transform', before!);
    const hitbox = (await pin.locator('.hit-target').boundingBox())!;
    expect(hitbox.width).toBeCloseTo(44, 1);
    await documentAction(page, 'Share');
    const shared = parseShareHash(new URL(await snapshotShareLink(page)).hash)!;
    const location = shared.doc!.comments[0]!.location!;
    expect(location.view).toBe(notation === 'Chen' ? 'chen' : 'crowfoot');
    expect(location.x).toBeCloseTo(world.x, 0);
    expect(location.y).toBeCloseTo(world.y, 0);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: notation === 'Chen' ? "Crow's-foot" : 'Chen', exact: true }).click();
    await expect(pin).toHaveCount(0);
    await expect(popover(page)).toHaveCount(0);
    await page.getByRole('button', { name: notation, exact: true }).click();
    await page.reload();
    await expect(pin).toHaveCount(1);
    await pin.press('Enter');
    await expect(popover(page)).toContainText(`Review this ${notation} location`);
  });
}

test('drafts survive moving pins, cancelling and switching panels; Ctrl+Enter respects composition', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByTestId('canvas').focus();
  await page.keyboard.press('m');
  await page.keyboard.press('Enter');
  const input = page.getByLabel('New comment', { exact: true });
  await expect(input).toBeFocused();
  await input.fill('   ');
  await expect(page.getByRole('button', { name: 'Post comment', exact: true })).toBeDisabled();
  await input.fill('A draft worth keeping');
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  await expect(page.locator('.comment-pin:not(.comment-pin--draft)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move pin', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Continue draft', exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue draft', exact: false }).click();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('A draft worth keeping');
  await page.getByRole('button', { name: 'Close comment', exact: true }).click();
  await page.getByRole('navigation', { name: 'Workspace panels' }).getByRole('button', { name: 'Help', exact: true }).click();
  await commentsButton(page).click();
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('A draft worth keeping');
  await input.press('Control+Enter');
  await expect(popover(page)).toContainText('A draft worth keeping');
  await expect(page.locator('.comment-pin:not(.comment-pin--draft)')).toHaveCount(1);
});

test('the comments list searches, filters by notation and jumps to the right pin', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  for (const notation of ['Chen', "Crow's-foot"] as const) {
    await page.getByRole('button', { name: notation, exact: true }).click();
    await page.getByRole('button', { name: 'Comment tool', exact: true }).click();
    await page.keyboard.press('Enter');
    await page.getByLabel('New comment', { exact: true }).fill(`${notation} feedback`);
    await page.getByRole('button', { name: 'Post comment', exact: true }).click();
    await page.getByRole('button', { name: 'Close comment', exact: true }).click();
  }
  await commentsButton(page).click();
  await expect(page.locator('.comment-item')).toHaveCount(2);
  await page.getByRole('button', { name: 'This view', exact: true }).click();
  await expect(page.locator('.comment-item')).toHaveCount(1);
  await expect(page.locator('.comment-item')).toContainText("Crow's-foot feedback");
  await page.getByRole('button', { name: 'All comments', exact: true }).click();
  await page.getByLabel('Search comments', { exact: true }).fill('chen FEEDBACK');
  await expect(page.locator('.comment-item')).toHaveCount(1);
  await page.locator('.comment-item').getByRole('button').click();
  await expect(page.getByRole('button', { name: 'Chen', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(popover(page)).toContainText('Chen feedback');
  await expect(page.locator('.comment-pin--selected')).toHaveCount(1);
  await page.getByLabel('Search comments', { exact: true }).fill('not a comment');
  await expect(page.getByText('No matching comments', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.comment-item')).toHaveCount(2);
});

test.describe('touch comments', () => {
  test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

  test('the default tap-to-pin flow and delete modal fit a small phone', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await commentsButton(page).tap();
    await expect(page.getByLabel('New comment', { exact: true })).toHaveCount(0);
    await page.touchscreen.tap(160, 290);
    const input = page.getByLabel('New comment', { exact: true });
    await expect(input).toBeFocused();
    await input.fill('Touch pin');
    const composer = (await popover(page).boundingBox())!;
    expect(composer.x).toBeGreaterThanOrEqual(0);
    expect(composer.x + composer.width).toBeLessThanOrEqual(320);
    expect(composer.y + composer.height).toBeLessThanOrEqual(640);
    const draftPin = (await page.locator('.comment-pin--draft').boundingBox())!;
    expect(draftPin.y + draftPin.height).toBeLessThanOrEqual(composer.y);
    await page.getByRole('button', { name: 'Post comment', exact: true }).tap();
    await page.getByRole('button', { name: 'Close comment', exact: true }).tap();
    const pin = page.locator('.comment-pin:not(.comment-pin--draft)');
    expect((await pin.locator('.hit-target').boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await pin.tap();
    await page.getByRole('button', { name: 'Delete comment', exact: true }).tap();
    const modal = page.getByRole('dialog', { name: 'Delete comment?', exact: true });
    const box = (await modal.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(pin).toHaveCount(1);
    await page.getByRole('button', { name: 'Delete comment', exact: true }).tap();
    await modal.getByRole('button', { name: 'Delete comment', exact: true }).tap();
    await expect(pin).toHaveCount(0);
  });

  test('a long thread keeps the reply box reachable with the phone keyboard open', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await commentsButton(page).tap();
    await page.touchscreen.tap(160, 290);
    await page.getByLabel('New comment', { exact: true }).fill('Phone thread');
    await page.getByRole('button', { name: 'Post comment', exact: true }).tap();
    for (let i = 1; i <= 7; i += 1) {
      await page.getByLabel('Reply', { exact: true }).fill(`Phone reply ${i}: keep the email column unique and review its nullability.`);
      await page.getByRole('button', { name: 'Reply', exact: true }).tap();
    }
    const history = page.locator('.comment-thread-scroll');
    await history.evaluate(node => { node.scrollTop = 0; });
    await expect(page.getByRole('button', { name: 'Jump to latest reply', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Jump to latest reply', exact: true }).tap();
    await expect(page.locator('.comment-message').filter({ hasText: 'Phone reply 7:' })).toBeInViewport();
    await page.getByLabel('Reply', { exact: true }).fill('Reply with the keyboard open');
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { value: 400, configurable: true });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => (await popover(page).boundingBox())!.y + (await popover(page).boundingBox())!.height).toBeLessThanOrEqual(400);
    await expect(page.getByLabel('Reply', { exact: true })).toBeInViewport();
    const submit = page.getByRole('button', { name: 'Reply', exact: true });
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await submit.tap();
    await expect(page.locator('.comment-replies > li')).toHaveCount(8);
    await expect(page.getByLabel('Reply', { exact: true })).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });

  test('a pinch in comment mode zooms without accidentally placing a pin', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await commentsButton(page).tap();
    const viewport = page.locator('[data-viewport]');
    const before = await viewport.getAttribute('transform');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 300, id: 1 }, { x: 200, y: 300, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 60, y: 300, id: 1 }, { x: 240, y: 300, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(viewport).not.toHaveAttribute('transform', before!);
    await expect(page.locator('.comment-pin--draft')).toHaveCount(0);
    await expect(popover(page)).toHaveCount(0);
  });
});
