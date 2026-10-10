import { describe, expect, it } from 'vitest';
import {
  canConnect,
  findAttributeSlot,
  findFreeSlot,
  occupiedBoxes,
  type Box,
} from '../../src/model/placement';
import { NODE_SIZE, type ErdDocument } from '../../src/model/types';

/** True when two boxes overlap, treating the placement gap as part of each. */
function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

/** A document with the given entities and owned attributes. */
function docWith(entities: { x: number; y: number }[], attributes: { x: number; y: number; ownerId: string | null }[] = []): ErdDocument {
  return {
    name: 'test',
    view: 'chen',
    entities: entities.map((e, i) => ({ id: `e${i}`, name: `E${i}`, x: e.x, y: e.y, kind: 'strong' })),
    attributes: attributes.map((a, i) => ({
      id: `a${i}`,
      name: String(i),
      x: a.x,
      y: a.y,
      kind: 'simple' as const,
      ownerId: a.ownerId,
    })),
    relationships: [],
    isas: [],
    legs: [],
  };
}

describe('findFreeSlot', () => {
  it('places the first shape at the origin', () => {
    expect(findFreeSlot([])).toEqual({ x: 120, y: 120 });
  });

  it('does not place a second shape on top of the first', () => {
    const first = { x: 120, y: 120, w: 150, h: 72 };
    const second = findFreeSlot([first]);
    expect(second).not.toEqual({ x: 120, y: 120 });
    expect(overlaps({ ...second, w: 150, h: 72 }, first, 0)).toBe(false);
  });

  it('fills a row before starting a new one', () => {
    const boxes: Box[] = [];
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const slot = findFreeSlot(boxes);
      placed.push(slot);
      boxes.push({ ...slot, w: 150, h: 72 });
    }
    // All four sit on the same row, in increasing x.
    const ys = new Set(placed.map((p) => p.y));
    expect(ys.size).toBe(1);
    const xs = placed.map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(4);
  });

  it('starts a new row once the first row is full', () => {
    const boxes: Box[] = [];
    for (let i = 0; i < 4; i += 1) {
      const slot = findFreeSlot(boxes);
      boxes.push({ ...slot, w: 150, h: 72 });
    }
    const fifth = findFreeSlot(boxes);
    expect(fifth.y).toBeGreaterThan(120);
    expect(fifth.x).toBe(120);
  });

  it('never overlaps any placed shape, across many additions', () => {
    const boxes: Box[] = [];
    for (let i = 0; i < 60; i += 1) {
      const slot = findFreeSlot(boxes);
      const box = { ...slot, w: 150, h: 72 };
      for (const existing of boxes) {
        expect(overlaps(box, existing, 0)).toBe(false);
      }
      boxes.push(box);
    }
  });

  it('returns a usable position even when the grid is exhausted', () => {
    // Fill a large area, then ask for one more.
    const boxes: Box[] = [];
    for (let i = 0; i < 400; i += 1) {
      boxes.push({ ...findFreeSlot(boxes), w: 150, h: 72 });
    }
    const slot = findFreeSlot(boxes);
    expect(Number.isFinite(slot.x)).toBe(true);
    expect(Number.isFinite(slot.y)).toBe(true);
  });

  it('avoids a shape placed off the grid, such as a dragged one', () => {
    // The origin slot is occupied by a shape the user dragged there.
    const dragged: Box = { x: 120, y: 120, w: 150, h: 60 };
    const slot = findFreeSlot([dragged]);
    expect(slot).not.toEqual({ x: 120, y: 120 });
  });
});

describe('findAttributeSlot', () => {
  it('returns null when there is no owner, so a free slot can be used', () => {
    expect(findAttributeSlot(docWith([{ x: 0, y: 0 }]), null)).toBeNull();
  });

  it('returns null when the owner does not exist', () => {
    expect(findAttributeSlot(docWith([{ x: 0, y: 0 }]), 'nope')).toBeNull();
  });

  it('places the attribute to the right of its owner', () => {
    const doc = docWith([{ x: 200, y: 200 }]);
    const slot = findAttributeSlot(doc, 'e0')!;
    expect(slot).not.toBeNull();
    // Right of the entity, vertically aligned with its top edge.
    expect(slot.x).toBeGreaterThan(200 + NODE_SIZE.entity.w);
    expect(slot.y).toBe(200);
  });

  it('never lands on top of the owner it belongs to', () => {
    const doc = docWith([{ x: 200, y: 200 }]);
    const slot = findAttributeSlot(doc, 'e0')!;
    const attrBox = { ...slot, ...NODE_SIZE.attribute };
    const ownerBox = { x: 200, y: 200, ...NODE_SIZE.entity };
    expect(overlaps(attrBox, ownerBox, 0)).toBe(false);
  });

  it('stacks a second attribute below the first', () => {
    const first = docWith([{ x: 200, y: 200 }], [{ x: 260, y: 200, ownerId: 'e0' }]);
    const slot = findAttributeSlot(first, 'e0')!;
    expect(slot.y).toBeGreaterThan(200 + NODE_SIZE.attribute.h);
    // Same column, so the fan of attributes reads as one group.
    expect(slot.x).toBe(260);
  });

  it('keeps stacking without overlapping any sibling', () => {
    const attributes = [
      { x: 260, y: 200, ownerId: 'e0' },
      { x: 260, y: 270, ownerId: 'e0' },
      { x: 260, y: 340, ownerId: 'e0' },
    ];
    const doc = docWith([{ x: 200, y: 200 }], attributes);
    const slot = findAttributeSlot(doc, 'e0')!;
    const attrBox = { ...slot, ...NODE_SIZE.attribute };
    for (const sibling of attributes) {
      expect(overlaps(attrBox, { x: sibling.x, y: sibling.y, ...NODE_SIZE.attribute }, 0)).toBe(false);
    }
  });

  it('respects a hand-arranged attribute rather than overwriting it', () => {
    // The user dragged the only attribute far away; a new one must not land on
    // top of it, and must still be beside the owner.
    const doc = docWith([{ x: 200, y: 200 }], [{ x: 900, y: 900, ownerId: 'e0' }]);
    const slot = findAttributeSlot(doc, 'e0')!;
    expect(slot.x).toBe(900);
    expect(slot.y).toBeGreaterThan(900 + NODE_SIZE.attribute.h);
  });

  it('works for a relationship and for a specialization as owner', () => {
    const doc: ErdDocument = {
      ...docWith([]),
      relationships: [{ id: 'r0', name: 'r', x: 100, y: 100, kind: 'strong' }],
      isas: [{ id: 'i0', x: 400, y: 100, parentId: null, childIds: [] }],
    };
    expect(findAttributeSlot(doc, 'r0')).not.toBeNull();
    expect(findAttributeSlot(doc, 'i0')).not.toBeNull();
  });
});

describe('occupiedBoxes', () => {
  it('reports every shape on the canvas', () => {
    const doc = docWith([{ x: 0, y: 0 }], [{ x: 10, y: 10, ownerId: null }]);
    expect(occupiedBoxes(doc)).toHaveLength(2);
  });
});

describe('canConnect', () => {
  it('allows two different entities', () => {
    expect(canConnect(docWith([{ x: 0, y: 0 }, { x: 400, y: 0 }]), 'e0', 'e1')).toBe(true);
  });

  it('refuses a self connection', () => {
    expect(canConnect(docWith([{ x: 0, y: 0 }]), 'e0', 'e0')).toBe(false);
  });

  it('refuses unknown nodes', () => {
    expect(canConnect(docWith([{ x: 0, y: 0 }]), 'e0', 'missing')).toBe(false);
  });

  it('allows an entity and a relationship', () => {
    const doc: ErdDocument = {
      ...docWith([{ x: 0, y: 0 }]),
      relationships: [{ id: 'r0', name: 'r', x: 300, y: 0, kind: 'strong' }],
    };
    expect(canConnect(doc, 'e0', 'r0')).toBe(true);
  });
});
