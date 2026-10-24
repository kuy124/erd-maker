import { expect, it } from 'vitest';
import { applyLayout, sizeFor } from '../../src/model/layout';
import { segmentBetween, segmentForLeg, type Point } from '../../src/canvas/geometry';
import { emptyDocument } from '../../src/model/types';
import { overlaps } from '../../src/model/placement';

it.each([
  { shape: 'chain', attributes: 0 },
  { shape: 'chain', attributes: 1 },
  { shape: 'chain', attributes: 6 },
  { shape: 'chain', attributes: 12 },
  { shape: 'star', attributes: 6 },
])('$shape with $attributes attributes keeps owners close and connectors clear', ({ shape, attributes }) => {
  const doc = emptyDocument();
  for (let e = 0; e < 8; e++) {
    doc.entities.push({ id: `e${e}`, name: `Entity ${e}`, kind: 'strong', x: 0, y: 0 });
    for (let a = 0; a < attributes; a++) {
      doc.attributes.push({ id: `a${e}_${a}`, name: `Attribute ${a}`, ownerId: `e${e}`,
        kind: 'simple', x: a * 1000, y: -a * 1000 });
    }
    if (!e) continue;
    doc.relationships.push({ id: `r${e}`, name: 'connects', kind: 'strong', x: 0, y: 0 });
    for (const owner of [shape === 'star' ? 0 : e - 1, e]) doc.legs.push({ id: `l${e}_${owner}`, fromId: `e${owner}`, toId: `r${e}`,
      cardinality: 'N', participation: { min: 0, max: 'N' } });
  }
  if (attributes) doc.attributes.unshift(
    { id: 'child', name: 'Part', ownerId: 'composite', kind: 'simple', x: 0, y: 0 },
    { id: 'child2', name: 'Part 2', ownerId: 'composite', kind: 'simple', x: 0, y: 0 },
    { id: 'child3', name: 'Part 3', ownerId: 'composite', kind: 'simple', x: 0, y: 0 },
    { id: 'composite', name: 'Composite', ownerId: 'e2', kind: 'composite', x: 0, y: 0 },
  );
  const arranged = applyLayout(doc);
  const boxes = [...arranged.entities, ...arranged.relationships, ...arranged.attributes]
    .map(node => ({ ...node, ...sizeFor(arranged, node.id) }));
  const byId = new Map(boxes.map(box => [box.id, box]));
  const center = (id: string) => {
    const box = byId.get(id)!;
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };
  for (const attribute of arranged.attributes) {
    const owner = center(attribute.ownerId!), point = center(attribute.id);
    expect(Math.hypot(point.x - owner.x, point.y - owner.y), attribute.id).toBeLessThanOrEqual(400);
  }
  for (let i = 0; i < boxes.length; i++) for (const box of boxes.slice(i + 1)) {
    expect(overlaps(boxes[i]!, box, 0), `${boxes[i]!.id} / ${box.id}`).toBe(false);
  }
  const edges = [
    ...arranged.legs.map(leg => ({ fromId: leg.fromId, toId: leg.toId, segment: segmentForLeg(arranged, leg)! })),
    ...arranged.attributes.map(attribute => ({ fromId: attribute.ownerId!, toId: attribute.id,
      segment: segmentBetween(arranged, attribute.ownerId!, attribute.id)! })),
  ].flatMap(edge => {
    const points = edge.segment.points ?? [edge.segment.from, edge.segment.to];
    return points.slice(1).map((point, i) => ({ ...edge, a: points[i]!, b: point }));
  });
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (const edge of edges) for (const box of boxes) {
    if ([edge.fromId, edge.toId].includes(box.id)) continue;
    let low = 0, high = 1;
    for (const axis of ['x', 'y'] as const) {
      const min = box[axis] + 2, max = box[axis] + (axis === 'x' ? box.w : box.h) - 2;
      const delta = edge.b[axis] - edge.a[axis];
      if (Math.abs(delta) < 1e-6) {
        if (edge.a[axis] <= min || edge.a[axis] >= max) high = -1;
      } else {
        const first = (min - edge.a[axis]) / delta, second = (max - edge.a[axis]) / delta;
        low = Math.max(low, Math.min(first, second));
        high = Math.min(high, Math.max(first, second));
      }
    }
    expect(high > low, `${edge.fromId}–${edge.toId} through ${box.id}`).toBe(false);
  }
  for (let i = 0; i < edges.length; i++) for (const other of edges.slice(i + 1)) {
    const edge = edges[i]!;
    if (Math.abs(cross(edge.a, edge.b, other.a)) > 1e-6 || Math.abs(cross(edge.a, edge.b, other.b)) > 1e-6) continue;
    const axis = Math.abs(edge.b.x - edge.a.x) > Math.abs(edge.b.y - edge.a.y) ? 'x' : 'y';
    const shared = Math.min(Math.max(edge.a[axis], edge.b[axis]), Math.max(other.a[axis], other.b[axis])) -
      Math.max(Math.min(edge.a[axis], edge.b[axis]), Math.min(other.a[axis], other.b[axis]));
    expect(shared, `${edge.fromId}–${edge.toId} over ${other.fromId}–${other.toId}`).toBeLessThanOrEqual(1);
  }
  expect(applyLayout(arranged)).toEqual(arranged);
});
