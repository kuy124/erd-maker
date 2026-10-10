import { describe, expect, it } from 'vitest';
import { deriveLinks, deriveTables, tableHeight } from '../../src/model/crowfoot';
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
    expect(fk?.name).toBe('customer_customer_id');
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

  it('produces two links for many-to-many so both ends get a foot', () => {
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
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.manyEntityId).sort()).toEqual(['c', 's']);
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
