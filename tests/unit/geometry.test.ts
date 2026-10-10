import { describe, expect, it } from 'vitest';
import {
  centerOf,
  diamondEdge,
  documentBounds,
  edgePoint,
  ellipseEdge,
  hitTestNode,
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
