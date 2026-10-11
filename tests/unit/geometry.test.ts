import { describe, expect, it } from 'vitest';
import {
  centerOf,
  cursorOrigin,
  diamondEdge,
  documentBounds,
  edgePoint,
  ellipseEdge,
  hitTestNode,
  isVisibleIn,
  legLabelPoints,
  offsetToward,
  rectEdge,
  segmentBetween,
} from '../../src/canvas/geometry';
import { emptyDocument, NODE_SIZE, type ErdDocument } from '../../src/model/types';

function scene(): ErdDocument {
  const doc = emptyDocument();
  // Entity at 0,0 sized 150x60 -> center (75,30)
  doc.entities.push({ id: 'e1', name: 'A', x: 0, y: 0, kind: 'strong' });
  // Entity at 400,0 -> center (475,30)
  doc.entities.push({ id: 'e2', name: 'B', x: 400, y: 0, kind: 'strong' });
  // Attribute (ellipse) at 200,300 -> center (265,326)
  doc.attributes.push({ id: 'a1', name: 'x', x: 200, y: 300, kind: 'simple', ownerId: 'e1' });
  // Relationship (diamond) at 200,0 -> center (275,36)
  doc.relationships.push({ id: 'r1', name: 'has', x: 200, y: 0, kind: 'strong' });
  return doc;
}

describe('centerOf / bounds', () => {
  it('computes the centre from top-left plus size', () => {
    expect(centerOf({ id: 'e', x: 10, y: 20 }, { w: 100, h: 50 })).toEqual({ x: 60, y: 45 });
  });
});

describe('rectEdge', () => {
  it('exits through the right edge on a purely horizontal ray', () => {
    const p = rectEdge({ x: 0, y: 0 }, { x: 100, y: 0 }, 50, 30);
    expect(p).toEqual({ x: 50, y: 0 });
  });

  it('exits through the top edge on a purely vertical ray', () => {
    const p = rectEdge({ x: 0, y: 0 }, { x: 0, y: -100 }, 50, 30);
    expect(p).toEqual({ x: 0, y: -30 });
  });

  it('lands exactly on the corner for a 45-degree ray when square', () => {
    const p = rectEdge({ x: 0, y: 0 }, { x: 10, y: 10 }, 50, 50);
    expect(p.x).toBeCloseTo(50);
    expect(p.y).toBeCloseTo(50);
  });

  it('returns the centre when the target coincides with it', () => {
    expect(rectEdge({ x: 5, y: 5 }, { x: 5, y: 5 }, 50, 30)).toEqual({ x: 5, y: 5 });
  });

  it('never escapes the box for arbitrary directions', () => {
    const hw = 50;
    const hh = 30;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
      const target = { x: Math.cos(angle) * 500, y: Math.sin(angle) * 500 };
      const p = rectEdge({ x: 0, y: 0 }, target, hw, hh);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(hw + 1e-9);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(hh + 1e-9);
      // and must touch a border
      const onBorder = Math.abs(Math.abs(p.x) - hw) < 1e-6 || Math.abs(Math.abs(p.y) - hh) < 1e-6;
      expect(onBorder).toBe(true);
    }
  });
});

describe('ellipseEdge', () => {
  it('exits at the horizontal radius on a horizontal ray', () => {
    const p = ellipseEdge({ x: 0, y: 0 }, { x: 100, y: 0 }, 60, 40);
    expect(p.x).toBeCloseTo(60);
    expect(p.y).toBeCloseTo(0);
  });

  it('exits at the vertical radius on a vertical ray', () => {
    const p = ellipseEdge({ x: 0, y: 0 }, { x: 0, y: 100 }, 60, 40);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(40);
  });

  it('satisfies the ellipse equation for arbitrary directions', () => {
    const rx = 65;
    const ry = 26;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 10) {
      const p = ellipseEdge({ x: 0, y: 0 }, { x: Math.cos(angle) * 900, y: Math.sin(angle) * 900 }, rx, ry);
      const value = (p.x * p.x) / (rx * rx) + (p.y * p.y) / (ry * ry);
      expect(value).toBeCloseTo(1, 6);
    }
  });
});

describe('diamondEdge', () => {
  it('exits at the horizontal vertex on a horizontal ray', () => {
    const p = diamondEdge({ x: 0, y: 0 }, { x: 100, y: 0 }, 75, 36);
    expect(p.x).toBeCloseTo(75);
    expect(p.y).toBeCloseTo(0);
  });

  it('exits at the vertical vertex on a vertical ray', () => {
    const p = diamondEdge({ x: 0, y: 0 }, { x: 0, y: 100 }, 75, 36);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(36);
  });

  it('satisfies the rhombus equation for arbitrary directions', () => {
    const hw = 75;
    const hh = 36;
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 10) {
      const p = diamondEdge({ x: 0, y: 0 }, { x: Math.cos(angle) * 900, y: Math.sin(angle) * 900 }, hw, hh);
      expect(Math.abs(p.x) / hw + Math.abs(p.y) / hh).toBeCloseTo(1, 6);
    }
  });
});

describe('edgePoint dispatch', () => {
  it('uses the rectangle silhouette for an entity', () => {
    const doc = scene();
    const p = edgePoint(doc, 'e1', { x: 1000, y: 30 })!;
    // horizontal from centre (75,30), so exits at x = 75 + 75
    expect(p.x).toBeCloseTo(150);
    expect(p.y).toBeCloseTo(30);
  });

  it('uses the ellipse silhouette for an attribute', () => {
    const doc = scene();
    const p = edgePoint(doc, 'a1', { x: 1000, y: 326 })!;
    expect(p.x).toBeCloseTo(265 + NODE_SIZE.attribute.w / 2);
    expect(p.y).toBeCloseTo(326);
  });

  it('uses the diamond silhouette for a relationship', () => {
    const doc = scene();
    const p = edgePoint(doc, 'r1', { x: 1000, y: 36 })!;
    expect(p.x).toBeCloseTo(275 + NODE_SIZE.relationship.w / 2);
    expect(p.y).toBeCloseTo(36);
  });

  it('returns undefined for a missing node', () => {
    expect(edgePoint(scene(), 'ghost', { x: 0, y: 0 })).toBeUndefined();
  });
});

describe('segmentBetween', () => {
  it('trims both ends at the silhouettes, leaving a visible gap', () => {
    const doc = scene();
    const seg = segmentBetween(doc, 'e1', 'e2')!;
    // e1 right edge at x=150, e2 left edge at x=400
    expect(seg.from.x).toBeCloseTo(150);
    expect(seg.to.x).toBeCloseTo(400);
    expect(seg.from.x).toBeLessThan(seg.to.x);
  });

  it('places the midpoint between the two trimmed ends', () => {
    const doc = scene();
    const seg = segmentBetween(doc, 'e1', 'e2')!;
    expect(seg.mid.x).toBeCloseTo((seg.from.x + seg.to.x) / 2);
    expect(seg.mid.y).toBeCloseTo((seg.from.y + seg.to.y) / 2);
  });

  it('is symmetric when called in reverse', () => {
    const doc = scene();
    const forward = segmentBetween(doc, 'e1', 'e2')!;
    const backward = segmentBetween(doc, 'e2', 'e1')!;
    expect(backward.from.x).toBeCloseTo(forward.to.x);
    expect(backward.to.x).toBeCloseTo(forward.from.x);
  });

  it('returns undefined when either node is missing', () => {
    expect(segmentBetween(scene(), 'e1', 'ghost')).toBeUndefined();
  });
});

describe('offsetToward', () => {
  it('moves the given distance along the direction', () => {
    const p = offsetToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(0);
  });

  it('returns the original point when direction is degenerate', () => {
    expect(offsetToward({ x: 3, y: 4 }, { x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 });
  });
});

describe('legLabelPoints', () => {
  it('puts the labels at their fractions of the leg, off the line', () => {
    const [near, far] = legLabelPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, [0.25, 0.5]);
    // Travelling +x, the normal is (0, 1) in screen coordinates.
    expect(near.x).toBeCloseTo(25);
    expect(far.x).toBeCloseTo(50);
    expect(near.y).toBeCloseTo(14);
    expect(far.y).toBe(near.y);
  });

  it('separates labels on legs that share a start point and direction', () => {
    // The case that broke it: Tidy stacked both entities in one column, so both
    // legs leave the same vertex going the same way. A fixed offset put both
    // cardinality labels on one pixel, unreadable and unclickable.
    const vertex = { x: 75, y: 360 };
    const [a] = legLabelPoints(vertex, { x: 75, y: 60 }, [0.28, 0.52]);
    const [b] = legLabelPoints(vertex, { x: 75, y: 240 }, [0.28, 0.52]);
    expect(a.y).not.toBeCloseTo(b.y);
  });

  it('returns the shared point when the leg has no length', () => {
    const p = { x: 3, y: 4 };
    expect(legLabelPoints(p, p, [0.3, 0.6])).toEqual([{ ...p }, { ...p }]);
  });
});

describe('hitTestNode', () => {
  it('hits inside an entity and misses outside', () => {
    const doc = scene();
    expect(hitTestNode(doc, 'e1', { x: 75, y: 30 })).toBe(true);
    expect(hitTestNode(doc, 'e1', { x: 500, y: 30 })).toBe(false);
  });

  it('respects the elliptical silhouette of an attribute', () => {
    const doc = scene();
    const size = NODE_SIZE.attribute;
    const center = { x: 265, y: 326 };
    expect(hitTestNode(doc, 'a1', center)).toBe(true);
    // A point just inside the bounding box corner is outside the ellipse.
    expect(
      hitTestNode(doc, 'a1', { x: center.x + size.w / 2 - 1, y: center.y + size.h / 2 - 1 }),
    ).toBe(false);
  });

  it('respects the diamond silhouette of a relationship', () => {
    const doc = scene();
    const size = NODE_SIZE.relationship;
    const center = { x: 275, y: 36 };
    expect(hitTestNode(doc, 'r1', center)).toBe(true);
    // Bounding-box corner is outside a diamond.
    expect(
      hitTestNode(doc, 'r1', { x: center.x + size.w / 2 - 1, y: center.y + size.h / 2 - 1 }),
    ).toBe(false);
  });

  it('misses a node id that does not exist', () => {
    expect(hitTestNode(scene(), 'ghost', { x: 0, y: 0 })).toBe(false);
  });
});

describe('documentBounds', () => {
  it('returns a default frame for an empty document', () => {
    const b = documentBounds(emptyDocument());
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 800, maxY: 600 });
  });

  it('encloses every node plus padding', () => {
    const doc = scene();
    const b = documentBounds(doc, 50);
    // widest node right edge is e2 at 400+150=550
    expect(b.maxX).toBe(550 + 50);
    expect(b.minX).toBeLessThanOrEqual(0);
  });

  it('uses a custom padding', () => {
    const doc = scene();
    expect(documentBounds(doc, 0).maxX).toBe(550);
  });
});

describe('cursorOrigin', () => {
  const SIZE = { w: 150, h: 60 };
  const RECT = { left: 0, top: 0, width: 1000, height: 800 };
  const VIEWPORT = { x: 0, y: 0, zoom: 1 };

  it('centres the shape on the pointer', () => {
    // Pointer at (300,400) in a canvas at the origin: the 150x60 shape's
    // top-left is the pointer minus half its size.
    expect(cursorOrigin(SIZE, { x: 300, y: 400 }, RECT, VIEWPORT)).toEqual({ x: 225, y: 370 });
  });

  it('falls back to the middle of the canvas with no pointer', () => {
    expect(cursorOrigin(SIZE, null, RECT, VIEWPORT)).toEqual({ x: 425, y: 370 });
  });

  it('falls back to the middle with no measured canvas', () => {
    expect(cursorOrigin(SIZE, { x: 300, y: 400 }, null, VIEWPORT)).toEqual({ x: 325, y: 270 });
  });

  it('accounts for pan and zoom', () => {
    // Panned right by 100 and zoomed to 2x: client (300,400) maps to world
    // (100,200), so the shape's top-left is that minus half its size.
    expect(cursorOrigin(SIZE, { x: 300, y: 400 }, RECT, { x: 100, y: 0, zoom: 2 })).toEqual({ x: 25, y: 170 });
  });

  it('accounts for the canvas not being at the page origin', () => {
    // A canvas offset by a 64px header: the same client point is 64 higher.
    const offset = { left: 0, top: 64, width: 1000, height: 800 };
    expect(cursorOrigin(SIZE, { x: 300, y: 464 }, offset, VIEWPORT)).toEqual({ x: 225, y: 370 });
  });

  it('keeps a shape on screen when the pointer wanders past the edge', () => {
    // Pointer far below the canvas: the shape is clamped to the bottom margin,
    // not dropped out of sight below the fold.
    const origin = cursorOrigin(SIZE, { x: 300, y: 5000 }, RECT, VIEWPORT);
    expect(origin.y + SIZE.h).toBeLessThanOrEqual(800 - 16);
    expect(origin.y + SIZE.h).toBeGreaterThan(800 - 16 - 1);
  });

  it('keeps a shape on screen when the pointer is over a side panel', () => {
    const origin = cursorOrigin(SIZE, { x: -240, y: 400 }, RECT, VIEWPORT);
    expect(origin.x).toBeGreaterThanOrEqual(16);
  });

  it('centres a shape too large to fit rather than fighting the clamp', () => {
    // 4000x3000 in a 1000x800 canvas: centred on the visible area, which is
    // inset by the 16px margin on each side.
    const huge = { w: 4000, h: 3000 };
    expect(cursorOrigin(huge, { x: 10, y: 10 }, RECT, VIEWPORT)).toEqual({ x: -1500, y: -1100 });
  });
});

describe('isVisibleIn', () => {
  const VIEWPORT = { x: 0, y: 0, zoom: 1 };
  it('accepts a shape inside the visible area', () => {
    expect(isVisibleIn(100, 100, { w: 150, h: 60 }, 1000, 800, VIEWPORT)).toBe(true);
  });
  it('rejects a shape past the right or bottom edge', () => {
    expect(isVisibleIn(900, 100, { w: 150, h: 60 }, 1000, 800, VIEWPORT)).toBe(false);
    expect(isVisibleIn(100, 780, { w: 150, h: 60 }, 1000, 800, VIEWPORT)).toBe(false);
  });
  it('follows pan and zoom', () => {
    // Content panned right by 500, so visible world x runs from -500 to 500.
    const panned = { x: 500, y: 0, zoom: 1 };
    expect(isVisibleIn(-400, 100, { w: 150, h: 60 }, 1000, 800, panned)).toBe(true);
    expect(isVisibleIn(-600, 100, { w: 150, h: 60 }, 1000, 800, panned)).toBe(false);
    // Zoomed to 2x with no pan, only world 0..500 is on screen.
    expect(isVisibleIn(600, 100, { w: 150, h: 60 }, 1000, 800, { x: 0, y: 0, zoom: 2 })).toBe(false);
    expect(isVisibleIn(300, 100, { w: 150, h: 60 }, 1000, 800, { x: 0, y: 0, zoom: 2 })).toBe(true);
  });
});
