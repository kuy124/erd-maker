import { expect, test, type Page } from '@playwright/test';
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

test.beforeEach(async ({ context, page }) => { await pointAtLocalSignaling(context); await open(page); });

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

for (const edge of ['source', 'target']) test(`an automatic vertical segment can align with its ${edge} port and persist`, async ({ page }) => {
  await open(page, false);
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
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
  await page.mouse.move(point.x + (edge === 'source' ? -160 : 160) * point.scale, point.y, { steps: 5 });
  await page.mouse.up();
  const points = orthogonalPoints((await path.getAttribute('d'))!);
  expect(points).toEqual(edge === 'source' ? [
    { x: 380, y: 166 }, { x: 380, y: 210 }, { x: 700, y: 210 },
  ] : [{ x: 380, y: 166 }, { x: 700, y: 166 }, { x: 700, y: 210 }]);
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
