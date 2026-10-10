import { describe, expect, it } from 'vitest';
import { findFreeSlot, type Box } from '../../src/model/placement';

/** True when two boxes overlap, treating the placement gap as part of each. */
function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
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
