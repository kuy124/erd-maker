import { expect, test } from '@playwright/test';
import { emptyDocument } from '../../src/model/types';
import { importDocument, inspectSelection } from './actions';

for (const notation of ['Chen', "Crow's-foot"]) {
  test(`${notation} two-finger pinch zooms without dragging shapes`, async ({ page, context }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Add your first entity', exact: true }).click();
    await inspectSelection(page);
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
    await expect.poll(async () => (await read())[2]).toBe(0.01);
  });
}

test('Auto Arrange fits a complex 30-entity Chen diagram below 25% without cropping nodes', async ({ page }) => {
  const doc = emptyDocument('Dense Chen overview');
  for (let i = 0; i < 30; i++) {
    const id = `e${i}`;
    doc.entities.push({ id, name: `Entity ${i}`, kind: 'strong', x: i * 5000, y: -i * 3000,
      crowX: i * 750, crowY: i * 100 });
    for (let a = 0; a < 8; a++) doc.attributes.push({ id: `${id}-a${a}`, name: `Field ${a}`, ownerId: id,
      kind: a ? 'simple' : 'key', x: 0, y: 0 });
    if (!i) continue;
    for (const parent of new Set([i - 1, Math.max(0, i - 5)])) {
      const rel = `r${i}-${parent}`;
      doc.relationships.push({ id: rel, name: 'connects', kind: 'strong', x: 0, y: 0 });
      doc.legs.push({ id: `${rel}-a`, fromId: `e${parent}`, toId: rel, cardinality: '1', participation: { min: 0, max: 1 } },
        { id: `${rel}-b`, fromId: rel, toId: id, cardinality: 'N', participation: { min: 0, max: 'N' } });
    }
  }
  await page.goto('/');
  await importDocument(page, doc);
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).first().click();
  const viewport = page.locator('[data-viewport]');
  await expect.poll(() => viewport.evaluate(node => {
    const bounds = (node as SVGGraphicsElement).getBBox();
    return Math.max(bounds.width / 6000, bounds.height / 5000);
  })).toBeLessThan(1);
  const zoom = () => viewport.evaluate(node => (node as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix.a);
  await expect.poll(zoom).toBeLessThan(0.25);
  const canvas = await page.getByTestId('canvas').boundingBox();
  const nodes = page.locator('[data-node-id]');
  await expect(nodes).toHaveCount(doc.entities.length + doc.relationships.length + doc.attributes.length);
  for (const rect of await nodes.evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect();
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
  }))) {
    expect(rect.x).toBeGreaterThanOrEqual(canvas!.x);
    expect(rect.y).toBeGreaterThanOrEqual(canvas!.y);
    expect(rect.right).toBeLessThanOrEqual(canvas!.x + canvas!.width);
    expect(rect.bottom).toBeLessThanOrEqual(canvas!.y + canvas!.height);
  }
  const fitted = await zoom();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(zoom).toBeLessThan(fitted);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  for (const entity of doc.entities) expect(await page.locator(`[data-node-id="${entity.id}"]`).evaluate(node => {
    const matrix = (node as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix;
    return [matrix.e, matrix.f];
  })).toEqual([entity.crowX, entity.crowY]);
});
