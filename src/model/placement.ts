/**
 * Placement of newly added shapes.
 *
 * Where a new shape lands is not cosmetic: a shape placed on top of another one
 * cannot be clicked, dragged, or even seen, which reads as the app having
 * dropped it. So the rule here is simply that a new shape never overlaps an
 * existing one.
 *
 * A grid walk is enough. The search only has to cover the area already in use,
 * and unlike a spiral it stays put across repeated additions instead of drifting
 * away from where the user is looking.
 */

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

/**
 * The first grid position where a new shape fits without overlapping one that
 * is already placed.
 *
 * If every slot in a generous area is taken the last one is reused, so this
 * always returns a usable position — a caller never has to handle "no room".
 */
export function findFreeSlot(occupied: Box[]): { x: number; y: number } {
  const cellW = SLOT_W + SLOT_GAP;
  const cellH = SLOT_H + SLOT_GAP;
  const maxSlots = Math.max(SLOT_COLUMNS * 12, occupied.length + SLOT_COLUMNS + 1);

  for (let index = 0; index < maxSlots; index += 1) {
    const column = index % SLOT_COLUMNS;
    const row = Math.floor(index / SLOT_COLUMNS);
    const x = ORIGIN_X + column * cellW;
    const y = ORIGIN_Y + row * cellH;
    const candidate: Box = { x, y, w: SLOT_W, h: SLOT_H };
    const clash = occupied.some(
      (box) =>
        candidate.x < box.x + box.w + SLOT_GAP &&
        candidate.x + candidate.w + SLOT_GAP > box.x &&
        candidate.y < box.y + box.h + SLOT_GAP &&
        candidate.y + candidate.h + SLOT_GAP > box.y,
    );
    if (!clash) return { x, y };
  }

  const last = maxSlots - 1;
  return {
    x: ORIGIN_X + (last % SLOT_COLUMNS) * cellW,
    y: ORIGIN_Y + Math.floor(last / SLOT_COLUMNS) * cellH,
  };
}
