import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { roomFromLink, writeDocumentDiff } from './live';
import { buildShareUrl, normalizeDocument } from '../src/model/snapshot';
import { emptyDocument, type Attribute, type ErdDocument, type Leg, type Relationship } from '../src/model/types';
import { seedDocument, snapshotFromYdoc, upsertAttribute } from '../src/collab/ydoc';

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
