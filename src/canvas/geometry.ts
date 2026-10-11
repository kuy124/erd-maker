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

import { sizeOf, allNodes, type ErdDocument, type NodeId, type Positioned } from '../model/types';
import { deriveLinks, deriveTables, routeColumns } from '../model/crowfoot';
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

/**
 * The ids a drag starting on `id` should carry.
 *
 * A group moves as one thing, so dragging any member carries the rest of its
 * group. Explicit selections still win over membership: if the person selected
 * something by hand, that is what they meant to move.
 */
export function dragSet(doc: ErdDocument, id: string, selected: string[]): string[] {
  if (selected.length > 1) return selected;
  const group = doc.groups.find((g) => g.memberIds.includes(id));
  return group ? group.memberIds : [id];
}

/**
 * Every node whose box overlaps a world rectangle, in document order.
 *
 * Used by the marquee. The test is deliberately loose — the rectangle only has
 * to touch a shape for it to count, because dragging a selection around four
 * scattered entities and missing one because a corner clipped it is far worse
 * than catching a shape you brushed past.
 */
export function nodesInRect(doc: ErdDocument, rect: Bounds): string[] {
  return allNodes(doc)
    .filter((node) => {
      const size = sizeOf(doc, node.id);
      return node.x < rect.maxX && node.x + size.w > rect.minX &&
             node.y < rect.maxY && node.y + size.h > rect.minY;
    })
    .map((node) => node.id);
}

/** Where a new shape should land, in world coordinates.
 *
 * Under the pointer, because that is where the person is looking. Creating in
 * the middle of the screen instead means every shape lands in the same spot no
 * matter where you were working, and then walks away from your cursor.
 *
 * Two guard rails, both of which matter more than they look:
 *
 *   - The pointer is only trusted while it is over the canvas. Wandering into
 *     the side panel and pressing E must not drop a shape behind the panel,
 *     where it looks like the keyboard did nothing.
 *   - The result is clamped to the visible area, so a pointer sitting just off
 *     the edge still produces a shape you can see.
 *
 * With no pointer, or no measured canvas, it falls back to the middle — which
 * is what happened unconditionally before.
 */
export function cursorOrigin(
  size: Size,
  pointer: { x: number; y: number } | null,
  rect: { left: number; top: number; width: number; height: number } | null,
  viewport: { x: number; y: number; zoom: number },
): Point {
  const width = rect?.width ?? 800;
  const height = rect?.height ?? 600;
  const inside = pointer && rect
    ? { x: pointer.x - rect.left, y: pointer.y - rect.top }
    : { x: width / 2, y: height / 2 };

  const { zoom } = viewport;
  const world = {
    x: (inside.x - viewport.x) / zoom,
    y: (inside.y - viewport.y) / zoom,
  };

  // The world rectangle currently on screen, with a little breathing room.
  const margin = 16;
  const minX = -viewport.x / zoom + margin;
  const minY = -viewport.y / zoom + margin;
  const maxX = (width - viewport.x) / zoom - margin;
  const maxY = (height - viewport.y) / zoom - margin;

  // A shape wider than the viewport cannot be kept inside it, so centre it
  // rather than fighting the clamp.
  const cx = maxX - minX < size.w
    ? (minX + maxX) / 2
    : Math.min(Math.max(world.x, minX + size.w / 2), maxX - size.w / 2);
  const cy = maxY - minY < size.h
    ? (minY + maxY) / 2
    : Math.min(Math.max(world.y, minY + size.h / 2), maxY - size.h / 2);

  return { x: cx - size.w / 2, y: cy - size.h / 2 };
}

/** True when a node's top-left corner and size fall inside the visible area. */
export function isVisibleIn(
  x: number,
  y: number,
  size: Size,
  viewportWidth: number,
  viewportHeight: number,
  viewport: { x: number; y: number; zoom: number },
): boolean {
  const { zoom } = viewport;
  return (
    x >= -viewport.x / zoom &&
    y >= -viewport.y / zoom &&
    x + size.w <= (viewportWidth - viewport.x) / zoom &&
    y + size.h <= (viewportHeight - viewport.y) / zoom
  );
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
  if (doc.view === 'crowfoot') {
    const tables = deriveTables(doc);
    for (const link of deriveLinks(doc).filter((link, index, all) => all.findIndex((l) => l.relId === link.relId) === index)) {
      const from = tables.find((t) => t.entityId === link.fromEntityId)!;
      const to = tables.find((t) => t.entityId === link.toEntityId)!;
      const route = routeColumns(from, link.fromColumnId, to, link.toColumnId, link.lane);
      const textWidth = Math.min(link.label.length, 24) * 8;
      minX = Math.min(minX, route.bounds.minX, route.label.x - (route.labelAnchor === 'start' ? 0 : textWidth));
      maxX = Math.max(maxX, route.bounds.maxX, route.label.x + (route.labelAnchor === 'end' ? 0 : textWidth));
      minY = Math.min(minY, route.bounds.minY, route.label.y - 25);
      maxY = Math.max(maxY, route.bounds.maxY, route.label.y + 10);
    }
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
