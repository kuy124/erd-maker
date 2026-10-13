import { describe, expect, it } from 'vitest';
import { routeColumns, tableObstacle, type CrowTable } from '../../src/model/crowfoot';
import { orthogonalPoints } from './svgPath';
import { isRouteSafe } from '../../src/model/connectorRouting';

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

  it('protects horizontal symbol stubs on automatic detours', () => {
    const route = routeColumns(from, 'r', to, 'r', 0, [tableObstacle(blocker)], 'above');
    const points = orthogonalPoints(route.path);
    expect(points[1]!.y).toBe(points[0]!.y);
    expect(points[1]!.x - points[0]!.x).toBeGreaterThanOrEqual(36);
    expect(points.at(-2)!.y).toBe(points.at(-1)!.y);
    expect(points.at(-1)!.x - points.at(-2)!.x).toBeGreaterThanOrEqual(36);
  });

  it('falls back to a safe route when saved geometry crosses a table or itself', () => {
    const automatic = routeColumns(from, 'r', to, 'r');
    for (const saved of [
      [{ x: 100, y: 166 }, { x: 100, y: 300 }, { x: 550, y: 300 }, { x: 550, y: 166 }],
      [{ x: 300, y: 166 }, { x: 300, y: -100 }, { x: 500, y: -100 }, { x: 500, y: 50 },
        { x: 400, y: 50 }, { x: 400, y: -150 }, { x: 550, y: -150 }, { x: 550, y: 166 }],
    ]) {
      const routed = routeColumns(from, 'r', to, 'r', 0, [], 'auto', null, saved);
      expect(routed.path).toBe(automatic.path);
    }
    expect(routeColumns(from, 'r', to, 'r', 0, [], 'auto', { x: 100, y: 300 }).path).toBe(automatic.path);
    expect(routeColumns(from, 'r', to, 'r', 0, [], 'auto', { x: 220, y: -120 }).path).toBe(automatic.path);
  });

  it('keeps an automatic detour clear of tables outside the original direct route', () => {
    const source = table(0, 0, 280), target = table(800, 0, 280);
    const blockers = [tableObstacle(table(400, 50, 100)), tableObstacle(table(550, -50, 100))];
    const route = routeColumns(source, 'r', target, 'r', 0, blockers, 'above');
    expect(isRouteSafe(route.points, route.guard)).toBe(true);
  });

  it('finds a clear fallback when additional tables block both simple exit channels', () => {
    const source = table(0, 0, 280), target = table(800, 0, 280);
    const blockers = [table(400, 50, 100), table(550, -50, 100),
      table(300, -100, 100), table(300, 90, 100)].map(tableObstacle);
    const route = routeColumns(source, 'r', target, 'r', 0, blockers);
    expect(isRouteSafe(route.points, route.guard)).toBe(true);
  });

  it('uses an open table side when a neighbour would cover the endpoint symbol', () => {
    const neighbour = tableObstacle(table(281, 170, 100));
    const route = routeColumns(table(0, 100, 280), 'r', table(800, 100, 280), 'r', 0, [neighbour]);
    const direction = Math.sign(route.aToward.x - route.a.x);
    const symbol = { minX: Math.min(route.a.x, route.a.x + direction * 26),
      maxX: Math.max(route.a.x, route.a.x + direction * 26), minY: route.a.y - 10, maxY: route.a.y + 10 };
    expect(symbol.maxX > neighbour.minX && symbol.minX < neighbour.maxX &&
      symbol.maxY > neighbour.minY && symbol.minY < neighbour.maxY).toBe(false);
    expect(Math.abs(route.aToward.x - route.a.x)).toBeGreaterThanOrEqual(36);
    expect(isRouteSafe(route.points, route.guard)).toBe(true);
  });
});
