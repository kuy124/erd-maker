import { expect, test, type Locator, type Page } from '@playwright/test';
import { emptyDocument } from '../../src/model/types';
import { importDocument, pointAtLocalSignaling, signalingContext } from './actions';
import { orthogonalPoints } from '../unit/svgPath';

async function open(page: Page, manual = true) {
  await page.goto('/'); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  const doc = emptyDocument(); doc.view = 'crowfoot';
  doc.entities = [
    { id: 'a', name: 'A', x: 0, y: 0, crowX: 100, crowY: 100, kind: 'strong' },
    { id: 'b', name: 'B', x: 0, y: 0, crowX: 700, crowY: 100, kind: 'strong' },
  ];
  doc.relationships = [{ id: 'r', name: 'owns', x: 0, y: 0, kind: 'strong',
    ...(manual ? { bendX: 500, bendY: -200 } : {}) }];
  doc.legs = [
    { id: 'a-leg', fromId: 'r', toId: 'a', cardinality: '1', participation: { min: 1, max: 1 } },
    { id: 'b-leg', fromId: 'r', toId: 'b', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  await importDocument(page, doc);
  await expect(page.getByTestId('crow-link-r')).toBeVisible();
}

/** A vertical segment well away from the optional bend dot and its label. */
async function grabPoint(page: Page) {
  return page.getByTestId('crow-link-r').locator('.crow-link__path').evaluate(el => {
    const matrix = (el as SVGPathElement).getScreenCTM()!;
    const point = new DOMPoint(500, 20).matrixTransform(matrix);
    return { x: point.x, y: point.y, scale: matrix.a };
  });
}

async function dragInsert(page: Page, control: Locator, distance = 32) {
  const p = await control.evaluate(el => {
    const matrix = (el as SVGGraphicsElement).getScreenCTM()!;
    const screen = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: screen.x, y: screen.y, scale: matrix.a, horizontal: el.getAttribute('aria-label')!.includes('horizontal') };
  });
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + (p.horizontal ? 0 : distance * p.scale), p.y + (p.horizontal ? distance * p.scale : 0), { steps: 5 });
  await page.mouse.up();
}

test.beforeEach(async ({ context, page }) => { await pointAtLocalSignaling(context); await open(page); });

test('dbdiagram controls offer two halves, ignore plain clicks, and keep the dragged section handle under the pointer', async ({ page }) => {
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const before = await path.getAttribute('d'), point = await grabPoint(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.dblclick(point.x, point.y);
  await expect(path).toHaveAttribute('d', before!);
  await expect(page.locator('.crow-link__corner-handle')).toHaveCount(0);
  const inserts = page.getByRole('button', { name: /^Split vertical segment 2/ });
  await expect(inserts).toHaveCount(2);
  const control = inserts.first();
  await control.click(); await expect(path).toHaveAttribute('d', before!);
  const pivot = await control.evaluate(el => {
    const matrix = (el as SVGGraphicsElement).getScreenCTM()!;
    const p = new DOMPoint(0, 0).matrixTransform(matrix);
    return { x: p.x, y: p.y, scale: matrix.a };
  });
  await page.mouse.move(pivot.x, pivot.y); await page.mouse.down();
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, pivot)).toBe('ew-resize');
  await page.mouse.move(pivot.x + 40 * pivot.scale, pivot.y - 30 * pivot.scale, { steps: 5 }); await page.mouse.up();
  const moved = orthogonalPoints((await path.getAttribute('d'))!);
  expect(moved.length).toBe(orthogonalPoints(before!).length + 2);
  expect(moved).toContainEqual({ x: 540, y: -17 });
  const dots = await page.locator('.crow-link__segment-handle').evaluateAll(els => els.map(el => {
    const p = new DOMPoint(0, 0).matrixTransform((el as SVGGraphicsElement).getScreenCTM()!);
    return { x: p.x, y: p.y };
  }));
  expect(dots.some(dot => Math.abs(dot.x - pivot.x - 40 * pivot.scale) < 1 && Math.abs(dot.y - pivot.y) < 1)).toBe(true);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
});

test('hover reveals controls without selection and dragging an insertion point makes one undoable step', async ({ page }) => {
  const link = page.getByTestId('crow-link-r'), path = link.locator('.crow-link__path');
  const before = await path.getAttribute('d'), point = await grabPoint(page);
  await page.mouse.move(point.x, point.y);
  await expect(link).not.toHaveClass(/crow-link--selected/);
  const add = page.getByRole('button', { name: /Split .* segment/ }).first();
  await expect(add).toBeVisible();
  const grab = await add.evaluate(el => {
    const p = new DOMPoint(0, 0).matrixTransform((el as SVGGraphicsElement).getScreenCTM()!);
    return { x: p.x, y: p.y, horizontal: el.getAttribute('aria-label')!.includes('horizontal') };
  });
  await page.mouse.move(grab.x, grab.y); await page.mouse.down();
  await page.mouse.move(grab.x + (grab.horizontal ? 0 : 45), grab.y + (grab.horizontal ? 45 : 0), { steps: 4 });
  await expect(path).not.toHaveAttribute('d', before!);
  const preview = await path.getAttribute('d'); await page.mouse.up();
  await expect(path).toHaveAttribute('d', preview!);
  expect(orthogonalPoints(preview!).length).toBeGreaterThan(orthogonalPoints(before!).length);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
  await page.mouse.click(20, 150);
  await expect(page.getByRole('button', { name: /Split .* segment/ })).toHaveCount(0);
  await page.mouse.move(point.x, point.y); await expect(add).toBeVisible();
  const box = (await add.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 45, { steps: 4 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(path).toHaveAttribute('d', before!);
});

for (const zoomedOut of [false, true]) test(`an unselected line can be dragged away from its dot ${zoomedOut ? 'while zoomed out' : 'at normal zoom'}`, async ({ page }) => {
  if (zoomedOut) for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const point = await grabPoint(page);
  // Grab 8 screen pixels beside the stroke, well away from the dot.
  await page.mouse.move(point.x + 8, point.y);
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
    { x: point.x + 8, y: point.y })).toBe('ew-resize');
  await page.mouse.down();
  await page.mouse.move(point.x + 58, point.y - 30, { steps: 5 }); await page.mouse.up();
  await expect(path).not.toHaveAttribute('d', before!);
  const points = orthogonalPoints((await path.getAttribute('d'))!);
  expect(points).toContainEqual({ x: Math.round(500 + 50 / point.scale), y: -200 });
  expect(points).toContainEqual({ x: 664, y: -200 });
  await expect(page.locator('.crow-link__bend')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
});

test('horizontal segments use an up/down cursor and move themselves rather than the middle pivot', async ({ page }) => {
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const point = await path.evaluate(el => {
    const matrix = (el as SVGPathElement).getScreenCTM()!;
    const client = new DOMPoint(450, 166).matrixTransform(matrix);
    return { x: client.x, y: client.y, scale: matrix.a };
  });
  await page.mouse.move(point.x, point.y + 6);
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
    { x: point.x, y: point.y + 6 })).toBe('ns-resize');
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 46, { steps: 5 }); await page.mouse.up();
  const y = Math.round(166 + 40 / point.scale);
  const points = orthogonalPoints((await path.getAttribute('d'))!);
  expect(points).toContainEqual({ x: 416, y });
  expect(points).toContainEqual({ x: 500, y });
  expect(points).toContainEqual({ x: 500, y: -200 });
  expect(points[0]).toEqual({ x: 380, y: 166 });
  expect(points.at(-1)).toEqual({ x: 700, y: 210 });
  const saved = await path.getAttribute('d');
  await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(path).toHaveAttribute('d', saved!);
});

test('a click and tiny pointer jitter select the line without changing its route', async ({ page }) => {
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const point = await grabPoint(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 1, point.y + 1); await page.mouse.up();
  await expect(page.getByTestId('crow-link-r')).toHaveClass(/crow-link--selected/);
  await expect(page.locator('.crow-link__bend')).toHaveCount(0);
  await expect(path).toHaveAttribute('d', before!);
});

test('symbol stubs select the relationship without moving its geometry', async ({ page }) => {
  const link = page.getByTestId('crow-link-r'), path = link.locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const point = await link.locator('[data-route-fixed]').first().evaluate(el => {
    const path = el as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() / 2);
    const c = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
    return { x: c.x, y: c.y };
  });
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 40, { steps: 4 }); await page.mouse.up();
  await expect(link).toHaveClass(/crow-link--selected/);
  await expect(path).toHaveAttribute('d', before!);
});

test('selected lines expose round segment handles, insert controls, and a visible automatic reset', async ({ page }) => {
  const link = page.getByTestId('crow-link-r'), path = link.locator('.crow-link__path');
  await link.focus(); await page.keyboard.press('Enter');
  await expect(path).toHaveAttribute('d', /Q/);
  const before = await path.getAttribute('d');
  const handle = page.getByRole('button', { name: 'Move vertical segment 2', exact: true });
  await expect(handle).toBeVisible();
  await handle.focus(); await page.keyboard.press('ArrowRight');
  await expect(path).not.toHaveAttribute('d', before!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
  await expect(path).not.toHaveAttribute('d', before!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
  const add = page.getByRole('button', { name: /Split .* segment/ }).first();
  await expect(add.locator('rect')).toBeVisible(); await dragInsert(page, add);
  await expect(path).not.toHaveAttribute('d', before!);
  await page.getByRole('button', { name: 'Reset line route', exact: true }).click();
  const automatic = await path.getAttribute('d');
  expect(automatic).not.toBe(before);
  await expect(page.getByRole('button', { name: 'Reset line route', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).not.toHaveAttribute('d', automatic!);
});

for (const zoomedOut of [false, true]) test(`splitting a segment creates movable sections with undo and persistent endpoint labels ${zoomedOut ? 'while zoomed out' : 'at normal zoom'}`, async ({ page }) => {
  if (zoomedOut) for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  const link = page.getByTestId('crow-link-r'), path = link.locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const labels = await link.locator('.crow-link__ratio').evaluateAll(els => els.map(el => ({
    text: el.textContent, x: el.getAttribute('x'), y: el.getAttribute('y'),
  })));
  expect(labels.map(label => label.text)).toEqual(['1', 'N']);
  await link.focus(); await page.keyboard.press('Enter');
  await dragInsert(page, page.getByRole('button', { name: /^Split vertical segment 2/ }).first());
  await expect(path).not.toHaveAttribute('d', before!);
  const split = await path.getAttribute('d');
  expect(orthogonalPoints(split!)).toHaveLength(orthogonalPoints(before!).length + 2);
  const moved = await link.locator('[data-route-axis="vertical"]').evaluateAll(els => {
    const segment = els.find(el => {
      const path = el as SVGPathElement;
      return path.getPointAtLength(0).x === 532;
    }) as SVGPathElement;
    const middle = segment.getPointAtLength(segment.getTotalLength() / 2);
    const p = new DOMPoint(middle.x, middle.y).matrixTransform(segment.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.move(moved.x, moved.y); await page.mouse.down();
  await page.mouse.move(moved.x + 25, moved.y, { steps: 5 }); await page.mouse.up();
  await expect(path).not.toHaveAttribute('d', split!);
  expect(await link.locator('.crow-link__ratio').evaluateAll(els => els.map(el => ({
    text: el.textContent, x: el.getAttribute('x'), y: el.getAttribute('y'),
  })))).toEqual(labels);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', split!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(path).toHaveAttribute('d', split!);
  await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(path).toHaveAttribute('d', split!);
  await link.focus(); await page.keyboard.press('Enter');
  const add = page.getByRole('button', { name: /Split .* segment/ }).first();
  await expect(add).toBeVisible(); await add.focus(); await page.keyboard.press('Enter');
  await expect(path).not.toHaveAttribute('d', split!);
  await page.screenshot({ path: `output/playwright/split-endpoints-${zoomedOut ? 'zoomed' : 'normal'}.png` });
});

test('an invalid drag keeps the last safe preview and commits only that route', async ({ page }) => {
  const link = page.getByTestId('crow-link-r'), path = link.locator('.crow-link__path');
  const before = await path.getAttribute('d'), point = await grabPoint(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 40 * point.scale, point.y);
  await expect(path).not.toHaveAttribute('d', before!);
  const safe = await path.getAttribute('d');
  // Crossing the fixed return segment would make a loop and enter table B.
  await page.mouse.move(point.x + 240 * point.scale, point.y);
  await expect(link).toHaveClass(/crow-link--blocked/);
  await expect(path).toHaveAttribute('d', safe!);
  await page.mouse.up();
  await expect(link).not.toHaveClass(/crow-link--blocked/);
  await expect(path).toHaveAttribute('d', safe!);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(path).toHaveAttribute('d', before!);
});

for (const edge of ['source', 'target']) test(`dragging past the ${edge} port preserves the symbol stub and persists`, async ({ page }) => {
  await open(page, false);
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const symbols = page.getByTestId('crow-link-r').locator('[data-cardinality]');
  await expect(symbols).toHaveCount(2);
  const beforeSymbols = await symbols.evaluateAll(els => els.map(el => el.parentElement!.getAttribute('transform')));
  const point = await path.evaluate(el => {
    const matrix = (el as SVGPathElement).getScreenCTM()!;
    // Grab the short vertical run where its ratio label is rendered.
    const p = new DOMPoint(540, 188).matrixTransform(matrix);
    return { x: p.x, y: p.y, scale: matrix.a };
  });
  await page.mouse.move(point.x, point.y);
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor,
    { x: point.x, y: point.y })).toBe('ew-resize');
  await page.mouse.down();
  await page.mouse.move(point.x + (edge === 'source' ? -500 : 500) * point.scale, point.y, { steps: 5 });
  await page.mouse.up();
  const points = orthogonalPoints((await path.getAttribute('d'))!);
  expect(points).toEqual(edge === 'source' ? [
    { x: 380, y: 166 }, { x: 416, y: 166 }, { x: 416, y: 210 }, { x: 700, y: 210 },
  ] : [{ x: 380, y: 166 }, { x: 664, y: 166 }, { x: 664, y: 210 }, { x: 700, y: 210 }]);
  expect(await symbols.evaluateAll(els => els.map(el => el.parentElement!.getAttribute('transform')))).toEqual(beforeSymbols);
  const captionsClear = await page.getByTestId('crow-link-r').evaluate(el => {
    const tables = [...document.querySelectorAll('[data-node-id] .node__body')].map(table => table.getBoundingClientRect());
    return [...el.querySelectorAll('.crow-link__ratio-background, .crow-link__label')].every(caption => {
      const box = caption.getBoundingClientRect();
      return tables.every(table => box.right <= table.left || box.left >= table.right ||
        box.bottom <= table.top || box.top >= table.bottom);
    });
  });
  expect(captionsClear).toBe(true);
  if (edge === 'target') await page.screenshot({ path: 'output/playwright/protected-crow-final.png' });
  const saved = await path.getAttribute('d');
  await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(path).toHaveAttribute('d', saved!);
});

test('Escape cancels a line drag and Pan moves the viewport rather than the route', async ({ page }) => {
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const point = await grabPoint(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y - 30, { steps: 5 });
  await expect(path).not.toHaveAttribute('d', before!);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(path).toHaveAttribute('d', before!);
  await page.getByRole('button', { name: 'Pan tool', exact: true }).click();
  const viewport = page.locator('[data-viewport]');
  const transform = await viewport.getAttribute('transform');
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 20, { steps: 5 }); await page.mouse.up();
  await expect(viewport).not.toHaveAttribute('transform', transform!);
  await expect(path).toHaveAttribute('d', before!);
  await page.mouse.dblclick(point.x + 40, point.y + 20);
  await expect(path).toHaveAttribute('d', before!);
  await expect(page.getByRole('button', { name: /Split .* segment/ })).toHaveCount(0);
});

test('segment edits synchronize with a peer and reset through the line menu', async ({ page, browser }) => {
  const context = await signalingContext(browser);
  const peer = await context.newPage();
  try {
    await peer.goto(page.url());
    await peer.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    const peerPath = peer.getByTestId('crow-link-r').locator('.crow-link__path');
    await expect(peerPath).toBeVisible({ timeout: 30_000 });
    const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
    const before = await path.getAttribute('d');
    const point = await grabPoint(page);
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 40, point.y, { steps: 5 }); await page.mouse.up();
    await expect(path).not.toHaveAttribute('d', before!);
    await expect(peerPath).toHaveAttribute('d', (await path.getAttribute('d'))!);
    await page.getByTestId('crow-link-r').focus(); await page.keyboard.press('Enter');
    await dragInsert(page, page.getByRole('button', { name: /Split .* segment/ }).first());
    await expect(peerPath).toHaveAttribute('d', (await path.getAttribute('d'))!);
    const click = await path.evaluate(el => {
      const svg = el as SVGPathElement, p = svg.getPointAtLength(svg.getTotalLength() * 0.25);
      const client = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()!);
      return { x: client.x, y: client.y };
    });
    const manual = await path.getAttribute('d');
    await page.mouse.click(click.x, click.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Route line automatically', exact: true }).click();
    await expect(path).not.toHaveAttribute('d', manual!);
    await expect(peerPath).toHaveAttribute('d', (await path.getAttribute('d'))!);
  } finally { await context.close(); }
});
