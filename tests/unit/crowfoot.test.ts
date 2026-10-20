import { describe, expect, it } from 'vitest';
import { deriveLinks, deriveTables, tableHeight } from '../../src/model/crowfoot';
import { foreignKeyColumnName, generateSql } from '../../src/model/sql';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

function shop(): ErdDocument {
  const doc = emptyDocument('Shop');
  doc.entities.push(
    { id: 'c', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'o', name: 'Order', x: 400, y: 0, kind: 'strong' },
  );
  doc.attributes.push(
    { id: 'c1', name: 'customer_id', x: 0, y: 0, kind: 'key', ownerId: 'c' },
    { id: 'c2', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'c' },
    { id: 'o1', name: 'order_id', x: 0, y: 0, kind: 'key', ownerId: 'o' },
    { id: 'o2', name: 'placed_at', x: 0, y: 0, kind: 'simple', ownerId: 'o' },
  );
  doc.relationships.push({ id: 'r', name: 'places', x: 200, y: 0, kind: 'strong' });
  doc.legs.push(
    { id: 'l1', fromId: 'c', toId: 'r', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r', toId: 'o', cardinality: 'N', participation: { min: 0, max: 'N' } },
  );
  return doc;
}

describe('deriveTables', () => {
  it('produces one table per entity', () => {
    expect(deriveTables(shop()).map((t) => t.name)).toEqual(['Customer', 'Order']);
  });

  it('marks key attributes as the primary key', () => {
    const customer = deriveTables(shop()).find((t) => t.name === 'Customer')!;
    const pk = customer.rows.filter((r) => r.pk);
    expect(pk.map((r) => r.name)).toEqual(['customer_id']);
  });

  it('adds a foreign key row on the many side', () => {
    const order = deriveTables(shop()).find((t) => t.name === 'Order')!;
    const fk = order.rows.find((r) => r.fk);
    expect(fk?.name).toBe('customer_id');
    expect(fk?.references?.label).toBe('Customer.customer_id');
  });

  it('does not add a foreign key on the one side', () => {
    const customer = deriveTables(shop()).find((t) => t.name === 'Customer')!;
    expect(customer.rows.some((r) => r.fk)).toBe(false);
  });

  it('synthesises an id key when the entity has no key attribute', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'Thing', x: 0, y: 0, kind: 'strong' });
    const table = deriveTables(doc)[0]!;
    expect(table.rows[0]).toMatchObject({ name: 'id', pk: true, attributeId: null });
  });

  it('excludes derived attributes', () => {
    const doc = shop();
    doc.attributes.push({ id: 'd', name: 'total_spent', x: 0, y: 0, kind: 'derived', ownerId: 'c' });
    const customer = deriveTables(doc).find((t) => t.name === 'Customer')!;
    expect(customer.rows.some((r) => r.name === 'total_spent')).toBe(false);
  });

  it('includes multivalued attributes as plain columns', () => {
    const doc = shop();
    doc.attributes.push({ id: 'mv', name: 'phone', x: 0, y: 0, kind: 'multivalued', ownerId: 'c' });
    const customer = deriveTables(doc).find((t) => t.name === 'Customer')!;
    expect(customer.rows.some((r) => r.name === 'phone')).toBe(true);
  });

  it('marks weak entities', () => {
    const doc = shop();
    doc.entities[1]!.kind = 'weak';
    expect(deriveTables(doc).find((t) => t.name === 'Order')!.weak).toBe(true);
  });

  it('does not duplicate a column name', () => {
    const doc = shop();
    doc.attributes.push({ id: 'dupe', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'c' });
    const customer = deriveTables(doc).find((t) => t.name === 'Customer')!;
    expect(customer.rows.filter((r) => r.name === 'email')).toHaveLength(1);
  });

  it('infers column types', () => {
    const customer = deriveTables(shop()).find((t) => t.name === 'Customer')!;
    expect(customer.rows.find((r) => r.name === 'customer_id')!.type).toBe('INT');
    expect(customer.rows.find((r) => r.name === 'email')!.type).toBe('TEXT');
  });

  it('gives two relationships to the same table a column each', () => {
    const doc = shop();
    doc.relationships.push({ id: 'r2', name: 'billing_customer', x: 200, y: 200, kind: 'strong' });
    doc.legs.push(
      { id: 'l3', fromId: 'c', toId: 'r2', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'l4', fromId: 'r2', toId: 'o', cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
    const order = deriveTables(doc).find((t) => t.name === 'Order')!;
    const keys = order.rows.filter((r) => r.fk);
    // One column for each relationship, and each line ends on its own.
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map((r) => r.name)).size).toBe(2);
    const links = deriveLinks(doc);
    expect(new Set(links.map((l) => l.toColumnId)).size).toBe(2);
  });

  it('gives a one-to-one relationship a foreign key', () => {
    const doc = shop();
    doc.legs[1]!.cardinality = '1'; doc.legs[1]!.participation.max = 1;
    const order = deriveTables(doc).find((t) => t.name === 'Order')!;
    const key = order.rows.find((r) => r.fk);
    expect(key?.name).toBe('customer_id');
    expect(key?.pk).toBe(false);
    expect(key?.references?.label).toBe('Customer.customer_id');
  });

  it('finds a foreign key row an older diagram bound by its old id', () => {
    // Older files named the generated row after the key it referenced, so a
    // room written by an earlier build still points at it. Nothing has to be
    // re-shared for the binding to keep working.
    const doc = shop();
    doc.legs.forEach((leg) => delete leg.columnId);
    doc.legs[1]!.columnId = 'foreign:c:attribute:c1';
    const order = deriveTables(doc).find((t) => t.name === 'Order')!;
    expect(order.rows.find((r) => r.fk)?.references?.label).toBe('Customer.customer_id');
    expect(deriveLinks(doc)[0]!.toColumnId).toBe(order.rows.find((r) => r.fk)!.id);
  });

  it('uses the name a person gives a generated foreign key', () => {
    const doc = shop();
    // The name lives on the leg that holds the column, so it belongs to the
    // connection rather than to the table it points at. It is keyed by the
    // referenced column, so a key of several columns has a name for each part.
    doc.legs[1]!.columnNames = { 'attribute:c1': 'shipped_to_customer' };
    const order = deriveTables(doc).find((t) => t.name === 'Order')!;
    const key = order.rows.find((r) => r.fk);
    expect(key?.name).toBe('shipped_to_customer');
    expect(key?.references?.label).toBe('Customer.customer_id');
    expect(generateSql(doc)).toContain('FOREIGN KEY ("shipped_to_customer") REFERENCES "customer" ("customer_id")');
  });

  it('names a weak entity’s inherited key after the table it comes from', () => {    const doc = shop();
    doc.entities[1]!.kind = 'weak'; doc.relationships[0]!.kind = 'weak';
    doc.legs.forEach((leg) => delete leg.columnId);
    // A weak entity with an id of its own keeps it.
    doc.attributes.push({ id: 'o3', name: 'id', x: 0, y: 0, kind: 'simple', ownerId: 'o' });
    const order = deriveTables(doc).find((t) => t.name === 'Order')!;
    const inherited = order.rows.find((r) => r.fk);
    expect(inherited).toMatchObject({ name: 'customer_id', pk: true });
    expect(order.rows.filter((r) => r.fk)).toHaveLength(1);
    expect(order.rows.find((r) => r.name === 'id')!.fk).toBe(false);
    expect(order.rows.find((r) => r.name === 'order_id')!.fk).toBe(false);
  });
});

describe('foreign key column naming', () => {
  it('does not double a key that is already named after its table', () => {
    // `customer_id` is the usual name for a `customer` key; prefixing again
    // gives `customer_customer_id`, which says nothing extra.
    expect(foreignKeyColumnName('customer', 'customer_id')).toBe('customer_id');
    expect(foreignKeyColumnName('order', 'order_id')).toBe('order_id');
    expect(foreignKeyColumnName('book', 'book')).toBe('book');
  });

  it('prefixes a key that does not carry the table name', () => {
    expect(foreignKeyColumnName('customer', 'isbn')).toBe('customer_isbn');
    expect(foreignKeyColumnName('customer', 'id')).toBe('customer_id');
  });

  it('keeps a key that already carries the table name', () => {
    // `customer_number` is the usual name for a key of `customer`, and prefixing
    // it again gives `customer_customer_number`, which says nothing extra.
    expect(foreignKeyColumnName('customer', 'customer_number')).toBe('customer_number');
    expect(foreignKeyColumnName('order', 'order_line_id')).toBe('order_line_id');
  });
});

describe('deriveLinks', () => {
  it('produces one link per relationship, foot on the many side', () => {
    const links = deriveLinks(shop());
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      fromEntityId: 'c',
      toEntityId: 'o',
      manyEntityId: 'o',
      oneEntityId: 'c',
      label: 'places',
    });
  });

  it('draws a many-to-many relationship as one line with a foot at each end', () => {
    const doc = emptyDocument();
    doc.entities.push(
      { id: 's', name: 'Student', x: 0, y: 0, kind: 'strong' },
      { id: 'c', name: 'Course', x: 0, y: 0, kind: 'strong' },
    );
    doc.relationships.push({ id: 'r', name: 'enrolls', x: 0, y: 0, kind: 'strong' });
    doc.legs.push(
      { id: 'l1', fromId: 's', toId: 'r', cardinality: 'N', participation: { min: 0, max: 'N' } },
      { id: 'l2', fromId: 'r', toId: 'c', cardinality: 'M', participation: { min: 0, max: 'N' } },
    );
    const links = deriveLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ fromEntityId: 's', toEntityId: 'c', fromMany: true, toMany: true, ratio: 'N:M' });
    // The relationship stays a line between two tables. A table of its own
    // would be a shape nobody could select, move, or share.
    const tables = deriveTables(doc);
    expect(tables.map((t) => t.name)).toEqual(['Student', 'Course']);
  });

  it('draws a line for every column of a composite key', () => {
    const doc = emptyDocument();
    doc.entities.push(
      { id: 'u', name: 'Pengguna', x: 0, y: 0, kind: 'strong' },
      { id: 'n', name: 'Notifikasi', x: 0, y: 0, kind: 'strong' },
    );
    doc.attributes.push(
      { id: 'u1', name: 'id_pengguna', x: 0, y: 0, kind: 'key', ownerId: 'u' },
      { id: 'u2', name: 'nim', x: 0, y: 0, kind: 'key', ownerId: 'u' },
      { id: 'n1', name: 'id', x: 0, y: 0, kind: 'key', ownerId: 'n' },
    );
    doc.relationships.push({ id: 'r', name: 'dikirim_ke', x: 0, y: 0, kind: 'strong' });
    doc.legs.push(
      { id: 'l1', fromId: 'u', toId: 'r', cardinality: '1', participation: { min: 1, max: 1 } },
      { id: 'l2', fromId: 'r', toId: 'n', cardinality: 'N', participation: { min: 0, max: 'N' } },
    );
    const table = deriveTables(doc).find((t) => t.name === 'Notifikasi')!;
    // One foreign-key column for each part of the key.
    expect(table.rows.filter((r) => r.fk).map((r) => r.name)).toEqual(['pengguna_id_pengguna', 'pengguna_nim']);
    // And a line for each of them, so no column leads nowhere.
    const links = deriveLinks(doc);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.toColumnId)).toEqual(table.rows.filter((r) => r.fk).map((r) => r.id));
    expect(links.map((l) => l.fromColumnId)).toEqual(['attribute:u1', 'attribute:u2']);
  });

  it('ignores a relationship with fewer than two entity ends', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'E', x: 0, y: 0, kind: 'strong' });
    doc.relationships.push({ id: 'r', name: 'r', x: 0, y: 0, kind: 'strong' });
    doc.legs.push({ id: 'l1', fromId: 'e', toId: 'r', cardinality: '1', participation: { min: 0, max: 1 } });
    expect(deriveLinks(doc)).toHaveLength(0);
  });
});

describe('tableHeight', () => {
  it('grows with the number of rows', () => {
    const tables = deriveTables(shop());
    const customer = tables.find((t) => t.name === 'Customer')!;
    const order = tables.find((t) => t.name === 'Order')!;
    expect(tableHeight(customer)).toBeGreaterThan(0);
    // Order carries an extra foreign-key row, so it is taller.
    expect(tableHeight(order)).toBeGreaterThan(tableHeight(customer));
  });

  it('reserves space for at least one row when empty', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'E', x: 0, y: 0, kind: 'strong' });
    const table = deriveTables(doc)[0]!;
    // Every table gets a synthesised id key, so this is always >= 1 row.
    expect(tableHeight(table)).toBeGreaterThan(30);
  });
});
