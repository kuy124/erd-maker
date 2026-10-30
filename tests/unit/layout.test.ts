import { describe, expect, it } from 'vitest';
import { applyLayout, autoArrange, sizeFor } from '../../src/model/layout';
import { segmentBetween, segmentForLeg } from '../../src/canvas/geometry';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { boundsOf } from '../../src/canvas/geometry';
import { overlaps } from '../../src/model/placement';
import { deriveTables } from '../../src/model/crowfoot';

/** Two entities joined through one relationship. */
function chain(): ErdDocument {
  const doc = emptyDocument();
  doc.entities.push(
    { id: 'e1', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'e2', name: 'Order', x: 0, y: 0, kind: 'strong' },
  );
  doc.relationships.push({ id: 'r1', name: 'places', x: 0, y: 0, kind: 'strong' });
  doc.legs.push(
    { id: 'l1', fromId: 'e1', toId: 'r1', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r1', toId: 'e2', cardinality: 'N', participation: { min: 0, max: 'N' } },
  );
  return doc;
}

it('arranges Chen attribute trees consistently, including unattached attributes', () => {
  const doc = chain();
  doc.attributes = [
    { id: 'name', name: 'name', kind: 'composite', ownerId: 'e1', x: 50000, y: -50000 },
    { id: 'last', name: 'last', kind: 'simple', ownerId: 'name', x: 50000, y: -50000 },
    { id: 'first', name: 'first', kind: 'simple', ownerId: 'name', x: 50000, y: -50000 },
    { id: 'key', name: 'id', kind: 'key', ownerId: 'e1', x: 50000, y: -50000 },
    { id: 'loose', name: 'notes', kind: 'simple', ownerId: null, x: 50000, y: -50000 },
  ];
  const arranged = applyLayout(doc);
  const reversed = applyLayout({ ...doc, entities: [...doc.entities].reverse(), legs: [...doc.legs].reverse(), attributes: [...doc.attributes].reverse() });
  const positions = (next: ErdDocument) => Object.fromEntries(next.attributes.map(({ id, x, y }) => [id, { x, y }]));
  expect(positions(arranged)).toEqual(positions(reversed));
  const boxes = [...arranged.entities, ...arranged.relationships, ...arranged.attributes].map(node => ({ ...node, ...sizeFor(arranged, node.id) }));
  for (let i = 0; i < boxes.length; i++) {
    expect(Math.max(Math.abs(boxes[i]!.x), Math.abs(boxes[i]!.y))).toBeLessThan(5000);
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!, 0)).toBe(false);
  }
  expect(applyLayout(arranged)).toEqual(arranged);
  expect(doc.attributes[0]!.x).toBe(50000);
});

it('arranges saved Crow positions without moving Chen and resets obsolete manual routes', () => {
  const doc = chain();
  doc.view = 'crowfoot';
  doc.entities = doc.entities.map((entity, index) => ({ ...entity, x: index * 300 + 73, y: 47, crowX: 9000, crowY: 9000 }));
  for (let i = 0; i < 20; i++) doc.attributes.push({ id: `a${i}`, name: `field_${i}`, kind: i === 0 ? 'key' : 'simple', ownerId: 'e2', x: 13, y: 17 });
  Object.assign(doc.relationships[0]!, { route: 'left', bendX: -8000, bendY: -4000, routePoints: [{ x: -8000, y: -4000 }, { x: -8000, y: 8000 }] });
  const arranged = applyLayout(doc);
  expect(arranged.entities.map(({ x, y }) => ({ x, y }))).toEqual(doc.entities.map(({ x, y }) => ({ x, y })));
  expect(arranged.attributes).toEqual(doc.attributes);
  const tables = deriveTables(arranged);
  expect(tables[0]!.y).toBe(tables[1]!.y);
  expect(tables.every(table => table.x < 9000 && table.y < 9000)).toBe(true);
  expect(arranged.relationships[0]!).toMatchObject({ x: 0, y: 0 });
  for (const key of ['route', 'bendX', 'bendY', 'routePoints']) expect(arranged.relationships[0]).not.toHaveProperty(key);
  expect(applyLayout(arranged)).toEqual(arranged);
  expect(doc.relationships[0]!.bendX).toBe(-8000);
});

describe('autoArrange', () => {
  it('returns nothing for an empty document', () => {
    expect(autoArrange(emptyDocument()).positions.size).toBe(0);
  });

  it('positions every graph node', () => {
    const positions = autoArrange(chain()).positions;
    expect([...positions.keys()].sort()).toEqual(['e1', 'e2', 'r1']);
  });

  it('puts connected nodes on different layers', () => {
    const positions = autoArrange(chain()).positions;
    const x1 = positions.get('e1')!.x;
    const xr = positions.get('r1')!.x;
    const x2 = positions.get('e2')!.x;
    // The relationship sits between the two entities.
    expect(x1).toBeLessThan(xr);
    expect(xr).toBeLessThan(x2);
  });

  it('never overlaps two nodes', () => {
    const doc = emptyDocument();
    // A hub entity related to five others.
    doc.entities.push({ id: 'hub', name: 'Hub', x: 0, y: 0, kind: 'strong' });
    for (let i = 0; i < 5; i += 1) {
      doc.entities.push({ id: `e${i}`, name: `E${i}`, x: 0, y: 0, kind: 'strong' });
      doc.relationships.push({ id: `r${i}`, name: `rel${i}`, x: 0, y: 0, kind: 'strong' });
      doc.legs.push(
        { id: `l${i}a`, fromId: 'hub', toId: `r${i}`, cardinality: '1', participation: { min: 0, max: 1 } },
        { id: `l${i}b`, fromId: `r${i}`, toId: `e${i}`, cardinality: 'N', participation: { min: 0, max: 'N' } },
      );
    }
    /*
     * Checked as rectangles, not as "same x means same column".
     *
     * That grouping was fine when every layer was one column, and stopped
     * being true once a deep Crow's-foot layer filled sideways: two nodes from
     * different layers can now share an x. What has to hold either way is that
     * no two shapes cover the same ground, which is what the reader sees.
     */
    const positions = autoArrange(doc).positions;
    const boxes = [...positions].map(([id, pos]) => {
      const size = sizeFor(doc, id);
      return { id, ...boundsOf({ id, x: pos.x, y: pos.y }, size) };
    });
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('is deterministic across repeated runs', () => {
    const doc = chain();
    const a = autoArrange(doc).positions;
    const b = autoArrange(doc).positions;
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('handles disconnected components without crashing', () => {
    const doc = chain();
    doc.entities.push({ id: 'lonely', name: 'Lonely', x: 0, y: 0, kind: 'strong' });
    const positions = autoArrange(doc).positions;
    expect(positions.has('lonely')).toBe(true);
  });

  it('handles a single isolated node', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'only', name: 'Only', x: 0, y: 0, kind: 'strong' });
    expect(autoArrange(doc).positions.size).toBe(1);
  });

  it('centres a hub against its branches instead of crowding the top branch', () => {
    const doc = chain();
    doc.entities.push({ id: 'e3', name: 'Invoice', x: 0, y: 0, kind: 'strong' });
    doc.relationships.push({ id: 'r2', name: 'receives', x: 0, y: 0, kind: 'strong' });
    doc.legs.push(
      { ...doc.legs[0]!, id: 'l3', toId: 'r2' },
      { ...doc.legs[1]!, id: 'l4', fromId: 'r2', toId: 'e3' },
    );
    const { positions } = autoArrange(doc);
    expect(positions.get('e1')!.y + sizeFor(doc, 'e1').h / 2).toBe(
      (positions.get('r1')!.y + positions.get('r2')!.y + sizeFor(doc, 'r1').h) / 2,
    );
  });

  it('keeps disconnected components in separate bands', () => {
    const doc = chain();
    doc.entities.push({ id: 'lonely', name: 'Lonely', x: 0, y: 0, kind: 'strong' });
    const { positions } = autoArrange(doc);
    expect(positions.get('lonely')!.y).toBeGreaterThan(Math.max(...['e1', 'e2', 'r1'].map(id => positions.get(id)!.y)) + 72);
  });

  it('lays out only visible tables in Crow’s Foot and leaves hidden shapes alone', () => {
    const doc = chain();
    doc.view = 'crowfoot';
    doc.attributes.push({ id: 'a1', ownerId: 'e1', kind: 'key', name: 'id', x: 123, y: 456 });
    const { positions } = autoArrange(doc);
    expect([...positions.keys()].sort()).toEqual(['e1', 'e2']);
    const next = applyLayout(doc);
    expect(next.relationships).toEqual(doc.relationships);
    expect(next.attributes).toEqual(doc.attributes);
    expect(applyLayout(next)).toEqual(next);
  });

  it('lays out isa parents and children', () => {
    const doc = emptyDocument();
    doc.entities.push(
      { id: 'p', name: 'Person', x: 0, y: 0, kind: 'strong' },
      { id: 'c1', name: 'Student', x: 0, y: 0, kind: 'strong' },
      { id: 'c2', name: 'Teacher', x: 0, y: 0, kind: 'strong' },
    );
    doc.isas.push({ id: 'i1', x: 0, y: 0, parentId: 'p', childIds: ['c1', 'c2'] });
    const positions = autoArrange(doc).positions;
    expect(positions.size).toBe(4);
    expect(positions.get('p')!.x).toBeLessThan(positions.get('i1')!.x);
  });
});

describe('applyLayout', () => {
  it('keeps a long chain compact instead of stretching it into a banner', () => {
    const doc = emptyDocument();
    for (let i = 0; i < 10; i++) {
      doc.entities.push({ id: `e${i}`, name: `Entity ${i}`, kind: 'strong', x: 0, y: 0 });
      if (!i) continue;
      doc.relationships.push({ id: `r${i}`, name: 'relates', kind: 'strong', x: 0, y: 0 });
      for (const [j, entity] of [`e${i - 1}`, `e${i}`].entries()) {
        doc.legs.push({ id: `l${i}-${j}`, fromId: entity, toId: `r${i}`, cardinality: '1', participation: { min: 0, max: 1 } });
      }
    }
    const next = applyLayout(doc);
    const nodes = [...next.entities, ...next.relationships];
    const width = Math.max(...nodes.map(n => n.x + sizeFor(next, n.id).w)) - Math.min(...nodes.map(n => n.x));
    const height = Math.max(...nodes.map(n => n.y + sizeFor(next, n.id).h)) - Math.min(...nodes.map(n => n.y));
    expect(width / height).toBeLessThan(2.5);
    expect(width).toBeLessThan(1600);
    expect(applyLayout(next)).toEqual(next);
  });
  it('packs an attribute-heavy diagram instead of stretching it across a banner', () => {
    const doc = emptyDocument();
    const names = ['Customer', 'Order', 'Item', 'Product', 'Payment', 'Rider',
      'Zone', 'Promo', 'Review', 'Vendor', 'Address'];
    names.forEach((name, index) => {
      doc.entities.push({ id: `e${index}`, name, kind: 'strong', x: 0, y: 0 });
      for (let a = 0; a < 4; a++) {
        doc.attributes.push({ id: `e${index}a${a}`, name: `field ${a}`, ownerId: `e${index}`,
          kind: a ? 'simple' : 'key', x: 0, y: 0 });
      }
    });
    [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 6], [1, 7], [1, 8], [8, 9], [9, 10]]
      .forEach(([from, to], index) => {
        doc.relationships.push({ id: `r${index}`, name: 'relates', kind: 'strong', x: 0, y: 0 });
        for (const [leg, entity] of [`e${from}`, `e${to}`].entries()) {
          doc.legs.push({ id: `l${index}-${leg}`, fromId: entity, toId: `r${index}`,
            cardinality: '1', participation: { min: 0, max: 1 } });
        }
      });
    const next = applyLayout(doc);
    const boxes = [...next.entities, ...next.relationships, ...next.attributes]
      .map(node => ({ ...node, ...sizeFor(next, node.id) }));
    const width = Math.max(...boxes.map(box => box.x + box.w)) - Math.min(...boxes.map(box => box.x));
    const height = Math.max(...boxes.map(box => box.y + box.h)) - Math.min(...boxes.map(box => box.y));
    const area = boxes.reduce((sum, box) => sum + box.w * box.h, 0);
    expect(width * height).toBeLessThan(area * 8);
    expect(Math.max(width / height, height / width)).toBeLessThan(2.6);
    for (let i = 0; i < boxes.length; i++) {
      for (const other of boxes.slice(i + 1)) {
        expect(overlaps(boxes[i]!, other, 0), `${boxes[i]!.id} overlaps ${other.id}`).toBe(false);
      }
    }
    expect(applyLayout(next)).toEqual(next);
  });
  it('moves graph nodes to their computed positions', () => {
    const doc = chain();
    const next = applyLayout(doc);
    const positions = autoArrange(doc).positions;
    expect(next.entities.find((e) => e.id === 'e1')!.x).toBe(positions.get('e1')!.x);
  });

  it('keeps attributes and their connectors clear of the relationship line', () => {
    const doc = chain();
    doc.attributes.push({ id: 'a1', name: 'email', x: -120, y: 40, kind: 'simple', ownerId: 'e1' });

    const next = applyLayout(doc);
    const owner = next.entities.find((e) => e.id === 'e1')!;
    const attr = next.attributes[0]!;

    expect(attr.x + 130 <= owner.x || attr.x >= owner.x + 150 ||
      attr.y + 42 <= owner.y || attr.y >= owner.y + 72).toBe(true);

    // Siblings can use different sides when the usual column would block a leg.
    doc.attributes.push({ id: 'a2', name: 'phone', x: -120, y: 100, kind: 'simple', ownerId: 'e1' });
    const both = applyLayout(doc);
    const first = both.attributes.find((a) => a.id === 'a1')!;
    const second = both.attributes.find((a) => a.id === 'a2')!;
    expect(Math.abs(first.x - second.x) >= 130 || Math.abs(first.y - second.y) >= 42).toBe(true);
    for (const attribute of both.attributes) {
      const link = segmentBetween(both, attribute.ownerId!, attribute.id)!;
      for (const leg of both.legs) {
        const line = segmentForLeg(both, leg)!;
        for (let step = 1; step < 100; step++) {
          const t = step / 100;
          const x = line.from.x + (line.to.x - line.from.x) * t;
          const y = line.from.y + (line.to.y - line.from.y) * t;
          expect(x > attribute.x && x < attribute.x + 130 && y > attribute.y && y < attribute.y + 42).toBe(false);
          // No shared horizontal run with an attribute connector.
          if (line.from.y === line.to.y && link.from.y === link.to.y) expect(link.from.y).not.toBe(line.from.y);
        }
      }
    }
    expect(applyLayout(both)).toEqual(both);
  });

  it('brings a floating attribute into the layout even without entities', () => {
    const doc = chain();
    doc.attributes.push({ id: 'a1', name: 'free', x: 999, y: 888, kind: 'simple', ownerId: null });
    const next = applyLayout(doc);
    expect(next.attributes[0]).toMatchObject({ id: 'a1', name: 'free', ownerId: null });
    expect(Math.abs(next.attributes[0]!.x)).toBeLessThan(500);
    expect(Math.abs(next.attributes[0]!.y)).toBeLessThan(500);
    expect(doc.attributes[0]).toMatchObject({ x: 999, y: 888 });
  });

  it('returns the same document when there is nothing to arrange', () => {
    const doc = emptyDocument();
    expect(applyLayout(doc)).toBe(doc);
  });

  it('does not mutate the input', () => {
    const doc = chain();
    const before = JSON.stringify(doc);
    applyLayout(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
