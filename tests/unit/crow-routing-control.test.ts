import { describe, expect, it } from 'vitest';
import { routeColumns, tableObstacle, type CrowTable } from '../../src/model/crowfoot';
import { orthogonalPoints } from './svgPath';

/**
 * Manual routing control.
 *
 * The automatic router picks the shorter side when a connector cannot go
 * straight. That is a reasonable default and it is sometimes plainly wrong, so
 * the choice has to be overridable without moving every table. These pin the
 * override: a chosen side wins, and it only applies when a detour happens at
 * all.
 */

/**
 * A table with one row at a known height.
 *
 * The row matters: the router leaves from a row's centre, so a table with no
 * rows makes every connector start from the table's own middle and the blocker
 * test never fires.
 */
function table(x: number, y: number, width = 200, rowCenter = y + 30): CrowTable {
  return {
    entityId: `e${x}-${y}`, name: `t${x}${y}`, weak: false, x, y, width,
    height: 80,
    rows: [{ id: 'r', name: 'id', type: 'INT', y: rowCenter, center: rowCenter, height: 20 }],
  } as unknown as CrowTable;
}

describe('manual routing', () => {
  const from = table(0, 100);
  const to = table(600, 100);
  /*
   * The blocker has to cover the row band the connector leaves from.
   *
   * `rowCenter` places a row at the table's top plus the header plus half a row,
   * so a table at y=100 leaves at about y=135. A blocker at y=60 ends at y=140
   * and the line clears it — which is why the first version of this test
   * measured no detour at all.
   */
  const blocker = table(280, 90, 160);

  it('routes around an obstruction when no preference is given', () => {
    const route = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)]);
    expect(route.path).toContain('V');
    // The detour should be near the blocker, not outside the whole drawing.
    const ys = orthogonalPoints(route.path).map(p => p.y);
    expect(Math.min(...ys)).toBeGreaterThan(-1000);
  });

  it('puts the detour above when told to', () => {
    const route = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)], 'above');
    const ys = orthogonalPoints(route.path).map(p => p.y);
    expect(Math.min(...ys)).toBeLessThan(90);
  });

  it('puts the detour below when told to', () => {
    const route = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)], 'below');
    const ys = orthogonalPoints(route.path).map(p => p.y);
    expect(Math.max(...ys)).toBeGreaterThan(170);
  });

  it('lets the preference change the result', () => {
    const above = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)], 'above');
    const below = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)], 'below');
    expect(above.path).not.toBe(below.path);
  });

  it('leaves a clear line alone under automatic, but obeys an explicit side', () => {
    // Automatic keeps the direct route when nothing is in the way: detouring
    // around nothing draws a longer line for no reason.
    expect(routeColumns(from, 'a', to, 'b', 0, [], 'auto').path).not.toContain('V');
    // An explicit choice is a decision, so it wins even with no obstruction.
    // A control that silently does nothing is worse than having no control.
    const below = routeColumns(from, 'a', to, 'b', 0, [], 'below');
    const above = routeColumns(from, 'a', to, 'b', 0, [], 'above');
    expect(above.path).not.toBe(below.path);
    expect(below.path).not.toBe(routeColumns(from, 'a', to, 'b', 0, [], 'auto').path);
  });

  it('ignores tables the line does not touch', () => {
    // A table far above must not drag the channel outside the drawing. This
    // was the bug: measuring against every table made one obstructed connector
    // span the height of a whole schema.
    const stray = table(-5000, -5000);
    const withStray = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker), tableObstacle(stray)], 'below');
    const withoutStray = routeColumns(from, 'a', to, 'b', 0, [tableObstacle(blocker)], 'below');
    expect(withStray.path).toBe(withoutStray.path);
  });

  it('makes a manual point a turn without retracing its vertical segment', () => {
    const route = routeColumns(from, 'r', to, 'r', 0, [], 'auto', { x: 400, y: -120 });
    const points = orthogonalPoints(route.path);
    expect(points[0]).toEqual({ x: 200, y: 166 });
    expect(points.at(-1)).toEqual({ x: 600, y: 166 });
    expect(points).toContainEqual({ x: 400, y: -120 });
    const corner = points.findIndex(p => p.x === 400 && p.y === -120);
    expect(points[corner - 1]!.x).toBe(400);
    expect(points[corner + 1]!.y).toBe(-120);
  });

  it('keeps independent segment positions attached to the current table rows', () => {
    const saved = [{ x: 300, y: 166 }, { x: 300, y: 40 }, { x: 550, y: 40 }, { x: 550, y: 166 }];
    const route = routeColumns(from, 'r', to, 'r', 0, [], 'auto', null, saved);
    expect(orthogonalPoints(route.path)).toContainEqual({ x: 300, y: 40 });
    expect(orthogonalPoints(route.path)).toContainEqual({ x: 550, y: 40 });
    const moved = routeColumns(table(0, 200), 'r', table(600, 300), 'r', 0, [], 'auto', null, saved);
    expect(orthogonalPoints(moved.path)[0]).toEqual({ x: 200, y: 266 });
    expect(orthogonalPoints(moved.path).at(-1)).toEqual({ x: 600, y: 366 });
    expect(orthogonalPoints(moved.path)).toContainEqual({ x: 550, y: 40 });
    const movedPastRoute = routeColumns(table(400, 200), 'r', table(1000, 300), 'r', 0, [], 'auto', null, saved);
    expect(orthogonalPoints(movedPastRoute.path)[0]).toEqual({ x: 400, y: 266 });
  });
});
