import { describe, expect, it } from 'vitest';
import { applyLayout, autoArrange } from '../../src/model/layout';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

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

  it('never overlaps two nodes in the same layer', () => {
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
    const positions = autoArrange(doc).positions;
    const byLayer = new Map<number, string[]>();
    for (const [id, pos] of positions) {
      const key = Math.round(pos.x);
      const bucket = byLayer.get(key) ?? [];
      bucket.push(id);
      byLayer.set(key, bucket);
    }
    for (const ids of byLayer.values()) {
      const ys = ids.map((id) => positions.get(id)!.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i]! - ys[i - 1]!).toBeGreaterThan(40);
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
  it('moves graph nodes to their computed positions', () => {
    const doc = chain();
    const next = applyLayout(doc);
    const positions = autoArrange(doc).positions;
    expect(next.entities.find((e) => e.id === 'e1')!.x).toBe(positions.get('e1')!.x);
  });

  it('carries an attribute along with its owner, and places it beside it', () => {
    const doc = chain();
    doc.attributes.push({ id: 'a1', name: 'email', x: -120, y: 40, kind: 'simple', ownerId: 'e1' });

    const next = applyLayout(doc);
    const owner = next.entities.find((e) => e.id === 'e1')!;
    const attr = next.attributes[0]!;

    // Beside, not on top: the old contract kept whatever offset the attribute
    // happened to have, which once the owner had been rearranged put it straight
    // back on the owner. Measured at 30 overlapping pairs on a three-table
    // schema before this changed.
    expect(attr.x).toBeGreaterThan(owner.x);
    const overlapBottom = Math.min(owner.y + 72, attr.y + 42);
    expect(overlapBottom - Math.max(owner.y, attr.y)).toBeGreaterThan(0);

    // Two attributes owned by the same shape stack rather than share a slot.
    doc.attributes.push({ id: 'a2', name: 'phone', x: -120, y: 100, kind: 'simple', ownerId: 'e1' });
    const both = applyLayout(doc);
    const first = both.attributes.find((a) => a.id === 'a1')!;
    const second = both.attributes.find((a) => a.id === 'a2')!;
    expect(Math.abs(first.x - second.x)).toBeLessThan(1);
    expect(Math.abs(first.y - second.y)).toBeGreaterThan(42);
  });

  it('leaves a floating attribute untouched', () => {
    const doc = chain();
    doc.attributes.push({ id: 'a1', name: 'free', x: 999, y: 888, kind: 'simple', ownerId: null });
    const next = applyLayout(doc);
    expect(next.attributes[0]).toMatchObject({ x: 999, y: 888 });
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
