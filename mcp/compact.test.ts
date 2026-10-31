import { describe, expect, it } from 'vitest';
import { parseCompactDiagram } from './compact';

describe('parseCompactDiagram', () => {
  it('reads entities with typed and flagged attributes', () => {
    const { entities } = parseCompactDiagram(`
      Customer
        customer_id: INT key
        email: TEXT unique
        name
    `);
    expect(entities).toEqual([{
      name: 'Customer',
      attributes: [
        { name: 'customer_id', dataType: 'INT', kind: 'key' },
        { name: 'email', dataType: 'TEXT', kind: 'unique' },
        { name: 'name' },
      ],
    }]);
  });

  it('nests composite parts by indentation', () => {
    const { entities } = parseCompactDiagram(`
      Customer
        address: composite
          street: TEXT
          city: TEXT
        phone
    `);
    expect(entities[0]!.attributes).toEqual([
      {
        name: 'address',
        kind: 'composite',
        attributes: [{ name: 'street', dataType: 'TEXT' }, { name: 'city', dataType: 'TEXT' }],
      },
      { name: 'phone' },
    ]);
  });

  it('reads relationships, names them, and defaults the name', () => {
    const { relationships } = parseCompactDiagram(`
      Customer
      Order
      Customer 1:N Order as places
      Customer 1:1 Profile
    `);
    expect(relationships).toEqual([
      { name: 'places', from: 'Customer', to: 'Order', cardinality: '1:N' },
      { name: 'Customer Profile', from: 'Customer', to: 'Profile', cardinality: '1:1' },
    ]);
  });

  it('keeps entity names that contain spaces', () => {
    const { relationships } = parseCompactDiagram(`
      Order Line
      Line Item
      Order Line 1:N Line Item
    `);
    expect(relationships[0]).toMatchObject({ from: 'Order Line', to: 'Line Item' });
  });

  it('hangs attributes off a relationship', () => {
    const { relationships } = parseCompactDiagram(`
      Student
      Course
      Student N:M Course as enrols
        enrolled_at: DATE
    `);
    expect(relationships[0]!.attributes).toEqual([{ name: 'enrolled_at', dataType: 'DATE' }]);
  });

  it('reads specializations and placement', () => {
    const model = parseCompactDiagram(`
      Party isa Customer, Supplier
      Supplier weak @ 900, 120
    `);
    expect(model.isas).toEqual([{ parent: 'Party', children: ['Customer', 'Supplier'] }]);
    expect(model.entities).toEqual([{ name: 'Supplier', kind: 'weak', x: 900, y: 120 }]);
  });

  it('ignores comments and blank lines', () => {
    const { entities } = parseCompactDiagram(`
      # the customer table
      Customer
        id: INT key   # surrogate key

    `);
    expect(entities[0]!.attributes).toEqual([{ name: 'id', dataType: 'INT', kind: 'key' }]);
  });

  it('accepts a flag before the colon', () => {
    const { entities } = parseCompactDiagram('Customer\n  email unique: TEXT\n');
    expect(entities[0]!.attributes).toEqual([{ name: 'email', kind: 'unique', dataType: 'TEXT' }]);
  });

  it('reports the line number of a bad line', () => {
    expect(() => parseCompactDiagram('Customer\n  id: INT\n  : TEXT\n')).toThrow(/Line 3/);
  });

  it('treats deeper indentation as composite parts', () => {
    const { entities } = parseCompactDiagram('Customer\n  address\n    street: TEXT\n');
    expect(entities[0]!.attributes).toEqual([
      { name: 'address', attributes: [{ name: 'street', dataType: 'TEXT' }] },
    ]);
  });

  it('rejects tabs', () => {
    expect(() => parseCompactDiagram('Customer\n\tid: INT\n')).toThrow(/tabs/);
  });

  it('rejects empty input with a usable message', () => {
    expect(() => parseCompactDiagram('   \n\n')).toThrow(/No entities found/);
  });
});
