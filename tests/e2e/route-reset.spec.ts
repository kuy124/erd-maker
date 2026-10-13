import { expect, test } from '@playwright/test';
import { emptyDocument } from '../../src/model/types';
import { importDocument, pointAtLocalSignaling } from './actions';

test('the line context menu can restore automatic routing after a manual bend', async ({ page, context }) => {
  await pointAtLocalSignaling(context);
  await page.goto('/'); await expect(page.getByLabel('Diagram name')).toBeEnabled();
  const doc = emptyDocument(); doc.view = 'crowfoot';
  doc.entities = [
    { id: 'a', name: 'A', x: 0, y: 0, crowX: 100, crowY: 100, kind: 'strong' },
    { id: 'b', name: 'B', x: 0, y: 0, crowX: 700, crowY: 100, kind: 'strong' },
  ];
  doc.relationships = [{ id: 'r', name: 'owns', x: 0, y: 0, kind: 'strong', bendX: 500, bendY: -300 }];
  doc.legs = [
    { id: 'a-leg', fromId: 'r', toId: 'a', cardinality: '1', participation: { min: 1, max: 1 } },
    { id: 'b-leg', fromId: 'r', toId: 'b', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  await importDocument(page, doc);
  const path = page.getByTestId('crow-link-r').locator('.crow-link__path');
  const before = await path.getAttribute('d');
  const point = await path.evaluate(el => {
    const svg = el as SVGPathElement;
    const world = svg.getPointAtLength(svg.getTotalLength() * 0.25);
    const client = new DOMPoint(world.x, world.y).matrixTransform(svg.getScreenCTM()!);
    return { x: client.x, y: client.y };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const automatic = page.getByRole('menuitem', { name: 'Route line automatically', exact: true });
  await expect(automatic).toBeEnabled();
  await automatic.click();
  await expect(path).not.toHaveAttribute('d', before!);
});
