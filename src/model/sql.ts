/**
 * SQL DDL generation.
 *
 * Walks the same document the canvas renders, so what you see is what you get
 * in the schema. The mapping is the standard textbook one for Chen notation:
 *
 *   - A strong entity becomes a table; its key attributes become the primary key.
 *   - A weak entity borrows the parent's key through its identifying
 *     relationship, so that relationship contributes a foreign key instead of
 *     its own table.
 *   - A many-to-many relationship becomes a junction table carrying both
 *     foreign keys (plus any attributes attached to the relationship).
 *   - A one-to-many relationship adds a foreign key to the "many" side's table
 *     pointing at the "one" side.
 *
 * Cardinality convention: the label on a leg describes the *entity* at that
 * end of the line, which is how Chen diagrams are read. In
 *
 *     Customer --(1)--- places ---(N)-- Order
 *
 * the leg touching Customer carries `1` and the leg touching Order carries `N`.
 * So "the many side" is whichever entity's own leg is not `1`.
 *
 * Names are quoted with double quotes, which is valid in Postgres, SQLite, and
 * standard SQL, so we do not have to guess the target dialect.
 */

import {
  attributesOf,
  legsFor,
  type ErdDocument,
  type Entity,
  type Leg,
  type Relationship,
} from './types';

export interface SqlOptions {
  /** Emit `DROP TABLE IF EXISTS` before each `CREATE TABLE`. */
  dropFirst?: boolean;
  /** Dialect for the auto-increment style of generated surrogate keys. */
  dialect?: 'standard' | 'postgres' | 'mysql' | 'sqlite';
}

export class SqlError extends Error {}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** snake_case, stripped to characters SQL tolerates unquoted. */
export function toSqlName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\s-]+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .toLowerCase();
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

function columnTypeFor(attr: { name: string; kind: string }): string {
  const n = attr.name.toLowerCase();
  if (/(^|_)(id|code|number|num|no)($|_)/.test(n) || /(^|_)id$/.test(n)) return 'INTEGER';
  if (/(date|time|created|updated|at)$/.test(n)) return 'TIMESTAMP';
  if (/(amount|price|total|cost|salary|balance|qty|quantity|count)/.test(n)) return 'NUMERIC';
  if (/(is|has|active|enabled|flag)/.test(n)) return 'BOOLEAN';
  return 'TEXT';
}

function surrogateKey(dialect: SqlOptions['dialect']): string {
  switch (dialect) {
    case 'mysql':
      return 'INT AUTO_INCREMENT';
    case 'sqlite':
      return 'INTEGER';
    case 'postgres':
      return 'SERIAL';
    default:
      return 'INTEGER';
  }
}

function findRelationship(doc: ErdDocument, id: string): Relationship | undefined {
  return doc.relationships.find((r) => r.id === id);
}

function findEntity(doc: ErdDocument, id: string): Entity | undefined {
  return doc.entities.find((e) => e.id === id);
}

/** The node at the far end of a leg from `nodeId`. */
function otherEnd(leg: Leg, nodeId: string): string {
  return leg.fromId === nodeId ? leg.toId : leg.fromId;
}

interface Column {
  name: string;
  type: string;
  pk: boolean;
  fk?: { table: string; column: string };
  nullable: boolean;
}

interface Table {
  name: string;
  sourceId: string;
  columns: Column[];
}

/**
 * A relationship is many-to-many when both of its entity legs are non-`1`, so
 * neither entity can carry the foreign key and the association needs its own
 * table.
 */
function isManyToMany(doc: ErdDocument, rel: Relationship): boolean {
  const entityLegs = legsFor(doc, rel.id).filter((l) => Boolean(findEntity(doc, otherEnd(l, rel.id))));
  if (entityLegs.length !== 2) return false;
  return entityLegs.every((l) => l.cardinality !== '1');
}

function entityTableName(entity: Entity): string {
  return toSqlName(entity.name);
}

/**
 * The parent entity of a weak entity.
 *
 * In Chen notation the weak entity connects to the identifying relationship
 * diamond, not to the parent entity directly, so this walks the two hops:
 * weak entity -> identifying relationship -> owning entity.
 */
function weakEntityParent(
  doc: ErdDocument,
  entity: Entity,
): { parent: Entity; rel: Relationship } | undefined {
  if (entity.kind !== 'weak') return undefined;
  for (const leg of legsFor(doc, entity.id)) {
    const rel = findRelationship(doc, otherEnd(leg, entity.id));
    if (!rel || rel.kind !== 'weak') continue;
    for (const relLeg of legsFor(doc, rel.id)) {
      if (relLeg.id === leg.id) continue;
      const parent = findEntity(doc, otherEnd(relLeg, rel.id));
      if (parent) return { parent, rel };
    }
  }
  return undefined;
}

/**
 * Entities this entity must reference: for each relationship where this entity
 * sits on the many side, the entity on the one side owns the referenced key.
 */
function foreignKeyTargets(doc: ErdDocument, entity: Entity): Entity[] {
  if (entity.kind === 'weak') return []; // handled by weakEntityParent
  const targets: Entity[] = [];
  for (const leg of legsFor(doc, entity.id)) {
    const rel = findRelationship(doc, otherEnd(leg, entity.id));
    if (!rel) continue;
    const relLegs = legsFor(doc, rel.id);
    if (relLegs.length !== 2) continue;
    const sibling = relLegs.find((l) => l.id !== leg.id);
    if (!sibling) continue;
    const otherEntity = findEntity(doc, otherEnd(sibling, rel.id));
    if (!otherEntity) continue;
    // This entity's own label is leg.cardinality; the far entity's is the sibling's.
    if (leg.cardinality !== '1' && sibling.cardinality === '1') {
      targets.push(otherEntity);
    }
  }
  return targets;
}

export function generateSql(doc: ErdDocument, options: SqlOptions = {}): string {
  const dialect = options.dialect ?? 'standard';
  const tables: Table[] = [];

  for (const entity of doc.entities) {
    const columns: Column[] = [];
    const attrs = attributesOf(doc, entity.id).filter((a) => a.kind !== 'derived');
    const keyAttrs = attrs.filter((a) => a.kind === 'key');
    const weakParent = weakEntityParent(doc, entity);

    if (weakParent) {
      // A weak entity's primary key is its partial key plus the parent's key.
      for (const pk of parentKeyColumns(doc, weakParent.parent)) {
        columns.push({
          name: pk.name,
          type: pk.type,
          pk: true,
          fk: { table: entityTableName(weakParent.parent), column: pk.name },
          nullable: false,
        });
      }
    }

    if (keyAttrs.length === 0 && !weakParent) {
      columns.push({ name: 'id', type: surrogateKey(dialect), pk: true, nullable: false });
    }

    for (const attr of attrs) {
      const name = toSqlName(attr.name);
      if (columns.some((c) => c.name === name)) continue;
      columns.push({
        name,
        type: columnTypeFor(attr),
        pk: attr.kind === 'key',
        nullable: attr.kind !== 'key',
      });
    }

    // Foreign keys for one-to-many relationships where this entity is the many side.
    for (const target of foreignKeyTargets(doc, entity)) {
      const targetCols = parentKeyColumns(doc, target);
      if (targetCols.length !== 1) continue; // composite targets are out of scope
      const targetCol = targetCols[0]!;
      const fkName = `${toSqlName(target.name)}_${targetCol.name}`;
      if (columns.some((c) => c.name === fkName)) continue;
      columns.push({
        name: fkName,
        type: targetCol.type,
        pk: false,
        fk: { table: entityTableName(target), column: targetCol.name },
        nullable: true,
      });
    }

    if (columns.length === 0) {
      columns.push({ name: 'id', type: surrogateKey(dialect), pk: true, nullable: false });
    }

    tables.push({ name: entityTableName(entity), sourceId: entity.id, columns });
  }

  // Junction tables for many-to-many relationships.
  for (const rel of doc.relationships) {
    if (!isManyToMany(doc, rel)) continue;
    const entityEnds = legsFor(doc, rel.id)
      .map((l) => findEntity(doc, otherEnd(l, rel.id)))
      .filter((e): e is Entity => Boolean(e));
    if (entityEnds.length !== 2) continue;

    const a = entityEnds[0]!;
    const b = entityEnds[1]!;
    const aKey = parentKeyColumns(doc, a)[0];
    const bKey = parentKeyColumns(doc, b)[0];
    if (!aKey || !bKey) continue;

    const columns: Column[] = [
      {
        name: `${toSqlName(a.name)}_${aKey.name}`,
        type: aKey.type,
        pk: true,
        fk: { table: entityTableName(a), column: aKey.name },
        nullable: false,
      },
      {
        name: `${toSqlName(b.name)}_${bKey.name}`,
        type: bKey.type,
        pk: true,
        fk: { table: entityTableName(b), column: bKey.name },
        nullable: false,
      },
    ];
    // Attributes hanging off the relationship describe the association itself.
    for (const attr of attributesOf(doc, rel.id).filter((x) => x.kind !== 'derived')) {
      const name = toSqlName(attr.name);
      if (columns.some((c) => c.name === name)) continue;
      columns.push({ name, type: columnTypeFor(attr), pk: false, nullable: true });
    }
    tables.push({ name: toSqlName(rel.name), sourceId: rel.id, columns });
  }

  if (tables.length === 0) {
    return '-- Nothing to generate yet. Add an entity with a key attribute.';
  }

  return tables.map((t) => renderTable(t, options.dropFirst ?? false)).join('\n\n') + '\n';
}

function parentKeyColumns(doc: ErdDocument, entity: Entity): Column[] {
  const keyAttrs = attributesOf(doc, entity.id).filter((a) => a.kind === 'key');
  if (keyAttrs.length > 0) {
    return keyAttrs.map((a) => ({
      name: toSqlName(a.name),
      type: columnTypeFor(a),
      pk: true,
      nullable: false,
    }));
  }
  return [{ name: 'id', type: 'INTEGER', pk: true, nullable: false }];
}

function renderTable(table: Table, dropFirst: boolean): string {
  const lines: string[] = [];
  if (dropFirst) lines.push(`DROP TABLE IF EXISTS ${quote(table.name)};`);

  const body: string[] = [];
  for (const col of table.columns) {
    let def = `  ${quote(col.name)} ${col.type}`;
    if (!col.nullable) def += ' NOT NULL';
    body.push(def);
  }

  const pkCols = table.columns.filter((c) => c.pk).map((c) => quote(c.name));
  if (pkCols.length > 0) body.push(`  PRIMARY KEY (${pkCols.join(', ')})`);

  for (const col of table.columns) {
    if (!col.fk) continue;
    body.push(
      `  FOREIGN KEY (${quote(col.name)}) REFERENCES ${quote(col.fk.table)} (${quote(col.fk.column)})`,
    );
  }

  lines.push(`CREATE TABLE ${quote(table.name)} (`);
  lines.push(body.join(',\n'));
  lines.push(');');
  return lines.join('\n');
}

/** Convenience used by the UI to explain why an export would be empty. */
export function describeSqlReadiness(doc: ErdDocument): string {
  if (doc.entities.length === 0) return 'Add an entity to generate SQL.';
  const anyKey = doc.entities.some((e) => attributesOf(doc, e.id).some((a) => a.kind === 'key'));
  if (!anyKey) return 'Mark at least one attribute as a key to get a primary key.';
  try {
    generateSql(doc);
    return 'Ready.';
  } catch (err) {
    return err instanceof SqlError ? err.message : 'Could not generate SQL.';
  }
}
