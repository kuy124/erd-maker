export interface RoutePoint { x: number; y: number }

/** A saved route consists of finite, orthogonal interior vertices. */
export function normalizeRoutePoints(value: unknown): RoutePoint[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 128) return undefined;
  const points: RoutePoint[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof raw.x !== 'number' || !Number.isFinite(raw.x) ||
      typeof raw.y !== 'number' || !Number.isFinite(raw.y)) return undefined;
    const previous = points.at(-1);
    if (previous && previous.x !== raw.x && previous.y !== raw.y) return undefined;
    points.push({ x: raw.x, y: raw.y });
  }
  return points;
}

/** Remove zero-length legs and merge collinear runs into usable segments. */
export function simplifyRoute(points: RoutePoint[]): RoutePoint[] {
  const result: RoutePoint[] = [];
  const closed = points.length > 1 && points[0]!.x === points.at(-1)!.x && points[0]!.y === points.at(-1)!.y;
  for (const point of points) {
    const last = result.at(-1);
    if (last?.x === point.x && last.y === point.y) continue;
    while (result.length >= 2) {
      const a = result[result.length - 2]!, b = result.at(-1)!;
      // Retain a loop that returns to its starting port.
      if (closed && result.length === 2 && a.x === point.x && a.y === point.y) break;
      if (!((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) break;
      result.pop();
    }
    const tail = result.at(-1);
    if (tail?.x === point.x && tail.y === point.y) continue;
    result.push({ ...point });
  }
  return result;
}

/** Move the grabbed segment along its normal, keeping the two ports fixed. */
export function moveRouteSegment(points: RoutePoint[], index: number, delta: number): RoutePoint[] {
  const a = points[index], b = points[index + 1];
  if (!a || !b || !Number.isFinite(delta)) return points;
  const horizontal = a.y === b.y;
  const first = index === 0, last = index + 1 === points.length - 1;
  const movedA = horizontal ? { x: a.x, y: Math.round(a.y + delta) } : { x: Math.round(a.x + delta), y: a.y };
  const movedB = horizontal ? { x: b.x, y: movedA.y } : { x: movedA.x, y: b.y };
  // A dragged outer run acquires a short horizontal stub at its anchored port.
  const direction = Math.sign(b.x - a.x) || 1;
  if (horizontal && first) movedA.x = a.x + direction * Math.min(36, Math.abs(b.x - a.x) / 3);
  if (horizontal && last) movedB.x = b.x - direction * Math.min(36, Math.abs(b.x - a.x) / 3);
  return simplifyRoute([
    ...points.slice(0, index + 1),
    ...(horizontal && first ? [{ x: movedA.x, y: a.y }] : []),
    movedA, movedB,
    ...(horizontal && last ? [{ x: movedB.x, y: b.y }] : []),
    ...points.slice(index + 1),
  ]);
}
