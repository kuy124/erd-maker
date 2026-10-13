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
  legsFor,
  type ErdDocument,
  type Entity,
  type Leg,
  type Relationship,
} from './types';
import { toSqlName } from './columnNames';
import { attributeType, normalizeDataType, sqlDataType } from './dataTypes';
import { leafAttributesOf } from './attributes';
import { binaryEnds, deriveTables, endpointRows, foreignKeyDirection, type CrowTable, type RelationshipEnd } from './crowfoot';
export { foreignKeyColumnName, toSqlName } from './columnNames';

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

function columnTypeFor(attr: { name: string; dataType?: unknown }): string {
  return sqlDataType(attributeType(attr));
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
  unique?: boolean;
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
      if (parent && parent.id !== entity.id) return { parent, rel };
    }
  }
  return undefined;
}

/** Generate DDL from the same columns and bindings displayed in the table view. */
export function generateSql(doc: ErdDocument, options: SqlOptions = {}): string {
  const dialect = options.dialect ?? 'standard';
  const tables: Table[] = [];
  const crowTables = deriveTables(doc);
  for (const leg of doc.legs.filter((l) => l.columnId)) {
    const rel = doc.relationships.find((r) => r.id === leg.fromId || r.id === leg.toId);
    if (!rel) continue;
    const entityId = otherEnd(leg, rel.id);
    if (!crowTables.find((t) => t.entityId === entityId)?.rows.some((r) => r.id === leg.columnId)) {
      throw new SqlError(`Choose an available connection attribute for ${rel.name}.`);
    }
  }
  const selectedKey = (end: RelationshipEnd, relationshipName: string): Column => {
    const rows = crowTables.find((t) => t.entityId === end.entity.id)!.rows;
    const keys = rows.filter((r) => r.pk);
    const row = end.leg.columnId ? rows.find((r) => r.id === end.leg.columnId) : keys[0];
    if (!row?.pk || keys.length !== 1) {
      throw new SqlError(`${relationshipName}: choose a single-column primary key at ${end.entity.name} for SQL export. A non-key field or one part of a composite key cannot be referenced alone.`);
    }
    return { name: toSqlName(row.name), type: sqlDataType(row.type),
      pk: true, nullable: false };
  };

  for (const entity of doc.entities) {
    const columns: Column[] = [];
    const attrs = leafAttributesOf(doc, entity.id);
    const keyAttrs = attrs.filter((a) => a.kind === 'key');
    const weakParent = weakEntityParent(doc, entity);

    if (weakParent) {
      // A weak entity's primary key is its partial key plus the parent's key.
      const ends = binaryEnds(doc, weakParent.rel.id);
      const source = ends?.find((end) => end.entity.id === entity.id);
      const target = ends?.find((end) => end.entity.id === weakParent.parent.id);
      const bound = source?.leg.columnId || target?.leg.columnId;
      const keys = bound && target ? [selectedKey(target, weakParent.rel.name)] : parentKeyColumns(crowTables, weakParent.parent);
      if (bound && keys.length !== 1) throw new SqlError(`${weakParent.rel.name}: a single connection attribute cannot reference a composite key.`);
      const sourceRow = bound && ends && source ? endpointRows(doc, crowTables, ends)[ends[0].leg.id === source.leg.id ? 0 : 1] : null;
      for (const pk of keys) {
        columns.push({
          name: sourceRow ? toSqlName(sourceRow.name) : pk.name,
          type: pk.type,
          pk: true,
          fk: { table: entityTableName(weakParent.parent), column: pk.name },
          nullable: false,
          unique: source?.leg.cardinality === '1',
        });
      }
    }

    if (keyAttrs.length === 0 && !weakParent) {
      const existingId = attrs.find((attr) => toSqlName(attr.name) === 'id');
      const type = existingId && normalizeDataType(existingId.dataType) ? columnTypeFor(existingId) : surrogateKey(dialect);
      columns.push({ name: 'id', type, pk: true, nullable: false });
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

    for (const rel of doc.relationships) {
      const ends = binaryEnds(doc, rel.id);
      const direction = ends && foreignKeyDirection(doc, ends);
      if (!ends || !direction || direction[0].entity.id !== entity.id || weakParent?.rel.id === rel.id) continue;
      const [source, target] = direction;
      if (!target.leg.columnId && parentKeyColumns(crowTables, target.entity).length !== 1) {
        if (source.leg.columnId) selectedKey(target, rel.name);
        continue;
      }
      const targetCol = selectedKey(target, rel.name);
      const rows = endpointRows(doc, crowTables, ends);
      const sourceRow = rows[ends[0].leg.id === source.leg.id ? 0 : 1];
      const fkName = toSqlName(sourceRow.name);
      const fk = { table: entityTableName(target.entity), column: targetCol.name };
      let column = columns.find((c) => c.name === fkName);
      if (!column) {
        column = { name: fkName, type: targetCol.type, pk: false, nullable: true };
        columns.push(column);
      }
      if (column.fk && (column.fk.table !== fk.table || column.fk.column !== fk.column)) {
        throw new SqlError(`${entity.name}.${sourceRow.name} references different keys. Use a separate attribute for each foreign key.`);
      }
      column.fk = fk;
      column.type = targetCol.type;
      if (target.leg.participation.min >= 1) column.nullable = false;
      if (source.leg.cardinality === '1') column.unique = true;
    }

    if (columns.length === 0) {
      columns.push({ name: 'id', type: surrogateKey(dialect), pk: true, nullable: false });
    }

    tables.push({ name: entityTableName(entity), sourceId: entity.id, columns });
  }

  // Junction tables for many-to-many relationships.
  for (const rel of doc.relationships) {
    if (!isManyToMany(doc, rel)) continue;
    const ends = binaryEnds(doc, rel.id);
    if (!ends) continue;
    const a = ends[0].entity, b = ends[1].entity;
    const aKey = selectedKey(ends[0], rel.name), bKey = selectedKey(ends[1], rel.name);

    const columns: Column[] = [
      {
        name: `${toSqlName(a.name)}_${aKey.name}`,
        type: aKey.type,
        pk: true,
        fk: { table: entityTableName(a), column: aKey.name },
        nullable: false,
      },
      {
        name: `${toSqlName(b.name)}_${bKey.name}${a.id === b.id ? '_2' : ''}`,
        type: bKey.type,
        pk: true,
        fk: { table: entityTableName(b), column: bKey.name },
        nullable: false,
      },
    ];
    // Attributes hanging off the relationship describe the association itself.
    for (const attr of leafAttributesOf(doc, rel.id)) {
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

function parentKeyColumns(tables: CrowTable[], entity: Entity): Column[] {
  return tables.find((table) => table.entityId === entity.id)!.rows.filter((row) => row.pk).map((row) => ({
    name: toSqlName(row.name),
    type: sqlDataType(row.type),
    pk: true,
    nullable: false,
  }));
}

function renderTable(table: Table, dropFirst: boolean): string {
  const lines: string[] = [];
  if (dropFirst) lines.push(`DROP TABLE IF EXISTS ${quote(table.name)};`);

  const body: string[] = [];
  const pkCols = table.columns.filter((c) => c.pk).map((c) => quote(c.name));
  for (const col of table.columns) {
    let def = `  ${quote(col.name)} ${col.type}`;
    if (!col.nullable) def += ' NOT NULL';
    if (col.unique && (!col.pk || pkCols.length > 1)) def += ' UNIQUE';
    body.push(def);
  }

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
  const anyKey = doc.entities.some((e) => leafAttributesOf(doc, e.id).some((a) => a.kind === 'key'));
  if (!anyKey) return 'Mark at least one attribute as a key to get a primary key.';
  try {
    generateSql(doc);
    return 'Ready.';
  } catch (err) {
    return err instanceof SqlError ? err.message : 'Could not generate SQL.';
  }
}
