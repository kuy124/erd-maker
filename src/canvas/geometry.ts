/**
 * Canvas geometry.
 *
 * Pure math for placing connectors. Each shape has a different silhouette, so
 * each gets its own ray/silhouette intersection: a line must stop at the
 * rectangle's border for an entity, the ellipse's for an attribute, and the
 * diamond's for a relationship. Getting this wrong is the difference between a
 * diagram that looks drawn and one that looks assembled.
 *
 * Convention: a node's `x`/`y` is the top-left of its bounding box.
 */

import { sizeOf, type ErdDocument, type NodeId, type Positioned } from '../model/types';
import { occupiedBoxes } from '../model/placement';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function centerOf(node: Positioned, size: Size): Point {
  return { x: node.x + size.w / 2, y: node.y + size.h / 2 };
}

export function boundsOf(node: Positioned, size: Size): Bounds {
  return { minX: node.x, minY: node.y, maxX: node.x + size.w, maxY: node.y + size.h };
}

/**
 * Where the segment from `center` toward `target` leaves a rectangle of
 * half-extents `hw`/`hh`. Scales the direction vector by the smallest factor
 * that lands on a border, which is the classic slab intersection.
 */
export function rectEdge(center: Point, target: Point, hw: number, hh: number): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { ...center };

  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : hw / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : hh / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/**
 * Where the segment leaves an axis-aligned ellipse with radii `rx`/`ry`.
 * Solves for the parameter where (x/rx)^2 + (y/ry)^2 = 1.
 */
export function ellipseEdge(center: Point, target: Point, rx: number, ry: number): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { ...center };
  const denom = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  if (denom === 0) return { ...center };
  const scale = 1 / denom;
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/**
 * Where the segment leaves a rhombus (the relationship diamond), whose border
 * satisfies |x|/hw + |y|/hh = 1.
 */
export function diamondEdge(center: Point, target: Point, hw: number, hh: number): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { ...center };
  const denom = Math.abs(dx) / hw + Math.abs(dy) / hh;
  if (denom === 0) return { ...center };
  const scale = 1 / denom;
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

/**
 * The point on a node's silhouette facing `target`, dispatching on shape kind.
 * Attributes are ellipses, relationships are diamonds, everything else is a
 * rectangle. Weak entities/relationships use the outer box so the connector
 * still meets the outermost line.
 */
export function edgePoint(
  doc: ErdDocument,
  id: NodeId,
  target: Point,
): Point | undefined {
  const node = findPositioned(doc, id);
  if (!node) return undefined;
  const size = sizeOf(doc, id);
  const center = centerOf(node, size);

  if (doc.attributes.some((a) => a.id === id)) {
    return ellipseEdge(center, target, size.w / 2, size.h / 2);
  }
  if (doc.relationships.some((r) => r.id === id)) {
    return diamondEdge(center, target, size.w / 2, size.h / 2);
  }
  return rectEdge(center, target, size.w / 2, size.h / 2);
}

function findPositioned(doc: ErdDocument, id: NodeId): Positioned | undefined {
  return (
    doc.entities.find((e) => e.id === id) ??
    doc.attributes.find((a) => a.id === id) ??
    doc.relationships.find((r) => r.id === id) ??
    doc.isas.find((i) => i.id === id)
  );
}

export interface Segment {
  from: Point;
  to: Point;
  /** Midpoint of the visible segment, where a cardinality label belongs. */
  mid: Point;
}

/**
 * The visible segment between two nodes: from the source's silhouette toward
 * the target's centre, to the target's silhouette toward the source's centre.
 * Trimming both ends is what keeps arrowheads and cardinality labels off the
 * shapes.
 */
export function segmentBetween(doc: ErdDocument, fromId: NodeId, toId: NodeId): Segment | undefined {
  const fromNode = findPositioned(doc, fromId);
  const toNode = findPositioned(doc, toId);
  if (!fromNode || !toNode) return undefined;

  const fromCenter = centerOf(fromNode, sizeOf(doc, fromId));
  const toCenter = centerOf(toNode, sizeOf(doc, toId));

  const from = edgePoint(doc, fromId, toCenter);
  const to = edgePoint(doc, toId, fromCenter);
  if (!from || !to) return undefined;

  return {
    from,
    to,
    mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
  };
}

/**
 * Where a leg's cardinality and participation labels sit.
 *
 * Placed at a fraction of the leg rather than a fixed distance from its start.
 * Two legs can leave the same shape in the same direction — a relationship
 * joined to two entities Tidy stacked in one column, for instance — and a fixed
 * offset then puts both labels on the identical pixel, leaving them unreadable
 * and impossible to click. A fraction separates them, because the two legs have
 * different lengths.
 *
 * Nudged sideways off the line so the text does not sit on the stroke.
 */
export function legLabelPoints(
  from: Point,
  to: Point,
  fractions: [number, number],
  standoff = 14,
): [Point, Point] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [{ ...from }, { ...from }];
  // Unit normal to the leg. Points to the left of the direction of travel.
  const nx = -dy / len;
  const ny = dx / len;
  const place = (fraction: number): Point => ({
    x: from.x + dx * fraction + nx * standoff,
    y: from.y + dy * fraction + ny * standoff,
  });
  return [place(fractions[0]), place(fractions[1])];
}

/** A point offset from `point` toward `toward` by `distance` pixels. */
export function offsetToward(point: Point, toward: Point, distance: number): Point {
  const dx = toward.x - point.x;
  const dy = toward.y - point.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { ...point };
  return { x: point.x + (dx / len) * distance, y: point.y + (dy / len) * distance };
}

/** Combined bounding box of every node, or a default frame when empty. */
export function documentBounds(doc: ErdDocument, padding = 80): Bounds {
  const nodes = occupiedBoxes(doc);
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const b = { minX: node.x, minY: node.y, maxX: node.x + node.w, maxY: node.y + node.h };
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

/** True when a point falls inside a node's silhouette (loose hit test). */
export function hitTestNode(doc: ErdDocument, id: NodeId, point: Point): boolean {
  const node = findPositioned(doc, id);
  if (!node) return false;
  const size = sizeOf(doc, id);
  const center = centerOf(node, size);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  if (doc.attributes.some((a) => a.id === id)) {
    const rx = size.w / 2;
    const ry = size.h / 2;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
  }
  if (doc.relationships.some((r) => r.id === id)) {
    const hw = size.w / 2;
    const hh = size.h / 2;
    return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
  }
  return Math.abs(dx) <= size.w / 2 && Math.abs(dy) <= size.h / 2;
}
