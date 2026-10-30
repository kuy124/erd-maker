/**
 * Auto-arrange.
 *
 * A Chen ERD is close to bipartite: entities and relationships alternate, with
 * attributes hanging off either. That structure is what the layout exploits —
 * assign each node a layer by graph distance from the busiest node, order
 * within a layer by the average position of its neighbours (barycentre), then
 * space the layers out.
 *
 * Written by hand rather than pulling in a general graph-layout library. A
 * general engine is a megabyte of code for a problem that is bipartite and
 * small, and this version is deterministic, which means the button always
 * produces the same picture and the tests can assert exact coordinates.
 *
 * Connected components get separate bands. Chen attributes fan around
 * their owners; Crow's-foot uses a compact grid of related tables with space
 * for connector channels.
 */

import { NODE_SIZE, type ErdDocument, type Positioned } from './types';
import { deriveLinks, deriveTables, tableHeight } from './crowfoot';
import { descendantAttributeIds } from './attributes';
import { overlaps, type Box } from './placement';
import { diamondEdge, ellipseEdge, rectEdge, segmentBetween, segmentForLeg, type Point } from '../canvas/geometry';

const V_GAP = 105;
const LAYER_GAP = 105;
// Bounded fans reserve extra angular space instead of borrowing distant rings.
const COMPACT_FAN_CAPACITY = 6;
const DENSE_ENTITY_COUNT = 25;

export interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  attributeBounds?: Map<string, Box>;
}

interface GraphNode {
  id: string;
  neighbors: string[];
}

/** Builds an adjacency list over entities, relationships and ISAs. */
function buildGraph(doc: ErdDocument): Map<string, GraphNode> {
  const graph = new Map<string, GraphNode>();
  const add = (id: string) => {
    if (!graph.has(id)) graph.set(id, { id, neighbors: [] });
  };

  for (const e of doc.entities) add(e.id);
  if (doc.view !== 'crowfoot') {
    for (const r of doc.relationships) add(r.id);
    for (const i of doc.isas) add(i.id);
    const owners = new Set([...doc.entities, ...doc.relationships, ...doc.attributes].map(node => node.id));
    for (const attribute of doc.attributes) if (!attribute.ownerId || !owners.has(attribute.ownerId)) add(attribute.id);
  }

  const link = (a: string, b: string) => {
    const na = graph.get(a);
    const nb = graph.get(b);
    if (!na || !nb) return;
    if (!na.neighbors.includes(b)) na.neighbors.push(b);
    if (!nb.neighbors.includes(a)) nb.neighbors.push(a);
  };

  if (doc.view === 'crowfoot') {
    for (const edge of deriveLinks(doc)) link(edge.fromEntityId, edge.toEntityId);
  } else {
    for (const leg of doc.legs) link(leg.fromId, leg.toId);
  }
  for (const isa of doc.isas) {
    if (isa.parentId) link(isa.id, isa.parentId);
    for (const child of isa.childIds) link(isa.id, child);
  }

  for (const node of graph.values()) node.neighbors.sort();
  return graph;
}

/** Breadth-first layer assignment from a chosen root. */
function assignLayers(graph: Map<string, GraphNode>, root: string): Map<string, number> {
  const layers = new Map<string, number>();
  const queue: string[] = [root];
  layers.set(root, 0);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const depth = layers.get(current)!;
    const node = graph.get(current);
    if (!node) continue;
    for (const next of node.neighbors) {
      if (layers.has(next)) continue;
      layers.set(next, depth + 1);
      queue.push(next);
    }
  }

  // Any node not reached (disconnected components) starts a fresh chain.
  for (const id of graph.keys()) {
    if (!layers.has(id)) {
      layers.set(id, 0);
      const queue2: string[] = [id];
      while (queue2.length > 0) {
        const current = queue2.shift()!;
        const depth = layers.get(current)!;
        const node = graph.get(current);
        if (!node) continue;
        for (const next of node.neighbors) {
          if (layers.has(next)) continue;
          layers.set(next, depth + 1);
          queue2.push(next);
        }
      }
    }
  }
  return layers;
}

/**
 * Orders nodes within each layer by barycentre over already-placed earlier
 * layers. Alternate down/up sweeps to reduce crossings deterministically.
 */
function orderLayers(
  graph: Map<string, GraphNode>,
  layers: Map<string, number>,
  layerCount: number,
): string[][] {
  const buckets: string[][] = Array.from({ length: layerCount }, () => []);
  for (const [id, layer] of layers) buckets[layer]!.push(id);
  for (const bucket of buckets) bucket.sort();

  const indexIn = (id: string): number => {
    const layer = layers.get(id);
    if (layer === undefined) return 0;
    return buckets[layer]!.indexOf(id);
  };

  const crossings = () => {
    let count = 0;
    for (let layer = 0; layer < layerCount - 1; layer++) {
      const edges = buckets[layer]!.flatMap(id => graph.get(id)!.neighbors
        .filter(next => layers.get(next) === layer + 1).map(next => [indexIn(id), indexIn(next)] as const));
      for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
        if ((edges[i]![0] - edges[j]![0]) * (edges[i]![1] - edges[j]![1]) < 0) count++;
      }
    }
    return count;
  };
  let best = buckets.map(bucket => [...bucket]);
  let bestCrossings = crossings();

  for (let sweep = 0; sweep < 8; sweep += 1) {
    const forward = sweep % 2 === 0;
    const order = forward
      ? Array.from({ length: layerCount }, (_, i) => i)
      : Array.from({ length: layerCount }, (_, i) => layerCount - 1 - i);

    for (const layerIndex of order) {
      const bucket = buckets[layerIndex]!;
      const scored = bucket.map((id) => {
        const node = graph.get(id)!;
        const placed = node.neighbors.filter((n) => {
          const nl = layers.get(n);
          return forward ? nl !== undefined && nl < layerIndex : nl !== undefined && nl > layerIndex;
        });
        const score =
          placed.length === 0
            ? indexIn(id)
            : placed.reduce((sum, n) => sum + indexIn(n), 0) / placed.length;
        return { id, score };
      });
      scored.sort((a, b) => (a.score === b.score ? (a.id < b.id ? -1 : 1) : a.score - b.score));
      buckets[layerIndex] = scored.map((s) => s.id);
    }
    const count = crossings();
    if (count < bestCrossings) {
      bestCrossings = count;
      best = buckets.map(bucket => [...bucket]);
    }
  }
  return best;
}

/** Interior intersections count; merely meeting at a port does not. */
function linesCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (Math.abs(abC) < 1e-6 && Math.abs(abD) < 1e-6) {
    const axis = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? 'x' : 'y';
    return Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) -
      Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) > 1;
  }
  return abC * abD < 0 && cdA * cdB < 0;
}

function lineHitsBox(a: Point, b: Point, box: Point & { w: number; h: number }): boolean {
  // Clip against an inset rectangle: a tangent to the silhouette is harmless.
  let low = 0, high = 1;
  for (const axis of ['x', 'y'] as const) {
    const min = box[axis] + 2, max = box[axis] + (axis === 'x' ? box.w : box.h) - 2;
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-6) {
      if (a[axis] <= min || a[axis] >= max) return false;
    } else {
      const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
      if (low >= high) return false;
    }
  }
  return true;
}

function attributeRadius(doc: ErdDocument, ownerId: string, count: number, capacity = 8): Point {
  const owner = sizeFor(doc, ownerId), size = NODE_SIZE.attribute;
  const scale = Math.max(1, count / capacity);
  return { x: ((owner.w + size.w) / 2 + 60) * scale, y: ((owner.h + size.h) / 2 + 60) * scale };
}

function clearAttributeSlot(doc: ErdDocument, owner: Positioned, count: number, bounds?: Box): Point {
  const size = NODE_SIZE.attribute, ownerSize = sizeFor(doc, owner.id);
  const ownerCenter = { x: owner.x + ownerSize.w / 2, y: owner.y + ownerSize.h / 2 };
  const ownerEdge = doc.attributes.some(a => a.id === owner.id) ? ellipseEdge
    : doc.relationships.some(r => r.id === owner.id) ? diamondEdge : rectEdge;
  const boxes = [...doc.entities, ...doc.relationships, ...doc.isas, ...doc.attributes]
    .map(node => ({ ...node, ...sizeFor(doc, node.id) }));
  const segments: Array<[Point, Point]> = [];
  const add = (segment: ReturnType<typeof segmentBetween>) => {
    if (!segment) return;
    const points = segment.points ?? [segment.from, segment.to];
    for (let i = 1; i < points.length; i++) segments.push([points[i - 1]!, points[i]!]);
  };
  for (const leg of doc.legs) add(segmentForLeg(doc, leg));
  for (const isa of doc.isas) {
    for (const id of [isa.parentId, ...isa.childIds]) if (id) add(segmentBetween(doc, isa.id, id));
  }
  for (const a of doc.attributes) if (a.ownerId) add(segmentBetween(doc, a.ownerId, a.id));
  const candidates: Point[] = [];
  // ponytail: bounded local search, not a global router; use global routing if dense graphs need it.
  const radius = attributeRadius(doc, owner.id, count, bounds ? COMPACT_FAN_CAPACITY : 8);
  const samples = Math.max(24, count * 4);
  for (let ring = 0; ring < 4; ring++) {
    for (let i = 0; i < samples; i++) {
      const angle = -Math.PI / 2 + i * Math.PI * 2 / samples;
      candidates.push({
        x: owner.x + ownerSize.w / 2 - size.w / 2 + Math.cos(angle) * (radius.x + ring * 70),
        y: owner.y + ownerSize.h / 2 - size.h / 2 + Math.sin(angle) * (radius.y + ring * 70),
      });
    }
  }
  const distance = (point: Point) => Math.hypot(point.x + size.w / 2 - ownerCenter.x,
    point.y + size.h / 2 - ownerCenter.y) / 20;
  const score = (point: Point) => {
    const center = { x: point.x + size.w / 2, y: point.y + size.h / 2 };
    const segment = { from: ownerEdge(ownerCenter, center, ownerSize.w / 2, ownerSize.h / 2),
      to: ellipseEdge(center, ownerCenter, size.w / 2, size.h / 2) };
    let cost = distance(point);
    for (const box of boxes) {
      if (point.x < box.x + box.w + 12 && point.x + size.w + 12 > box.x &&
        point.y < box.y + box.h + 12 && point.y + size.h + 12 > box.y) cost += 1000000;
      if (box.id !== owner.id && lineHitsBox(segment.from, segment.to, box)) cost += 10000;
    }
    for (const [a, b] of segments) {
      if (lineHitsBox(a, b, { ...point, ...size })) cost += 10000;
      if (linesCross(a, b, segment.from, segment.to)) cost += 100;
    }
    return cost;
  };
  const local = candidates.map(point => bounds ? {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.w - size.w, point.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.h - size.h, point.y)),
  } : point);
  const ranked = local.map((point, i) => ({ point, i, minimum: distance(point) + i * 1e-6 }))
    .sort((a, b) => a.minimum - b.minimum);
  let best = { point: ranked[0]!.point, cost: Infinity };
  for (const candidate of ranked) {
    if (candidate.minimum >= best.cost) break;
    const cost = score(candidate.point) + candidate.i * 1e-6;
    if (cost < best.cost) best = { point: candidate.point, cost };
  }
  return best.point;
}

/**
 * Arranges every visible graph node. Returns absolute top-left positions.
 */
/** Pack related nodes into a balanced grid, then bring neighbours closer. */
function arrangeGridComponent(graph: Map<string, GraphNode>, sizes: Map<string, { w: number; h: number }>, horizontalGap?: number, alignTop = false) {
  const ids = [...graph.keys()].sort();
  const edges = ids.flatMap(id => graph.get(id)!.neighbors.filter(next => id < next).map(next => [id, next] as const));
  const average = { w: ids.reduce((sum, id) => sum + sizes.get(id)!.w, 0) / ids.length,
    h: ids.reduce((sum, id) => sum + sizes.get(id)!.h, 0) / ids.length };
  const gap = horizontalGap ?? Math.max(144, 72 + Math.ceil(Math.max(...[...graph.values()].map(node => node.neighbors.length)) / 2) * 18);
  const ideal = Math.max(1, Math.min(ids.length, Math.round(Math.sqrt(ids.length * 1.6 * (average.h + V_GAP) / (average.w + gap)))));
  const candidates = [];
  for (let columns = Math.max(1, ideal - 1); columns <= Math.min(ids.length, ideal + 1); columns++) {
    const order = [...ids];
    for (let start = columns; start < order.length; start += columns * 2) {
      order.splice(start, columns, ...order.slice(start, start + columns).reverse());
    }
    const cell = new Map(order.map((id, index) => [id, index]));
    const distance = (a: number, b: number) => Math.abs(a % columns - b % columns) * (average.w + gap) +
      Math.abs(Math.floor(a / columns) - Math.floor(b / columns)) * (average.h + V_GAP);
    const cost = (id: string) => graph.get(id)!.neighbors.reduce((sum, next) => sum + distance(cell.get(id)!, cell.get(next)!), 0);
    // ponytail: four local swap sweeps; use a graph-layout engine if much larger
    // schemas need global crossing minimization rather than nearby neighbours.
    for (let sweep = 0; sweep < 4; sweep++) {
      let changed = false;
      for (let a = 0; a < order.length; a++) for (let b = a + 1; b < order.length; b++) {
        const first = order[a]!, second = order[b]!, before = cost(first) + cost(second);
        cell.set(first, b); cell.set(second, a);
        if (cost(first) + cost(second) < before - 1) {
          order[a] = second; order[b] = first; changed = true;
        } else { cell.set(first, a); cell.set(second, b); }
      }
      if (!changed) break;
    }
    const widths = Array.from({ length: columns }, () => 0);
    const heights = Array.from({ length: Math.ceil(order.length / columns) }, () => 0);
    for (let i = 0; i < order.length; i++) {
      const size = sizes.get(order[i]!)!;
      widths[i % columns] = Math.max(widths[i % columns]!, size.w);
      heights[Math.floor(i / columns)] = Math.max(heights[Math.floor(i / columns)]!, size.h);
    }
    const boxes = order.map((id, index) => {
      const size = sizes.get(id)!, column = index % columns, row = Math.floor(index / columns);
      return { id, ...size, x: widths.slice(0, column).reduce((sum, w) => sum + w + gap, 0) + (widths[column]! - size.w) / 2,
        y: heights.slice(0, row).reduce((sum, h) => sum + h + V_GAP, 0) + (alignTop ? 0 : (heights[row]! - size.h) / 2) };
    });
    const width = widths.reduce((sum, w) => sum + w, 0) + (columns - 1) * gap;
    const height = heights.reduce((sum, h) => sum + h, 0) + (heights.length - 1) * V_GAP;
    const length = order.reduce((sum, id) => sum + cost(id), 0) / Math.max(1, order.length);
    const byId = new Map(boxes.map(box => [box.id, box]));
    const segments = edges.map(([from, to]) => {
      const a = byId.get(from)!, b = byId.get(to)!;
      return { from, to, a: { x: a.x + a.w / 2, y: a.y + a.h / 2 }, b: { x: b.x + b.w / 2, y: b.y + b.h / 2 } };
    });
    let conflicts = 0;
    for (let i = 0; i < segments.length; i++) {
      const edge = segments[i]!;
      for (const box of boxes) if (box.id !== edge.from && box.id !== edge.to && lineHitsBox(edge.a, edge.b, box)) conflicts += 4;
      for (let j = i + 1; j < segments.length; j++) if (linesCross(edge.a, edge.b, segments[j]!.a, segments[j]!.b)) conflicts++;
    }
    candidates.push({ boxes, width, height, score: Math.max(width / 1.6, height) ** 2 + width * height * 0.1 +
      (length + conflicts * gap / Math.max(1, ids.length) * 4) * Math.max(width, height) * 0.2 });
  }
  return candidates.sort((a, b) => a.score - b.score)[0]!;
}

/** Dense Chen diagrams pack owner/attribute groups, not alternating layers. */
function arrangeChenComponent(doc: ErdDocument, graph: Map<string, GraphNode>, sizes: Map<string, { w: number; h: number }>) {
  const entities = new Set(doc.entities.map(entity => entity.id));
  const anchors = new Set([...graph.keys()].filter(id => {
    const size = sizes.get(id)!, core = sizeFor(doc, id);
    return entities.has(id) || size.w > core.w || size.h > core.h;
  }));
  const neighbours = (id: string) => {
    const found = new Set<string>(), seen = new Set([id]), queue = [...graph.get(id)!.neighbors];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (anchors.has(next)) found.add(next);
      else queue.push(...graph.get(next)!.neighbors);
    }
    return [...found].sort();
  };
  const linked = new Map([...anchors].map(id => [id, { id, neighbors: neighbours(id) }]));
  const gap = NODE_SIZE.relationship.w + 40;
  const grid = arrangeGridComponent(linked, sizes, gap);
  const coreBox = (block: Positioned & { w: number; h: number }) => {
    const size = sizeFor(doc, block.id);
    return { id: block.id, ...size, x: block.x + (block.w - size.w) / 2, y: block.y + (block.h - size.h) / 2 };
  };
  const boxes = grid.boxes.map(coreBox), occupied: Box[] = [...grid.boxes];
  const byId = new Map(boxes.map(box => [box.id, box]));
  const center = (id: string) => {
    const box = byId.get(id)!;
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  };
  const columns = [...new Set(grid.boxes.map(box => box.x + box.w / 2))].sort((a, b) => a - b);
  const rows = [...new Set(grid.boxes.map(box => box.y + box.h / 2))].sort((a, b) => a - b);
  const xs = columns.map(x => Math.min(...grid.boxes.filter(box => box.x + box.w / 2 === x).map(box => box.x)) - gap / 2);
  const ys = rows.map(y => Math.min(...grid.boxes.filter(box => box.y + box.h / 2 === y).map(box => box.y)) - V_GAP / 2);
  xs.push(grid.width + gap / 2); ys.push(grid.height + V_GAP / 2);
  const points: Point[] = [];
  for (const y of ys) {
    for (let x = -gap / 2; x <= grid.width + gap / 2; x += NODE_SIZE.relationship.w + 20) points.push({ x, y });
    for (const x of columns) points.push({ x, y });
  }
  for (const x of xs) {
    for (let y = -V_GAP / 2; y <= grid.height + V_GAP / 2; y += NODE_SIZE.relationship.h + 16) points.push({ x, y });
    for (const y of rows) points.push({ x, y });
  }
  const lines: Array<[Point, Point]> = [];
  for (const node of [...graph.values()].filter(node => !anchors.has(node.id))
    .sort((a, b) => b.neighbors.length - a.neighbors.length || a.id.localeCompare(b.id))) {
    const targets = [...new Set([...neighbours(node.id), ...node.neighbors])].filter(id => byId.has(id));
    const ends = targets.map(center), size = sizeFor(doc, node.id);
    const desired = { x: ends.reduce((sum, p) => sum + p.x, 0) / ends.length,
      y: ends.reduce((sum, p) => sum + p.y, 0) / ends.length };
    const slots = [desired, ...points].map(p => ({ id: node.id, x: p.x - size.w / 2, y: p.y - size.h / 2, ...size }))
      .filter(slot => !occupied.some(box => overlaps(slot, box, 8)));
    if (!slots.length) {
      // ponytail: finite connector corridors; a full-node grid handles overflow
      // without expanding layers or letting shapes overlap.
      const fallback = arrangeGridComponent(graph, sizes, gap);
      return { ...fallback, boxes: fallback.boxes.map(coreBox) };
    }
    const score = (slot: typeof slots[number]) => {
      const p = { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 };
      let cost = ends.reduce((sum, end) => sum + ((p.x - end.x) ** 2 + (p.y - end.y) ** 2) / 500, 0);
      for (let i = 0; i < ends.length; i++) {
        for (const box of boxes) if (box.id !== targets[i] && lineHitsBox(p, ends[i]!, box)) cost += 100000;
        for (const [a, b] of lines) if (linesCross(p, ends[i]!, a, b)) cost += 100;
      }
      return cost;
    };
    const best = slots.map(slot => ({ slot, score: score(slot) })).sort((a, b) => a.score - b.score)[0]!.slot;
    boxes.push(best); byId.set(best.id, best); occupied.push(best);
    for (const end of ends) lines.push([center(best.id), end]);
  }
  const left = Math.min(...occupied.map(box => box.x)), top = Math.min(...occupied.map(box => box.y));
  return { ...grid, width: Math.max(...occupied.map(box => box.x + box.w)) - left,
    height: Math.max(...occupied.map(box => box.y + box.h)) - top,
    boxes: boxes.map(box => ({ ...box, x: box.x - left, y: box.y - top })) };
}

export function autoArrange(doc: ErdDocument): LayoutResult {
  const tableSizes = new Map(
    (doc.view === 'crowfoot' ? deriveTables(doc) : []).map((table) =>
      [table.entityId, { w: table.width, h: tableHeight(table) }] as const),
  );
  const renderedSize = (id: string) => tableSizes.get(id) ?? sizeFor(doc, id);
  const remaining = buildGraph(doc);
  const layoutSizes = new Map([...remaining.keys()].map(id =>
    [id, doc.view === 'crowfoot' ? renderedSize(id) : attributeSpace(doc, id)] as const));
  const positions = new Map<string, { x: number; y: number }>();
  const components: ReturnType<typeof arrangeGridComponent>[] = [];
  const compactOwners = new Set<string>();
  // The compact engine packs owners and threads relationships between them.
  // It wins whenever the attribute fans fit its budget: the layered engine
  // reserves a wide ring around every owner, which pays off only for fans
  // that actually fill the ring.
  const fans = new Map<string, number>();
  for (const attribute of doc.attributes) {
    if (attribute.ownerId) fans.set(attribute.ownerId, (fans.get(attribute.ownerId) ?? 0) + 1);
  }
  const compactGraph = doc.view !== 'crowfoot' && (doc.entities.length >= DENSE_ENTITY_COUNT ||
    (fans.size > 0 && Math.max(...fans.values()) <= COMPACT_FAN_CAPACITY));
  while (remaining.size) {
    const graph = new Map<string, GraphNode>();
    const queue = [[...remaining.keys()].sort()[0]!];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index]!;
      const node = remaining.get(id);
      if (!node) continue;
      graph.set(id, node);
      remaining.delete(id);
      queue.push(...node.neighbors);
    }
    if (doc.view === 'crowfoot') {
      components.push(arrangeGridComponent(graph, layoutSizes, undefined, true));
      continue;
    }
    if (compactGraph && doc.entities.some(entity => graph.has(entity.id))) {
      for (const id of graph.keys()) layoutSizes.set(id, attributeSpace(doc, id, new Set(), COMPACT_FAN_CAPACITY));
      components.push(arrangeChenComponent(doc, graph, layoutSizes));
      for (const id of graph.keys()) compactOwners.add(id);
      continue;
    }

  // Root at an entity, so the diagram reads entity → relationship → entity
  // rather than starting on a diamond. Among entities, prefer one that is an
  // ISA parent (so a hierarchy reads top-down), then the highest degree, then
  // the lowest id for determinism.
  const isIsaParent = new Set(
    doc.isas.map((i) => i.parentId).filter((id): id is string => typeof id === 'string'),
  );
  let root = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const node of graph.values()) {
    const isEntity = doc.entities.some((e) => e.id === node.id);
    if (!isEntity) continue;
    const distances = assignLayers(graph, node.id);
    const radius = Math.max(...distances.values());
    const score = (isIsaParent.has(node.id) ? 100000 : 0) - radius * 100 + node.neighbors.length;
    if (score > bestScore || (score === bestScore && node.id < root)) {
      bestScore = score;
      root = node.id;
    }
  }
  // Fall back to any node when the document has no entities.
  if (root === '') {
    let bestDegree = -1;
    for (const node of graph.values()) {
      const degree = node.neighbors.length;
      if (degree > bestDegree || (degree === bestDegree && node.id < root)) {
        bestDegree = degree;
        root = node.id;
      }
    }
  }

  const layers = assignLayers(graph, root);
  const layerCount = Math.max(...layers.values()) + 1;
  const buckets = orderLayers(graph, layers, layerCount);

  // Column widths from the widest node in each layer keeps shapes from colliding.
  const columnWidths = buckets.map(bucket => bucket.reduce((max, id) => Math.max(max, layoutSizes.get(id)!.w), 0));
  const heights = buckets.map(bucket => bucket.reduce((sum, id) =>
    sum + layoutSizes.get(id)!.h + V_GAP, -V_GAP));
  // ponytail: score serpentine grids, not a global embedding; use a layout
  // engine if very large, dense graphs need exhaustive crossing minimization.
  const grid = (columns: number) => {
    // Separate turn branches and reverse alternate rows so connectors stay in
    // their lanes instead of crossing through the next branch.
    const isTurn = (layer: number) => columns < layerCount &&
      ((layer + 1 < layerCount && (layer + 1) % columns === 0) || (layer > 0 && layer % columns === 0));
    const layerWidths = buckets.map((bucket, layer) => isTurn(layer)
      ? bucket.reduce((sum, id) => sum + layoutSizes.get(id)!.w + V_GAP, -V_GAP) : columnWidths[layer]!);
    const widths = Array.from({ length: columns }, () => 0);
    const rowHeights = Array.from({ length: Math.ceil(layerCount / columns) }, () => 0);
    for (let i = 0; i < layerCount; i++) {
      const row = Math.floor(i / columns);
      const column = row % 2 === 0 ? i % columns : columns - 1 - i % columns;
      widths[column] = Math.max(widths[column]!, layerWidths[i]!);
      rowHeights[row] = Math.max(rowHeights[row]!, heights[i]!);
    }
    const width = widths.reduce((sum, w) => sum + w, 0) + (columns - 1) * LAYER_GAP;
    const height = rowHeights.reduce((sum, h) => sum + h, 0) + (rowHeights.length - 1) * (LAYER_GAP);
    const boxes: Array<Positioned & { w: number; h: number }> = [];
    for (let layer = 0; layer < layerCount; layer++) {
      const row = Math.floor(layer / columns);
      const column = row % 2 === 0 ? layer % columns : columns - 1 - layer % columns;
      const x = widths.slice(0, column).reduce((sum, w) => sum + w + LAYER_GAP, 0);
      const rowY = rowHeights.slice(0, row).reduce((sum, h) => sum + h + LAYER_GAP, 0);
      let y = rowY + (rowHeights[row]! - heights[layer]!) / 2;
      const groupX = x + (widths[column]! - layerWidths[layer]!) / 2;
      let lane = 0;
      const bucket = row % 2 ? [...buckets[layer]!].reverse() : buckets[layer]!;
      for (const id of bucket) {
        const size = renderedSize(id), block = layoutSizes.get(id)!;
        boxes.push({ id, ...size,
          x: isTurn(layer) ? groupX + (row % 2 ? lane : layerWidths[layer]! - lane - block.w) + (block.w - size.w) / 2
            : x + (widths[column]! - size.w) / 2,
          y: y + (block.h - size.h) / 2 });
        lane += block.w + V_GAP;
        y += block.h + V_GAP;
      }
    }
    let obstructions = 0, crossings = 0;
    if (doc.view !== 'crowfoot') {
      const byId = new Map(boxes.map(box => [box.id, box]));
      const center = (id: string): Point => {
        const box = byId.get(id)!;
        return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      };
      const edges = [...graph.values()].flatMap(node => node.neighbors.filter(id => node.id < id)
        .map(id => ({ fromId: node.id, toId: id, a: center(node.id), b: center(id) })));
      for (const edge of edges) for (const box of boxes) {
        if (box.id !== edge.fromId && box.id !== edge.toId && lineHitsBox(edge.a, edge.b, box)) obstructions++;
      }
      for (let i = 0; i < edges.length; i++) for (const other of edges.slice(i + 1)) {
        if (linesCross(edges[i]!.a, edges[i]!.b, other.a, other.b)) crossings++;
      }
    }
    return { boxes, width, height, obstructions, crossings, score: Math.max(width / 1.6, height) ** 2 + width * height * 0.1 };
  };
  const minColumns = Math.min(3, layerCount);
  const bestGrid = Array.from({ length: layerCount - minColumns + 1 }, (_, i) => grid(i + minColumns))
    .sort((a, b) => a.obstructions - b.obstructions || a.crossings - b.crossings || a.score - b.score)[0]!;
  components.push(bestGrid);
  }
  const targetWidth = Math.sqrt(components.reduce((sum, component) =>
    sum + (component.width + LAYER_GAP) * (component.height + LAYER_GAP), 0) * 1.6);
  components.sort((a, b) => b.width * b.height - a.width * a.height);
  if (doc.entities.length >= DENSE_ENTITY_COUNT && components.length > 1) {
    const groups = new Map(components.map((component, index) =>
      [String(index).padStart(String(components.length).length, '0'), component] as const));
    const groupGraph = new Map<string, GraphNode>(), groupSizes = new Map<string, { w: number; h: number }>();
    for (const [id, component] of groups) {
      groupGraph.set(id, { id, neighbors: [] });
      groupSizes.set(id, { w: component.width, h: component.height });
    }
    for (const group of arrangeGridComponent(groupGraph, groupSizes, LAYER_GAP).boxes) {
      for (const box of groups.get(group.id)!.boxes) positions.set(box.id, { x: box.x + group.x, y: box.y + group.y });
    }
  } else {
    let x = 0, y = 0, rowHeight = 0;
    for (const component of components) {
      if (x && x + component.width > targetWidth) { x = 0; y += rowHeight + LAYER_GAP; rowHeight = 0; }
      for (const box of component.boxes) positions.set(box.id, { x: box.x + x, y: box.y + y });
      x += component.width + LAYER_GAP;
      rowHeight = Math.max(rowHeight, component.height);
    }
  }
  const attributeBounds = new Map([...compactOwners].map(id => {
    const position = positions.get(id)!, size = sizeFor(doc, id), block = layoutSizes.get(id)!;
    return [id, { x: position.x + (size.w - block.w) / 2, y: position.y + (size.h - block.h) / 2, ...block }] as const;
  }));
  return { positions, attributeBounds };
}

/** Reserve the same compact fan used by placement, including nested composites. */
function attributeSpace(doc: ErdDocument, id: string, seen = new Set<string>(), capacity = 8): { w: number; h: number } {
  const size = sizeFor(doc, id);
  if (seen.has(id)) return size;
  seen.add(id);
  const children = doc.attributes.filter(attribute => attribute.ownerId === id && !seen.has(attribute.id));
  if (!children.length) return size;
  const radius = attributeRadius(doc, id, children.length, capacity);
  const blocks = children.map(child => attributeSpace(doc, child.id, seen, capacity));
  return { w: Math.max(size.w, radius.x * 2 + Math.max(...blocks.map(block => block.w))),
    h: Math.max(size.h, radius.y * 2 + Math.max(...blocks.map(block => block.h))) };
}

export function sizeFor(doc: ErdDocument, id: string): { w: number; h: number } {
  if (doc.entities.some((e) => e.id === id)) return NODE_SIZE.entity;
  if (doc.attributes.some((a) => a.id === id)) return NODE_SIZE.attribute;
  if (doc.relationships.some((r) => r.id === id)) return NODE_SIZE.relationship;
  if (doc.isas.some((i) => i.id === id)) return NODE_SIZE.isa;
  return { w: 0, h: 0 };
}

/**
 * Chen moves shapes and their attribute fans. Crow's-foot changes only its
 * table positions and drops manual routes tied to the previous arrangement.
 */
export function applyLayout(doc: ErdDocument): ErdDocument {
  const { positions, attributeBounds } = autoArrange(doc);
  if (positions.size === 0) return doc;
  if (doc.view === 'crowfoot') return {
    ...doc,
    entities: doc.entities.map(entity => {
      const point = positions.get(entity.id);
      return point ? { ...entity, crowX: point.x, crowY: point.y } : entity;
    }),
    relationships: doc.relationships.map(relationship => {
      const next = { ...relationship };
      delete next.route; delete next.bendX; delete next.bendY; delete next.routePoints;
      return next;
    }),
  };

  const move = <T extends Positioned>(node: T): T => {
    const next = positions.get(node.id);
    return next ? { ...node, x: next.x, y: next.y } : node;
  };

  const movedEntities = doc.entities.map(move);
  const movedRelationships = doc.relationships.map(move);
  const movedIsas = doc.isas.map(move);

  // Rebuild attribute fans rather than preserving offsets from the old layout.
  const movedEntitiesById = new Map(movedEntities.map((e) => [e.id, e]));
  const movedRelationshipsById = new Map(movedRelationships.map((r) => [r.id, r]));
  const movedIsasById = new Map(movedIsas.map((i) => [i.id, i]));
  const placedAttributes = new Map<string, ErdDocument['attributes'][number]>();
  const ownerAt = (ownerId: string) =>
    movedEntitiesById.get(ownerId) ?? movedRelationshipsById.get(ownerId) ?? movedIsasById.get(ownerId) ?? placedAttributes.get(ownerId);

  const movedAttributes: ErdDocument['attributes'] = [];
  const attributeOrder = [...doc.attributes].sort((a, b) => Number(b.kind === 'key') - Number(a.kind === 'key') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limits = new Map<string, Box>();
  for (const [ownerId, bounds] of attributeBounds ?? []) {
    for (const id of descendantAttributeIds(doc, ownerId)) limits.set(id, bounds);
  }
  let placed: ErdDocument = { ...doc, entities: movedEntities, relationships: movedRelationships, isas: movedIsas };
  const visiting = new Set<string>();
  const placeAttribute = (attr: ErdDocument['attributes'][number]) => {
    if (placedAttributes.has(attr.id) || visiting.has(attr.id)) return;
    visiting.add(attr.id);
    const parent = doc.attributes.find(a => a.id === attr.ownerId);
    if (parent) {
      placeAttribute(parent);
      // Fill the owner's fan before a composite's children consume its slots.
      for (const sibling of attributeOrder.filter(a => a.ownerId === parent.ownerId)) placeAttribute(sibling);
    }
    const owner = attr.ownerId ? ownerAt(attr.ownerId) : undefined;
    if (!owner) {
      const next = move(attr);
      movedAttributes.push(next);
      placedAttributes.set(attr.id, next);
      return;
    }
    // Place against what has been arranged so far, so siblings spread rather
    // than each claiming the same slot.
    const count = doc.attributes.filter(a => a.ownerId === owner.id).length;
    const next = { ...attr, ...clearAttributeSlot({ ...placed, attributes: movedAttributes }, owner, count, limits.get(attr.id)) };
    movedAttributes.push(next);
    placedAttributes.set(attr.id, next);
    placed = { ...placed, attributes: movedAttributes };
  };
  for (const attr of attributeOrder) placeAttribute(attr);

  return {
    ...doc,
    entities: movedEntities,
    relationships: movedRelationships,
    isas: movedIsas,
    attributes: doc.attributes.map(attr => placedAttributes.get(attr.id) ?? attr),
  };
}
