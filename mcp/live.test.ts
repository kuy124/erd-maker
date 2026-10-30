import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { HOVER_MS, LiveRoom, PRESS_MS, THINK_MS, TYPING_MS, legEase, liveSteps, presenceAt, roomFromLink, routeDurationsMs, routePoint, settleOffset, travelBow, travelControl, travelDurationMs, travelEase, travelPoint, writeDocumentDiff, type CursorPoint } from './live';
import { buildShareUrl, normalizeDocument } from '../src/model/snapshot';
import { emptyDocument, type Attribute, type ErdDocument, type Leg, type Relationship } from '../src/model/types';
import { seedDocument, snapshotFromYdoc, upsertAttribute } from '../src/collab/ydoc';
import { CROW_HEADER_HEIGHT, CROW_WIDTH } from '../src/model/crowfoot';

function sampleDoc(): ErdDocument {
  const doc = emptyDocument('Sales');
  doc.entities.push(
    { id: 'ent_customer', name: 'Customer', x: 10, y: 20, kind: 'strong' },
    { id: 'ent_order', name: 'Order', x: 300, y: 20, kind: 'strong' },
  );
  const attributes: Attribute[] = [
    { id: 'attr_customer_id', name: 'customer_id', x: 10, y: 80, kind: 'key', ownerId: 'ent_customer', dataType: 'INT' },
    { id: 'attr_email', name: 'email', x: 10, y: 120, kind: 'unique', ownerId: 'ent_customer', dataType: 'VARCHAR(160)' },
    { id: 'attr_order_id', name: 'order_id', x: 300, y: 80, kind: 'key', ownerId: 'ent_order', dataType: 'INT' },
  ];
  const relationship: Relationship = { id: 'rel_places', name: 'places', x: 200, y: 100, kind: 'strong' };
  const legs: Leg[] = [
    { id: 'leg_places_customer', fromId: 'rel_places', toId: 'ent_customer', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'leg_places_order', fromId: 'rel_places', toId: 'ent_order', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  doc.attributes.push(...attributes);
  doc.relationships.push(relationship);
  doc.legs.push(...legs);
  return doc;
}

function comparable(doc: ErdDocument): ErdDocument {
  const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    ...doc,
    entities: [...doc.entities].sort(byId),
    attributes: [...doc.attributes].sort(byId),
    relationships: [...doc.relationships].sort(byId),
    isas: [...doc.isas].sort(byId),
    legs: [...doc.legs].sort(byId),
    groups: [...doc.groups].sort(byId),
    comments: [...doc.comments].sort(byId),
  };
}

describe('room links', () => {
  it('reads a room and snapshot from a share URL', () => {
    const link = roomFromLink(buildShareUrl('https://kuy124.github.io/erd-maker/', sampleDoc(), 'room1234'));
    expect(link.room).toBe('room1234');
    expect(link.baseUrl).toBe('https://kuy124.github.io/erd-maker/');
    expect(link.origin).toBe('https://kuy124.github.io');
    expect(link.doc?.name).toBe('Sales');
    expect(link.doc?.entities).toHaveLength(2);
  });

  it('reads a fragment, a bare id, and a URL with no room', () => {
    expect(roomFromLink('#room=room1234').room).toBe('room1234');
    expect(roomFromLink('"room1234"').room).toBe('room1234');
    expect(roomFromLink('https://kuy124.github.io/erd-maker/')).toMatchObject({
      baseUrl: 'https://kuy124.github.io/erd-maker/',
      origin: 'https://kuy124.github.io',
    });
    expect(roomFromLink('https://kuy124.github.io/erd-maker/').room).toBeUndefined();
  });

  it('rejects text that is neither a link nor a room id', () => {
    expect(roomFromLink('not a room!')).toEqual({});
    expect(roomFromLink('   ')).toEqual({});
  });
});

describe('presence', () => {
  it('points into the middle of the focused shape, not its corner', () => {
    expect(presenceAt(sampleDoc(), 'ent_customer', 'chen')).toEqual({
      view: 'chen',
      cursor: { x: 85, y: 50 },
      selectedIds: ['ent_customer'],
    });
  });

  it('uses the table header in crow’s-foot, where the entity itself has no position', () => {
    const doc = sampleDoc();
    doc.entities[0]!.crowX = 500;
    doc.entities[0]!.crowY = 300;
    expect(presenceAt(doc, 'ent_customer', 'crowfoot').cursor).toEqual({
      x: 500 + CROW_WIDTH / 2,
      y: 300 + CROW_HEADER_HEIGHT / 2,
    });
  });

  it('falls back to the plain position when the table has not been arranged', () => {
    expect(presenceAt(sampleDoc(), 'ent_customer', 'crowfoot').cursor).toEqual({ x: 10, y: 20 });
  });

  it('points at an attribute’s own bubble in Chen', () => {
    expect(presenceAt(sampleDoc(), 'attr_customer_id', 'chen').cursor).toEqual({ x: 75, y: 106 });
  });

  it('holds an attribute on its table’s header in crow’s-foot', () => {
    const doc = sampleDoc();
    doc.entities[0]!.crowX = 500;
    doc.entities[0]!.crowY = 300;
    expect(presenceAt(doc, 'attr_customer_id', 'crowfoot').cursor).toEqual({
      x: 500 + CROW_WIDTH / 2,
      y: 300 + CROW_HEADER_HEIGHT / 2,
    });
  });

  it('points at the relationship diamond itself in Chen', () => {
    expect(presenceAt(sampleDoc(), 'rel_places', 'chen').cursor).toEqual({ x: 275, y: 136 });
  });

  it('sends no cursor for no focus, and no selection for a shape that is gone', () => {
    expect(presenceAt(sampleDoc(), null, 'chen')).toEqual({ view: 'chen', cursor: null, selectedIds: [] });
    expect(presenceAt(sampleDoc(), 'ent_deleted', 'chen')).toEqual({ view: 'chen', cursor: null, selectedIds: [] });
  });
});

describe('streaming order', () => {
  it('visits every entity and every attribute before the relationships', () => {
    expect(liveSteps(sampleDoc())).toEqual([
      { id: 'ent_customer', kind: 'entity' },
      { id: 'attr_customer_id', kind: 'attribute' },
      { id: 'attr_email', kind: 'attribute' },
      { id: 'ent_order', kind: 'entity' },
      { id: 'attr_order_id', kind: 'attribute' },
      { id: 'rel_places', kind: 'relationship' },
    ]);
  });

  it('clicks a relationship’s own attributes after the diamond', () => {
    const doc = sampleDoc();
    doc.attributes.push({ id: 'attr_places_since', name: 'since', x: 200, y: 180, kind: 'simple', ownerId: 'rel_places' });
    expect(liveSteps(doc).map((step) => step.id)).toEqual([
      'ent_customer', 'attr_customer_id', 'attr_email',
      'ent_order', 'attr_order_id',
      'rel_places', 'attr_places_since',
    ]);
  });

  it('keeps an attribute whose owner is missing instead of dropping it', () => {
    const doc = sampleDoc();
    doc.attributes.push({ id: 'attr_orphan', name: 'orphan', x: 0, y: 0, kind: 'simple', ownerId: 'ent_missing' });
    expect(liveSteps(doc).map((step) => step.id)).toContain('attr_orphan');
  });
});

describe('pointer travel', () => {
  it('eases with a minimum-jerk curve that starts and ends at rest', () => {
    expect(travelEase(0)).toBe(0);
    expect(travelEase(1)).toBe(1);
    expect(travelEase(0.5)).toBeCloseTo(0.5, 6);
    // Slow at both ends, fastest in the middle: that is the shape a hand makes.
    expect(travelEase(0.25)).toBeLessThan(0.25);
    expect(travelEase(0.75)).toBeGreaterThan(0.75);
    expect(travelEase(-1)).toBe(0);
    expect(travelEase(2)).toBe(1);
  });

  it('lands exactly on the destination and bows only slightly on the way', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 400, y: 300 };
    expect(travelPoint(from, to, 0)).toEqual(from);
    expect(travelPoint(from, to, 1)).toEqual(to);
    const mid = travelPoint(from, to, 0.5);
    const bow = Math.hypot(mid.x - 200, mid.y - 150);
    expect(bow).toBeGreaterThan(1);
    expect(bow).toBeLessThan(34);
  });

  it('stays on the straight line for short hops', () => {
    const mid = travelPoint({ x: 0, y: 0 }, { x: 20, y: 0 }, 0.5);
    expect(mid).toEqual({ x: 10, y: 0 });
  });

  it('keeps a hop between a readable floor and ceiling, longer for longer distances', () => {
    const near = travelDurationMs({ x: 0, y: 0 }, { x: 20, y: 0 });
    const mid = travelDurationMs({ x: 0, y: 0 }, { x: 600, y: 0 });
    const huge = travelDurationMs({ x: 0, y: 0 }, { x: 5000, y: 0 });
    // Slow enough to look like a hand reaching, not a transition firing.
    expect(near).toBe(320);
    expect(mid).toBe(570);
    // Across a big canvas the pointer still should not crawl off screen.
    expect(huge).toBe(1250);
  });

  it('arcs successive hops differently, but the same pair the same way', () => {
    const first = { from: { x: 100, y: 120 }, to: { x: 620, y: 240 } };
    const hops = [
      first,
      { from: { x: 620, y: 240 }, to: { x: 300, y: 710 } },
      { from: { x: 300, y: 710 }, to: { x: 980, y: 640 } },
      { from: { x: 980, y: 640 }, to: { x: 1180, y: 190 } },
      { from: { x: 1180, y: 190 }, to: { x: 460, y: 60 } },
    ].map(({ from, to }) => travelBow(from, to));
    expect(new Set(hops.map((bow) => bow.toFixed(2))).size).toBe(hops.length);
    expect(travelBow(first.from, first.to)).toBe(hops[0]);
  });

  it('moves in small steps when sampled at the app’s frame rate', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 600, y: 0 };
    const frames = Math.ceil(travelDurationMs(from, to) / 16);
    let previous = travelPoint(from, to, 0);
    let backward = 0;
    for (let frame = 1; frame <= frames; frame += 1) {
      const next = travelPoint(from, to, frame / frames);
      expect(Math.hypot(next.x - previous.x, next.y - previous.y)).toBeLessThan(80);
      if (next.x < previous.x) backward += previous.x - next.x;
      previous = next;
    }
    // The only backward travel is the follow-through giving the overshoot back.
    const overshoot = Math.max(...Array.from({ length: frames + 1 },
      (_, frame) => travelPoint(from, to, frame / frames).x)) - to.x;
    expect(overshoot).toBeGreaterThan(1);
    expect(overshoot).toBeLessThan(36);
    expect(backward).toBeCloseTo(overshoot, 1);
    expect(previous).toEqual(to);
  });
});

describe('follow-through settle', () => {
  it('adds nothing at either end of the hop', () => {
    expect(settleOffset(0, 600)).toBe(0);
    expect(settleOffset(1, 600)).toBe(0);
    // And nothing during the cruise: the settle belongs to the end of the reach.
    expect(settleOffset(0.2, 600)).toBe(0);
    expect(settleOffset(0.7, 600)).toBe(0);
  });

  it('carries the pointer a little past the target before it settles back', () => {
    const peak = settleOffset(0.88, 600);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(600 * 0.06);
    // A longer reach overshoots proportionally further, like a real hand.
    expect(settleOffset(0.88, 1200)).toBeGreaterThan(peak);
  });
});

describe('carried retarget', () => {
  it('bows the plain way when the pointer was not already moving', () => {
    const plain = travelControl({ x: 0, y: 0 }, { x: 0, y: 400 }, 30, null);
    expect(plain.x).toBeCloseTo(-30, 6);
    expect(plain.y).toBeCloseTo(200, 6);
    expect(travelControl({ x: 0, y: 0 }, { x: 0, y: 400 }, 30)).toEqual(plain);
  });

  it('leaves a retargeted hop along the direction the pointer was already going', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 0, y: 400 };
    // Already moving hard to the right when the new target appears straight above.
    const carried = travelControl(from, to, 30, { x: 300, y: 0 });
    const plain = travelControl(from, to, 30, null);
    expect(carried.x).toBeGreaterThan(plain.x + 1);
    // The carry is a corner cut, not a detour: it stays a fraction of the hop.
    expect(Math.hypot(carried.x - plain.x, carried.y - plain.y)).toBeLessThan(400 * 0.25);
    // And the landing never moves: only the shape of the path changes.
    expect(travelPoint(from, to, 1, { x: 300, y: 0 })).toEqual(to);
  });

  it('ignores a carried velocity too small to read as momentum', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 0, y: 400 };
    expect(travelControl(from, to, 30, { x: 0.2, y: 0 })).toEqual(travelControl(from, to, 30, null));
  });
});

describe('stitched route travel', () => {
  const knots = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 800, y: 300 },
    { x: 1200, y: 120 },
  ];
  const at = (u: number): CursorPoint => routePoint(knots, u)!;

  it('passes exactly through every knot at its whole route parameter', () => {
    knots.forEach((knot, index) => {
      expect(at(index).x).toBeCloseTo(knot.x, 6);
      expect(at(index).y).toBeCloseTo(knot.y, 6);
    });
    expect(routePoint(knots, -2)).toEqual(knots[0]);
    expect(routePoint(knots, knots.length + 5)).toEqual(knots[knots.length - 1]);
  });

  it('keeps travelling through an interior knot instead of coming to rest', () => {
    const before = at(1.98);
    const here = at(2);
    const after = at(2.02);
    const v1 = { x: here.x - before.x, y: here.y - before.y };
    const v2 = { x: after.x - here.x, y: after.y - here.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    const cross = v1.x * v2.y - v1.y * v2.x;
    // Never stops, and never kinks: a stream of shapes reads as one stroke.
    expect(Math.hypot(v1.x, v1.y)).toBeGreaterThan(0);
    expect(Math.abs(Math.atan2(cross, dot))).toBeLessThan(0.35);
  });

  it('handles a route that is one shape, or none', () => {
    expect(routePoint([{ x: 5, y: 7 }], 0.5)).toEqual({ x: 5, y: 7 });
    expect(routePoint([], 0)).toBeNull();
  });

  it('times each route segment by its own chord', () => {
    const durations = routeDurationsMs(knots);
    expect(durations).toHaveLength(3);
    expect(durations).toEqual([
      travelDurationMs(knots[0]!, knots[1]!),
      travelDurationMs(knots[1]!, knots[2]!),
      travelDurationMs(knots[2]!, knots[3]!),
    ]);
  });
});

describe('leg easing across a stitched route', () => {
  const slope = (restStart: boolean, restEnd: boolean, from: number): number =>
    (legEase(from + 0.01, restStart, restEnd) - legEase(from, restStart, restEnd)) / 0.01;

  it('starts and finishes every leg exactly where the next one begins', () => {
    expect(legEase(0, true, true)).toBe(0);
    expect(legEase(1, true, true)).toBe(1);
    expect(legEase(0, false, true)).toBe(0);
    expect(legEase(1, false, true)).toBe(1);
    expect(legEase(0, true, false)).toBe(0);
    expect(legEase(1, true, false)).toBe(1);
    expect(legEase(0, false, false)).toBe(0);
    expect(legEase(1, false, false)).toBe(1);
  });

  it('rests at both ends of a lone leg, the way a single hop does', () => {
    expect(slope(true, true, 0)).toBeLessThan(0.05);
    expect(slope(true, true, 0.99)).toBeLessThan(0.05);
  });

  it('keeps the pointer moving through the middle of a route', () => {
    // A dip to a third of cruising speed: a check at the shape, not a stop.
    expect(slope(false, false, 0)).toBeGreaterThan(0.2);
    expect(slope(false, false, 0.99)).toBeGreaterThan(0.2);
    // Halfway along, the leg is at full speed.
    expect(slope(false, false, 0.5)).toBeGreaterThan(slope(false, false, 0));
  });

  it('arrives at the first knot already moving and leaves the last at rest', () => {
    expect(slope(true, false, 0)).toBeLessThan(0.05);
    expect(slope(true, false, 0.99)).toBeGreaterThan(0.5);
    expect(slope(false, true, 0)).toBeGreaterThan(0.5);
    expect(slope(false, true, 0.99)).toBeLessThan(0.05);
  });
});

describe('live diffs', () => {
  it('writes only the shape a rename touched, and keeps the same Y.Map', () => {
    const before = sampleDoc();
    const ydoc = new Y.Doc();
    seedDocument(ydoc, before);
    const customer = ydoc.getMap('entities').get('ent_customer') as Y.Map<unknown>;

    const after = structuredClone(before);
    after.entities[0]!.name = 'Client';
    const changed = writeDocumentDiff(ydoc, before, after);

    expect(changed).toEqual(['ent_customer']);
    expect(ydoc.getMap('entities').get('ent_customer')).toBe(customer);
    expect(customer.get('name')).toBe('Client');
  });

  it('materialises the exact document a multi-part edit produced', () => {
    const before = sampleDoc();
    const ydoc = new Y.Doc();
    seedDocument(ydoc, before);

    const after = structuredClone(before);
    after.name = 'Sales (renamed)';
    after.view = 'crowfoot';
    after.entities[1]!.name = 'Purchase';
    after.attributes = after.attributes.filter((attribute) => attribute.id !== 'attr_email');
    after.entities.push({ id: 'ent_product', name: 'Product', x: 600, y: 20, kind: 'strong' });
    after.attributes.push({
      id: 'attr_product_id', name: 'product_id', x: 600, y: 80, kind: 'key', ownerId: 'ent_product', dataType: 'INT',
    });

    const changed = writeDocumentDiff(ydoc, before, after);

    expect(changed).toContain('ent_order');
    expect(changed).toContain('ent_product');
    expect(comparable(snapshotFromYdoc(ydoc))).toEqual(comparable(normalizeDocument(after)));
  });

  it('deletes a removed entity with its attributes and lines', () => {
    const before = sampleDoc();
    const ydoc = new Y.Doc();
    seedDocument(ydoc, before);

    const after = structuredClone(before);
    after.entities = after.entities.filter((entity) => entity.id !== 'ent_order');
    after.attributes = after.attributes.filter((attribute) => attribute.ownerId !== 'ent_order');
    after.relationships = [];
    after.legs = [];
    writeDocumentDiff(ydoc, before, after);

    const snapshot = snapshotFromYdoc(ydoc);
    expect(snapshot.entities.map((entity) => entity.id)).toEqual(['ent_customer']);
    expect(snapshot.attributes.map((attribute) => attribute.id)).not.toContain('attr_order_id');
    expect(snapshot.relationships).toHaveLength(0);
    expect(snapshot.legs).toHaveLength(0);
  });

  it('leaves a peer edit that arrived during the call alone', () => {
    const before = sampleDoc();
    const ydoc = new Y.Doc();
    seedDocument(ydoc, before);
    upsertAttribute(ydoc, {
      id: 'attr_peer', name: 'nickname', x: 1, y: 1, kind: 'simple', ownerId: 'ent_customer',
    });

    const after = structuredClone(before);
    after.entities.push({ id: 'ent_shipment', name: 'Shipment', x: 600, y: 20, kind: 'strong' });
    writeDocumentDiff(ydoc, before, after);

    const snapshot = snapshotFromYdoc(ydoc);
    expect(snapshot.attributes.some((attribute) => attribute.id === 'attr_peer')).toBe(true);
    expect(snapshot.entities.some((entity) => entity.id === 'ent_shipment')).toBe(true);
  });
});

/**
 * The room's presence choreography.
 *
 * Awareness is the only channel involved, so a headless room with a local
 * Y.Doc and a transport that never connects exercises exactly what a watcher
 * would receive.
 */
describe('intent choreography', () => {
  function headless(): { live: LiveRoom; local: () => Record<string, any> } {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const transport = { on: () => {}, off: () => {}, connect: () => {}, destroy: () => {} };
    const live = new LiveRoom(
      'room1234', ydoc, transport as never, awareness, 'wss://relay.test', 'https://app.test',
    );
    return { live, local: () => (awareness.getLocalState() ?? {}) as Record<string, any> };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('hovers before it presses, and releases the click afterwards', async () => {
    const { live, local } = headless();
    live.flash(sampleDoc(), 'ent_customer');

    expect(local().cursor).toEqual({ x: 85, y: 50 });
    expect(local().intent).toEqual({ kind: 'hover', targetId: 'ent_customer' });
    expect(local().pressing).toBe(false);
    expect(local().selectedIds).toEqual([]);

    await vi.advanceTimersByTimeAsync(HOVER_MS);
    expect(local().intent).toEqual({ kind: 'press', targetId: 'ent_customer' });
    expect(local().pressing).toBe(true);
    expect(local().selectedIds).toEqual(['ent_customer']);

    await vi.advanceTimersByTimeAsync(PRESS_MS);
    expect(local().pressing).toBe(false);
    expect(local().intent).toBeNull();
  });

  it('resolves a glide on the press, so the caller writes when the click lands', async () => {
    const { live, local } = headless();
    const doc = sampleDoc();
    live.flash(doc, 'ent_order');
    await vi.advanceTimersByTimeAsync(HOVER_MS + PRESS_MS);

    let resolved = false;
    const gliding = live.glideTo(doc, 'ent_customer').then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(travelDurationMs({ x: 375, y: 50 }, { x: 85, y: 50 }));

    // Landed, but still only hovering: the write must not start yet.
    expect(local().cursor).toEqual({ x: 85, y: 50 });
    expect(local().intent).toEqual({ kind: 'hover', targetId: 'ent_customer' });
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(HOVER_MS);
    expect(local().intent).toEqual({ kind: 'press', targetId: 'ent_customer' });
    await gliding;
    expect(resolved).toBe(true);
  });

  it('treats a write on the same click as that click, not a second one', async () => {
    const { live, local } = headless();
    const doc = sampleDoc();
    const gliding = live.glideTo(doc, 'ent_customer');
    await vi.advanceTimersByTimeAsync(travelDurationMs({ x: 0, y: 0 }, { x: 85, y: 50 }) + HOVER_MS);

    live.flash(doc, 'ent_customer', true);
    expect(local().intent).toEqual({ kind: 'press', targetId: 'ent_customer' });
    expect(local().pressing).toBe(true);
    expect(local().typing).toBe(true);

    await vi.advanceTimersByTimeAsync(PRESS_MS);
    expect(local().pressing).toBe(false);
    expect(local().intent).toBeNull();
    await gliding;
  });

  it('holds the typing indicator for 900ms, then lets it go', async () => {
    const { live, local } = headless();
    live.flash(sampleDoc(), 'ent_customer', true);

    await vi.advanceTimersByTimeAsync(HOVER_MS);
    expect(local().typing).toBe(true);

    await vi.advanceTimersByTimeAsync(TYPING_MS - 2);
    expect(local().typing).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(local().typing).toBe(false);
  });

  it('drags a moved entity with its attributes instead of teleporting it', async () => {
    const { live, local } = headless();
    const before = sampleDoc();
    const after = structuredClone(before);
    after.entities[0]!.x = 210;
    after.entities[0]!.y = 120;
    for (const attribute of after.attributes) {
      if (attribute.ownerId !== 'ent_customer') continue;
      attribute.x += 200;
      attribute.y += 100;
    }

    const dragging = live.dragTo(before, after, 'ent_customer');
    await vi.advanceTimersByTimeAsync(HOVER_MS);

    expect(local().intent).toEqual({ kind: 'drag', targetId: 'ent_customer' });
    expect(local().pressing).toBe(true);
    expect(local().dragging).toMatchObject({
      ids: expect.arrayContaining(['ent_customer', 'attr_customer_id', 'attr_email']),
      start: {
        ent_customer: { x: 10, y: 20 },
        attr_customer_id: { x: 10, y: 80 },
        attr_email: { x: 10, y: 120 },
      },
      dx: 0,
      dy: 0,
    });

    const travel = travelDurationMs({ x: 85, y: 50 }, { x: 285, y: 150 });
    await vi.advanceTimersByTimeAsync(travel / 2);
    expect(local().dragging.dx).toBeGreaterThan(0);
    expect(local().dragging.dx).toBeLessThan(200);

    await vi.advanceTimersByTimeAsync(travel);
    await dragging;
    // The shape is still in the air: the caller writes, then releases.
    expect(local().dragging.dx).toBeCloseTo(200, 6);
    expect(local().dragging.dy).toBeCloseTo(100, 6);
    expect(local().cursor).toEqual({ x: 285, y: 150 });
    expect(local().pressing).toBe(true);

    live.release(after, 'ent_customer');
    expect(local().dragging).toBeNull();
    expect(local().pressing).toBe(false);
    expect(local().intent).toBeNull();
    expect(local().cursor).toEqual({ x: 285, y: 150 });
    expect(local().selectedIds).toEqual(['ent_customer']);
  });

  it('draws a lasso around every shape a group delete will take', async () => {
    const { live, local } = headless();
    const doc = sampleDoc();
    const lassoing = live.lasso(doc, ['ent_customer', 'attr_customer_id', 'attr_email']);

    await vi.advanceTimersByTimeAsync(120);
    expect(local().intent?.kind).toBe('lasso');
    expect(local().pressing).toBe(false);
    expect(local().intent.lasso.length).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(3000);
    await lassoing;
    const state = local();
    expect(state.pressing).toBe(true);
    const xs = state.intent.lasso.map((point: CursorPoint) => point.x);
    const ys = state.intent.lasso.map((point: CursorPoint) => point.y);
    // The loop is padded around the whole group: entity (10..160 x, 20..80 y)
    // and its two attributes (10..140 x, 80..172 y).
    expect(Math.min(...xs)).toBeLessThan(10);
    expect(Math.max(...xs)).toBeGreaterThan(160);
    expect(Math.min(...ys)).toBeLessThan(20);
    expect(Math.max(...ys)).toBeGreaterThan(172);
    // And it closes back where it started.
    const first = state.intent.lasso[0];
    const last = state.intent.lasso[state.intent.lasso.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-6);

    live.release(doc, null);
    expect(local().intent).toBeNull();
    expect(local().pressing).toBe(false);
  });

  it('shows a thinking ring over the last shape and lets it fade', async () => {
    const { live, local } = headless();
    const doc = sampleDoc();
    live.flash(doc, 'rel_places');
    await vi.advanceTimersByTimeAsync(HOVER_MS + PRESS_MS);
    const cursor = local().cursor;

    live.think();
    expect(local().intent).toEqual({ kind: 'think', targetId: 'rel_places' });
    expect(local().cursor).toEqual(cursor);

    await vi.advanceTimersByTimeAsync(THINK_MS - 1);
    expect(local().intent?.kind).toBe('think');
    await vi.advanceTimersByTimeAsync(2);
    expect(local().intent).toBeNull();
  });

  it('arrives from outside the diagram instead of materialising on the first shape', async () => {
    const { live, local } = headless();
    const doc = sampleDoc();
    live.enter(doc, 'ent_customer');

    const entrance = local().cursor!;
    expect(entrance).not.toEqual({ x: 85, y: 50 });
    await vi.advanceTimersByTimeAsync(travelDurationMs(entrance, { x: 85, y: 50 }));
    expect(local().intent).toEqual({ kind: 'hover', targetId: 'ent_customer' });
    expect(local().cursor).toEqual({ x: 85, y: 50 });
  });
});
