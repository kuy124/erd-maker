import { describe, expect, it } from 'vitest';
import { generateSql, toSqlName, describeSqlReadiness } from '../../src/model/sql';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

/** Customer(1) --places-- (N)Order, both with key attributes. */
function oneToMany(): ErdDocument {
  const doc = emptyDocument('Shop');
  doc.entities.push(
    { id: 'c', name: 'Customer', x: 0, y: 0, kind: 'strong' },
    { id: 'o', name: 'Order', x: 300, y: 0, kind: 'strong' },
  );
  doc.attributes.push(
    { id: 'c1', name: 'customer_id', x: 0, y: 0, kind: 'key', ownerId: 'c' },
    { id: 'c2', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'c' },
    { id: 'o1', name: 'order_id', x: 0, y: 0, kind: 'key', ownerId: 'o' },
    { id: 'o2', name: 'placed_at', x: 0, y: 0, kind: 'simple', ownerId: 'o' },
  );
  doc.relationships.push({ id: 'r', name: 'places', x: 150, y: 0, kind: 'strong' });
  doc.legs.push(
    { id: 'l1', fromId: 'c', toId: 'r', cardinality: '1', participation: { min: 0, max: 1 } },
    { id: 'l2', fromId: 'r', toId: 'o', cardinality: 'N', participation: { min: 1, max: 'N' } },
  );
  return doc;
}

/** Student(N) --enrolls-- (M)Course. */
function manyToMany(): ErdDocument {
  const doc = emptyDocument('School');
  doc.entities.push(
    { id: 's', name: 'Student', x: 0, y: 0, kind: 'strong' },
    { id: 'c', name: 'Course', x: 300, y: 0, kind: 'strong' },
  );
  doc.attributes.push(
    { id: 's1', name: 'student_id', x: 0, y: 0, kind: 'key', ownerId: 's' },
    { id: 'c1', name: 'course_id', x: 0, y: 0, kind: 'key', ownerId: 'c' },
  );
  doc.relationships.push({ id: 'r', name: 'enrolls', x: 150, y: 0, kind: 'strong' });
  doc.legs.push(
    { id: 'l1', fromId: 's', toId: 'r', cardinality: 'N', participation: { min: 0, max: 'N' } },
    { id: 'l2', fromId: 'r', toId: 'c', cardinality: 'M', participation: { min: 0, max: 'N' } },
  );
  return doc;
}

describe('toSqlName', () => {
  it('snake_cases and strips characters SQL dislikes', () => {
    expect(toSqlName('Customer Order')).toBe('customer_order');
    expect(toSqlName('Full-Name')).toBe('full_name');
    expect(toSqlName('café (id)')).toBe('caf_id');
  });

  it('falls back for names that strip to nothing', () => {
    expect(toSqlName('   ')).toBe('unnamed');
    expect(toSqlName('###')).toBe('unnamed');
  });
});

describe('generateSql — one to many', () => {
  const sql = generateSql(oneToMany());

  it('creates a table per entity', () => {
    expect(sql).toContain('CREATE TABLE "customer"');
    expect(sql).toContain('CREATE TABLE "order"');
  });

  it('does not create a table for the relationship', () => {
    expect(sql).not.toContain('CREATE TABLE "places"');
  });

  it('makes key attributes the primary key', () => {
    expect(sql).toContain('PRIMARY KEY ("customer_id")');
    expect(sql).toContain('PRIMARY KEY ("order_id")');
  });

  it('adds the foreign key on the many side', () => {
    // `customer_id` is already named after its table, so it is not doubled
    // into `customer_customer_id`.
    expect(sql).toContain('"customer_id" INTEGER');
    expect(sql).toContain('FOREIGN KEY ("customer_id") REFERENCES "customer" ("customer_id")');
    expect(sql).not.toContain('customer_customer_id');
  });

  it('does not put a foreign key on the one side', () => {
    const customer = sql.slice(sql.indexOf('CREATE TABLE "customer"'), sql.indexOf('CREATE TABLE "order"'));
    expect(customer).not.toContain('FOREIGN KEY');
  });

  it('infers sensible column types', () => {
    expect(sql).toMatch(/"placed_at" TIMESTAMP/);
    expect(sql).toMatch(/"email" TEXT/);
  });
});

describe('generateSql — many to many', () => {
  const sql = generateSql(manyToMany());

  it('creates a junction table named after the relationship', () => {
    expect(sql).toContain('CREATE TABLE "enrolls"');
  });

  it('carries both foreign keys and makes them a composite primary key', () => {
    expect(sql).toContain('FOREIGN KEY ("student_id") REFERENCES "student" ("student_id")');
    expect(sql).toContain('FOREIGN KEY ("course_id") REFERENCES "course" ("course_id")');
    expect(sql).toContain('PRIMARY KEY ("student_id", "course_id")');
  });
});

describe('generateSql — weak entity', () => {
  it('borrows the parent key as part of the weak entity primary key', () => {
    const doc = emptyDocument('Weak');
    doc.entities.push(
      { id: 'e', name: 'Employee', x: 0, y: 0, kind: 'strong' },
      { id: 'd', name: 'Dependent', x: 300, y: 0, kind: 'weak' },
    );
    doc.attributes.push(
      { id: 'e1', name: 'emp_id', x: 0, y: 0, kind: 'key', ownerId: 'e' },
      { id: 'd1', name: 'dep_name', x: 0, y: 0, kind: 'key', ownerId: 'd' },
    );
    doc.relationships.push({ id: 'r', name: 'has', x: 150, y: 0, kind: 'weak' });
    doc.legs.push(
      { id: 'l1', fromId: 'e', toId: 'r', cardinality: '1', participation: { min: 0, max: 1 } },
      { id: 'l2', fromId: 'r', toId: 'd', cardinality: 'N', participation: { min: 1, max: 'N' } },
    );
    const sql = generateSql(doc);
    expect(sql).toContain('CREATE TABLE "dependent"');
    expect(sql).toContain('"emp_id" INTEGER NOT NULL');
    // The inherited key is named after the table it comes from.
    expect(sql).toContain('FOREIGN KEY ("employee_emp_id") REFERENCES "employee" ("emp_id")');
    expect(sql).toContain('PRIMARY KEY ("employee_emp_id", "dep_name")');
  });
});

describe('generateSql — edge cases', () => {
  it('synthesises a surrogate key when no key attribute exists', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'Thing', x: 0, y: 0, kind: 'strong' });
    doc.attributes.push({ id: 'a', name: 'label', x: 0, y: 0, kind: 'simple', ownerId: 'e' });
    const sql = generateSql(doc);
    expect(sql).toContain('"id" INTEGER');
    expect(sql).toContain('PRIMARY KEY ("id")');
  });

  it('uses the dialect-specific surrogate key', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'Thing', x: 0, y: 0, kind: 'strong' });
    expect(generateSql(doc, { dialect: 'postgres' })).toContain('SERIAL');
    expect(generateSql(doc, { dialect: 'mysql' })).toContain('AUTO_INCREMENT');
  });

  it('emits DROP statements when asked', () => {
    const sql = generateSql(oneToMany(), { dropFirst: true });
    expect(sql).toContain('DROP TABLE IF EXISTS "customer";');
  });

  it('excludes derived attributes', () => {
    const doc = oneToMany();
    doc.attributes.push({ id: 'derived', name: 'age', x: 0, y: 0, kind: 'derived', ownerId: 'c' });
    expect(generateSql(doc)).not.toContain('"age"');
  });

  it('handles an empty document with a helpful comment', () => {
    expect(generateSql(emptyDocument())).toContain('-- Nothing to generate');
  });

  it('does not emit duplicate column names', () => {
    const doc = oneToMany();
    doc.attributes.push({ id: 'dupe', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: 'c' });
    const sql = generateSql(doc);
    const emailCount = (sql.match(/"email"/g) ?? []).length;
    expect(emailCount).toBe(1);
  });

  it('produces balanced parentheses and semicolons', () => {
    const sql = generateSql(oneToMany());
    expect((sql.match(/\(/g) ?? []).length).toBe((sql.match(/\)/g) ?? []).length);
    expect(sql.trimEnd().endsWith(';')).toBe(true);
  });
});

describe('describeSqlReadiness', () => {
  it('asks for an entity when empty', () => {
    expect(describeSqlReadiness(emptyDocument())).toContain('Add an entity');
  });

  it('asks for a key when there is none', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: 'Thing', x: 0, y: 0, kind: 'strong' });
    expect(describeSqlReadiness(doc)).toContain('key');
  });

  it('reports ready for a complete diagram', () => {
    expect(describeSqlReadiness(oneToMany())).toBe('Ready.');
  });
});
