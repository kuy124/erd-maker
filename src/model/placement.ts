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
import { deriveTables, tableHeight } from './crowfoot';

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

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
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
  return null;
}

/**
 * Vertical gap between stacked attributes, and the gap out to the side.
 *
 * Exported because the layout has to reserve the same space when it stacks
 * shapes: if the two drift apart, auto-arrange can put a shape on top of the
 * attributes belonging to the one above it.
 */
export const ATTRIBUTE_ROW_GAP = 18;
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
  let y = box.y;
  for (const sibling of siblings) {
    y = Math.max(y, sibling.y + size.h + ROW_GAP);
  }

  // Never land on top of the owner. A column the user dragged to the left of
  // the owner can overlap it vertically, so this has to be checked rather than
  // assumed.
  if (overlaps({ x: columnX, y, ...size }, box, 0)) {
    y = box.y + box.h + ROW_GAP;
  }

  return { x: columnX, y };
}

/** Keep an automatic diamond between its entities, stepping sideways if space is tight. */
export function findRelationshipSlot(doc: ErdDocument, fromId: string, toId: string): { x: number; y: number } {
  const from = doc.entities.find((entity) => entity.id === fromId)!;
  const to = doc.entities.find((entity) => entity.id === toId)!;
  const size = NODE_SIZE.relationship;
  const origin = {
    x: (from.x + to.x + NODE_SIZE.entity.w - size.w) / 2,
    y: (from.y + to.y + NODE_SIZE.entity.h - size.h) / 2,
  };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const normal = length ? { x: -dy / length, y: dx / length } : { x: 0, y: 1 };
  const occupied = occupiedBoxes({ ...doc, view: 'chen' });
  for (let index = 0; index < 48; index += 1) {
    const distance = Math.ceil(index / 2) * SLOT_GAP * (index % 2 ? 1 : -1);
    const point = { x: origin.x + normal.x * distance, y: origin.y + normal.y * distance };
    if (!occupied.some((box) => overlaps({ ...point, ...size }, box, SLOT_GAP))) return point;
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
