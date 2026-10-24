import { expect, it } from 'vitest';
import { applyLayout, sizeFor } from '../../src/model/layout';
import { documentBounds, fitViewport, zoomViewport } from '../../src/canvas/geometry';
import { overlaps } from '../../src/model/placement';
import { emptyDocument } from '../../src/model/types';

it.each([['chain', 25], ['mesh', 30], ['hub', 40], ['groups', 30]] as const)(
  'keeps a %s of %i Chen entities and their attributes in a compact overview', (shape, count) => {
    const doc = emptyDocument('Dense Chen');
    for (let i = 0; i < count; i++) {
      const id = `e${String(i).padStart(2, '0')}`;
      doc.entities.push({ id, name: `Entity ${i}`, kind: 'strong', x: i * 8000, y: -i * 6000,
        crowX: i * 123, crowY: i * 45 });
      for (let a = 0; a < (shape === 'mesh' ? 8 : 6); a++) doc.attributes.push({ id: `${id}-a${a}`, name: `Field ${a}`, ownerId: id,
        kind: a ? 'simple' : 'key', x: i * 8000 + a * 1000, y: -i * 6000 });
      const start = shape === 'groups' ? Math.floor(i / 10) * 10 : 0;
      if (i === start) continue;
      for (const parent of new Set(shape === 'hub' ? [0] : shape === 'mesh' || shape === 'groups'
        ? [i - 1, Math.max(start, i - 5)] : [i - 1])) {
        const rel = `r${i}-${parent}`;
        doc.relationships.push({ id: rel, name: 'connects', kind: 'strong', x: 0, y: 0 });
        doc.legs.push({ id: `${rel}-a`, fromId: doc.entities[parent]!.id, toId: rel,
          cardinality: '1', participation: { min: 0, max: 1 } },
        { id: `${rel}-b`, fromId: rel, toId: id, cardinality: 'N', participation: { min: 0, max: 'N' } });
        if (shape === 'mesh' && i % 10 === 0) doc.attributes.push({ id: `${rel}-a`, name: 'Since', ownerId: rel,
          kind: 'simple', x: 0, y: 0 });
      }
    }
    doc.attributes.unshift(
      { id: 'part1', name: 'Street', ownerId: 'address', kind: 'simple', x: 0, y: 0 },
      { id: 'part2', name: 'City', ownerId: 'address', kind: 'simple', x: 0, y: 0 },
      { id: 'address', name: 'Address', ownerId: 'e00', kind: 'composite', x: 0, y: 0 });
    if (shape === 'mesh') doc.isas.push({ id: 'isa', parentId: 'e00', childIds: ['e01', 'e02'], x: 0, y: 0 });
    const original = JSON.stringify(doc);
    const next = applyLayout(doc), bounds = documentBounds(next, 0);
    const nodes = [...next.entities, ...next.relationships, ...next.isas, ...next.attributes];
    const boxes = nodes.map(node => ({ ...node, ...sizeFor(next, node.id) }));
    const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
    expect(Math.max(width / height, height / width)).toBeLessThan(2.6);
    expect(width * height).toBeLessThan(boxes.reduce((sum, box) => sum + box.w * box.h, 0) * 8);
    const area = { x: 80, y: 80, width: 960, height: 520 }, viewport = fitViewport(bounds, area);
    for (const box of boxes) {
      expect(box.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(area.x - 1e-6);
      expect((box.x + box.w) * viewport.zoom + viewport.x).toBeLessThanOrEqual(area.x + area.width + 1e-6);
      expect(box.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(area.y - 1e-6);
      expect((box.y + box.h) * viewport.zoom + viewport.y).toBeLessThanOrEqual(area.y + area.height + 1e-6);
    }
    for (let i = 0; i < boxes.length; i++) for (const other of boxes.slice(i + 1)) {
      expect(overlaps(boxes[i]!, other, 0), `${boxes[i]!.id} overlaps ${other.id}`).toBe(false);
    }
    const byId = new Map(boxes.map(box => [box.id, box]));
    for (const attribute of next.attributes) {
      const owner = byId.get(attribute.ownerId!)!;
      expect(Math.hypot(attribute.x + 65 - owner.x - owner.w / 2,
        attribute.y + 26 - owner.y - owner.h / 2), `${attribute.id} too far from its owner`).toBeLessThan(450);
    }
    expect(next.entities.map(e => [e.crowX, e.crowY])).toEqual(doc.entities.map(e => [e.crowX, e.crowY]));
    expect(JSON.stringify(doc)).toBe(original);
    expect(applyLayout(next)).toEqual(next);
  },
);

it('packs 30 disconnected entities instead of making a tall stack', () => {
  const source = emptyDocument('Disconnected entities');
  for (let i = 0; i < 30; i++) source.entities.push({ id: `e${i}`, name: `Entity ${i}`, kind: 'strong', x: 0, y: 0 });
  const bounds = documentBounds(applyLayout(source), 0);
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  expect(Math.max(width / height, height / width)).toBeLessThan(2.5);
});

it('fits below 25% and keeps wheel/button/pinch zoom anchored without snapping larger', () => {
  const area = { x: 30, y: 60, width: 960, height: 520 };
  const bounds = { minX: -400, minY: -300, maxX: 12000, maxY: 8000 };
  const viewport = fitViewport(bounds, area), cursor = { x: 420, y: 300 };
  expect(viewport.zoom).toBeLessThan(0.25);
  for (const point of [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.maxY }]) {
    expect(point.x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(area.x - 1e-8);
    expect(point.x * viewport.zoom + viewport.x).toBeLessThanOrEqual(area.x + area.width + 1e-8);
    expect(point.y * viewport.zoom + viewport.y).toBeGreaterThanOrEqual(area.y - 1e-8);
    expect(point.y * viewport.zoom + viewport.y).toBeLessThanOrEqual(area.y + area.height + 1e-8);
  }
  const out = zoomViewport(viewport, 0.9, cursor);
  expect(out.zoom).toBeLessThan(viewport.zoom);
  expect((cursor.x - out.x) / out.zoom).toBeCloseTo((cursor.x - viewport.x) / viewport.zoom);
  expect((cursor.y - out.y) / out.zoom).toBeCloseTo((cursor.y - viewport.y) / viewport.zoom);
  expect(zoomViewport(viewport, 1000, cursor).zoom).toBe(3);
  const tiny = fitViewport({ ...bounds, maxX: 1000000, maxY: 1000000 }, area);
  expect(zoomViewport(tiny, 0.5, cursor).zoom).toBeLessThanOrEqual(tiny.zoom);
  const extreme = fitViewport({ minX: -Number.MAX_VALUE, minY: -Number.MAX_VALUE,
    maxX: Number.MAX_VALUE, maxY: Number.MAX_VALUE }, area);
  expect(extreme.zoom).toBeGreaterThan(0);
  expect(Number.isFinite(extreme.x) && Number.isFinite(extreme.y)).toBe(true);
});
