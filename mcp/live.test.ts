import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveSteps, presenceAt, roomFromLink, travelDurationMs, travelEase, travelPoint, writeDocumentDiff } from './live';
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
    expect(bow).toBeLessThan(30);
  });

  it('stays on the straight line for short hops', () => {
    const mid = travelPoint({ x: 0, y: 0 }, { x: 20, y: 0 }, 0.5);
    expect(mid).toEqual({ x: 10, y: 0 });
  });

  it('keeps a hop between a readable floor and ceiling, longer for longer distances', () => {
    const near = travelDurationMs({ x: 0, y: 0 }, { x: 20, y: 0 });
    const far = travelDurationMs({ x: 0, y: 0 }, { x: 1200, y: 0 });
    expect(near).toBeGreaterThanOrEqual(220);
    expect(far).toBeLessThanOrEqual(700);
    expect(far).toBeGreaterThan(near);
  });

  it('moves in small steps when sampled at the app’s frame rate', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 600, y: 0 };
    const frames = Math.ceil(travelDurationMs(from, to) / 16);
    let previous = travelPoint(from, to, 0);
    for (let frame = 1; frame <= frames; frame += 1) {
      const next = travelPoint(from, to, frame / frames);
      expect(next.x).toBeGreaterThanOrEqual(previous.x);
      expect(Math.hypot(next.x - previous.x, next.y - previous.y)).toBeLessThan(80);
      previous = next;
    }
    expect(previous).toEqual(to);
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
