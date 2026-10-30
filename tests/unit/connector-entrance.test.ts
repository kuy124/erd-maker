import { expect, it } from 'vitest';
import { attributeEdgeId, connectorIds, isaChildEdgeId, isaParentEdgeId } from '../../src/canvas/entrance';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

function fixture(): ErdDocument {
  const doc = emptyDocument();
  doc.legs.push({
    id: 'leg1',
    fromId: 'e1',
    toId: 'r1',
    cardinality: 'N',
    participation: { min: 1, max: 'N' },
  });
  doc.isas.push({ id: 'isa1', x: 0, y: 0, parentId: 'e1', childIds: ['e2', 'e3'] });
  doc.attributes.push(
    { id: 'a1', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'e1' },
    { id: 'a2', name: 'floating', x: 0, y: 0, kind: 'simple', ownerId: null },
  );
  return doc;
}

it('names each connector a document draws, so an arriving line can draw itself', () => {
  const ids = connectorIds(fixture());
  expect(ids).toContain('leg1');
  expect(ids).toContain(isaParentEdgeId('isa1'));
  expect(ids).toContain(isaChildEdgeId('isa1', 'e3'));
  expect(ids).toContain(attributeEdgeId('a1'));
  // A floating attribute has no connector, so there is nothing to animate.
  expect(ids).not.toContain(attributeEdgeId('a2'));
  expect(new Set(ids).size).toBe(ids.length);
});
