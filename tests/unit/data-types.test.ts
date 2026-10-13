import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deriveTables } from '../../src/model/crowfoot';
import { generateSql } from '../../src/model/sql';
import { decodeSnapshot, encodeSnapshot, normalizeDocument } from '../../src/model/snapshot';
import { emptyDocument } from '../../src/model/types';
import { ATTRIBUTES, seedDocument, snapshotFromYdoc, upsertAttribute } from '../../src/collab/ydoc';

function schema() {
  const doc = emptyDocument('Typed orders');
  doc.view = 'crowfoot';
  doc.entities = [
    { id: 'c', name: 'Customer', kind: 'strong', x: 0, y: 0 },
    { id: 'o', name: 'Order', kind: 'strong', x: 400, y: 0 },
  ];
  doc.attributes = [
    { id: 'id', name: 'customer_id', kind: 'key', ownerId: 'c', x: 0, y: 0 },
    { id: 'email', name: 'email', kind: 'simple', ownerId: 'c', x: 0, y: 0 },
    { id: 'price', name: 'total_price', kind: 'simple', ownerId: 'o', x: 0, y: 0 },
  ];
  doc.relationships = [{ id: 'r', name: 'places', kind: 'strong', x: 200, y: 0 }];
  doc.legs = [
    { id: 'l1', fromId: 'r', toId: 'c', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r', toId: 'o', cardinality: 'N', participation: { min: 0, max: 'N' } },
  ];
  return doc;
}

function keyChain(length = 4) {
  const doc = emptyDocument('Inherited key chain');
  for (let index = 0; index < length; index++) {
    const id = String.fromCharCode(97 + index);
    doc.entities.push({ id, name: id.toUpperCase(), kind: 'strong', x: index * 400, y: 0 });
    doc.attributes.push({ id: id + '_key', name: id + '_id', kind: 'key', ownerId: id, x: 0, y: 0,
      ...(index === 0 ? { dataType: 'UUID' as const } : {}) });
    if (index === 0) continue;
    const parent = String.fromCharCode(96 + index), rel = 'r' + index;
    doc.relationships.unshift({ id: rel, name: id + '_references_' + parent, kind: 'strong', x: 0, y: 0 });
    doc.legs.push(
      { id: rel + '_child', fromId: rel, toId: id, columnId: 'attribute:' + id + '_key', cardinality: 'N', participation: { min: 0, max: 'N' } },
      { id: rel + '_parent', fromId: rel, toId: parent, columnId: 'attribute:' + parent + '_key', cardinality: '1', participation: { min: 0, max: 1 } },
    );
  }
  return doc;
}

describe('editable data types', () => {
  it('overrides inferred table types and exports the chosen parameterized SQL types', () => {
    const doc = schema();
    Object.assign(doc.attributes[1]!, { dataType: 'VARCHAR(255)' });
    Object.assign(doc.attributes[2]!, { dataType: 'DECIMAL(10,2)' });
    const tables = deriveTables(doc);
    expect(tables[0]!.rows.find((r) => r.attributeId === 'email')?.type).toBe('VARCHAR(255)');
    expect(tables[1]!.rows.find((r) => r.attributeId === 'price')?.type).toBe('DECIMAL(10,2)');
    expect(generateSql(doc)).toContain('"email" VARCHAR(255)');
    expect(generateSql(doc)).toContain('"total_price" DECIMAL(10,2)');
  });

  it('retains name inference for legacy attributes without a data type', () => {
    const doc = schema();
    expect(deriveTables(doc)[0]!.rows[0]!.type).toBe('INT');
    expect(deriveTables(doc)[1]!.rows.find((r) => r.attributeId === 'price')?.type).toBe('NUMERIC');
    expect(generateSql(doc)).toContain('"customer_id" INTEGER');
    expect(generateSql(doc)).toContain('"total_price" NUMERIC');
  });

  it('honors a chosen type on an editable id promoted to the generated primary key', () => {
    const doc = schema();
    Object.assign(doc.attributes[0]!, { name: 'id', kind: 'simple', dataType: 'UUID' });
    expect(deriveTables(doc)[0]!.rows.find((r) => r.attributeId === 'id')).toMatchObject({ type: 'UUID', pk: true });
    for (const dialect of ['standard', 'postgres', 'mysql', 'sqlite'] as const) {
      expect(generateSql(doc, { dialect })).toContain('"id" UUID NOT NULL');
    }
  });

  it('inherits a promoted id’s explicit type into identifying foreign keys', () => {
    const doc = schema();
    Object.assign(doc.attributes[0]!, { name: 'id', kind: 'simple', dataType: 'UUID' });
    doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    expect(generateSql(doc).match(/"id" UUID NOT NULL/g)).toHaveLength(2);
  });

  it('inherits UUID keys into generated foreign keys', () => {
    const doc = schema(); Object.assign(doc.attributes[0]!, { dataType: 'UUID' });
    expect(deriveTables(doc)[1]!.rows.find((r) => r.fk)?.type).toBe('UUID');
    expect(generateSql(doc).match(/"customer_id" UUID/g)).toHaveLength(2);
  });

  it('keeps an explicitly bound foreign key compatible with its referenced key', () => {
    const doc = schema(); Object.assign(doc.attributes[0]!, { dataType: 'BIGINT' });
    Object.assign(doc.attributes[2]!, { dataType: 'TEXT' });
    doc.legs[1]!.columnId = 'attribute:price';
    expect(deriveTables(doc)[1]!.rows.find((r) => r.attributeId === 'price')).toMatchObject({ type: 'BIGINT', fk: true });
    expect(generateSql(doc)).toContain('"total_price" BIGINT');
  });

  it('inherits chosen key types into weak entities and junction tables', () => {
    const doc = schema(); Object.assign(doc.attributes[0]!, { dataType: 'UUID' });
    doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    expect(generateSql(doc)).toContain('"customer_id" UUID');
    expect(deriveTables(doc)[1]!.rows.find((r) => r.fk)).toMatchObject({ pk: true, type: 'UUID' });
    doc.entities[1]!.kind = 'strong'; doc.relationships[0]!.kind = 'strong';
    doc.legs[0]!.cardinality = 'M';
    expect(generateSql(doc)).toContain('"customer_customer_id" UUID');
  });

  it('propagates inherited PK/FK types through a chain regardless of relationship order', () => {
    const doc = keyChain();
    for (const reverse of [false, true]) {
      if (reverse) doc.relationships.reverse();
      for (const table of deriveTables(doc)) {
        expect(table.rows.find((row) => row.pk)?.type, table.name).toBe('UUID');
      }
      const sql = generateSql(doc);
      for (const id of ['a', 'b', 'c', 'd']) expect(sql).toContain('"' + id + '_id" UUID');
    }
  });

  it('uses resolved inherited key types for an automatic identifying weak descendant', () => {
    const doc = keyChain(3);
    doc.entities[2]!.kind = 'weak';
    doc.relationships.find((rel) => rel.id === 'r2')!.kind = 'weak';
    for (const leg of doc.legs.filter((leg) => leg.fromId === 'r2')) delete leg.columnId;
    expect(deriveTables(doc)[2]!.rows.find((row) => row.fk)).toMatchObject({ name: 'b_id', type: 'UUID', pk: true });
    const sql = generateSql(doc);
    const child = sql.slice(sql.indexOf('CREATE TABLE "c"'));
    expect(child).toContain('"b_id" UUID NOT NULL');
    expect(child).toContain('FOREIGN KEY ("b_id") REFERENCES "b" ("b_id")');
  });

  it('preserves chosen types through JSON normalization and URL snapshots', () => {
    const doc = schema(); Object.assign(doc.attributes[1]!, { dataType: 'JSON' });
    expect(normalizeDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(decodeSnapshot(encodeSnapshot(doc))).toEqual(doc);
  });

  it.each(['TEXT); DROP TABLE customer; --', 'VARCHAR(0)', 'DECIMAL(99,100)', 7])('drops unsupported imported type %s and safely infers instead', (dataType) => {
    const doc = schema(); Object.assign(doc.attributes[1]!, { dataType });
    const normalized = normalizeDocument(doc);
    expect(normalized.attributes[1]).not.toHaveProperty('dataType');
    expect(generateSql(doc)).toContain('"email" TEXT');
    expect(generateSql(doc)).not.toContain('DROP TABLE');
  });

  it('normalizes supported lower-case imported types without accepting arbitrary SQL', () => {
    const doc = schema(); Object.assign(doc.attributes[1]!, { dataType: '  varchar(255)  ' });
    expect(normalizeDocument(doc).attributes[1]).toHaveProperty('dataType', 'VARCHAR(255)');
    expect(generateSql(doc)).toContain('"email" VARCHAR(255)');
  });

  it('preserves types in Yjs, broadcasts changes, and undo keeps remote edits', () => {
    const source = new Y.Doc(), peer = new Y.Doc();
    const doc = schema(); Object.assign(doc.attributes[0]!, { dataType: 'UUID' });
    seedDocument(source, doc); Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
    expect(snapshotFromYdoc(peer).attributes.find((a) => a.id === 'id')).toHaveProperty('dataType', 'UUID');
    const undo = new Y.UndoManager(source.getMap(ATTRIBUTES));
    upsertAttribute(source, Object.assign({}, doc.attributes[1]!, { dataType: 'JSON' }));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
    expect(snapshotFromYdoc(peer).attributes.find((a) => a.id === 'email')).toHaveProperty('dataType', 'JSON');
    (peer.getMap(ATTRIBUTES).get('price') as Y.Map<unknown>).set('name', 'invoice_amount');
    Y.applyUpdate(source, Y.encodeStateAsUpdate(peer), 'peer'); undo.undo();
    const restored = snapshotFromYdoc(source);
    expect(restored.attributes.find((a) => a.id === 'email')).not.toHaveProperty('dataType');
    expect(restored.attributes.find((a) => a.id === 'price')?.name).toBe('invoice_amount');
    undo.redo();
    expect(snapshotFromYdoc(source).attributes.find((a) => a.id === 'email')).toHaveProperty('dataType', 'JSON');
    upsertAttribute(source, doc.attributes[1]!);
    expect(snapshotFromYdoc(source).attributes.find((a) => a.id === 'email')).not.toHaveProperty('dataType');
    undo.destroy(); source.destroy(); peer.destroy();
  });
});
