import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ATTRIBUTES,
  ENTITIES,
  LEGS,
  RELATIONSHIPS,
  connectNodes,
  deleteNodeFromYdoc,
  seedDocument,
  setMeta,
  snapshotFromYdoc,
  upsertAttribute,
  upsertEntity,
  upsertLeg,
} from '../../src/collab/ydoc';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

function sample(): ErdDocument {
  const doc = emptyDocument('Library');
  doc.view = 'crowfoot';
  doc.entities.push(
    { id: 'e1', name: 'Book', x: 10, y: 20, kind: 'strong' },
    { id: 'e2', name: 'Copy', x: 300, y: 20, kind: 'weak' },
  );
  doc.attributes.push(
    { id: 'a1', name: 'isbn', x: 0, y: 0, kind: 'key', ownerId: 'e1' },
    { id: 'a2', name: 'floating', x: 900, y: 900, kind: 'simple', ownerId: null },
  );
  doc.relationships.push({ id: 'r1', name: 'has', x: 150, y: 20, kind: 'weak' });
  doc.isas.push({ id: 'i1', x: 500, y: 20, parentId: 'e1', childIds: ['e2'] });
  doc.legs.push({
    id: 'l1',
    fromId: 'e1',
    toId: 'r1',
    cardinality: '1',
    participation: { min: 1, max: 'N' },
  });
  return doc;
}

describe('connecting nodes', () => {
  const ids = () => { let count = 0; return (kind: string) => kind + '_' + ++count; };

  it('creates one diamond and two participant legs in a single Undo action', () => {
    const ydoc = new Y.Doc();
    const doc = sample(); doc.relationships = []; doc.legs = [];
    seedDocument(ydoc, doc);
    const undo = new Y.UndoManager([ydoc.getMap(ENTITIES), ydoc.getMap(RELATIONSHIPS), ydoc.getMap(LEGS)]);
    const id = connectNodes(ydoc, 'e1', 'e2', ids());
    const connected = snapshotFromYdoc(ydoc);
    expect(connected.relationships.map((node) => node.id)).toEqual([id]);
    expect(connected.legs.map((leg) => [leg.fromId, leg.toId])).toEqual([[id, 'e1'], [id, 'e2']]);
    expect(undo.undoStack).toHaveLength(1);
    ydoc.transact(() => (ydoc.getMap(ENTITIES).get('e2') as Y.Map<unknown>).set('name', 'Remote copy'), 'remote');
    undo.undo();
    expect(snapshotFromYdoc(ydoc).relationships).toHaveLength(0);
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(0);
    expect(snapshotFromYdoc(ydoc).entities.find((entity) => entity.id === 'e2')?.name).toBe('Remote copy');
    undo.redo();
    expect(snapshotFromYdoc(ydoc).legs).toEqual(connected.legs);
  });

  it('keeps connections to an existing diamond as ordinary legs', () => {
    const ydoc = new Y.Doc(); seedDocument(ydoc, sample());
    const id = connectNodes(ydoc, 'r1', 'e2', ids());
    expect(snapshotFromYdoc(ydoc).relationships).toEqual(sample().relationships);
    expect(snapshotFromYdoc(ydoc).legs.find((leg) => leg.id === id)).toMatchObject({ fromId: 'r1', toId: 'e2' });
  });

  it('refuses self-connections, attributes, and endpoints removed before the drop', () => {
    const ydoc = new Y.Doc(); seedDocument(ydoc, sample());
    const before = snapshotFromYdoc(ydoc);
    for (const [from, to] of [['e1', 'e1'], ['a1', 'e2'], ['e1', 'missing']] as const) {
      expect(connectNodes(ydoc, from, to, ids())).toBeNull();
    }
    expect(snapshotFromYdoc(ydoc)).toEqual(before);
  });
});

describe('seedDocument / snapshotFromYdoc', () => {
  it('round-trips a full document through Yjs', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    expect(snapshotFromYdoc(ydoc)).toEqual(sample());
  });

  it('preserves meta including the view mode', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    expect(snapshotFromYdoc(ydoc).name).toBe('Library');
    expect(snapshotFromYdoc(ydoc).view).toBe('crowfoot');
  });

  it('produces an empty document from a fresh Yjs doc', () => {
    expect(snapshotFromYdoc(new Y.Doc())).toEqual(emptyDocument());
  });

  it('does not clobber existing meta when seeding twice', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    setMeta(ydoc, { name: 'Renamed' });
    seedDocument(ydoc, sample());
    expect(snapshotFromYdoc(ydoc).name).toBe('Renamed');
  });
});

describe('two peers editing different fields merge cleanly', () => {
  it('keeps both renames when peers edit different nodes', () => {
    const alice = new Y.Doc();
    seedDocument(alice, sample());

    // Bob starts from Alice's state, then edits offline.
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    const aliceEntity = alice.getMap(ENTITIES).get('e1') as Y.Map<unknown>;
    aliceEntity.set('name', 'Publication');

    const bobEntity = bob.getMap(ENTITIES).get('e2') as Y.Map<unknown>;
    bobEntity.set('name', 'Physical copy');

    // Exchange updates both ways.
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    const a = snapshotFromYdoc(alice);
    const b = snapshotFromYdoc(bob);
    expect(a).toEqual(b);
    expect(a.entities.find((e) => e.id === 'e1')?.name).toBe('Publication');
    expect(a.entities.find((e) => e.id === 'e2')?.name).toBe('Physical copy');
  });

  it('merges concurrent moves of two different entities', () => {
    const alice = new Y.Doc();
    seedDocument(alice, sample());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    (alice.getMap(ENTITIES).get('e1') as Y.Map<unknown>).set('x', 111);
    (bob.getMap(ENTITIES).get('e2') as Y.Map<unknown>).set('x', 222);

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    const doc = snapshotFromYdoc(alice);
    expect(doc.entities.find((e) => e.id === 'e1')?.x).toBe(111);
    expect(doc.entities.find((e) => e.id === 'e2')?.x).toBe(222);
  });

  it('converges to the same state when a node is added concurrently on both sides', () => {
    const alice = new Y.Doc();
    seedDocument(alice, sample());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    upsertEntity(alice, { id: 'new-a', name: 'From Alice', x: 1, y: 1, kind: 'strong' });
    upsertEntity(bob, { id: 'new-b', name: 'From Bob', x: 2, y: 2, kind: 'strong' });

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    expect(snapshotFromYdoc(alice)).toEqual(snapshotFromYdoc(bob));
    expect(snapshotFromYdoc(alice).entities).toHaveLength(4);
  });

  it('last write wins for the same field, and both peers agree', () => {
    const alice = new Y.Doc();
    seedDocument(alice, sample());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    (alice.getMap(ENTITIES).get('e1') as Y.Map<unknown>).set('name', 'Alice name');
    (bob.getMap(ENTITIES).get('e1') as Y.Map<unknown>).set('name', 'Bob name');

    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    const a = snapshotFromYdoc(alice);
    const b = snapshotFromYdoc(bob);
    expect(a.entities.find((e) => e.id === 'e1')?.name).toBe(b.entities.find((e) => e.id === 'e1')?.name);
  });

  it('propagates a delete to the other peer along with its legs', () => {
    const alice = new Y.Doc();
    seedDocument(alice, sample());
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    deleteNodeFromYdoc(alice, 'e1');
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));

    const doc = snapshotFromYdoc(bob);
    expect(doc.entities.find((e) => e.id === 'e1')).toBeUndefined();
    expect(doc.legs).toHaveLength(0);
    // a1 was owned by e1, so it goes too; a2 was floating and stays.
    expect(doc.attributes.map((a) => a.id)).toEqual(['a2']);
  });
});

describe('deleteNodeFromYdoc', () => {
  it('removes the node from every map', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    deleteNodeFromYdoc(ydoc, 'e1');
    expect(ydoc.getMap(ENTITIES).has('e1')).toBe(false);
    expect(ydoc.getMap(ATTRIBUTES).has('a1')).toBe(false);
  });

  it('detaches isa links pointing at the deleted node', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    deleteNodeFromYdoc(ydoc, 'e2');
    const isa = ydoc.getMap('isas').get('i1') as Y.Map<unknown>;
    expect(isa.get('childIds')).toEqual([]);
  });

  it('removes a relationship and its legs', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    deleteNodeFromYdoc(ydoc, 'r1');
    expect(ydoc.getMap(RELATIONSHIPS).has('r1')).toBe(false);
    expect(ydoc.getMap(LEGS).size).toBe(0);
  });

  it('removes a single leg without touching the shapes it joins', () => {
    const ydoc = new Y.Doc();
    const doc = sample();
    // Two legs, so removing one leaves the other in place.
    doc.legs.push({
      id: 'l2',
      fromId: 'r1',
      toId: 'e2',
      cardinality: 'N',
      participation: { min: 0, max: 1 },
    });
    seedDocument(ydoc, doc);
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(2);

    deleteNodeFromYdoc(ydoc, 'l1');

    const after = snapshotFromYdoc(ydoc);
    expect(after.legs.map((l) => l.id)).toEqual(['l2']);
    // Both endpoints survive, and the relationship that owns the line does too.
    expect(after.entities).toHaveLength(2);
    expect(after.relationships).toHaveLength(1);
  });

  it('is a no-op for an unknown id', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    deleteNodeFromYdoc(ydoc, 'ghost');
    expect(snapshotFromYdoc(ydoc)).toEqual(sample());
  });
});

describe('upserts', () => {
  it('updates an existing entity in place rather than duplicating', () => {
    const ydoc = new Y.Doc();
    seedDocument(ydoc, sample());
    upsertEntity(ydoc, { id: 'e1', name: 'Renamed', x: 5, y: 6, kind: 'weak' });
    const doc = snapshotFromYdoc(ydoc);
    expect(doc.entities.filter((e) => e.id === 'e1')).toHaveLength(1);
    expect(doc.entities.find((e) => e.id === 'e1')).toEqual({
      id: 'e1',
      name: 'Renamed',
      x: 5,
      y: 6,
      kind: 'weak',
    });
  });

  it('stores leg participation as flat fields and rebuilds them', () => {
    const ydoc = new Y.Doc();
    upsertEntity(ydoc, { id: 'e1', name: 'A', x: 0, y: 0, kind: 'strong' });
    upsertEntity(ydoc, { id: 'e2', name: 'B', x: 0, y: 0, kind: 'strong' });
    upsertLeg(ydoc, {
      id: 'l1',
      fromId: 'e1',
      toId: 'e2',
      cardinality: 'M',
      participation: { min: 0, max: 'N' },
    });
    const leg = ydoc.getMap(LEGS).get('l1') as Y.Map<unknown>;
    expect(leg.get('min')).toBe(0);
    expect(leg.get('max')).toBe('N');
    const rebuilt = snapshotFromYdoc(ydoc).legs[0]!;
    expect(rebuilt.cardinality).toBe('M');
    expect(rebuilt.participation).toEqual({ min: 0, max: 'N' });
  });

  it('coerces an invalid attribute kind to simple on read', () => {
    const ydoc = new Y.Doc();
    upsertAttribute(ydoc, { id: 'a', name: 'A', x: 0, y: 0, kind: 'simple', ownerId: null });
    (ydoc.getMap(ATTRIBUTES).get('a') as Y.Map<unknown>).set('kind', 'bogus');
    expect(snapshotFromYdoc(ydoc).attributes[0]?.kind).toBe('simple');
  });

  it('drops legs whose endpoints are missing', () => {
    const ydoc = new Y.Doc();
    upsertLeg(ydoc, {
      id: 'l1',
      fromId: 'ghost1',
      toId: 'ghost2',
      cardinality: '1',
      participation: { min: 0, max: 1 },
    });
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(0);
  });
});
