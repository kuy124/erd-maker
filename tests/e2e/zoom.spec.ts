import { expect, test } from '@playwright/test';

for (const notation of ['Chen', "Crow's-foot"]) {
  test(`${notation} two-finger pinch zooms without dragging shapes`, async ({ page, context }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add your first entity', exact: true }).click();
    await page.getByLabel('Entity name').fill('Pinch target');
    await page.getByRole('button', { name: 'Close panel', exact: true }).click();
    await page.getByRole('button', { name: notation, exact: true }).click();
    const shape = page.locator('[data-node-id]').first();
    const original = await shape.getAttribute('transform');
    const viewport = page.locator('[data-viewport]');
    const before = await viewport.getAttribute('transform');
    const client = await context.newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 350, id: 1 }, { x: 600, y: 350, id: 2 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 450, y: 350, id: 1 }, { x: 650, y: 350, id: 2 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(viewport).not.toHaveAttribute('transform', before!);
    await expect(shape).toHaveAttribute('transform', original!);
  });
  test(`${notation} wheel zoom is continuous, anchored, and bounded`, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Diagram name')).toBeEnabled();
    await page.getByRole('button', { name: notation, exact: true }).click();
    const viewport = page.locator('[data-viewport]');
    const read = async () => (await viewport.getAttribute('transform'))!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const before = await read();
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -10);
    await expect.poll(async () => (await read())[2]).toBeGreaterThan(before[2]!);
    const after = await read();
    expect(after[2]! / before[2]!).toBeLessThan(1.1);
    expect((400 - after[0]!) / after[2]!).toBeCloseTo((400 - before[0]!) / before[2]!, 5);
    expect((300 - after[1]!) / after[2]!).toBeCloseTo((300 - before[1]!) / before[2]!, 5);
    await page.mouse.wheel(0, -10000);
    await expect.poll(async () => (await read())[2]).toBe(3);
    await page.mouse.wheel(0, 10000);
    await expect.poll(async () => (await read())[2]).toBe(0.25);
  });
}
