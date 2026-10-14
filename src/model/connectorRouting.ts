export interface RoutePoint { x: number; y: number }
export const ENDPOINT_STUB = 36;
export interface RouteGuard {
  a: RoutePoint; b: RoutePoint; aStub: RoutePoint; bStub: RoutePoint;
  obstacles: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
}
type RouteBox = RouteGuard['obstacles'][number];

function crossesBox(p: RoutePoint, q: RoutePoint, rect: RouteBox): boolean {
  return Math.max(p.x, q.x) > rect.minX + 1 && Math.min(p.x, q.x) < rect.maxX - 1 &&
    Math.max(p.y, q.y) > rect.minY + 1 && Math.min(p.y, q.y) < rect.maxY - 1;
}

export function symbolBoxes({ a, b, aStub, bStub }: RouteGuard): RouteBox[] {
  return [[a, aStub], [b, bStub]].map(([port, stub]) => {
    const height = 12 * Math.min(1, Math.abs(stub!.x - port!.x) / ENDPOINT_STUB);
    return { minX: Math.min(port!.x, stub!.x), maxX: Math.max(port!.x, stub!.x),
      minY: port!.y - height, maxY: port!.y + height };
  });
}

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

/** Round only clear turns; the saved vertices and protected endpoint spaces stay exact. */
export function roundedRoutePath(points: RoutePoint[], guard: RouteGuard): string {
  if (!points.length) return '';
  let path = `M${points[0]!.x} ${points[0]!.y}`;
  const boxes = [...guard.obstacles, ...symbolBoxes(guard)];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1]!, b = points[i]!, c = points[i + 1]!;
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(8, before / 2, after / 2);
    const entry = { x: b.x + (a.x - b.x) / before * radius, y: b.y + (a.y - b.y) / before * radius };
    const exit = { x: b.x + (c.x - b.x) / after * radius, y: b.y + (c.y - b.y) / after * radius };
    if (!radius || boxes.some(box => crossesBox(entry, exit, box))) path += ` L${b.x} ${b.y}`;
    else path += ` L${entry.x} ${entry.y} Q${b.x} ${b.y} ${exit.x} ${exit.y}`;
  }
  const end = points.at(-1)!;
  return points.length > 1 ? path + ` L${end.x} ${end.y}` : path;
}

/** Move the grabbed segment along its normal, keeping the two ports fixed. */
export function moveRouteSegment(points: RoutePoint[], index: number, delta: number,
  stubs?: { start: number; end: number }): RoutePoint[] {
  const a = points[index], b = points[index + 1];
  if (!a || !b || !Number.isFinite(delta)) return points;
  const horizontal = a.y === b.y;
  const first = index === 0, last = index + 1 === points.length - 1;
  const start = points[0]!, end = points.at(-1)!;
  const startDirection = Math.sign(points[1]!.x - start.x) || 1;
  const endDirection = Math.sign(points.at(-2)!.x - end.x) || -1;
  const startLength = stubs?.start ?? Math.min(ENDPOINT_STUB, Math.abs(points[1]!.x - start.x));
  const endLength = stubs?.end ?? Math.min(ENDPOINT_STUB, Math.abs(points.at(-2)!.x - end.x));
  let x = Math.round(a.x + delta);
  if (!horizontal && index === 1) {
    const limit = start.x + startDirection * startLength;
    x = startDirection > 0 ? Math.max(x, limit) : Math.min(x, limit);
  }
  if (!horizontal && index === points.length - 3) {
    const limit = end.x + endDirection * endLength;
    x = endDirection > 0 ? Math.max(x, limit) : Math.min(x, limit);
  }
  const movedA = horizontal ? { x: a.x, y: Math.round(a.y + delta) } : { x, y: a.y };
  const movedB = horizontal ? { x: b.x, y: movedA.y } : { x: movedA.x, y: b.y };
  // A dragged outer run acquires a short horizontal stub at its anchored port.
  const direction = Math.sign(b.x - a.x) || 1;
  if (horizontal && first) movedA.x = a.x + direction * startLength;
  if (horizontal && last) movedB.x = b.x - direction * endLength;
  return simplifyRoute([
    ...points.slice(0, index + 1),
    ...(horizontal && first ? [{ x: movedA.x, y: a.y }] : []),
    movedA, movedB,
    ...(horizontal && last ? [{ x: movedB.x, y: b.y }] : []),
    ...points.slice(index + 1),
  ]);
}

/** dbdiagram-style insertion: split at the section midpoint and slide the chosen half. */
export function splitRouteSegment(points: RoutePoint[], index: number, guard: RouteGuard,
  position?: RoutePoint, dragOffset?: number): RoutePoint[] | null {
  const a = points[index], b = points[index + 1];
  if (!a || !b) return null;
  const horizontal = a.y === b.y;
  const start = index === 0 ? guard.aStub : a;
  const end = index === points.length - 2 ? guard.bStub : b;
  const axis = horizontal ? 'x' : 'y';
  if (Math.abs(end[axis] - start[axis]) < 24) return null;
  const middle = { ...start, [axis]: Math.round((start[axis] + end[axis]) / 2) };
  const secondHalf = position && (position[axis] - start[axis]) / (end[axis] - start[axis]) > 0.5;
  const expanded = [...points.slice(0, index + 1), ...(index === 0 ? [start] : []), middle,
    ...(index === points.length - 2 ? [end] : []), ...points.slice(index + 1)];
  const section = index + (index === 0 ? 1 : 0) + (secondHalf ? 1 : 0);
  for (const offset of dragOffset === undefined ? [32, -32] : [Math.round(dragOffset)]) {
    const split = moveRouteSegment(expanded, section, offset,
      { start: Math.abs(guard.aStub.x - guard.a.x), end: Math.abs(guard.bStub.x - guard.b.x) });
    if (isRouteSafe(split, guard)) return split;
  }
  return null;
}

/** A manual edit must leave symbols outside tables and cannot cross or double back. */
export function isRouteSafe(points: RoutePoint[], guard: RouteGuard): boolean {
  if (points.length < 2 || points.length > 130) return false;
  const { a, b, aStub, bStub, obstacles } = guard;
  const symbols = symbolBoxes(guard);
  if (symbols.some(symbol => obstacles.some(rect => symbol.maxX > rect.minX && symbol.minX < rect.maxX &&
    symbol.maxY > rect.minY && symbol.minY < rect.maxY))) return false;
  const first = points[0]!, next = points[1]!, last = points.at(-1)!, previous = points.at(-2)!;
  if (first.x !== a.x || first.y !== a.y || last.x !== b.x || last.y !== b.y ||
    next.y !== a.y || previous.y !== b.y ||
    (next.x - a.x) * Math.sign(aStub.x - a.x) < Math.abs(aStub.x - a.x) ||
    (previous.x - b.x) * Math.sign(bStub.x - b.x) < Math.abs(bStub.x - b.x)) return false;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!, q = points[i]!;
    if (![p.x, p.y, q.x, q.y].every(Number.isFinite) ||
      (p.x !== q.x && p.y !== q.y) || (p.x === q.x && p.y === q.y)) return false;
    if (obstacles.some(rect => crossesBox(p, q, rect)) ||
      (i !== 1 && crossesBox(p, q, symbols[0]!)) ||
      (i !== points.length - 1 && crossesBox(p, q, symbols[1]!))) return false;
    for (let j = i + 2; j < points.length; j++) {
      const r = points[j - 1]!, s = points[j]!;
      if (p.y === q.y && r.y === s.y) {
        if (p.y === r.y && Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)) <=
          Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x))) return false;
      } else if (p.x === q.x && r.x === s.x) {
        if (p.x === r.x && Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)) <=
          Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y))) return false;
      } else {
        const h1 = p.y === q.y ? p : r, h2 = p.y === q.y ? q : s;
        const v1 = p.y === q.y ? r : p, v2 = p.y === q.y ? s : q;
        if (v1.x >= Math.min(h1.x, h2.x) && v1.x <= Math.max(h1.x, h2.x) &&
          h1.y >= Math.min(v1.y, v2.y) && h1.y <= Math.max(v1.y, v2.y)) return false;
      }
    }
  }
  return true;
}

/** Used only when the simple detour is blocked: join visible box corners by clear L-shaped runs. */
export function findSafeRoute(guard: RouteGuard): RoutePoint[] | null {
  const boxes = [...guard.obstacles, ...symbolBoxes(guard)];
  const nodes: RoutePoint[] = [guard.aStub, guard.bStub];
  for (const box of boxes) {
    for (const x of [box.minX - 1, box.maxX + 1]) for (const y of [box.minY - 1, box.maxY + 1]) {
      if (!boxes.some(rect => x > rect.minX + 1 && x < rect.maxX - 1 && y > rect.minY + 1 && y < rect.maxY - 1) &&
        !nodes.some(point => point.x === x && point.y === y)) nodes.push({ x, y });
    }
  }
  const distances = nodes.map(() => Infinity), visited = new Set<number>();
  const parents: Array<{ from: number; bend: RoutePoint } | undefined> = [];
  distances[0] = 0;
  for (let step = 0; step < nodes.length; step++) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && Number.isFinite(distances[i]) &&
      (current < 0 || distances[i]! < distances[current]!)) current = i;
    if (current < 0) return null;
    if (current === 1) {
      const path: RoutePoint[] = [guard.bStub];
      for (let at = 1; at !== 0;) {
        const parent = parents[at]!;
        path.unshift(nodes[parent.from]!, parent.bend); at = parent.from;
      }
      const points = simplifyRoute([guard.a, ...path, guard.b]);
      return isRouteSafe(points, guard) ? points : null;
    }
    visited.add(current);
    const from = nodes[current]!;
    for (let next = 0; next < nodes.length; next++) {
      if (visited.has(next) || next === current) continue;
      const to = nodes[next]!;
      const bend = [{ x: to.x, y: from.y }, { x: from.x, y: to.y }].find(corner =>
        boxes.every(box => !crossesBox(from, corner, box) && !crossesBox(corner, to, box)));
      if (!bend) continue;
      const turns = from.x !== to.x && from.y !== to.y ? 8 : 0;
      const distance = distances[current]! + Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + turns;
      if (distance < distances[next]!) { distances[next] = distance; parents[next] = { from: current, bend }; }
    }
  }
  return null;
}

/** Each end's cardinality stays beside its port, independent of the manual route. */
export function placeEndpointLabels(guard: RouteGuard, ratio: string) {
  const placed: RouteBox[] = [];
  return [[guard.a, guard.aStub], [guard.b, guard.bStub]].map(([port, stub], index) => {
    const value = ratio.split(':')[index] ?? '';
    const width = value.length * 10 + 16;
    const at = (x: number, y: number) => ({ x, y, value,
      bounds: { minX: x - width / 2, maxX: x + width / 2, minY: y - 11, maxY: y + 11 } });
    const x = (port!.x + stub!.x) / 2;
    const outward = stub!.x + Math.sign(stub!.x - port!.x) * (width / 2 + 8);
    const boxes = [...guard.obstacles, ...symbolBoxes(guard), ...placed];
    const candidates = [at(x, port!.y - 24), at(x, port!.y + 24),
      at(outward, port!.y - 24), at(outward, port!.y + 24),
      ...guard.obstacles.flatMap(box => [at(x, box.minY - 19), at(x, box.maxY + 19)])
        .sort((a, b) => Math.abs(a.y - port!.y) - Math.abs(b.y - port!.y))];
    const label = candidates.find(label => boxes.every(box =>
      label.bounds.maxX <= box.minX || label.bounds.minX >= box.maxX ||
      label.bounds.maxY <= box.minY || label.bounds.minY >= box.maxY)) ??
      at(x, Math.min(port!.y, ...boxes.map(box => box.minY)) - 19);
    placed.push(label.bounds);
    return label;
  });
}

/** Keep relationship names clear of tables, endpoint symbols, and their labels. */
export function placeRouteCaption(route: {
  points: RoutePoint[]; label: RoutePoint; labelAnchor: 'start' | 'middle' | 'end'; guard: RouteGuard;
}, name: string, ratio: string) {
  // Allow for wide uppercase glyphs in the 13px relationship name.
  const width = Math.min(name.length, 24) * 14 + 20;
  const boxes = [...route.guard.obstacles, ...symbolBoxes(route.guard),
    ...placeEndpointLabels(route.guard, ratio).map(label => label.bounds),
    ...route.points.slice(1, -1).map(point => ({ minX: point.x - 12, maxX: point.x + 12,
      minY: point.y - 12, maxY: point.y + 12 }))];
  const at = (x: number, y: number, labelAnchor: 'start' | 'middle' | 'end') => {
    const left = x - (labelAnchor === 'start' ? 10 : labelAnchor === 'end' ? width - 10 : width / 2);
    return { x, y, labelAnchor, bounds: { minX: left, maxX: left + width, minY: y - 35, maxY: y - 15 } };
  };
  const clear = (caption: ReturnType<typeof at>) => boxes.every(box =>
    caption.bounds.maxX <= box.minX || caption.bounds.minX >= box.maxX ||
    caption.bounds.maxY <= box.minY || caption.bounds.minY >= box.maxY);
  const preferred = at(route.label.x, route.label.y, route.labelAnchor);
  if (clear(preferred)) return preferred;
  const segments = route.points.slice(1).map((end, i) => ({ start: route.points[i]!, end }))
    .sort((a, b) => (Math.abs(b.end.x - b.start.x) + Math.abs(b.end.y - b.start.y)) -
      (Math.abs(a.end.x - a.start.x) + Math.abs(a.end.y - a.start.y)));
  for (const { start, end } of segments) {
    const x = (start.x + end.x) / 2, y = (start.y + end.y) / 2;
    const candidates = start.y === end.y ? [at(x, y - 20, 'middle'), at(x, y + 40, 'middle')] :
      [at(x + width / 2 + 12, y, 'middle'), at(x - width / 2 - 12, y, 'middle')];
    const candidate = candidates.find(clear);
    if (candidate) return candidate;
  }
  return at(route.label.x, Math.min(route.label.y, ...boxes.map(box => box.minY)) - 50, 'middle');
}
