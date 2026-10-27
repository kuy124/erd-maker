import { expect, test, type Page } from '@playwright/test';
import { createExample } from '../../src/model/examples';
import type { ErdDocument } from '../../src/model/types';
import { documentAction, importDocument, readDownload } from './actions';

async function exported(page: Page): Promise<ErdDocument> {
  await documentAction(page, 'Export');
  await page.getByRole('tab', { name: 'JSON', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const doc = JSON.parse(await readDownload(await download)) as ErdDocument;
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return doc;
}

test('arranging either notation preserves the other, resets old Crow routes, and undoes as one action', async ({ page }) => {
  const doc = createExample('orders');
  doc.view = 'crowfoot';
  doc.entities = doc.entities.map((entity, i) => ({ ...entity, crowX: 2500 + i * 600, crowY: 3500 + i * 300 }));
  Object.assign(doc.relationships[0]!, { route: 'left', bendX: -12000, bendY: -8000,
    routePoints: [{ x: -12000, y: -8000 }, { x: -12000, y: 8000 }] });
  doc.attributes.push({ id: 'loose-field', name: 'notes', kind: 'simple', ownerId: null, x: 100000, y: -100000 });
  await page.goto('/');
  await importDocument(page, doc);
  await page.getByRole('button', { name: "Crow's-foot", exact: true }).click();
  const before = await exported(page);
  const chen = (d: ErdDocument) => Object.fromEntries([...d.entities, ...d.relationships, ...d.attributes, ...d.isas].map(n => [n.id, { x: n.x, y: n.y }]));
  const crow = (d: ErdDocument) => Object.fromEntries(d.entities.map(n => [n.id, { x: n.crowX, y: n.crowY }]));

  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click();
  const arranged = await exported(page);
  expect(chen(arranged)).toEqual(chen(before));
  expect(crow(arranged)).not.toEqual(crow(before));
  expect(arranged.entities.every(entity => entity.crowX! < 2500 && entity.crowY! < 3500)).toBe(true);
  const relationship = arranged.relationships.find(r => r.id === doc.relationships[0]!.id)!;
  expect([undefined, 'auto']).toContain(relationship.route);
  expect(relationship.bendX).toBeUndefined();
  expect(relationship.routePoints).toBeUndefined();
  await page.getByRole('button', { name: /^Undo/ }).click();
  const undone = await exported(page);
  expect(crow(undone)).toEqual(crow(before));
  expect(undone.relationships).toEqual(before.relationships);
  await page.getByRole('button', { name: /^Redo/ }).click();
  expect(crow(await exported(page))).toEqual(crow(arranged));

  await page.getByRole('button', { name: 'Chen', exact: true }).click();
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click();
  const chenArranged = await exported(page);
  expect(crow(chenArranged)).toEqual(crow(arranged));
  expect(chen(chenArranged)).not.toEqual(chen(arranged));
  const loose = chenArranged.attributes.find(attribute => attribute.id === 'loose-field')!;
  expect(Math.max(Math.abs(loose.x), Math.abs(loose.y))).toBeLessThan(5000);
  await page.reload();
  await expect(page.getByLabel('Diagram name')).toBeEnabled();
  expect(chen(await exported(page))).toEqual(chen(chenArranged));
});
