import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deriveTables } from '../../src/model/crowfoot';
import { generateSql } from '../../src/model/sql';
import { decodeSnapshot, encodeSnapshot, normalizeDocument } from '../../src/model/snapshot';
import {
  BASE_TYPES, enumValuesFromInput, enumValuesOf, makeDataType, makeEnumType,
  normalizeDataType, splitDataType,
} from '../../src/model/dataTypes';
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

describe('parameterised types', () => {
  it('builds a type from a base and its numbers', () => {
    expect(makeDataType('VARCHAR', [64])).toBe('VARCHAR(64)');
    expect(makeDataType('CHAR', [2])).toBe('CHAR(2)');
    expect(makeDataType('DECIMAL', [12, 4])).toBe('DECIMAL(12,4)');
    expect(makeDataType('NUMERIC', [8, 0])).toBe('NUMERIC(8,0)');
    // A base with no numbers takes none.
    expect(makeDataType('INT')).toBe('INT');
    expect(makeDataType('INT', [4])).toBeUndefined();
  });

  it('gives a bare parameterised base its usual default', () => {
    expect(normalizeDataType('VARCHAR')).toBe('VARCHAR(255)');
    expect(normalizeDataType('DECIMAL')).toBe('DECIMAL(10,2)');
    // Lowercase and padding are the same type, not a different one.
    expect(normalizeDataType('  varchar ( 64 )  ')).toBe('VARCHAR(64)');
    expect(normalizeDataType('decimal(12, 4)')).toBe('DECIMAL(12,4)');
  });

  it('rejects a malformed number rather than repairing it into something plausible', () => {
    // This is the point of parsing instead of passing through: a link carrying
    // `VARCHAR(0)` must not become a column definition nobody chose.
    for (const bad of ['VARCHAR(0)', 'VARCHAR(-1)', 'VARCHAR(abc)', 'VARCHAR()',
      'VARCHAR(999999999)', 'DECIMAL(4,9)', 'DECIMAL(10,999999)', 'INT(4)', 'TEXT(4)']) {
      expect(normalizeDataType(bad), bad).toBeUndefined();
    }
  });

  it('rejects anything that is not a type at all', () => {
    for (const bad of ['DROP TABLE users', 'VARCHAR; --', '', '   ', 42, null, undefined, {}]) {
      expect(normalizeDataType(bad as unknown)).toBeUndefined();
    }
  });

  it('reads a type back into the parts the form edits', () => {
    expect(splitDataType('VARCHAR(64)')).toEqual({ base: 'VARCHAR', args: [64], enumValues: [] });
    expect(splitDataType('DECIMAL(12,4)')).toEqual({ base: 'DECIMAL', args: [12, 4], enumValues: [] });
    expect(splitDataType('UUID')).toEqual({ base: 'UUID', args: [], enumValues: [] });
    // Nothing chosen reads as TEXT with no arguments, not as a broken type.
    expect(splitDataType(undefined)).toEqual({ base: 'TEXT', args: [], enumValues: [] });
  });

  it('accepts the whole base list it offers', () => {
    for (const base of BASE_TYPES) {
      expect(normalizeDataType(base), base).toBeDefined();
    }
  });
});

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
    // The weak table borrows the parent's key as `customer_id`, with its type.
    expect(generateSql(doc)).toContain('"customer_id" UUID NOT NULL');
    expect(generateSql(doc)).toContain('FOREIGN KEY ("customer_id") REFERENCES "customer" ("id")');
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
    // The junction table names its columns after the table they point at.
    expect(generateSql(doc)).toContain('FOREIGN KEY ("customer_id") REFERENCES "customer" ("customer_id")');
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

describe('enum data types', () => {
  it('builds a canonical ENUM with quoted, comma-separated values', () => {
    expect(makeEnumType(['pending', 'active', 'closed'])).toBe("ENUM('pending','active','closed')");
    expect(makeEnumType(['a'])).toBe("ENUM('a')");
    // No space after the commas: this is the canonical form the exporter emits.
    expect(makeEnumType(['a', 'b'])).not.toContain(', ');
  });

  it('escapes a single quote inside a value the way SQL does', () => {
    expect(makeEnumType(["it's"])).toBe("ENUM('it''s')");
    expect(enumValuesOf("ENUM('it''s','ok')")).toEqual(["it's", 'ok']);
  });

  it('choosing the base without values gives a usable default', () => {
    const made = makeDataType('ENUM');
    expect(made).toBeDefined();
    expect(enumValuesOf(made!)).toEqual(['value']);
    expect(makeDataType('INT', [4])).toBeUndefined();
  });

  it('normalizes case, padding, and quoting to one canonical form', () => {
    expect(normalizeDataType('enum')).toBe("ENUM('value')");
    expect(normalizeDataType("  enum ( 'a' , 'b' )  ")).toBe("ENUM('a','b')");
    expect(normalizeDataType("ENUM('a','b')")).toBe("ENUM('a','b')");
  });

  it('treats the whitespace-separated and no-space spellings as the same list', () => {
    expect(enumValuesOf("ENUM('a','b','c')")).toEqual(enumValuesOf("ENUM( 'a' , 'b' , 'c' )"));
  });

  it('reads the values back out in order for the form', () => {
    expect(splitDataType("ENUM('low','high')")).toEqual({
      base: 'ENUM', args: [], enumValues: ['low', 'high'],
    });
    // A non-enum never reports values, so the form knows to hide the list field.
    expect(splitDataType('VARCHAR(64)').enumValues).toEqual([]);
  });

  it('rejects a malformed enum rather than repairing it into something plausible', () => {
    for (const bad of [
      'ENUM()', 'ENUM(', 'ENUM(red)', "ENUM('a',)", "ENUM('a' junk)", 'ENUM(,)',
      "ENUM('')", 'ENUM(a,b)',
    ]) {
      expect(normalizeDataType(bad), bad).toBeUndefined();
    }
  });

  it('refuses duplicate values, an empty list, and unreasonably large lists', () => {
    expect(makeEnumType([])).toBeUndefined();
    expect(makeEnumType([])).toBeUndefined();
    expect(makeEnumType(['a', 'a'])).toBeUndefined();
    expect(makeEnumType(Array.from({ length: 65 }, (_, i) => 'v' + i))).toBeUndefined();
    expect(makeEnumType(['x'.repeat(65)])).toBeUndefined();
    // The boundary itself is allowed.
    expect(makeEnumType(Array.from({ length: 64 }, (_, i) => 'v' + i))).toBeDefined();
    expect(makeEnumType(['x'.repeat(64)])).toBeDefined();
  });

  it('drops an absurd imported enum and safely infers instead', () => {
    const doc = schema();
    Object.assign(doc.attributes[1]!, { dataType: "ENUM('a'" });
    const normalized = normalizeDocument(doc);
    expect(normalized.attributes[1]).not.toHaveProperty('dataType');
    expect(generateSql(normalized)).toContain('"email" TEXT');
  });

  it('parses the comma-separated text a person types, with or without quotes', () => {
    expect(enumValuesFromInput('pending, active, closed')).toEqual(['pending', 'active', 'closed']);
    expect(enumValuesFromInput("'pending', 'active'")).toEqual(['pending', 'active']);
    // Quotes protect an internal comma; without them, the comma splits.
    expect(enumValuesFromInput("'a,b', c")).toEqual(['a,b', 'c']);
    expect(enumValuesFromInput('  a ,  b  ')).toEqual(['a', 'b']);
    expect(enumValuesFromInput('')).toEqual([]);
    expect(enumValuesFromInput('   ,  ,  ')).toEqual([]);
  });

  it('exports an enum column and carries its type into inherited foreign keys', () => {
    const doc = schema();
    Object.assign(doc.attributes[0]!, { dataType: "ENUM('gold','silver')" });
    expect(deriveTables(doc)[0]!.rows.find((r) => r.attributeId === 'id')?.type).toBe("ENUM('gold','silver')");
    expect(generateSql(doc)).toContain('"customer_id" ENUM(\'gold\',\'silver\')');
    // A key of enum type carries the same enum into the many-side foreign key.
    expect(deriveTables(doc)[1]!.rows.find((r) => r.fk)?.type).toBe("ENUM('gold','silver')");
  });

  it('survives JSON normalization, URL snapshots, and a Yjs round trip', () => {
    const doc = schema();
    Object.assign(doc.attributes[1]!, { dataType: "ENUM('a','b')" });
    expect(normalizeDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(decodeSnapshot(encodeSnapshot(doc))).toEqual(doc);

    const source = new Y.Doc(), peer = new Y.Doc();
    seedDocument(source, doc); Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
    expect(snapshotFromYdoc(peer).attributes.find((a) => a.id === 'email'))
      .toHaveProperty('dataType', "ENUM('a','b')");
    source.destroy(); peer.destroy();
  });
});
