/**
 * Placement of newly added shapes.
 *
 * Where a new shape lands is not cosmetic. A shape placed on top of another one
 * cannot be clicked, dragged, or even seen, which reads as the app having dropped
 * it. A shape placed far from the thing it belongs to costs a drag every time,
 * which is why attributes get a dedicated slot beside their owner instead of a
 * general free grid.
 *
 * A grid walk is enough for everything else. The search only has to cover the
 * area already in use, and unlike a spiral it stays put across repeated
 * additions instead of drifting away from where the user is looking.
 */

import { NODE_SIZE, type ErdDocument } from './types';
import type { RoutePoint } from './connectorRouting';
import { deriveTables, tableHeight } from './crowfoot';
import { segmentForLeg } from '../canvas/geometry';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest shape the placement logic needs to clear. */
const SLOT_W = 150;
const SLOT_H = 72;

/** Breathing room around each shape, so slots do not touch. */
const SLOT_GAP = 40;

/** The grid is wider than a laptop viewport at 100% zoom, which is deliberate. */
const SLOT_COLUMNS = 4;

const ORIGIN_X = 120;
const ORIGIN_Y = 120;

export function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

/** Shared by placement and Chen rendering, so clearance checks use the actual role paths. */
export function unaryRolePoints(entity: Box, relationship: Box, role: number): [RoutePoint, RoutePoint, RoutePoint] {
  const dx = relationship.x + relationship.w / 2 - entity.x - entity.w / 2;
  const dy = relationship.y + relationship.h / 2 - entity.y - entity.h / 2;
  const vertical = Math.abs(dy) >= Math.abs(dx), side = Math.sign(vertical ? dy : dx) || -1;
  const port = vertical
    ? { x: entity.x + entity.w * (0.18 + role * 0.64), y: entity.y + (side > 0 ? entity.h : 0) }
    : { x: entity.x + (side > 0 ? entity.w : 0), y: entity.y + entity.h * (0.18 + role * 0.64) };
  const shoulder = vertical ? { x: port.x, y: port.y + side * 38 } : { x: port.x + side * 38, y: port.y };
  const corner = vertical
    ? { x: relationship.x + role * relationship.w, y: relationship.y + relationship.h / 2 - side * (1 - Math.abs(2 * role - 1)) * relationship.h / 2 }
    : { x: relationship.x + relationship.w / 2 - side * (1 - Math.abs(2 * role - 1)) * relationship.w / 2, y: relationship.y + role * relationship.h };
  return [port, shoulder, corner];
}

/** Segment/rectangle slab intersection, including space for endpoint symbols. */
function roleCrossesBox(a: RoutePoint, b: RoutePoint, box: Box): boolean {
  let enter = 0, leave = 1;
  for (const [axis, size] of [['x', 'w'], ['y', 'h']] as const) {
    const delta = b[axis] - a[axis], low = box[axis] - 12, high = box[axis] + box[size] + 12;
    if (!delta) { if (a[axis] <= low || a[axis] >= high) return false; }
    else {
      const first = (low - a[axis]) / delta, last = (high - a[axis]) / delta;
      enter = Math.max(enter, Math.min(first, last)); leave = Math.min(leave, Math.max(first, last));
    }
  }
  return leave > enter;
}

/**
 * The first grid position where a new shape fits without overlapping one that is
 * already placed.
 *
 * If the nearby grid is full, put the shape just beyond the occupied area.
 */
export function findFreeSlot(
  occupied: Box[], origin = { x: ORIGIN_X, y: ORIGIN_Y },
  size = { w: SLOT_W, h: SLOT_H },
): { x: number; y: number } {
  const cellW = size.w + SLOT_GAP;
  const cellH = size.h + SLOT_GAP;
  const maxSlots = Math.max(SLOT_COLUMNS * 12, occupied.length + SLOT_COLUMNS + 1);

  for (let index = 0; index < maxSlots; index += 1) {
    const column = index % SLOT_COLUMNS;
    const row = Math.floor(index / SLOT_COLUMNS);
    const x = origin.x + column * cellW;
    const y = origin.y + row * cellH;
    const candidate: Box = { x, y, ...size };
    if (!occupied.some((box) => overlaps(candidate, box, SLOT_GAP))) return { x, y };
  }

  return {
    x: origin.x,
    y: Math.max(origin.y, ...occupied.map((box) => box.y + box.h)) + SLOT_GAP,
  };
}

/** Every shape currently on the canvas, as a box. */
export function occupiedBoxes(doc: ErdDocument): Box[] {
  if (doc.view === 'crowfoot') {
    return deriveTables(doc).map((table) => ({ x: table.x, y: table.y, w: table.width, h: tableHeight(table) }));
  }
  return [
    ...doc.entities.map((n) => ({ x: n.x, y: n.y, ...NODE_SIZE.entity })),
    ...doc.attributes.map((n) => ({ x: n.x, y: n.y, ...NODE_SIZE.attribute })),
    ...doc.relationships.map((n) => ({ x: n.x, y: n.y, ...NODE_SIZE.relationship })),
    ...doc.isas.map((n) => ({ x: n.x, y: n.y, ...NODE_SIZE.isa })),
  ];
}

/** The box of a shape that can own attributes, or null if it cannot. */
function ownerBox(doc: ErdDocument, ownerId: string): Box | null {
  const entity = doc.entities.find((e) => e.id === ownerId);
  if (entity) return { x: entity.x, y: entity.y, ...NODE_SIZE.entity };
  const relationship = doc.relationships.find((r) => r.id === ownerId);
  if (relationship) return { x: relationship.x, y: relationship.y, ...NODE_SIZE.relationship };
  const isa = doc.isas.find((i) => i.id === ownerId);
  if (isa) return { x: isa.x, y: isa.y, ...NODE_SIZE.isa };
  const attr = doc.attributes.find((a) => a.id === ownerId && a.kind === 'composite');
  if (attr) return { x: attr.x, y: attr.y, ...NODE_SIZE.attribute };
  return null;
}

/**
 * Vertical gap between stacked attributes, and the gap out to the side.
 *
 * Exported because the layout has to reserve the same space when it stacks
 * shapes: if the two drift apart, auto-arrange can put a shape on top of the
 * attributes belonging to the one above it.
 */
export const ATTRIBUTE_ROW_GAP = 28;
const ROW_GAP = ATTRIBUTE_ROW_GAP;
const COLUMN_GAP = 60;

/**
 * Where to put a new attribute that belongs to `ownerId`.
 *
 * An attribute is only readable next to the shape it describes — the connector
 * line is what carries that meaning in Chen notation, and a long line across the
 * canvas turns a readable diagram into a hairball. So attributes fan out in a
 * column beside their owner, one per row, which is the arrangement every
 * textbook diagram uses.
 *
 * An existing column is followed rather than restarted. If someone has dragged
 * their attributes into a particular place, the next one belongs with them
 * instead of at a second, competing position.
 *
 * Returns null when there is no owner, so the caller can fall back to a free
 * slot for a genuinely floating attribute.
 */
export function findAttributeSlot(
  doc: ErdDocument,
  ownerId: string | null,
): { x: number; y: number } | null {
  if (!ownerId) return null;
  const box = ownerBox(doc, ownerId);
  if (!box) return null;

  const size = NODE_SIZE.attribute;
  const siblings = doc.attributes.filter((a) => a.ownerId === ownerId);

  // Join the column the user already has, or start one beside the owner.
  const x = siblings.reduce((rightmost, a) => Math.max(rightmost, a.x), Number.NEGATIVE_INFINITY);
  const columnX = Number.isFinite(x) ? x : box.x + box.w + COLUMN_GAP;

  // Stack below the lowest thing already in the column.
  let startY = box.y;
  for (const sibling of siblings) {
    startY = Math.max(startY, sibling.y + size.h + ROW_GAP);
  }

  // Never land on top of the owner. A column the user dragged to the left of
  // the owner can overlap it vertically, so this has to be checked rather than
  // assumed.
  if (overlaps({ x: columnX, y: startY, ...size }, box, 0)) {
    startY = box.y + box.h + ROW_GAP;
  }

  const occupied = occupiedBoxes({ ...doc, view: 'chen' });
  // A link's corridor is occupied too: an attribute drawn across a line hides
  // the cardinality glyph that sits on that line, making both unreadable.
  const pad = 12; // room for the glyph at each end of a segment
  const legBoxes = doc.legs.flatMap((leg) => {
    const seg = segmentForLeg(doc, leg);
    if (!seg) return [];
    const pts = seg.points ?? [seg.from, seg.to];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return [{
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    }];
  });

  // Walk down the column, stepping past clusters of blockers, and report the
  // first clear row. `limit` is how far the walk may drift before the column
  // counts as full: a new attribute belongs near its owner, so a column that
  // is crowded at the owner's end is abandoned for one beside it instead of
  // running down to the bottom of the band.
  const scan = (x: number, from: number, limit: number): number | null => {
    let y = from;
    for (let step = 0; step <= occupied.length + legBoxes.length; step += 1) {
      const candidate = { x, y, ...size };
      const blockers = occupied.filter((box) => overlaps(candidate, box, ROW_GAP));
      const across = legBoxes.findIndex((box) => overlaps(candidate, box, 0));
      if (blockers.length === 0 && across === -1) return y;
      const bottoms = blockers.map((box) => box.y + box.h);
      if (across !== -1) bottoms.push(legBoxes[across]!.y + legBoxes[across]!.h);
      y = Math.max(...bottoms) + ROW_GAP;
      if (y - from > limit) return null;
    }
    return null;
  };

  // The column starts beside the owner and shifts right only as far as it takes.
  const columnPitch = size.w + COLUMN_GAP;
  const drift = (size.h + ROW_GAP) * 4;
  for (let column = 0; column < 6; column += 1) {
    const x = columnX + column * columnPitch;
    const y = scan(x, startY, drift);
    if (y !== null) return { x, y };
  }
  // Every nearby column is full; the next clear row of the first one is the
  // honest answer, however far down it is.
  const fallback = scan(columnX, startY, Number.POSITIVE_INFINITY);
  return { x: columnX, y: fallback ?? Math.max(startY, ...occupied.map((box) => box.y + box.h)) + ROW_GAP };
}

/** Keep an automatic diamond between its entities, at the nearest free point to their midpoint. */
export function findRelationshipSlot(doc: ErdDocument, fromId: string, toId: string): { x: number; y: number } {
  const from = doc.entities.find((entity) => entity.id === fromId)!;
  const to = doc.entities.find((entity) => entity.id === toId)!;
  const size = NODE_SIZE.relationship;
  if (fromId === toId) {
    const occupied = occupiedBoxes({ ...doc, view: 'chen' });
    const entity = { ...from, ...NODE_SIZE.entity };
    const origin = { x: from.x + (entity.w - size.w) / 2, y: from.y - size.h - 64 };
    const blockers = occupied.filter(box => !(box.x === entity.x && box.y === entity.y && box.w === entity.w && box.h === entity.h));
    for (let ring = 0; ring < 48; ring++) {
      const distance = ring * (size.w + SLOT_GAP);
      const candidates = ring === 0 ? [origin] : [
        { x: origin.x - distance, y: origin.y }, { x: origin.x + distance, y: origin.y },
        { x: origin.x, y: origin.y - distance }, { x: origin.x, y: from.y + entity.h + 64 + distance },
      ];
      for (const point of candidates) {
        const diamond = { ...point, ...size };
        if (occupied.some(box => overlaps(diamond, box, SLOT_GAP))) continue;
        const paths = [0, 1].map(role => unaryRolePoints(entity, diamond, role));
        if (paths.every(path => path.slice(1).every((end, index) => !blockers.some(box => roleCrossesBox(path[index]!, end, box))))) return point;
      }
    }
    return findFreeSlot(occupied, origin, size);
  }
  const origin = {
    x: (from.x + to.x + NODE_SIZE.entity.w - size.w) / 2,
    y: (from.y + to.y + NODE_SIZE.entity.h - size.h) / 2,
  };
  const occupied = occupiedBoxes({ ...doc, view: 'chen' });
  // Nearest free point around the midpoint, searched in two dimensions: a
  // column of attributes beside the line is stepped around, not climbed over.
  const reach = 16;
  const candidates: { x: number; y: number; distance: number }[] = [];
  for (let dx = -reach; dx <= reach; dx += 1) {
    for (let dy = -reach; dy <= reach; dy += 1) {
      candidates.push({ x: origin.x + dx * SLOT_GAP, y: origin.y + dy * SLOT_GAP, distance: dx * dx + dy * dy });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  for (const point of candidates) {
    if (!occupied.some((box) => overlaps({ ...point, ...size }, box, SLOT_GAP))) return { x: point.x, y: point.y };
  }
  return findFreeSlot(occupied, origin, size);
}

/**
 * Whether a leg between two nodes makes sense.
 *
 * Entities, relationships, and specializations can all take part in a line.
 * Attributes cannot: their link to their owner is stored as `ownerId` and drawn
 * separately, so a leg between two attributes is a line that the SQL
 * generator and the crow's-foot view both ignore — a connection that appears to
 * work and does nothing.
 *
 * The UI uses this to decide what can be connected, so the rule lives here
 * rather than being re-implemented by each caller.
 */
export function canConnect(doc: ErdDocument, fromId: string, toId: string): boolean {
  if (fromId === toId) return false;
  const connectable = (id: string): boolean =>
    doc.entities.some((e) => e.id === id) ||
    doc.relationships.some((r) => r.id === id) ||
    doc.isas.some((i) => i.id === id);
  return connectable(fromId) && connectable(toId);
}
