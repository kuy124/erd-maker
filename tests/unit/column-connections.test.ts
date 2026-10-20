// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { connectColumns, deleteNodeFromYdoc, seedDocument, snapshotFromYdoc } from '../../src/collab/ydoc';
import { writeParticipants } from '../../src/collab/participants';
import { binaryEnds, deriveLinks, deriveTables, endpointRows, routeColumns, rowCenter } from '../../src/model/crowfoot';
import { documentBounds } from '../../src/canvas/geometry';
import { emptyDocument, type ErdDocument } from '../../src/model/types';
import { buildShareUrl, normalizeDocument, parseShareHash } from '../../src/model/snapshot';
import { generateSql, SqlError } from '../../src/model/sql';
import { getDiagramIssues } from '../../src/model/issues';

// Vitest's bundled Vite predates node:sqlite; load the native module without transforming it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');

function shop(connected = true): ErdDocument {
  const doc = emptyDocument('Column connections');
  doc.view = 'crowfoot';
  doc.entities = [{ id: 'c', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'o', name: 'Order', x: 520, y: 44, kind: 'strong' }];
  doc.attributes = [
    { id: 'c-key', name: 'id', x: 0, y: 0, kind: 'key', ownerId: 'c' },
    { id: 'c-email', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'c' },
    { id: 'o-key', name: 'id', x: 0, y: 0, kind: 'key', ownerId: 'o' },
    { id: 'o-buyer', name: 'buyer_ref', x: 0, y: 0, kind: 'simple', ownerId: 'o' },
    { id: 'o-total', name: 'total', x: 0, y: 0, kind: 'simple', ownerId: 'o' },
  ];
  if (connected) {
    doc.relationships = [{ id: 'r', name: 'places', x: 300, y: 0, kind: 'strong' }];
    doc.legs = [
      { id: 'a', fromId: 'c', toId: 'r', columnId: 'attribute:c-key', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'b', fromId: 'r', toId: 'o', columnId: 'attribute:o-buyer', cardinality: 'N', participation: { min: 0, max: 'N' } },
    ];
  }
  return doc;
}
function room(doc = shop()) { const ydoc = new Y.Doc(); seedDocument(ydoc, doc); return ydoc; }
function ids() { let count = 0; return (kind: string) => kind + '-' + ++count; }
const customer = { entityId: 'c', columnId: 'attribute:c-key' };
const buyer = { entityId: 'o', columnId: 'attribute:o-buyer' };
function participants(doc: ErdDocument) {
  return doc.legs.map((l) => ({ legId: l.id, entityId: l.fromId === 'r' ? l.toId : l.fromId,
    cardinality: l.cardinality, participation: l.participation, columnId: l.columnId }));
}

describe('durable attribute endpoints', () => {
  it('creates the relationship and both selected endpoints atomically', () => {
    const ydoc = room(shop(false));
    const undo = new Y.UndoManager(['relationships', 'legs'].map((k) => ydoc.getMap(k)));
    const id = connectColumns(ydoc, customer, buyer, ids());
    const doc = snapshotFromYdoc(ydoc);
    expect(doc.relationships.map((r) => r.id)).toEqual([id]);
    expect(doc.legs.map((l) => [l.columnId, l.cardinality])).toEqual([['attribute:c-key', '1'], ['attribute:o-buyer', 'N']]);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(snapshotFromYdoc(ydoc).relationships).toHaveLength(0);
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(0);
    undo.redo();
    expect(snapshotFromYdoc(ydoc).legs).toEqual(doc.legs);
  });
  it.each([
    { entityId: 'missing', columnId: 'attribute:c-key' },
    { entityId: 'o', columnId: 'attribute:c-key' },
    { entityId: 'c', columnId: 'attribute:deleted' },
    customer,
  ])('rejects a missing, wrong-owner, or identical endpoint without publishing changes: %j', (to) => {
    const ydoc = room(shop(false));
    let updates = 0; ydoc.on('update', () => updates++);
    expect(connectColumns(ydoc, customer, to, ids())).toBeNull();
    expect(updates).toBe(0);
    expect(snapshotFromYdoc(ydoc).relationships).toHaveLength(0);
  });
  it('supports generated primary keys without inventing editable attributes', () => {
    const doc = shop(false); doc.attributes = doc.attributes.filter((a) => a.ownerId !== 'c');
    const ydoc = room(doc);
    expect(connectColumns(ydoc, { entityId: 'c', columnId: 'key:c' }, buyer, ids())).toBeTruthy();
    expect(snapshotFromYdoc(ydoc).attributes).toEqual(expect.arrayContaining(doc.attributes));
    expect(snapshotFromYdoc(ydoc).attributes).toHaveLength(doc.attributes.length);
    expect(deriveLinks(snapshotFromYdoc(ydoc))[0]?.fromColumnId).toBe('key:c');
  });
  it('keeps an existing id attribute editable when its primary-key role is generated', () => {
    const doc = shop(); doc.attributes[0]!.kind = 'simple';
    const row = deriveTables(doc)[0]!.rows.find((r) => r.name === 'id')!;
    expect(row).toMatchObject({ id: 'attribute:c-key', attributeId: 'c-key', pk: true, generatedKey: true });
    expect(generateSql(doc)).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("id")');
  });
  it('supports two different attributes of the same entity', () => {
    const ydoc = room(shop(false));
    connectColumns(ydoc, customer, { entityId: 'c', columnId: 'attribute:c-email' }, ids());
    const doc = snapshotFromYdoc(ydoc), link = deriveLinks(doc)[0]!;
    const table = deriveTables(doc)[0]!;
    expect(link.fromEntityId).toBe(link.toEntityId);
    const route = routeColumns(table, link.fromColumnId, table, link.toColumnId);
    expect(route.a.y).not.toBe(route.b.y);
    expect(route.bounds.maxX).toBeGreaterThan(table.x + 280);
  });
  it('keeps a legacy recursive weak relationship renderable and exports its self-reference', () => {
    const doc = shop(); doc.entities = [doc.entities[0]!]; doc.entities[0]!.kind = 'weak';
    doc.attributes = []; doc.relationships[0]!.kind = 'weak';
    doc.legs.forEach((l) => { l.fromId = 'r'; l.toId = 'c'; delete l.columnId; });
    const table = deriveTables(doc)[0]!, link = deriveLinks(doc)[0]!;
    expect(table.rows).toHaveLength(2); expect(link.fromColumnId).not.toBe(link.toColumnId);
    const db = new DatabaseSync(':memory:');
    try { db.exec('PRAGMA foreign_keys = ON'); db.exec(generateSql(doc));
      db.exec('INSERT INTO customer (id) VALUES (1)'); db.exec('INSERT INTO customer (id, customer_id) VALUES (2, 1)');
      expect(() => db.exec('INSERT INTO customer (id, customer_id) VALUES (3, 99)')).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
  it('retains row identity through renaming, moving, and row reordering', () => {
    const doc = shop();
    doc.attributes.find((a) => a.id === 'o-buyer')!.name = 'account_holder_id';
    doc.attributes.reverse(); doc.entities[1]!.y = 200;
    const link = deriveLinks(doc)[0]!, table = deriveTables(doc)[1]!;
    expect(link.toColumnId).toBe('attribute:o-buyer');
    expect(rowCenter(table, link.toColumnId)).toBe(354);
    expect(table.rows.find((r) => r.id === link.toColumnId)).toMatchObject({ name: 'account_holder_id', fk: true, attributeId: 'o-buyer' });
  });
  it('keeps an existing FK attribute editable instead of shadowing it with a generated row', () => {
    const doc = shop(); doc.legs.forEach((l) => delete l.columnId);
    doc.attributes.find((a) => a.id === 'o-buyer')!.name = 'customer_id';
    const table = deriveTables(doc)[1]!;
    expect(table.rows.filter((r) => r.name === 'customer_id')).toHaveLength(1);
    expect(table.rows.find((r) => r.name === 'customer_id')).toMatchObject({ attributeId: 'o-buyer', fk: true });
    expect(deriveLinks(doc)[0]?.toColumnId).toBe('attribute:o-buyer');
  });
  it('automatically attaches legacy diagrams to their key and generated FK rows', () => {
    const doc = shop(); doc.legs.forEach((l) => delete l.columnId);
    const tables = deriveTables(doc);
    const rows = endpointRows(doc, tables, binaryEnds(doc, 'r')!);
    expect(rows[0].id).toBe('attribute:c-key');
    expect(rows[1]).toMatchObject({ name: 'customer_id', attributeId: null, fk: true });
    expect(deriveLinks(doc)[0]?.toColumnId).toBe(rows[1].id);
  });
  it('preserves a selected generated FK through key/table renaming and cardinality edits', () => {
    const doc = shop(); doc.legs.forEach((l) => delete l.columnId);
    const foreign = deriveTables(doc)[1]!.rows.find((r) => r.fk)!;
    doc.legs[1]!.columnId = foreign.id; doc.legs[0]!.columnId = 'attribute:c-key';
    doc.entities[0]!.name = 'Account'; doc.attributes[0]!.name = 'account_id';
    doc.legs[1]!.cardinality = '1'; doc.legs[1]!.participation.max = 1;
    const link = deriveLinks(doc)[0]!;
    expect(link.toColumnId).toBe(foreign.id);
    expect(deriveTables(doc)[1]!.rows.find((r) => r.id === foreign.id)?.name).toBe('account_id');
    expect(generateSql(doc)).toContain('FOREIGN KEY ("account_id") REFERENCES "account" ("account_id")');
  });
  it('renders an attribute changed to derived as an unavailable endpoint without throwing', () => {
    const doc = shop(); doc.attributes.find((a) => a.id === 'o-buyer')!.kind = 'derived';
    expect(deriveLinks(doc)[0]?.toColumnId).not.toBe('attribute:o-buyer');
    expect(getDiagramIssues(doc).some((i) => i.code === 'missing-connection-attribute')).toBe(true);
  });
  it('round-trips new bindings through version-1 JSON and offline share links', () => {
    const doc = shop();
    expect(normalizeDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const url = buildShareUrl('https://example.com/', doc, 'columns-room');
    expect(parseShareHash(new URL(url).hash).doc).toEqual(doc);
    expect(snapshotFromYdoc(room(doc)).legs).toEqual(doc.legs);
  });
  it('retains old files without adding endpoint fields', () => {
    const doc = shop(); doc.legs.forEach((l) => delete l.columnId);
    expect(normalizeDocument(doc)).toEqual(doc);
    expect(snapshotFromYdoc(room(doc)).legs).toEqual(doc.legs);
  });
  it('ignores malformed endpoint values during import normalization', () => {
    const doc = shop();
    const imported = normalizeDocument({ ...doc, legs: doc.legs.map((l) => ({ ...l, columnId: { id: 'c-key' } })) });
    expect(imported.legs.every((l) => l.columnId === undefined)).toBe(true);
  });
  it('falls back safely and shows an actionable finding after an attribute is deleted or moved', () => {
    const doc = shop(); doc.attributes.find((a) => a.id === 'o-buyer')!.ownerId = 'c';
    expect(deriveLinks(doc)[0]?.toColumnId).not.toBe('attribute:o-buyer');
    expect(getDiagramIssues(doc)).toContainEqual({ code: 'missing-connection-attribute', nodeId: 'r',
      message: 'places uses an unavailable attribute. Choose another connection attribute.' });
    const ydoc = room(); const undo = new Y.UndoManager(ydoc.getMap('attributes'));
    deleteNodeFromYdoc(ydoc, 'o-buyer');
    expect(getDiagramIssues(snapshotFromYdoc(ydoc)).some((i) => i.code === 'missing-connection-attribute')).toBe(true);
    undo.undo();
    expect(deriveLinks(snapshotFromYdoc(ydoc))[0]?.toColumnId).toBe('attribute:o-buyer');
  });
  it('reports one finding per relationship when both endpoints are unavailable or non-keys', () => {
    const doc = shop(); doc.attributes = doc.attributes.filter((a) => a.id !== 'c-key' && a.id !== 'o-buyer');
    expect(getDiagramIssues(doc).filter((i) => i.code === 'missing-connection-attribute')).toHaveLength(1);
    const many = shop(); many.legs[0]!.columnId = 'attribute:c-email'; many.legs[0]!.cardinality = 'N';
    many.legs[0]!.participation.max = 'N';
    const issues = getDiagramIssues(many).filter((i) => i.code === 'non-key-reference');
    expect(issues).toHaveLength(1); expect(issues[0]!.message).toContain('Customer and Order');
  });
});

describe('participant edits and collaboration', () => {
  it('retains endpoints and legacy orientation while editing cardinality and participation', () => {
    const ydoc = room(); const rows = participants(shop());
    rows[1]!.cardinality = 'M'; rows[1]!.participation = { min: 1, max: 5 };
    writeParticipants(ydoc, 'r', rows, () => 'unused');
    expect(snapshotFromYdoc(ydoc).legs).toEqual([shop().legs[0], { ...shop().legs[1]!, cardinality: 'M', participation: { min: 1, max: 5 } }]);
  });
  it('clears a binding explicitly or when its participant changes entities', () => {
    const ydoc = room(); const rows = participants(shop());
    writeParticipants(ydoc, 'r', rows.map((r) => ({ ...r, columnId: undefined })), () => 'unused');
    expect(snapshotFromYdoc(ydoc).legs[1]?.columnId).toBe('attribute:o-buyer');
    rows[1]!.columnId = undefined; rows[1]!.entityId = 'c';
    writeParticipants(ydoc, 'r', rows, () => 'unused');
    expect(snapshotFromYdoc(ydoc).legs[1]?.columnId).toBeUndefined();
    writeParticipants(ydoc, 'r', participants(shop()).map((r) => ({ ...r, columnId: null })), () => 'unused');
    expect(snapshotFromYdoc(ydoc).legs.every((l) => l.columnId === undefined)).toBe(true);
  });
  it('rejects unavailable or wrong-owner columns before any participant change is written', () => {
    const ydoc = room(); const before = snapshotFromYdoc(ydoc);
    const rows = participants(shop()); rows[0]!.cardinality = 'M'; rows[1]!.columnId = 'attribute:c-email';
    expect(() => writeParticipants(ydoc, 'r', rows, () => 'unused')).toThrow('no longer available');
    expect(snapshotFromYdoc(ydoc)).toEqual(before);
  });
  it('lets other properties of a missing endpoint be corrected', () => {
    const ydoc = room(); deleteNodeFromYdoc(ydoc, 'o-buyer');
    const rows = participants(snapshotFromYdoc(ydoc)); rows[1]!.participation = { min: 1, max: 'N' };
    expect(() => writeParticipants(ydoc, 'r', rows, () => 'unused')).not.toThrow();
    expect(snapshotFromYdoc(ydoc).legs[1]?.columnId).toBe('attribute:o-buyer');
  });
  it('undoes a local binding change while retaining a remote edit on the other participant', () => {
    const alice = room(), bob = new Y.Doc(); Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const undo = new Y.UndoManager(alice.getMap('legs'));
    const local = participants(shop()); local[1]!.columnId = 'attribute:o-total';
    writeParticipants(alice, 'r', local, () => 'unused'); undo.stopCapturing();
    const remote = participants(snapshotFromYdoc(bob)); remote[0]!.participation.min = 1;
    writeParticipants(bob, 'r', remote, () => 'unused');
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob), 'remote');
    undo.undo();
    const doc = snapshotFromYdoc(alice);
    expect(doc.legs[0]?.participation.min).toBe(1);
    expect(doc.legs[1]?.columnId).toBe('attribute:o-buyer');
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice), 'remote');
    expect(snapshotFromYdoc(bob)).toEqual(doc);
  });
});

describe('row routing and export framing', () => {
  it.each([{ x: 520, y: 44 }, { x: -520, y: 160 }, { x: 0, y: 300 }])('anchors both ends at the selected rows at %j', (position) => {
    const doc = shop(); Object.assign(doc.entities[1]!, position);
    const [a, b] = deriveTables(doc); const link = deriveLinks(doc)[0]!;
    const route = routeColumns(a!, link.fromColumnId, b!, link.toColumnId);
    expect(route.a.y).toBe(rowCenter(a!, 'attribute:c-key'));
    expect(route.b.y).toBe(rowCenter(b!, 'attribute:o-buyer'));
    expect(route.aToward.y).toBe(route.a.y); expect(route.bToward.y).toBe(route.b.y);
    expect(route.path).not.toMatch(/NaN|undefined/);
    const bounds = documentBounds(doc, 0);
    expect(bounds.minX).toBeLessThanOrEqual(route.bounds.minX);
    expect(bounds.maxX).toBeGreaterThanOrEqual(route.bounds.maxX);
  });
  it('separates multiple relationships between the same pair', () => {
    const doc = shop(); doc.entities[1]!.y = -44;
    doc.relationships.push({ ...doc.relationships[0]!, id: 'r2', name: 'approves' });
    doc.legs.push(...doc.legs.map((l) => ({ ...l, id: l.id + '2', fromId: l.fromId === 'r' ? 'r2' : l.fromId, toId: l.toId === 'r' ? 'r2' : l.toId })));
    const [a, b] = deriveTables(doc), links = deriveLinks(doc);
    const routes = links.map((l) => routeColumns(a!, l.fromColumnId, b!, l.toColumnId, l.lane));
    expect(routes[0]!.path).not.toBe(routes[1]!.path);
    expect(routes[0]!.a).toEqual(routes[1]!.a); expect(routes[0]!.b).toEqual(routes[1]!.b);
  });
  it('frames a real relationship whose imported ID ends in :reverse', () => {
    const doc = shop(); doc.entities[1]!.x = 0; doc.entities[1]!.y = 250;
    doc.relationships[0]!.id = 'r:reverse';
    doc.legs = doc.legs.map((l) => ({ ...l, fromId: l.fromId === 'r' ? 'r:reverse' : l.fromId, toId: l.toId === 'r' ? 'r:reverse' : l.toId }));
    const [a, b] = deriveTables(doc), link = deriveLinks(doc)[0]!;
    const route = routeColumns(a!, link.fromColumnId, b!, link.toColumnId);
    expect(documentBounds(doc, 0).maxX).toBeGreaterThanOrEqual(route.bounds.maxX);
  });
});

describe('SQL uses the connected fields', () => {
  it('uses a selected existing attribute with the referenced key’s type and no duplicate generated FK', () => {
    const sql = generateSql(shop());
    expect(sql).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("id")');
    expect(sql).toContain('"buyer_ref" INTEGER');
    expect(sql).not.toContain('"customer_id"');
  });
  it('enforces the selected foreign key in SQLite', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(generateSql(shop(), { dialect: 'sqlite' }));
      db.exec('INSERT INTO customer (id) VALUES (1)');
      db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (1, 1)');
      expect(() => db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (2, 999)')).toThrow(/FOREIGN KEY/);
      db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (3, NULL)');
    } finally { db.close(); }
  });
  it('enforces uniqueness for explicit one-to-one and required referenced endpoints', () => {
    const doc = shop(); doc.legs[1]!.cardinality = '1'; doc.legs[1]!.participation.max = 1; doc.legs[0]!.participation.min = 1;
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(generateSql(doc));
      db.exec('INSERT INTO customer (id) VALUES (1)'); db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (1, 1)');
      expect(() => db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (2, 1)')).toThrow(/UNIQUE/);
      expect(() => db.exec('INSERT INTO "order" (id) VALUES (3)')).toThrow(/NOT NULL/);
    } finally { db.close(); }
  });
  it('adds a foreign-key constraint when an automatic FK name already exists as an attribute', () => {
    const doc = shop(); doc.legs.forEach((l) => delete l.columnId);
    doc.attributes.find((a) => a.id === 'o-buyer')!.name = 'customer_id';
    expect(generateSql(doc)).toContain('FOREIGN KEY ("customer_id") REFERENCES "customer" ("id")');
  });
  it('uses the bound fields in a many-to-many junction and retains both directions in the view', () => {
    const doc = shop(); doc.legs[0]!.cardinality = 'N'; doc.legs[0]!.participation.max = 'N';
    doc.legs[1]!.columnId = 'attribute:o-key';
    expect(deriveLinks(doc).map((l) => [l.fromColumnId, l.toColumnId])).toEqual([
      ['attribute:c-key', 'attribute:o-key'], ['attribute:o-key', 'attribute:c-key'],
    ]);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(generateSql(doc));
      db.exec('INSERT INTO customer (id) VALUES (1)'); db.exec('INSERT INTO "order" (id) VALUES (2)');
      db.exec('INSERT INTO places (customer_id, order_id) VALUES (1, 2)');
      expect(() => db.exec('INSERT INTO places (customer_id, order_id) VALUES (1, 99)')).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
  it('uses a weak entity’s selected identifying FK in both table rows and its composite primary key', () => {
    const doc = shop(); doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    const row = deriveTables(doc)[1]!.rows.find((r) => r.attributeId === 'o-buyer')!;
    expect(row).toMatchObject({ pk: true, fk: true, type: 'INT' });
    const sql = generateSql(doc);
    expect(sql).toContain('PRIMARY KEY ("buyer_ref", "id")');
    expect(sql).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("id")');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(sql);
      db.exec('INSERT INTO customer (id) VALUES (1)'); db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (1, 1)');
      expect(() => db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (2, 99)')).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
  it('enforces one-to-one uniqueness even when a weak entity’s FK is part of a composite key', () => {
    const doc = shop(); doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    doc.legs[1]!.cardinality = '1'; doc.legs[1]!.participation.max = 1;
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(generateSql(doc));
      db.exec('INSERT INTO customer (id) VALUES (1)'); db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (1, 1)');
      expect(() => db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (2, 1)')).toThrow(/UNIQUE/);
    } finally { db.close(); }
  });
  it('shows the inherited generated PK/FK for a weak entity without a partial key', () => {
    const doc = shop(); doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    doc.legs.forEach((l) => delete l.columnId); doc.attributes = doc.attributes.filter((a) => a.ownerId !== 'o');
    const rows = deriveTables(doc)[1]!.rows;
    expect(rows).toHaveLength(1);
    // The inherited key is named after the table it comes from, so the weak
    // table does not carry a second column called `id`.
    expect(rows[0]).toMatchObject({ name: 'customer_id', pk: true, fk: true, attributeId: null });
    expect(generateSql(doc)).toContain('FOREIGN KEY ("customer_id") REFERENCES "customer" ("id")');
  });
  it('keeps an identifying FK on the weak end when both selected attributes are keys', () => {
    const doc = shop(); doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    doc.legs[1]!.columnId = 'attribute:o-key'; doc.legs[1]!.cardinality = '1'; doc.legs[1]!.participation.max = 1;
    const tables = deriveTables(doc);
    expect(tables[0]!.rows.some((r) => r.fk)).toBe(false);
    expect(tables[1]!.rows.find((r) => r.id === 'attribute:o-key')).toMatchObject({ pk: true, fk: true });
  });
  it('retains a weak entity’s plain id attribute without giving it a second generated PK role', () => {
    const doc = shop(); doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    doc.legs.forEach((l) => delete l.columnId); doc.attributes.find((a) => a.id === 'o-key')!.kind = 'simple';
    doc.attributes[0]!.name = 'customer_id';
    const table = deriveTables(doc)[1]!;
    expect(table.rows.find((r) => r.id === 'attribute:o-key')).toMatchObject({ pk: false, attributeId: 'o-key' });
    expect(table.rows.filter((r) => r.pk).map((r) => r.name)).toEqual(['customer_id']);
  });
  it('rejects an automatic weak composite target when the referencing field is explicitly selected', () => {
    const doc = shop(); doc.entities[0]!.kind = 'weak'; delete doc.legs[0]!.columnId;
    doc.entities.push({ id: 's', name: 'Staff', x: 800, y: 0, kind: 'strong' });
    doc.attributes.push({ id: 's-key', name: 'staff_id', kind: 'key', ownerId: 's', x: 0, y: 0 });
    doc.relationships.push({ id: 'owns', name: 'owns', kind: 'weak', x: 400, y: 200 });
    doc.legs.push(
      { id: 'owns-1', fromId: 'owns', toId: 's', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'owns-2', fromId: 'owns', toId: 'c', cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
    // Customer has its partial id plus Staff's inherited id: neither part is unique alone.
    expect(() => generateSql(doc)).toThrow(/single-column primary key at Customer/);
  });
  it('references a weak entity’s sole inherited key by its actual name', () => {
    const doc = shop(); doc.entities[0]!.kind = 'weak'; delete doc.legs[0]!.columnId;
    doc.attributes = doc.attributes.filter((a) => a.ownerId !== 'c');
    doc.entities.push({ id: 's', name: 'Staff', x: 800, y: 0, kind: 'strong' });
    doc.attributes.push({ id: 's-key', name: 'staff_id', kind: 'key', ownerId: 's', x: 0, y: 0 });
    doc.relationships.push({ id: 'owns', name: 'owns', kind: 'weak', x: 400, y: 200 });
    doc.legs.push(
      { id: 'owns-1', fromId: 'owns', toId: 's', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'owns-2', fromId: 'owns', toId: 'c', cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
    const sql = generateSql(doc);
    expect(sql).toContain('FOREIGN KEY ("buyer_ref") REFERENCES "customer" ("staff_id")');
    expect(deriveTables(doc)[1]!.rows.find((r) => r.id === 'attribute:o-buyer')?.references?.label).toBe('Customer.staff_id');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON'); db.exec(sql); db.exec('INSERT INTO staff (staff_id) VALUES (1)');
      db.exec('INSERT INTO customer (staff_id) VALUES (1)'); db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (1, 1)');
      expect(() => db.exec('INSERT INTO "order" (id, buyer_ref) VALUES (2, 99)')).toThrow(/FOREIGN KEY/);
    } finally { db.close(); }
  });
  it('rejects conflicting uses of the same FK attribute instead of silently picking one', () => {
    const doc = shop();
    doc.entities.push({ id: 's', name: 'Staff', x: 800, y: 300, kind: 'strong' });
    doc.relationships.push({ id: 's-r', name: 'approves', x: 500, y: 300, kind: 'strong' });
    doc.legs.push(
      { id: 's-a', fromId: 's-r', toId: 's', columnId: 'key:s', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 's-b', fromId: 's-r', toId: 'o', columnId: 'attribute:o-buyer', cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
    expect(() => generateSql(doc)).toThrow(/separate attribute for each foreign key/);
  });
  it('rejects referenced non-key fields, partial composite keys, and missing attributes with actionable errors', () => {
    const doc = shop(); doc.legs[0]!.columnId = 'attribute:c-email';
    expect(() => generateSql(doc)).toThrow(/single-column primary key at Customer/);
    doc.legs[0]!.columnId = 'attribute:c-key'; doc.attributes.find((a) => a.id === 'c-email')!.kind = 'key';
    expect(() => generateSql(doc)).toThrow(SqlError);
    doc.attributes = doc.attributes.filter((a) => a.id !== 'o-buyer');
    expect(() => generateSql(doc)).toThrow(/available connection attribute/);
  });
});
