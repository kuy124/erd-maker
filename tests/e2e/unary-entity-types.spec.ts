import { expect, test } from '@playwright/test';
import { emptyDocument } from '../../src/model/types';
import { documentAction, importDocument, pointAtLocalSignaling, readDownload, signalingContext } from './actions';

test.beforeEach(async ({ page, context }) => {
  await pointAtLocalSignaling(context); await page.goto('/');
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  const doc = emptyDocument();
  doc.entities = [{ id: 'e', name: 'Employee', kind: 'strong', x: 100, y: 120, crowX: 100, crowY: 120 }];
  doc.attributes = [{ id: 'key', name: 'employee_id', kind: 'key', ownerId: 'e', dataType: 'UUID', x: 100, y: 0 }];
  await importDocument(page, doc);
  await page.getByRole('button', { name: 'Entity Employee', exact: true }).click();
  if (!(await page.getByLabel('Entity name', { exact: true }).isVisible())) await page.getByRole('button', { name: 'Properties', exact: true }).click();
});

test('Regular, Weak, and Associative types have distinct symbols and survive reload and JSON', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Regular', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Weak', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Entity Employee, weak', exact: true }).locator('.node__body')).toHaveCount(2);
  await page.getByRole('button', { name: 'Regular', exact: true }).click();
  await expect(page.locator('.entity-associative')).toHaveCount(0);
  await page.getByRole('button', { name: 'Associative', exact: true }).click();
  await expect(page.locator('.entity-associative')).toHaveCount(1);
  await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Entity Employee, associative', exact: true })).toBeVisible();
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  await expect(page.getByTestId('table-Employee')).toContainText('Employee (associative)');
  await documentAction(page, 'Export'); await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const saved = JSON.parse(await readDownload(await pending));
  expect(saved.entities[0].kind).toBe('associative'); expect(saved.attributes[0].dataType).toBe('UUID');
});

test('adding a unary relationship gives two separate Chen legs, a table loop, undo, and peer synchronization', async ({ page, browser }) => {
  await page.getByRole('button', { name: 'Add unary relationship', exact: true }).click();
  await page.getByLabel('Relationship name', { exact: true }).fill('manages');
  await expect(page.getByTestId('participant-row')).toHaveCount(2);
  await expect(page.getByText('Unary relationship:', { exact: false })).toBeVisible();
  const lines = await page.locator('.leg-hit').evaluateAll(els => els.map(el => {
    const path = el as SVGPathElement, end = path.getPointAtLength(path.getTotalLength()), before = path.getPointAtLength(path.getTotalLength() - 10);
    const clearOfKey = Array.from({ length: 101 }, (_, i) => path.getPointAtLength(path.getTotalLength() * i / 100))
      .every(p => ((p.x - 165) / 65) ** 2 + ((p.y - 26) / 26) ** 2 > 1);
    return { d: path.getAttribute('d'), end: { x: end.x, y: end.y }, before: { x: before.x, y: before.y }, clearOfKey };
  }));
  expect(lines).toHaveLength(2); expect(lines[0]!.d).not.toBe(lines[1]!.d);
  for (const line of lines) {
    expect(line.end.x === 100 || line.end.x === 250 || line.end.y === 120 || line.end.y === 180).toBe(true);
    expect(line.before.x === line.end.x || line.before.y === line.end.y).toBe(true);
    expect(line.clearOfKey).toBe(true);
  }
  await expect(page.locator('.leg-endpoint [data-participation="required"]')).toHaveCount(2);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  const link = page.locator('.crow-link'), path = link.locator('.crow-link__path');
  await expect(link).toHaveCount(1); await expect(link.locator('.crow-link__ratio')).toHaveText(['1', 'N']);
  const context = await signalingContext(browser), peer = await context.newPage();
  try {
    await peer.goto(page.url()); await peer.getByRole('button', { name: "Crow's-foot", exact: true }).click();
    await expect(peer.locator('.crow-link')).toHaveCount(1, { timeout: 30_000 });
    await expect(peer.locator('.crow-link__path')).toHaveAttribute('d', (await path.getAttribute('d'))!);
    await page.reload(); await expect(page.getByLabel('Diagram name')).toBeEnabled(); await expect(link).toHaveCount(1);
    const point = await path.evaluate(el => {
      const path = el as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() / 3);
      const screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete selection', exact: true }).click();
    await expect(link).toHaveCount(0); await page.getByTitle('Undo (Ctrl+Z)', { exact: true }).click();
    await expect(link).toHaveCount(1); await expect(peer.locator('.crow-link')).toHaveCount(1);
  } finally { await context.close(); }
});
