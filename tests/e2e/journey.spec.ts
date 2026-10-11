/**
 * New-user journey.
 *
 * Counts the actual interactions needed to reach a finished diagram, rather
 * than asserting that features exist. A feature can be present and the tool
 * still be hard, so the number of steps is the thing worth measuring.
 *
 * The journey is deliberately the obvious one a newcomer would try: make two
 * entities, give them keys, relate them. The total is broken down per stage so a
 * regression says which part got harder rather than just "more than before".
 */

import { expect, test, type Page } from '@playwright/test';

const canvas = (page: Page) => page.getByTestId('canvas');
const node = (page: Page, label: string | RegExp) =>
  canvas(page).getByRole('button', { name: label });
const relationshipLines = (page: Page) =>
  page.locator('.layer-legs line.leg:not(.leg--attribute)');

/**
 * Counts deliberate actions: every click, and every key press made outside a
 * text field.
 *
 * Typing a name counts as nothing, because it is one intent rather than nine
 * keystrokes — counting characters would make this a proxy for how long the
 * words in the sample diagram happen to be, which says nothing about whether
 * the tool is easy. Modifier-only presses are skipped for the same reason.
 *
 * Must be registered before navigation: `addInitScript` only applies to
 * subsequent loads, so a counter installed afterwards reports zero and would
 * satisfy any budget without measuring anything.
 */
async function countInteractions(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __interactions?: number };
    w.__interactions = 0;
    document.addEventListener(
      'click',
      () => {
        w.__interactions = (w.__interactions ?? 0) + 1;
      },
      true,
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        const target = e.target as HTMLElement | null;
        const typing =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target?.isContentEditable === true;
        // Text entry is part of naming a shape, not a separate navigation.
        if (typing) return;
        w.__interactions = (w.__interactions ?? 0) + 1;
      },
      true,
    );
  });
  return async () =>
    page.evaluate(() => (window as unknown as { __interactions?: number }).__interactions ?? 0);
}

/**
 * Presses on one shape, releases on another: the Connect tool's own gesture.
 * The connection is committed on pointer release.
 */
async function dragOnto(page: Page, from: RegExp, to: RegExp): Promise<void> {
  const a = (await node(page, from).boundingBox())!;
  const b = (await node(page, to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('new user journey', () => {
  test('builds a two-table schema without hunting', async ({ page }) => {
    const count = await countInteractions(page);

    await page.goto('/');
    await expect(page.getByTestId('canvas')).toBeVisible();
    await page.waitForTimeout(250);

    // Prove the counter records before trusting its verdict.
    await page.keyboard.press('Escape');
    expect(await count(), 'interaction counter is not recording').toBe(1);

    const stages: [string, number][] = [];
    let spent = await count();
    const mark = async (label: string): Promise<void> => {
      const now = await count();
      stages.push([label, now - spent]);
      spent = now;
    };

    // 1. First entity: press E, type the name.
    await page.keyboard.press('e');
    await page.keyboard.type('Customer');
    await page.keyboard.press('Escape');
    await mark('entity 1: add + name');

    // 2. Its key.
    await page.keyboard.press('a');
    await page.keyboard.type('customer_id');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await mark('attribute: add + name + mark key');

    // 3. Second entity and its key.
    await page.keyboard.press('e');
    await page.keyboard.type('Order');
    await page.keyboard.press('Escape');
    await page.keyboard.press('a');
    await page.keyboard.type('order_id');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Key', exact: true }).click();
    await mark('entity 2 + attribute + key');

    // 4. The relationship.
    await page.keyboard.press('r');
    await page.keyboard.type('places');
    await page.keyboard.press('Escape');
    await mark('relationship: add + name');

    // 5. Connect. Adding a relationship already started the gesture from it, and
    // each completed leg stays on the diamond, so two drags finish the chain.
    await page.getByRole('button', { name: 'Auto-arrange' }).click();
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Connect tool' }).click();
    await dragOnto(page, /Relationship places/i, /Entity Customer/i);
    await dragOnto(page, /Relationship places/i, /Entity Order/i);
    await mark('tidy + connect two entities');

    const total = await count();
    console.log('INTERACTIONS BY STAGE:');
    for (const [label, n] of stages) console.log(`  ${String(n).padStart(3)}  ${label}`);
    console.log(`  ${String(total).padStart(3)}  TOTAL`);

    // The diagram is correct.
    await expect(relationshipLines(page)).toHaveCount(2);
    await expect(node(page, /Entity Customer/i)).toBeVisible();
    await expect(node(page, /Relationship places/i)).toBeVisible();

    // The budget. Every step should be one intent — add, name, mark key,
    // connect — with no hunting and no re-selecting.
    //
    // Twelve, not eleven: Shift-click used to connect, and Shift now extends the
    // selection, so connecting costs one tool switch. That switch is paid once
    // per editing session, not once per relationship, and it is what puts the
    // line on screen before it is committed. Everything else is unchanged, and
    // the count is still well under what the same diagram costs in most tools.
    expect(total, `journey took ${total} interactions`).toBeLessThanOrEqual(12);
  });
});
