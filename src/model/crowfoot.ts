import { legsFor, type ErdDocument, type Entity, type Leg, type RouteSide } from './types';
import { foreignKeyColumnName, toSqlName } from './columnNames';
import { attributeType } from './dataTypes';
import { leafAttributesOf } from './attributes';
import { ENDPOINT_STUB, findSafeRoute, isRouteSafe, normalizeRoutePoints, simplifyRoute, type RoutePoint } from './connectorRouting';

export interface CrowTable {
  entityId: string;
  name: string;
  x: number;
  y: number;
  weak: boolean;
  associative?: boolean;
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
/**
 * Left edge of a row's name.
 *
 * Clear of the PK/FK badge on one line. This was 46 when a generated key also
 * drew "gen" underneath, which pushed every name right for the sake of a marker
 * that has since gone.
 */
export const CROW_NAME_X = 34;
/** Gap between the longest text and the table border, each side. */
const CROW_GUTTER = 12;

/** Width that fits the table's own title and every row's name and type. */
function widthFor(name: string, weak: boolean, rows: CrowRow[], associative = false): number {
  const title = name + (weak ? ' (weak)' : associative ? ' (associative)' : '');
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
  references?: { entityId: string; columnId: string; label: string; relationshipIds?: string[] };
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
  /** Which side this connector detours to, when it has to detour at all. */
  route: RouteSide;
  /** A corner the person dragged. Absent means the router still decides. */
  bend?: { x: number; y: number };
  routePoints?: RoutePoint[];
}

function baseRows(doc: ErdDocument, entity: Entity): CrowRow[] {
  const attrs = leafAttributesOf(doc, entity.id);
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
  if (identifying && (a.entity.kind === 'weak') !== (b.entity.kind === 'weak')) return a.entity.kind === 'weak' ? [a, b] : [b, a];
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
 * A table sits at the entity's Crow's-foot position, which is stored apart from
 * its Chen position and shared like everything else. An entity with no
 * Crow's-foot position yet falls back to Chen's, which is only ever what a person
 * sees for the instant before this browser has arranged it — the view then
 * places it from the schema and writes that back, so the two arrangements stop
 * being related at all.
 */
export function deriveTables(doc: ErdDocument): CrowTable[] {
  const tables = doc.entities.map((entity) => ({ entityId: entity.id, name: entity.name,
    x: entity.crowX ?? entity.x, y: entity.crowY ?? entity.y,
    weak: entity.kind === 'weak', ...(entity.kind === 'associative' ? { associative: true } : {}), width: CROW_WIDTH, rows: baseRows(doc, entity) }));
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
      const recursive = source.entity.id === target.entity.id;
      let name = identifying ? toSqlName(key.name) : foreignKeyColumnName(toSqlName(target.entity.name), toSqlName(key.name));
      const legacyId = 'foreign:' + target.entity.id + ':' + key.id;
      const id = recursive && source.leg.columnId !== legacyId ? 'foreign:' + rel.id + ':' + target.entity.id + ':' + key.id : legacyId;
      let row = sourceTable.rows.find((r) => r.id === source.leg.columnId);
      row ??= sourceTable.rows.find((r) => toSqlName(r.name) === name &&
        (!recursive || (r.attributeId && !r.pk && !r.references) || r.references?.relationshipIds?.includes(rel.id)));
      if (!row) {
        if (recursive && sourceTable.rows.some(r => toSqlName(r.name) === name)) {
          const base = foreignKeyColumnName(toSqlName(rel.name), toSqlName(key.name));
          name = base;
          for (let suffix = 2; sourceTable.rows.some(r => toSqlName(r.name) === name); suffix++) name = base + '_' + suffix;
        }
        row = { id, attributeId: null, name, pk: false, fk: false, type: key.type };
        sourceTable.rows.push(row);
      }
      row.fk = true;
      if (identifying) row.pk = true;
      row.type = key.type;
      row.references = { entityId: target.entity.id, columnId: key.id, label: target.entity.name + '.' + key.name,
        ...(recursive ? { relationshipIds: [...new Set([...(row.references?.relationshipIds ?? []), rel.id])] } : {}) };
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
  for (const table of tables) table.width = widthFor(table.name, table.weak, table.rows, table.associative);
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
  const recursive = a.entity.id === b.entity.id;
  const relationshipId = doc.relationships.find(rel => rel.id === a.leg.fromId || rel.id === a.leg.toId)?.id;
  if (direction?.[0].leg.id === a.leg.id && !a.leg.columnId) {
    aRow = aTable.rows.find((r) => recursive ? r.references?.relationshipIds?.includes(relationshipId!) :
      r.references?.entityId === b.entity.id && r.references.columnId === bRow.id) ?? aRow;
  } else if (direction?.[0].leg.id === b.leg.id && !b.leg.columnId) {
    bRow = bTable.rows.find((r) => recursive ? r.references?.relationshipIds?.includes(relationshipId!) :
      r.references?.entityId === a.entity.id && r.references.columnId === aRow.id) ?? bRow;
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
      route: rel.route ?? 'auto',
      // Absent stays absent, so a document with no dragged corners is unchanged.
      ...(rel.bendX !== undefined && rel.bendY !== undefined ? { bend: { x: rel.bendX, y: rel.bendY } } : {}),
      ...(rel.routePoints ? { routePoints: rel.routePoints } : {}),
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
    if (point.x === previous.x && point.y === previous.y) return '';
    return point.y === previous.y ? `H${point.x}` : `V${point.y}`;
  }).join(' ').replace(/^/, `M${first.x} ${first.y} `);
}

/** Horizontal run that leaves a row, kept clear of the table it comes from. */
const EXIT_STUB = ENDPOINT_STUB;
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
 *
 * `preferred` overrides which side a detour takes. It only matters when the
 * connector has to detour at all: a clear straight line is left alone, because
 * forcing a detour around nothing is worse than the line someone is complaining
 * about.
 */
export function routeColumns(
  from: CrowTable,
  fromColumnId: string,
  to: CrowTable,
  toColumnId: string,
  lane = 0,
  obstacles: Obstacle[] = [],
  preferred: RouteSide = 'auto',
  bend?: Point | null,
  routePoints?: RoutePoint[],
) {
  const ay = rowCenter(from, fromColumnId), by = rowCenter(to, toColumnId);
  const span = Math.max(from.width, to.width);
  const gapRight = to.x - from.x - span;
  const gapLeft = from.x - to.x - span;
  const facing = Math.max(gapRight, gapLeft) >= EXIT_STUB + 44;
  const saved = normalizeRoutePoints(routePoints);
  let fromRight = saved ? saved[0]!.x >= from.x + from.width / 2 : facing ? gapRight >= gapLeft : to.x >= from.x;
  let toRight = from.entityId === to.entityId && ay === by ? !fromRight :
    saved ? saved.at(-1)!.x >= to.x + to.width / 2 : facing ? !fromRight : fromRight;
  const allObstacles = [...obstacles, tableObstacle(from), tableObstacle(to)];
  const port = (table: CrowTable, right: boolean, y: number) => ({ x: table.x + (right ? table.width : 0), y });
  // Reserve the whole marker's height, including a neighbour just above/below its row.
  const available = (point: Point, right: boolean) => Math.min(Infinity, ...allObstacles
    .filter(rect => point.y + 12 > rect.minY && point.y - 12 < rect.maxY)
    .map(rect => right ? rect.minX - point.x : point.x - rect.maxX).filter(gap => gap >= 0));
  if (available(port(from, fromRight, ay), fromRight) < EXIT_STUB &&
    available(port(from, !fromRight, ay), !fromRight) >= EXIT_STUB) fromRight = !fromRight;
  if (available(port(to, toRight, by), toRight) < EXIT_STUB &&
    available(port(to, !toRight, by), !toRight) >= EXIT_STUB) toRight = !toRight;
  if (from.entityId === to.entityId && ay === by) toRight = !fromRight;
  const a = { x: from.x + (fromRight ? from.width : 0), y: ay };
  const b = { x: to.x + (toRight ? to.width : 0), y: by };
  // In a narrow table gap, reserve the available space rather than entering a neighbour.
  const stub = (port: Point, right: boolean) => {
    const gap = available(port, right);
    const length = Math.min(EXIT_STUB, Math.max(gap / 2, gap - 1));
    return { x: port.x + (right ? length : -length), y: port.y };
  };
  const aStub = stub(a, fromRight), bStub = stub(b, toRight);
  const guard = { a, b, aStub, bStub, obstacles: allObstacles };

  // The direct route, plus the jog used to fan out parallel connectors.
  const bendX = facing ? (a.x + b.x) / 2 + lane * 12 :
    fromRight ? Math.max(a.x, b.x) + 48 + lane * 16 : Math.min(a.x, b.x) - 48 - lane * 16;
  const jogY = facing && lane > 0 ? Math.min(ay, by) - lane * 44 : ay;
  const direct = jogY === ay
    ? [a, { x: bendX, y: ay }, { x: bendX, y: by }, b]
    : [a, aStub, { x: aStub.x, y: jogY }, { x: bStub.x, y: jogY }, bStub, b];

  const directPoints = simplifyRoute(direct);
  const directPath = polyline(directPoints);
  const clear = isRouteSafe(directPoints, guard);

  /*
   * Respect a manual route while it keeps ports, symbols and table bodies clear.
   * Old routes invalidated by table movement fall back to the automatic router.
   */
  if (saved) {
    const first = saved[0]!, last = saved.at(-1)!;
    const points = simplifyRoute([a, { x: first.x, y: ay }, ...saved, { x: last.x, y: by }, b]);
    const middle = points[Math.floor(points.length / 2)]!;
    if (isRouteSafe(points, guard)) return {
      a, b, guard, manualAccepted: true, points, path: polyline(points),
      aToward: aStub, bToward: bStub,
      handle: middle, label: { x: middle.x + 26, y: middle.y }, labelAnchor: 'start' as const,
      bounds: { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
        minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) },
    };
  }
  if (bend) {
    const corner = { x: bend.x, y: bend.y };
    const points = simplifyRoute([a, aStub, { x: corner.x, y: ay }, corner,
      { x: bStub.x, y: corner.y }, bStub, b]);
    const path = polyline(points);
    if (isRouteSafe(points, guard)) return {
      a, b, guard, manualAccepted: true,
      aToward: aStub, bToward: bStub,
      path, points,
      /*
       * The label sits beside the corner, never on it.
       *
       * Both are drawn in the same place otherwise, and the label is on top, so
       * the handle could not be grabbed: the drag went to the text.
       */
      label: { x: corner.x + 26, y: corner.y },
      labelAnchor: 'start' as const,
      handle: corner,
      bounds: { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
        minY: Math.min(ay, by, corner.y), maxY: Math.max(ay, by, corner.y) },
    };
  }

  /*
   * A clear line is left alone unless the person asked otherwise.
   *
   * Automatic keeps the direct route whenever nothing is in the way, because
   * detouring around nothing draws a longer line for no reason. An explicit
   * side overrides that: choosing "above" means above, even when the line would
   * have fitted straight through. A control that silently does nothing is worse
   * than no control, and this is the reason someone reaches for the menu.
   */
  if (clear && preferred === 'auto') {
    const label = { x: facing ? (a.x + b.x) / 2 : bendX + (fromRight ? 12 : -12),
      y: jogY !== ay || ay === by ? jogY - 20 : (ay + by) / 2 - (facing ? 0 : lane * 32) };
    return { a, b, guard, manualAccepted: false, aToward: aStub, bToward: bStub,
      path: directPath, points: directPoints, label, labelAnchor: facing ? 'middle' as const : fromRight ? 'start' as const : 'end' as const,
      handle: { x: bendX, y: jogY === ay ? by : jogY },
      bounds: { minX: Math.min(a.x, b.x, bendX), maxX: Math.max(a.x, b.x, bendX),
        minY: Math.min(ay, by, jogY), maxY: Math.max(ay, by) } };
  }

  /*
   * Detour just past the tables actually in the way.
   *
   * Only the obstacles the direct route crosses decide where the line goes.
   * Measuring against every table instead meant the channel sat outside the
   * whole drawing, so on a diagram of any size one obstructed connector drew a
   * line the height of the entire schema — which is what made Crow's-foot look
   * broken rather than busy. An unrelated table far above must not move this
   * line past it.
   */
  const blocking = allObstacles.filter((rect) =>
    direct.slice(1).some((point, index) => crossesObstacle(direct[index]!, point, rect)));
  /*
   * With nothing in the way the direct route is already the answer, so the
   * detour channels are measured from the row band: a preference can then move
   * the line off a path that was merely ugly without pretending there was an
   * obstacle to go around.
   */
  const above = Math.min(ay, by, ...blocking.map((rect) => rect.minY)) - DETOUR_CLEARANCE - lane * 20;
  const below = Math.max(ay, by, ...blocking.map((rect) => rect.maxY)) + DETOUR_CLEARANCE + lane * 20;
  const cost = (channel: number) => Math.abs(channel - ay) + Math.abs(channel - by);
  // An explicit side wins over the shorter one. The caller sets it because the
  // shorter detour is not always the one they want, and a diagram that puts the
  // line off the edge of the drawing is worse than a longer one.
  const forced = preferred === 'above' ? above : preferred === 'below' ? below : undefined;
  const channel = forced ?? (cost(above) <= cost(below) ? above : below);
  const detour = simplifyRoute([a, aStub, { x: aStub.x, y: channel }, { x: bStub.x, y: channel }, bStub, b]);
  const points = isRouteSafe(detour, guard) ? detour : findSafeRoute(guard) ?? detour;
  // A repaired route may use another channel. Keep its caption and handle on the drawn line.
  let longest = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const length = (index: number) => Math.abs(points[index + 1]!.x - points[index]!.x) +
      Math.abs(points[index + 1]!.y - points[index]!.y);
    if (length(i) > length(longest)) longest = i;
  }
  const middle = { x: (points[longest]!.x + points[longest + 1]!.x) / 2,
    y: (points[longest]!.y + points[longest + 1]!.y) / 2 };
  const path = polyline(points);
  return {
    a, b, guard, manualAccepted: false,
    aToward: aStub, bToward: bStub,
    path, points,
    label: points === detour ? { x: (a.x + b.x) / 2, y: channel + (channel < Math.min(ay, by) ? -12 : 16) } :
      { x: middle.x, y: middle.y - 20 },
    labelAnchor: 'middle' as const,
    handle: points === detour ? { x: (a.x + b.x) / 2, y: channel } : middle,
    bounds: { minX: Math.min(...points.map(p => p.x)), maxX: Math.max(...points.map(p => p.x)),
      minY: Math.min(...points.map(p => p.y)), maxY: Math.max(...points.map(p => p.y)) },
  };
}
