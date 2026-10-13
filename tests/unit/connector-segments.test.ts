import { expect, it } from 'vitest';
import { moveRouteSegment, normalizeRoutePoints } from '../../src/model/connectorRouting';

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

it('aligns a vertical segment with the source without leaving its old backtrack', () => {
  expect(moveRouteSegment([{ x: 380, y: 166 }, { x: 540, y: 166 },
    { x: 540, y: 210 }, { x: 700, y: 210 }], 1, -160)).toEqual([
    { x: 380, y: 166 }, { x: 380, y: 210 }, { x: 700, y: 210 },
  ]);
});
