import { expect, it } from 'vitest';
import { isRouteSafe, moveRouteSegment, normalizeRoutePoints, placeEndpointLabels, placeRouteCaption, splitRouteSegment } from '../../src/model/connectorRouting';

it('reproduces dbdiagram insertion by moving either half between its midpoint and protected stub', () => {
  const points = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
  const guard = { a: points[0]!, b: points[1]!, aStub: { x: 36, y: 0 }, bStub: { x: 364, y: 0 }, obstacles: [] };
  expect(splitRouteSegment(points, 0, guard, { x: 118, y: 0 }, 45)).toEqual([
    { x: 0, y: 0 }, { x: 36, y: 0 }, { x: 36, y: 45 }, { x: 200, y: 45 }, { x: 200, y: 0 }, { x: 400, y: 0 },
  ]);
  expect(splitRouteSegment(points, 0, guard, { x: 282, y: 0 }, 45)).toEqual([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 45 }, { x: 364, y: 45 }, { x: 364, y: 0 }, { x: 400, y: 0 },
  ]);
  expect(splitRouteSegment(points, 0, guard, { x: 118, y: 0 }, 0)).toEqual(points);
});

it('splits fractional table coordinates without making diagonal legs', () => {
  for (const points of [[{ x: 0, y: 0.5 }, { x: 400, y: 0.5 }],
    [{ x: -200, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 200 }, { x: 200, y: 200 }]]) {
    const a = points[0]!, b = points.at(-1)!, index = points.length === 2 ? 0 : 1;
    const guard = { a, b, aStub: { x: a.x + 36, y: a.y }, bStub: { x: b.x - 36, y: b.y }, obstacles: [] };
    for (const fraction of [0.25, 0.75]) {
      const from = index === 0 ? guard.aStub : points[index]!, to = index === points.length - 2 ? guard.bStub : points[index + 1]!;
      const position = { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction };
      const split = splitRouteSegment(points, index, guard, position, 45);
      expect(split).not.toBeNull(); expect(isRouteSafe(split!, guard)).toBe(true);
    }
  }
});

it('moves a vertical run sideways without moving the adjacent horizontal channel', () => {
  const points = [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: -40 },
    { x: 600, y: -40 }, { x: 600, y: 200 }, { x: 700, y: 200 }];
  expect(moveRouteSegment(points, 1, 70)).toEqual([
    { x: 100, y: 100 }, { x: 370, y: 100 }, { x: 370, y: -40 },
    { x: 600, y: -40 }, { x: 600, y: 200 }, { x: 700, y: 200 },
  ]);
  expect(points[1]).toEqual({ x: 300, y: 100 });
});

it('moves a straight horizontal line into a channel while keeping horizontal endpoint stubs', () => {
  expect(moveRouteSegment([{ x: 0, y: 0 }, { x: 300, y: 0 }], 0, 100)).toEqual([
    { x: 0, y: 0 }, { x: 36, y: 0 }, { x: 36, y: 100 },
    { x: 264, y: 100 }, { x: 264, y: 0 }, { x: 300, y: 0 },
  ]);
});

it('rejects malformed, diagonal and non-finite saved routes', () => {
  for (const value of [[], [null, null], [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    [{ x: Infinity, y: 0 }, { x: 1, y: 0 }]]) expect(normalizeRoutePoints(value)).toBeUndefined();
});

it('stops a vertical segment before it collapses the source symbol space', () => {
  expect(moveRouteSegment([{ x: 380, y: 166 }, { x: 540, y: 166 },
    { x: 540, y: 210 }, { x: 700, y: 210 }], 1, -160)).toEqual([
    { x: 380, y: 166 }, { x: 416, y: 166 }, { x: 416, y: 210 }, { x: 700, y: 210 },
  ]);
});

it('keeps both endpoint stubs when a central segment is dragged far beyond either table', () => {
  const points = [{ x: 380, y: 166 }, { x: 540, y: 166 }, { x: 540, y: 210 }, { x: 700, y: 210 }];
  for (const [delta, x] of [[-1000, 416], [1000, 664]]) {
    expect(moveRouteSegment(points, 1, delta!)).toEqual([
      { x: 380, y: 166 }, { x, y: 166 }, { x, y: 210 }, { x: 700, y: 210 },
    ]);
  }
});

it('splits a half in either orientation without changing table ports', () => {
  const points = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 400, y: 200 }];
  const guard = { a: points[0]!, b: points[3]!, aStub: { x: 36, y: 0 }, bStub: { x: 364, y: 200 }, obstacles: [] };
  for (const index of [0, 1, 2]) {
    const split = splitRouteSegment(points, index, guard)!;
    expect(split.length).toBe(points.length + (index === 0 ? 4 : 2));
    expect(split[0]).toEqual(points[0]);
    expect(split.at(-1)).toEqual(points.at(-1));
    expect(isRouteSafe(split, guard)).toBe(true);
    expect(normalizeRoutePoints(split.slice(1, -1))).toBeDefined();
  }
  expect(points).toHaveLength(4);
  expect(splitRouteSegment(points, 0, guard, { x: 159, y: 0 }, 45)).toEqual([
    { x: 0, y: 0 }, { x: 118, y: 0 }, { x: 118, y: 45 }, { x: 200, y: 45 },
    { x: 200, y: 200 }, { x: 400, y: 200 },
  ]);
});

it('splits at the requested spot, tries the clear side, and refuses steps into tables or symbol space', () => {
  const points = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
  const guard = { a: points[0]!, b: points[1]!, aStub: { x: 36, y: 0 }, bStub: { x: 364, y: 0 },
    obstacles: [{ minX: 60, maxX: 140, minY: 1, maxY: 100 }] };
  const split = splitRouteSegment(points, 0, guard, { x: 118, y: 0 })!;
  expect(split).toEqual([{ x: 0, y: 0 }, { x: 36, y: 0 }, { x: 36, y: -32 },
    { x: 200, y: -32 }, { x: 200, y: 0 }, { x: 400, y: 0 }]);
  expect(split).not.toContainEqual({ x: 132, y: 0 });
  expect(isRouteSafe(split, guard)).toBe(true);
  guard.obstacles.push({ minX: 60, maxX: 140, minY: -100, maxY: -1 });
  expect(splitRouteSegment(points, 0, guard, { x: 118, y: 0 })).toBeNull();
});

it('keeps the caption anchor clear of the real corner dots', () => {
  const points = [{ x: 380, y: 166 }, { x: 540, y: 166 }, { x: 540, y: 210 }, { x: 700, y: 210 }];
  const guard = { a: points[0]!, b: points[3]!, aStub: { x: 416, y: 166 }, bStub: { x: 664, y: 210 }, obstacles: [] };
  const caption = placeRouteCaption({ points, guard, label: { x: 540, y: 188 }, labelAnchor: 'middle' }, '1:N');
  for (const point of points.slice(1, -1)) expect(caption.bounds.maxX <= point.x - 12 || caption.bounds.minX >= point.x + 12 ||
    caption.bounds.maxY <= point.y - 12 || caption.bounds.minY >= point.y + 12).toBe(true);
});

it('places each cardinality beside its table port and keeps labels independent of manual bends', () => {
  const guard = { a: { x: 280, y: 66 }, b: { x: 700, y: 110 },
    aStub: { x: 316, y: 66 }, bStub: { x: 664, y: 110 }, obstacles: [] };
  const labels = placeEndpointLabels(guard, '1:N');
  expect(labels.map(label => label.value)).toEqual(['1', 'N']);
  expect(labels[0]!.x).toBeGreaterThan(guard.a.x);
  expect(labels[0]!.x).toBeLessThan(guard.aStub.x);
  expect(labels[1]!.x).toBeLessThan(guard.b.x);
  expect(labels[1]!.x).toBeGreaterThan(guard.bStub.x);
  const obstructed = placeEndpointLabels({ ...guard, obstacles: [labels[0]!.bounds] }, '1:N');
  expect(obstructed[0]!.y).toBeGreaterThan(guard.a.y);
  expect(obstructed[1]).toEqual(labels[1]);
});

it('keeps both endpoint labels clear and distinct when table gaps are narrower than a badge', () => {
  const obstacles = [0, 300, 600].map(x => ({ minX: x, maxX: x + 280, minY: 0, maxY: 88 }));
  const labels = placeEndpointLabels({ a: { x: 580, y: 66 }, b: { x: 600, y: 66 },
    aStub: { x: 599, y: 66 }, bStub: { x: 581, y: 66 }, obstacles }, '1:N');
  for (const { bounds } of labels) expect(obstacles.every(box => bounds.maxX <= box.minX ||
    bounds.minX >= box.maxX || bounds.maxY <= box.minY || bounds.minY >= box.maxY)).toBe(true);
  expect(labels[0]!.y).not.toBe(labels[1]!.y);
});

it('keeps fallback labels clear of endpoint symbols as well as neighboring tables', () => {
  const obstacles = [{ minX: 0, maxX: 280, minY: 0, maxY: 88 },
    { minX: 800, maxX: 1080, minY: 85, maxY: 173 },
    { minX: 281, maxX: 381, minY: -34, maxY: 54 }, { minX: 281, maxX: 381, minY: 78, maxY: 166 }];
  const labels = placeEndpointLabels({ a: { x: 280, y: 66 }, b: { x: 800, y: 151 },
    aStub: { x: 316, y: 66 }, bStub: { x: 764, y: 151 }, obstacles }, '1:N');
  const symbols = [{ minX: 280, maxX: 316, minY: 54, maxY: 78 },
    { minX: 764, maxX: 800, minY: 139, maxY: 163 }];
  for (const { bounds } of labels) expect([...obstacles, ...symbols].every(box =>
    bounds.maxX <= box.minX || bounds.minX >= box.maxX || bounds.maxY <= box.minY || bounds.minY >= box.maxY)).toBe(true);
});
