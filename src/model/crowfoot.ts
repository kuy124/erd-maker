import { attributesOf, legsFor, type ErdDocument, type Entity, type Leg } from './types';
import { foreignKeyColumnName, toSqlName } from './columnNames';
import { attributeType } from './dataTypes';

export interface CrowTable {
  entityId: string;
  name: string;
  x: number;
  y: number;
  weak: boolean;
  rows: CrowRow[];
  /**
   * Rendered width, which grows with the longest text so nothing is truncated.
   *
   * Previously a fixed 280 clipped long column names to an ellipsis, which made
   * two tables with the same column indistinguishable — the one thing a schema
   * cannot afford.
   */
  width: number;
}

/**
 * Rough advance width per character, used to size a table to its contents.
 *
 * Deliberately estimates wide. An over-wide table reads as generous spacing; an
 * under-wide one clips the text, and `measureLabel` in NodeShapes already
 * relies on the same trade.
 */
const CHAR_SANS = 7.0;
const CHAR_SANS_BOLD = 7.4;
const CHAR_MONO = 8.0;
/** Left edge of a row's name; the type is anchored to the right edge. */
export const CROW_NAME_X = 46;
/** Gap between the longest text and the table border, each side. */
const CROW_GUTTER = 12;

/** Width that fits the table's own title and every row's name and type. */
function widthFor(name: string, weak: boolean, rows: CrowRow[]): number {
  const title = name + (weak ? ' (weak)' : '');
  let needed = CROW_GUTTER * 2 + title.length * CHAR_SANS_BOLD;
  for (const row of rows) {
    needed = Math.max(needed,
      CROW_NAME_X + row.name.length * CHAR_SANS + CROW_GUTTER + row.type.length * CHAR_MONO + CROW_GUTTER);
  }
  return Math.max(CROW_WIDTH, Math.ceil(needed));
}



export interface CrowRow {
  /** Stable across renaming, moving, and changes to row order. */
  id: string;
  attributeId: string | null;
  name: string;
  pk: boolean;
  fk: boolean;
  references?: { entityId: string; columnId: string; label: string };
  type: string;
  generatedKey?: boolean;
}

export interface ColumnEndpoint { entityId: string; columnId: string }
export interface RelationshipEnd { entity: Entity; leg: Leg }

export interface CrowLink {
  id: string;
  relId: string;
  fromEntityId: string;
  toEntityId: string;
  fromColumnId: string;
  toColumnId: string;
  manyEntityId: string;
  oneEntityId: string;
  label: string;
  ratio: string;
  fromMandatory: boolean;
  toMandatory: boolean;
  fromMany: boolean;
  toMany: boolean;
  lane: number;
}

function baseRows(doc: ErdDocument, entity: Entity): CrowRow[] {
  const attrs = attributesOf(doc, entity.id).filter((a) => a.kind !== 'derived');
  const rows: CrowRow[] = attrs.filter((a) => a.kind === 'key').concat(attrs.filter((a) => a.kind !== 'key'))
    .map((a) => ({ id: 'attribute:' + a.id, attributeId: a.id, name: a.name,
      pk: a.kind === 'key', fk: false, type: attributeType(a) }));
  if (!rows.some((r) => r.pk)) {
    const existingId = rows.find((r) => toSqlName(r.name) === 'id');
    if (existingId) { existingId.pk = true; existingId.generatedKey = true; }
    else rows.unshift({ id: 'key:' + entity.id, attributeId: null, name: 'id', pk: true, fk: false, type: 'INT' });
  }
  // Match SQL's name normalization, retaining the actual attribute when an FK shares its name.
  return rows.filter((row, index) => rows.findIndex((r) => toSqlName(r.name) === toSqlName(row.name)) === index);
}

/** Keep unfinished and multi-entity relationships in the model, outside this binary view. */
export function binaryEnds(doc: ErdDocument, relationshipId: string): [RelationshipEnd, RelationshipEnd] | null {
  const legs = legsFor(doc, relationshipId);
  if (legs.length !== 2) return null;
  const ends = legs.map((leg) => ({ leg,
    entity: doc.entities.find((e) => e.id === (leg.fromId === relationshipId ? leg.toId : leg.fromId)) }));
  if (!ends[0]?.entity || !ends[1]?.entity) return null;
  return [ends[0] as RelationshipEnd, ends[1] as RelationshipEnd];
}

/** Return the referencing end followed by the referenced end. */
export function foreignKeyDirection(doc: ErdDocument, [a, b]: [RelationshipEnd, RelationshipEnd]): [RelationshipEnd, RelationshipEnd] | null {
  const identifying = doc.relationships.some((r) => r.kind === 'weak' &&
    (r.id === a.leg.fromId || r.id === a.leg.toId) && (r.id === b.leg.fromId || r.id === b.leg.toId));
  if (identifying && a.entity.kind !== b.entity.kind) return a.entity.kind === 'weak' ? [a, b] : [b, a];
  if (a.leg.cardinality !== '1' && b.leg.cardinality === '1') return [a, b];
  if (b.leg.cardinality !== '1' && a.leg.cardinality === '1') return [b, a];
  if (a.leg.cardinality !== '1' || b.leg.cardinality !== '1' || (!a.leg.columnId && !b.leg.columnId)) return null;
  // Explicit one-to-one bindings use the non-key field as the FK; two keys use the second end.
  const isKey = (end: RelationshipEnd) => baseRows(doc, end.entity).find((r) => r.id === end.leg.columnId)?.pk;
  return isKey(b) && !isKey(a) ? [a, b] : [b, a];
}

/**
 * Where this browser has put each table.
 *
 * Deliberately not in the document, and deliberately not the entity's Chen
 * position. Placement is a local reading of the schema: it belongs to the
 * person looking, it is not part of what is being agreed on, and it must not
 * leak sideways from one notation into the other. Everything that *is* the
 * schema — attributes, keys, types, relationships — still travels.
 */
export type CrowLayout = Map<string, { x: number; y: number }>;

const CROW_LAYOUT_KEY = 'erd:crow:';

/** Reads this browser's table positions for a room. Never throws. */
export function loadCrowLayout(room: string): CrowLayout {
  try {
    const raw = localStorage.getItem(CROW_LAYOUT_KEY + room);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const layout: CrowLayout = new Map();
    for (const [id, value] of Object.entries(parsed)) {
      const point = Array.isArray(value) ? value : null;
      if (point && typeof point[0] === 'number' && typeof point[1] === 'number') {
        layout.set(id, { x: point[0], y: point[1] });
      }
    }
    return layout;
  } catch {
    return new Map();
  }
}

/** Stores this browser's table positions for a room. Never throws. */
export function saveCrowLayout(room: string, layout: CrowLayout): void {
  try {
    const plain: Record<string, [number, number]> = {};
    for (const [id, point] of layout) plain[id] = [Math.round(point.x), Math.round(point.y)];
    localStorage.setItem(CROW_LAYOUT_KEY + room, JSON.stringify(plain));
  } catch {
    // A full or disabled store costs the user their layout, not their diagram.
  }
}

/**
 * The document as this browser's table layout shows it.
 *
 * Everything downstream — tables, links, `occupiedBoxes`, framing, and
 * new-shape placement — already takes a document, so applying the layout in one
 * place keeps the local positions out of the shared document without any of
 * those functions needing to know it exists.
 */
export function withCrowLayout(doc: ErdDocument, layout: CrowLayout | null): ErdDocument {
  if (!layout || layout.size === 0) return doc;
  let changed = false;
  const entities = doc.entities.map((entity) => {
    const at = layout.get(entity.id);
    if (!at) return entity;
    changed = true;
    return { ...entity, x: at.x, y: at.y };
  });
  return changed ? { ...doc, entities } : doc;
}

/**
 * Every entity's editable columns, plus foreign keys inferred from its relationships.
 *
 * Positions come from whichever document is passed in, so the same function
 * serves the shared Chen layout and this browser's Crow's-foot one.
 */
export function deriveTables(doc: ErdDocument): CrowTable[] {
  const tables = doc.entities.map((entity) => ({ entityId: entity.id, name: entity.name,
    x: entity.x, y: entity.y, weak: entity.kind === 'weak', width: CROW_WIDTH, rows: baseRows(doc, entity) }));
  const byId = new Map(tables.map((t) => [t.entityId, t]));
  // Inherited keys must exist before another table can reference the weak entity.
  for (const rel of [...doc.relationships].sort((a, b) => Number(b.kind === 'weak') - Number(a.kind === 'weak'))) {
    const ends = binaryEnds(doc, rel.id);
    const direction = ends && foreignKeyDirection(doc, ends);
    if (!direction) continue;
    const [source, target] = direction;
    const identifying = source.entity.kind === 'weak' && rel.kind === 'weak' && source.entity.id !== target.entity.id;
    const sourceTable = byId.get(source.entity.id)!;
    const targetTable = byId.get(target.entity.id)!;
    if (identifying) {
      sourceTable.rows = sourceTable.rows.filter((r) => r.id !== 'key:' + source.entity.id);
      for (const row of sourceTable.rows) {
        if (row.generatedKey) { row.pk = false; delete row.generatedKey; }
      }
    }
    const selectedTarget = targetTable.rows.find((r) => r.id === target.leg.columnId);
    const keys = selectedTarget ? [selectedTarget] : targetTable.rows.filter((r) => r.pk);
    for (const key of keys) {
      const name = identifying ? toSqlName(key.name) : foreignKeyColumnName(toSqlName(target.entity.name), toSqlName(key.name));
      const id = 'foreign:' + target.entity.id + ':' + key.id;
      let row = sourceTable.rows.find((r) => r.id === source.leg.columnId);
      row ??= sourceTable.rows.find((r) => toSqlName(r.name) === name);
      if (!row) {
        row = { id, attributeId: null, name, pk: false, fk: false, type: key.type };
        sourceTable.rows.push(row);
      }
      row.fk = true;
      if (identifying) row.pk = true;
      row.type = key.type;
      row.references = { entityId: target.entity.id, columnId: key.id, label: target.entity.name + '.' + key.name };
    }
  }
  // A referenced key can itself be an FK processed later. Resolve types only
  // after every reference exists; the row bound also terminates cyclic models.
  const rows = tables.flatMap((table) => table.rows);
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (const row of rows) {
      if (!row.references) continue;
      const target = byId.get(row.references.entityId)?.rows.find((r) => r.id === row.references!.columnId);
      if (target && row.type !== target.type) { row.type = target.type; changed = true; }
    }
    if (!changed) break;
  }
  // Sized last: foreign-key rows are appended above, and a table that measured
  // itself before them would still truncate the names it gained.
  for (const table of tables) table.width = widthFor(table.name, table.weak, table.rows);
  return tables;
}

/** Explicit selections win; older diagrams automatically use their key/FK rows. */
export function endpointRows(doc: ErdDocument, tables: CrowTable[], ends: [RelationshipEnd, RelationshipEnd]): [CrowRow, CrowRow] {
  const [a, b] = ends;
  const aTable = tables.find((t) => t.entityId === a.entity.id)!;
  const bTable = tables.find((t) => t.entityId === b.entity.id)!;
  const key = (t: CrowTable) => t.rows.find((r) => r.pk) ?? t.rows[0]!;
  let aRow = aTable.rows.find((r) => r.id === a.leg.columnId) ?? key(aTable);
  let bRow = bTable.rows.find((r) => r.id === b.leg.columnId) ?? key(bTable);
  const direction = foreignKeyDirection(doc, ends);
  if (direction?.[0].leg.id === a.leg.id && !a.leg.columnId) {
    aRow = aTable.rows.find((r) => r.references?.entityId === b.entity.id && r.references.columnId === bRow.id) ?? aRow;
  } else if (direction?.[0].leg.id === b.leg.id && !b.leg.columnId) {
    bRow = bTable.rows.find((r) => r.references?.entityId === a.entity.id && r.references.columnId === aRow.id) ?? bRow;
  }
  return [aRow, bRow];
}

export function deriveLinks(doc: ErdDocument): CrowLink[] {
  const links: CrowLink[] = [];
  const lanes = new Map<string, number>();
  const tables = deriveTables(doc);
  for (const rel of doc.relationships) {
    const ends = binaryEnds(doc, rel.id);
    if (!ends) continue;
    const [a, b] = ends;
    const [aRow, bRow] = endpointRows(doc, tables, ends);
    const aMany = a.leg.cardinality !== '1';
    const bMany = b.leg.cardinality !== '1';
    const pair = [a.entity.id, b.entity.id].sort().join('|');
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    const link: CrowLink = {
      id: rel.id, relId: rel.id, fromEntityId: a.entity.id, toEntityId: b.entity.id,
      fromColumnId: aRow.id, toColumnId: bRow.id,
      manyEntityId: aMany ? a.entity.id : b.entity.id, oneEntityId: aMany ? b.entity.id : a.entity.id,
      label: rel.name, ratio: `${a.leg.cardinality}:${b.leg.cardinality}`,
      fromMandatory: a.leg.participation.min >= 1, toMandatory: b.leg.participation.min >= 1,
      fromMany: aMany, toMany: bMany, lane,
    };
    links.push(link);
    // Preserve the existing helper contract; the renderer draws the relationship once.
    if (aMany && bMany) links.push({ ...link, id: `${rel.id}:reverse`,
      fromEntityId: b.entity.id, toEntityId: a.entity.id, fromColumnId: bRow.id, toColumnId: aRow.id,
      manyEntityId: b.entity.id, oneEntityId: a.entity.id, ratio: `${b.leg.cardinality}:${a.leg.cardinality}`,
      fromMandatory: link.toMandatory, toMandatory: link.fromMandatory });
  }
  return links;
}

export const CROW_ROW_HEIGHT = 44;
export const CROW_HEADER_HEIGHT = 44;
export const CROW_WIDTH = 280;

export function tableHeight(table: CrowTable): number {
  return CROW_HEADER_HEIGHT + Math.max(table.rows.length, 1) * CROW_ROW_HEIGHT;
}

export function rowCenter(table: CrowTable, columnId: string): number {
  const index = Math.max(0, table.rows.findIndex((r) => r.id === columnId));
  return table.y + CROW_HEADER_HEIGHT + (index + 0.5) * CROW_ROW_HEIGHT;
}

/** A rectangle a connector must not be drawn through. */
export interface Obstacle { minX: number; minY: number; maxX: number; maxY: number }

interface Point { x: number; y: number }

/** Emits the orthogonal SVG path this router works in. */
function polyline(points: Point[]): string {
  const [first, ...rest] = points;
  if (!first) return '';
  return rest.map((point, index) => {
    const previous = points[index]!;
    return `${point.y === previous.y ? 'H' : 'V'}${point.x} ${point.y}`;
  }).join(' ').replace(/^/, `M${first.x} ${first.y} `);
}

/** Horizontal run that leaves a row, kept clear of the table it comes from. */
const EXIT_STUB = 36;
/** Clearance above or below the drawing for a detour. */
const DETOUR_CLEARANCE = 24;

/** True when a straight segment passes through the interior of a box. */
function crossesObstacle(a: Point, b: Point, rect: Obstacle): boolean {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  // Strictly inside, so leaving from a table's own edge counts as clear.
  return x2 > rect.minX + 1 && x1 < rect.maxX - 1 && y2 > rect.minY + 1 && y1 < rect.maxY - 1;
}

/** The drawn shape of a table, for routing around it. */
export function tableObstacle(table: CrowTable): Obstacle {
  return { minX: table.x, minY: table.y, maxX: table.x + table.width, maxY: table.y + tableHeight(table) };
}

/**
 * Routes an orthogonal connector from one row to another.
 *
 * The direct route is tried first and is what most diagrams get: leave the row,
 * turn in the gap, arrive. It is kept only when it is actually clear.
 *
 * When tables sit close enough that the gap is smaller than the stub, or a third
 * table is in the way, the connector detours through a channel above or below
 * the whole drawing instead of crossing a table body. A line drawn over a table
 * hides the rows under it, which is worse than an awkward detour, and this was
 * measurable rather than theoretical: at a 60px gap the old route went straight
 * through the neighbour.
 *
 * `lane` separates connectors that share the same pair of tables, so three
 * relationships between two entities read as three lines rather than one.
 */
export function routeColumns(
  from: CrowTable,
  fromColumnId: string,
  to: CrowTable,
  toColumnId: string,
  lane = 0,
  obstacles: Obstacle[] = [],
) {
  const ay = rowCenter(from, fromColumnId), by = rowCenter(to, toColumnId);
  const span = Math.max(from.width, to.width);
  const gapRight = to.x - from.x - span;
  const gapLeft = from.x - to.x - span;
  const facing = Math.max(gapRight, gapLeft) >= EXIT_STUB + 44;
  const fromRight = facing ? gapRight >= gapLeft : to.x >= from.x;
  const toRight = facing ? !fromRight : fromRight;
  const a = { x: from.x + (fromRight ? from.width : 0), y: ay };
  const b = { x: to.x + (toRight ? to.width : 0), y: by };

  // The direct route, plus the jog used to fan out parallel connectors.
  const bendX = facing ? (a.x + b.x) / 2 + lane * 12 :
    fromRight ? Math.max(a.x, b.x) + 48 + lane * 16 : Math.min(a.x, b.x) - 48 - lane * 16;
  const jogY = facing && lane > 0 ? Math.min(ay, by) - lane * 44 : ay;
  const direct = jogY === ay
    ? [a, { x: bendX, y: ay }, { x: bendX, y: by }, b]
    : [a, { x: a.x + (fromRight ? EXIT_STUB : -EXIT_STUB), y: ay },
      { x: a.x + (fromRight ? EXIT_STUB : -EXIT_STUB), y: jogY },
      { x: b.x + (toRight ? EXIT_STUB : -EXIT_STUB), y: jogY },
      { x: b.x + (toRight ? EXIT_STUB : -EXIT_STUB), y: by }, b];

  const directPath = polyline(direct);
  const clear = obstacles.every((rect) =>
    direct.slice(1).every((point, index) => !crossesObstacle(direct[index]!, point, rect)));

  if (clear || obstacles.length === 0) {
    const label = { x: facing ? (a.x + b.x) / 2 : bendX + (fromRight ? 12 : -12),
      y: jogY !== ay || ay === by ? jogY - 20 : (ay + by) / 2 - (facing ? 0 : lane * 32) };
    return { a, b, aToward: { x: a.x + (fromRight ? 30 : -30), y: ay },
      bToward: { x: b.x + (toRight ? 30 : -30), y: by },
      path: directPath, label, labelAnchor: facing ? 'middle' as const : fromRight ? 'start' as const : 'end' as const,
      bounds: { minX: Math.min(a.x, b.x, bendX), maxX: Math.max(a.x, b.x, bendX),
        minY: Math.min(ay, by, jogY), maxY: Math.max(ay, by) } };
  }

  // Detour through a clear channel above or below everything, whichever is
  // closer. The lane shifts the channel so parallel connectors do not coincide.
  const above = Math.min(...obstacles.map((rect) => rect.minY)) - DETOUR_CLEARANCE - lane * 20;
  const below = Math.max(...obstacles.map((rect) => rect.maxY)) + DETOUR_CLEARANCE + lane * 20;
  const cost = (channel: number) => Math.abs(channel - ay) + Math.abs(channel - by);
  const channel = cost(above) <= cost(below) ? above : below;
  const path = polyline([a, { x: a.x, y: channel }, { x: b.x, y: channel }, b]);
  return {
    a, b,
    aToward: { x: a.x + (fromRight ? 30 : -30), y: ay },
    bToward: { x: b.x + (toRight ? 30 : -30), y: by },
    path,
    label: { x: (a.x + b.x) / 2, y: channel + (channel < Math.min(ay, by) ? -12 : 16) },
    labelAnchor: 'middle' as const,
    bounds: { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minY: Math.min(ay, by, channel), maxY: Math.max(ay, by, channel) },
  };
}
