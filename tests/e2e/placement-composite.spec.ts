import { expect, test, type Page } from '@playwright/test';
import { importDocument, inspectSelection, pointAtLocalSignaling, shape, readDownload } from './actions';
import { emptyDocument } from '../../src/model/types';

function schema() {
  const doc = emptyDocument('Placement regression');
  doc.view = 'crowfoot';
  doc.entities = [
    { id: 'a', name: 'Alpha', kind: 'strong', x: 900, y: 900, crowX: 100, crowY: 100 },
    { id: 'b', name: 'Beta', kind: 'strong', x: 1700, y: 900, crowX: 700, crowY: 100 },
  ];
  doc.relationships = [{ id: 'r', name: 'owns', x: 0, y: 0, kind: 'strong' }];
  doc.legs = [
    { id: 'la', fromId: 'r', toId: 'a', cardinality: '1', participation: { min: 1, max: 1 } },
    { id: 'lb', fromId: 'r', toId: 'b', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  return doc;
}

async function position(page: Page, name: string) {
  return page.getByTestId('table-' + name).evaluate(el => {
    const t = (el as unknown as SVGGraphicsElement).transform.baseVal.getItem(0).matrix;
    return { x: t.e, y: t.f };
  });
}

async function dragHeader(page: Page, name: string, dx: number, dy: number) {
  const box = (await page.getByTestId('table-' + name).getByRole('button', { name: 'Table ' + name, exact: true }).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
}

test.beforeEach(async ({ page, context }) => {
  await pointAtLocalSignaling(context);
  await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
});

test('repeated table drags use table coordinates and undo independently of Chen', async ({ page }) => {
  await importDocument(page, schema());
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  await dragHeader(page, 'Alpha', 60, 30);
  await expect.poll(() => position(page, 'Alpha')).toEqual({ x: 160, y: 130 });
  await dragHeader(page, 'Alpha', 40, -20);
  await expect.poll(() => position(page, 'Alpha')).toEqual({ x: 200, y: 110 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => position(page, 'Alpha')).toEqual({ x: 160, y: 130 });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.getByRole('button', { name: 'Chen', exact: true }).click();
  await expect(shape(page, 'Entity Alpha')).toHaveAttribute('transform', 'translate(900 900)');
});

for (const zoomAction of ['Fit', 'Zoom in', 'Zoom out']) test(`connector paths end at rows and bends follow the pointer after ${zoomAction}`, async ({ page }) => {
  await importDocument(page, schema());
  if (zoomAction !== 'Fit') {
    await page.getByRole('button', { name: zoomAction, exact: true }).click();
    await page.getByRole('button', { name: zoomAction, exact: true }).click();
  }
  const link = page.getByTestId('crow-link-r');
  await link.focus(); await page.keyboard.press('Enter');
  const path = link.locator('.crow-link__path');
  const endpoint = await path.evaluate(el => {
    const p = el as SVGPathElement;
    const end = p.getPointAtLength(p.getTotalLength());
    return { x: end.x, y: end.y };
  });
  expect(endpoint).toEqual({ x: 700, y: 210 });
  const handle = page.locator('.crow-link__bend');
  const before = await handle.evaluate(el => ({ x: Number(el.getAttribute('cx')), y: Number(el.getAttribute('cy')) }));
  const scale = await page.locator('[data-viewport]').evaluate(el => (el as unknown as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix.a);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 - 60, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => handle.getAttribute('cx')).toBe(String(Math.round(before.x + 40 / scale)));
  await expect.poll(() => handle.getAttribute('cy')).toBe(String(Math.round(before.y - 60 / scale)));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => handle.getAttribute('cx')).toBe(String(before.x));
});

test('a composite owns children, draws them in Chen, and exports prefixed leaves', async ({ page }) => {
  const doc = schema(); doc.view = 'chen';
  doc.attributes = [{ id: 'address', name: 'Address', x: 1100, y: 900, kind: 'composite', ownerId: 'a' }];
  await importDocument(page, doc);
  await shape(page, 'Attribute Address, composite').click(); await inspectSelection(page);
  await page.getByRole('button', { name: 'Add attribute', exact: true }).click();
  await page.getByLabel('Attribute name').fill('Street');
  await expect(page.getByLabel('Belongs to')).toHaveValue('address');
  await expect(page.locator('[data-attribute-link]')).toHaveCount(2);
  await shape(page, 'Attribute Address, composite').click();
  await expect(page.getByRole('button', { name: 'Simple', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit attribute address_street', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('tab', { name: 'SQL', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Download/ }).click();
  expect(await readDownload(await download)).toContain('"address_street"');
});

test('automatic placement fills missing table positions without overlapping settled tables', async ({ page }) => {
  const doc = schema();
  doc.relationships = []; doc.legs = [];
  // Beta's automatic slot is (0, 208); Alpha was manually moved into it.
  doc.entities[0]!.crowX = 0; doc.entities[0]!.crowY = 208;
  delete doc.entities[1]!.crowX; delete doc.entities[1]!.crowY;
  await importDocument(page, doc);
  await expect(page.getByTestId('table-Beta')).toBeVisible();
  await expect.poll(() => position(page, 'Alpha')).toEqual({ x: 0, y: 208 });
  const boxes = await page.locator('[data-node-id] .node__body').evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  }));
  const [a, b] = boxes;
  expect(a!.x < b!.x + b!.w && a!.x + a!.w > b!.x && a!.y < b!.y + b!.h && a!.y + a!.h > b!.y).toBe(false);
});

test('cancelled bends leave saved geometry unchanged and pan works on their handles', async ({ page }) => {
  await importDocument(page, schema());
  const link = page.getByTestId('crow-link-r');
  await link.focus(); await page.keyboard.press('Enter');
  const handle = page.locator('.crow-link__bend');
  const path = await link.locator('.crow-link__path').getAttribute('d');
  for (const cancel of ['escape', 'pointercancel'] as const) {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 30, y - 50, { steps: 4 });
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await page.mouse.up();
    await expect(link.locator('.crow-link__path')).toHaveAttribute('d', path!);
    await link.focus(); await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
  const before = await page.locator('[data-viewport]').getAttribute('transform');
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 30, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('[data-viewport]')).not.toHaveAttribute('transform', before!);
  await expect(link.locator('.crow-link__path')).toHaveAttribute('d', path!);
});

test('route controls clear manual bends and SVG export includes their bounds', async ({ page }) => {
  // Keep the exported bend outside Alpha's protected 36-unit symbol stub.
  const doc = schema(); doc.relationships[0]!.bendX = 500; doc.relationships[0]!.bendY = -700;
  await importDocument(page, doc);
  const link = page.getByTestId('crow-link-r');
  await link.focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download SVG', exact: true }).click();
  const svg = await readDownload(await download);
  const minY = Number(/viewBox="[^ ]+ ([^ ]+)/.exec(svg)![1]);
  expect(minY).toBeLessThan(-700);
  expect(svg).not.toContain('class="crow-link__bend');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await inspectSelection(page);
  const path = await link.locator('.crow-link__path').getAttribute('d');
  await page.getByTestId('rel-route-auto').click();
  await expect(link.locator('.crow-link__path')).not.toHaveAttribute('d', path!);
  await expect(page.locator('.crow-link__bend')).not.toHaveAttribute('cy', '-700');
});

test('grouped tables retain their offsets through a drag', async ({ page }) => {
  const doc = schema(); doc.groups = [{ id: 'g', name: 'Billing', memberIds: ['a', 'b'] }];
  await importDocument(page, doc);
  await page.getByRole('button', { name: 'Reset zoom to 100%' }).click();
  await dragHeader(page, 'Alpha', 50, 20);
  await expect.poll(() => position(page, 'Alpha')).toEqual({ x: 150, y: 120 });
  await expect.poll(() => position(page, 'Beta')).toEqual({ x: 750, y: 120 });
});

test('nested composites carry descendants, delete and undo as a subtree, and survive reload', async ({ page }) => {
  const doc = schema(); doc.view = 'chen';
  doc.attributes = [
    { id: 'street', name: 'Street', kind: 'key', ownerId: 'address', x: 1400, y: 900 },
    { id: 'address', name: 'Address', kind: 'composite', ownerId: 'billing', x: 1200, y: 900 },
    { id: 'billing', name: 'Billing', kind: 'composite', ownerId: 'a', x: 1000, y: 900 },
  ];
  await importDocument(page, doc);
  await expect(shape(page, 'Attribute Billing, composite')).toBeVisible();
  const scale = await page.locator('[data-viewport]').evaluate(el => (el as unknown as SVGGraphicsElement).transform.baseVal.consolidate()!.matrix.a);
  const box = (await shape(page, 'Attribute Billing, composite').boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 80 * scale, y + 20 * scale, { steps: 5 }); await page.mouse.up();
  for (const [id, expectedX] of [['billing', 1080], ['address', 1280], ['street', 1480]] as const) {
    const p = await page.locator(`[data-node-id="${id}"]`).evaluate(el => {
      const matrix = (el as unknown as SVGGraphicsElement).transform.baseVal.getItem(0).matrix;
      return { x: matrix.e, y: matrix.f };
    });
    expect(p.x).toBeCloseTo(expectedX); expect(p.y).toBeCloseTo(920);
  }
  await shape(page, 'Attribute Billing, composite').focus(); await page.keyboard.press('Delete');
  await expect(page.locator('[data-attribute-link]')).toHaveCount(0);
  await page.getByRole('toolbar', { name: 'Diagram tools' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-attribute-link]')).toHaveCount(3);
  await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit attribute billing_address_street', exact: true })).toBeVisible();
});

test('a new table keeps the requested canvas position and creation undoes in one step', async ({ page }) => {
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  const canvas = page.getByTestId('canvas');
  const rect = (await canvas.boundingBox())!;
  const x = rect.x + rect.width * 0.75, y = rect.y + rect.height * 0.7;
  const world = await page.locator('[data-viewport]').evaluate((el, client) => {
    const matrix = (el as unknown as SVGGraphicsElement).getScreenCTM()!.inverse();
    const point = new DOMPoint(client.x, client.y).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  }, { x, y });
  await page.mouse.click(x, y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'New entity', exact: true }).click();
  // Crow creation uses a 280×88 placement box, centered at the requested point.
  await expect.poll(async () => (await position(page, 'New entity')).x).toBeCloseTo(world.x - 140);
  await expect.poll(async () => (await position(page, 'New entity')).y).toBeCloseTo(world.y - 44);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-node-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await position(page, 'New entity')).x).toBeCloseTo(world.x - 140);
  await expect.poll(async () => (await position(page, 'New entity')).y).toBeCloseTo(world.y - 44);
});
