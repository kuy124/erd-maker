/**
 * Crow's-foot derivation.
 *
 * The second notation is a *view* over the same document, not a second model.
 * That is the payoff of the data model decided at the start: entities become
 * tables, key attributes become the primary key, and relationship legs become
 * foreign keys, all using the same cardinality convention as the SQL
 * generator. Nothing here can disagree with the Chen view because both read
 * the same nodes.
 *
 * A crow's-foot connector is drawn at the "many" end of a relationship, which
 * in Chen terms is whichever entity's own leg is not `1`.
 */

import { attributesOf, legsFor, type ErdDocument, type Entity } from './types';
import { foreignKeyColumnName } from './sql';

export interface CrowTable {
  entityId: string;
  name: string;
  x: number;
  y: number;
  weak: boolean;
  rows: CrowRow[];
}

export interface CrowRow {
  /** The attribute this row came from, or null for a synthesised surrogate key. */
  attributeId: string | null;
  name: string;
  pk: boolean;
  fk: boolean;
  /** Table this row references, when it is a foreign key. */
  references?: { entityId: string; label: string };
  type: string;
}

export interface CrowLink {
  id: string;
  /** The relationship this connector came from, so it can be selected and removed. */
  relId: string;
  fromEntityId: string;
  toEntityId: string;
  /** Which end is the "many" side, so the crow's foot goes on the right table. */
  manyEntityId: string;
  oneEntityId: string;
  label: string;
  /**
   * The ratio written on the connector, in the form crow's-foot notation uses:
   * `1:1`, `1:N`, or `N:N`. Naming the ratio is what makes the notation
   * readable at a glance — a bare fan at each end says how many without saying
   * which is which.
   */
  ratio: string;
  /** Whether each end is mandatory, which adds a second bar near the table. */
  fromMandatory: boolean;
  toMandatory: boolean;
  fromMany: boolean;
  toMany: boolean;
}

function typeFor(name: string): string {
  const n = name.toLowerCase();
  if (/(^|_)(id|code|number|num|no)($|_)/.test(n) || /(^|_)id$/.test(n)) return 'INT';
  if (/(date|time|created|updated|at)$/.test(n)) return 'TIMESTAMP';
  if (/(amount|price|total|cost|qty|quantity|count)/.test(n)) return 'NUMERIC';
  if (/(is|has|active|enabled|flag)/.test(n)) return 'BOOL';
  return 'TEXT';
}

function keyRows(doc: ErdDocument, entity: Entity): CrowRow[] {
  const keys = attributesOf(doc, entity.id).filter((a) => a.kind === 'key');
  if (keys.length > 0) {
    return keys.map((a) => ({
      attributeId: a.id,
      name: a.name,
      pk: true,
      fk: false,
      type: typeFor(a.name),
    }));
  }
  return [{ attributeId: null, name: 'id', pk: true, fk: false, type: 'INT' }];
}

/** Every entity as a table, with keys, foreign keys, and plain columns. */
export function deriveTables(doc: ErdDocument): CrowTable[] {
  return doc.entities.map((entity) => {
    const rows: CrowRow[] = [];
    const seen = new Set<string>();

    // Foreign keys first, the way most tools render them.
    if (entity.kind !== 'weak') {
      for (const leg of legsFor(doc, entity.id)) {
        const relId = leg.fromId === entity.id ? leg.toId : leg.fromId;
        const rel = doc.relationships.find((r) => r.id === relId);
        if (!rel) continue;
        const relLegs = legsFor(doc, rel.id);
        if (relLegs.length !== 2) continue;
        const sibling = relLegs.find((l) => l.id !== leg.id);
        if (!sibling) continue;
        const otherId = sibling.fromId === rel.id ? sibling.toId : sibling.fromId;
        const other = doc.entities.find((e) => e.id === otherId);
        if (!other) continue;
        // This entity is the many side; the one side is referenced.
        if (leg.cardinality === '1' || sibling.cardinality !== '1') continue;
        for (const key of keyRows(doc, other)) {
          // Shares the SQL generator's rule so a key already named after its
          // table is not doubled into `customer_customer_id`.
          const name = foreignKeyColumnName(
            other.name.toLowerCase().replace(/\s+/g, '_'),
            key.name,
          );
          if (seen.has(name)) continue;
          seen.add(name);
          rows.push({
            attributeId: null,
            name,
            pk: false,
            fk: true,
            references: { entityId: other.id, label: `${other.name}.${key.name}` },
            type: key.type,
          });
        }
      }
    }

    for (const key of keyRows(doc, entity)) {
      if (seen.has(key.name)) continue;
      seen.add(key.name);
      rows.push(key);
    }

    for (const attr of attributesOf(doc, entity.id)) {
      if (attr.kind === 'key' || attr.kind === 'derived') continue;
      const name = attr.name;
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({ attributeId: attr.id, name, pk: false, fk: false, type: typeFor(name) });
    }

    return {
      entityId: entity.id,
      name: entity.name,
      x: entity.x,
      y: entity.y,
      weak: entity.kind === 'weak',
      rows,
    };
  });
}

/**
 * One link per relationship between two entities. Junctions (many-to-many) are
 * drawn as links too, but the table view shows them without a junction table
 * because the crow's-foot notation expresses the association directly.
 */
export function deriveLinks(doc: ErdDocument): CrowLink[] {
  const links: CrowLink[] = [];
  for (const rel of doc.relationships) {
    const relLegs = legsFor(doc, rel.id);
    if (relLegs.length !== 2) continue;
    const ends = relLegs.map((l) => {
      const otherId = l.fromId === rel.id ? l.toId : l.fromId;
      const entity = doc.entities.find((e) => e.id === otherId);
      return { leg: l, entity };
    });
    const [a, b] = ends;
    if (!a?.entity || !b?.entity) continue;

    // The many side is whichever leg is not labelled `1`. When both are many
    // it is many-to-many, and the foot is drawn at both ends.
    const aMany = a.leg.cardinality !== '1';
    const bMany = b.leg.cardinality !== '1';
    // Participation decides whether an end is drawn mandatory: a minimum of one
    // means every instance has to take part, which is a second bar.
    const aMandatory = a.leg.participation.min >= 1;
    const bMandatory = b.leg.participation.min >= 1;

    // A leg's label describes the shape at its own end, so the ratio reads from
    // the same end as the foot.
    const ratio = `${a.leg.cardinality}:${b.leg.cardinality}`;

    links.push({
      id: rel.id,
      relId: rel.id,
      fromEntityId: a.entity.id,
      toEntityId: b.entity.id,
      manyEntityId: aMany ? a.entity.id : b.entity.id,
      oneEntityId: aMany ? b.entity.id : a.entity.id,
      label: rel.name,
      ratio,
      fromMandatory: aMandatory,
      toMandatory: bMandatory,
      fromMany: aMany,
      toMany: bMany,
    });
    if (aMany && bMany) {
      links.push({
        id: `${rel.id}:reverse`,
        relId: rel.id,
        fromEntityId: b.entity.id,
        toEntityId: a.entity.id,
        manyEntityId: b.entity.id,
        oneEntityId: a.entity.id,
        label: rel.name,
        // Reversed, so the ratio reads from the other end.
        ratio: `${b.leg.cardinality}:${a.leg.cardinality}`,
        fromMandatory: bMandatory,
        toMandatory: aMandatory,
        fromMany: bMany,
        toMany: aMany,
      });
    }
  }
  return links;
}

/** Height of a rendered table, used for connector trimming and layout. */
export const CROW_ROW_HEIGHT = 44;
export const CROW_HEADER_HEIGHT = 44;
export const CROW_WIDTH = 280;

export function tableHeight(table: CrowTable): number {
  return CROW_HEADER_HEIGHT + Math.max(table.rows.length, 1) * CROW_ROW_HEIGHT;
}
