/**
 * Yjs binding.
 *
 * The document is stored as Yjs maps keyed by node id rather than as one
 * serialized blob. That is the whole reason concurrent editing works: when two
 * people rename different attributes, or move different entities, the two
 * changes touch different keys and merge without conflict. Serializing the
 * document to JSON on every keystroke would lose one of the edits.
 *
 * Layout of the shared document:
 *
 *   doc.getMap('meta')          -> { name, view }
 *   doc.getMap('entities')      -> id -> Y.Map
 *   doc.getMap('attributes')    -> id -> Y.Map
 *   doc.getMap('relationships') -> id -> Y.Map
 *   doc.getMap('isas')          -> id -> Y.Map
 *   doc.getMap('legs')          -> id -> Y.Map
 *
 * Positions are the one thing written at high frequency, so drags are kept
 * local and only committed on drop (see `useDrag`), which keeps the update
 * stream small enough for peer-to-peer.
 */

import * as Y from 'yjs';
import type {
  Attribute,
  Entity,
  ErdDocument,
  Group,
  Isa,
  Leg,
  Relationship,
  RouteSide,
} from '../model/types';
import { ENTITY_KINDS, ROUTE_SIDES } from '../model/types';
import { emptyDocument } from '../model/types';
import { normalizeDataType } from '../model/dataTypes';
import { descendantAttributeIds, normalizeAttributeOwners } from '../model/attributes';
import { normalizeRoutePoints, type RoutePoint } from '../model/connectorRouting';
import { canConnect, findRelationshipSlot } from '../model/placement';
import { deriveTables, type ColumnEndpoint } from '../model/crowfoot';

export const META = 'meta';
export const ENTITIES = 'entities';
export const ATTRIBUTES = 'attributes';
export const RELATIONSHIPS = 'relationships';
export const ISAS = 'isas';
export const LEGS = 'legs';
export const GROUPS = 'groups';

type Primitive = string | number | boolean | null;

function setFields(map: Y.Map<unknown>, fields: Record<string, Primitive | string[] | RoutePoint[]>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      map.set(key, value);
    } else {
      map.set(key, value);
    }
  }
}

function readString(map: Y.Map<unknown>, key: string, fallback: string): string {
  const v = map.get(key);
  return typeof v === 'string' ? v : fallback;
}

function readNumber(map: Y.Map<unknown>, key: string, fallback = 0): number {
  const v = map.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** A number that is either a real value or absent, never silently zero. */
function readOptionalNumber(map: Y.Map<unknown>, key: string): number | undefined {
  const v = map.get(key);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The names a person gave their generated columns, when there are any. */
function crowNames(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const names: Record<string, string> = {};
  for (const [key, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === 'string' && name.trim()) names[key] = name;
  }
  return Object.keys(names).length ? names : undefined;
}

function readStringArray(map: Y.Map<unknown>, key: string): string[] {
  const v = map.get(key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Seeds an empty Yjs document from a plain document, once. */
export function seedDocument(ydoc: Y.Doc, source: ErdDocument): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap(META);
    if (!meta.has('name')) meta.set('name', source.name);
    if (!meta.has('view')) meta.set('view', source.view);

    for (const entity of source.entities) upsertEntity(ydoc, entity);
    for (const attribute of source.attributes) upsertAttribute(ydoc, attribute);
    for (const relationship of source.relationships) upsertRelationship(ydoc, relationship);
    for (const isa of source.isas) upsertIsa(ydoc, isa);
    for (const leg of source.legs) upsertLeg(ydoc, leg);
    for (const group of source.groups) upsertGroup(ydoc, group);
  });
}

/**
 * Writes a group, or deletes it when it is empty.
 *
 * An empty group has no frame to draw and nothing to carry, so it is removed
 * rather than stored: a group that cannot be seen should not survive a reload.
 */
export function upsertGroup(ydoc: Y.Doc, group: Group): void {
  const map = ydoc.getMap(GROUPS);
  if (group.memberIds.length < 2) {
    map.delete(group.id);
    return;
  }
  const existing = map.get(group.id) as Y.Map<unknown> | undefined;
  if (existing) {
    setFields(existing, { id: group.id, name: group.name, memberIds: group.memberIds });
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, { id: group.id, name: group.name, memberIds: group.memberIds });
  map.set(group.id, next);
}

/** Removes a group, leaving its members exactly where they are. */
export function deleteGroupFromYdoc(ydoc: Y.Doc, id: string): void {
  ydoc.getMap(GROUPS).delete(id);
}

/**
 * Puts every id in memberIds into one group, and takes them out of any other.
 *
 * A shape belongs to a single group. Selecting something already grouped moves
 * it rather than silently listing it in two frames, which would make dragging
 * one of them ambiguous.
 */
export function setGroupMembers(ydoc: Y.Doc, id: string, name: string, memberIds: string[]): void {
  const groups = ydoc.getMap(GROUPS);
  ydoc.transact(() => {
    groups.forEach((value) => {
      const group = value as Y.Map<unknown>;
      const before = readStringArray(group, 'memberIds');
      const after = before.filter((m) => !memberIds.includes(m));
      if (after.length !== before.length) group.set('memberIds', after);
    });
    groups.forEach((value, key) => {
      if (readStringArray(value as Y.Map<unknown>, 'memberIds').length < 2) groups.delete(key);
    });
    const next = new Y.Map<unknown>();
    setFields(next, { id, name, memberIds });
    groups.set(id, next);
  });
}

export function upsertEntity(ydoc: Y.Doc, entity: Entity): void {
  const map = ydoc.getMap(ENTITIES);
  const existing = map.get(entity.id) as Y.Map<unknown> | undefined;
  if (existing) {
    setFields(existing, { ...entity });
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, { ...entity });
  map.set(entity.id, next);
}

export function upsertAttribute(ydoc: Y.Doc, attribute: Attribute): void {
  const map = ydoc.getMap(ATTRIBUTES);
  const existing = map.get(attribute.id) as Y.Map<unknown> | undefined;
  const { dataType: rawType, ...fields } = attribute;
  const dataType = normalizeDataType(rawType);
  if (existing) {
    setFields(existing, fields);
    if (dataType) existing.set('dataType', dataType);
    else existing.delete('dataType');
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, fields);
  if (dataType) next.set('dataType', dataType);
  map.set(attribute.id, next);
}

export function upsertRelationship(ydoc: Y.Doc, relationship: Relationship): void {
  const map = ydoc.getMap(RELATIONSHIPS);
  const existing = map.get(relationship.id) as Y.Map<unknown> | undefined;
  if (existing) {
    setFields(existing, { ...relationship });
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, { ...relationship });
  map.set(relationship.id, next);
}

export function upsertIsa(ydoc: Y.Doc, isa: Isa): void {
  const map = ydoc.getMap(ISAS);
  const existing = map.get(isa.id) as Y.Map<unknown> | undefined;
  if (existing) {
    setFields(existing, { ...isa });
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, { ...isa });
  map.set(isa.id, next);
}

export function upsertLeg(ydoc: Y.Doc, leg: Leg): void {
  const map = ydoc.getMap(LEGS);
  const existing = map.get(leg.id) as Y.Map<unknown> | undefined;
  const fields = {
    id: leg.id,
    fromId: leg.fromId,
    toId: leg.toId,
    cardinality: leg.cardinality,
    min: leg.participation.min,
    max: leg.participation.max,
  };
  if (existing) {
    for (const [key, value] of Object.entries(fields)) {
      if (existing.get(key) !== value) existing.set(key, value);
    }
    if (leg.columnId) {
      if (existing.get('columnId') !== leg.columnId) existing.set('columnId', leg.columnId);
    } else existing.delete('columnId');
    const names = leg.columnNames && Object.keys(leg.columnNames).length ? leg.columnNames : undefined;
    if (names) {
      if (JSON.stringify(existing.get('columnNames')) !== JSON.stringify(names)) existing.set('columnNames', names);
    } else existing.delete('columnNames');
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, fields);
  if (leg.columnId) next.set('columnId', leg.columnId);
  if (leg.columnNames && Object.keys(leg.columnNames).length) next.set('columnNames', leg.columnNames);
  map.set(leg.id, next);
}

/** Entity pairs become a diamond and two legs in one shared, undoable change. */
export function connectNodes(
  ydoc: Y.Doc, fromId: string, toId: string, makeId: (kind: string) => string,
): string | null {
  const doc = snapshotFromYdoc(ydoc);
  const entityPair = doc.entities.some((entity) => entity.id === fromId) &&
    doc.entities.some((entity) => entity.id === toId);
  const unary = entityPair && fromId === toId;
  if (!unary && !canConnect(doc, fromId, toId)) return null;
  const id = makeId(entityPair ? 'rel' : 'leg');
  ydoc.transact(() => {
    if (entityPair) {
      upsertRelationship(ydoc, { id, name: 'relationship', kind: 'strong', ...findRelationshipSlot(doc, fromId, toId) });
      for (const [index, entityId] of [fromId, toId].entries()) {
        upsertLeg(ydoc, { id: makeId('leg'), fromId: id, toId: entityId,
          cardinality: unary && index === 1 ? 'N' : '1', participation: { min: unary ? 1 : 0, max: unary && index === 1 ? 'N' : 1 } });
      }
    } else {
      upsertLeg(ydoc, { id, fromId, toId, cardinality: '1', participation: { min: 0, max: 1 } });
    }
  });
  return id;
}

/** Column connections share the Chen relationship model and undo as one change. */
export function connectColumns(
  ydoc: Y.Doc, from: ColumnEndpoint, to: ColumnEndpoint, makeId: (kind: string) => string,
): string | null {
  const doc = snapshotFromYdoc(ydoc);
  const tables = deriveTables(doc);
  const rowAt = (end: ColumnEndpoint) => tables.find((t) => t.entityId === end.entityId)?.rows.find((r) => r.id === end.columnId);
  const a = rowAt(from), b = rowAt(to);
  if (!a || !b || (from.entityId === to.entityId && from.columnId === to.columnId)) return null;
  const id = makeId('rel');
  ydoc.transact(() => {
    upsertRelationship(ydoc, { id, name: 'relationship', kind: 'strong', ...findRelationshipSlot(doc, from.entityId, to.entityId) });
    for (const [end, row] of [[from, a], [to, b]] as const) {
      upsertLeg(ydoc, { id: makeId('leg'), fromId: id, toId: end.entityId, columnId: end.columnId,
        cardinality: row.pk ? '1' : 'N', participation: { min: 0, max: row.pk ? 1 : 'N' } });
    }
  });
  return id;
}

/** Removes a node and the legs and attributes that depended on it. */
export function deleteNodeFromYdoc(ydoc: Y.Doc, id: string): void {
  ydoc.transact(() => {
    const removed = descendantAttributeIds(snapshotFromYdoc(ydoc), id);
    removed.add(id);
    // Legs are nodes too. Without this a relationship line cannot be deleted on
    // its own: nothing below removes it, because a leg is never the `fromId` or
    // `toId` of another leg.
    ydoc.getMap(LEGS).delete(id);

    for (const key of [ENTITIES, ATTRIBUTES, RELATIONSHIPS, ISAS] as const) {
      for (const nodeId of removed) ydoc.getMap(key).delete(nodeId);
    }
    const legs = ydoc.getMap(LEGS);
    legs.forEach((value, key) => {
      const leg = value as Y.Map<unknown>;
      if (removed.has(String(leg.get('fromId'))) || removed.has(String(leg.get('toId')))) legs.delete(key);
    });
    const attributes = ydoc.getMap(ATTRIBUTES);
    attributes.forEach((value, key) => {
      const attr = value as Y.Map<unknown>;
      if (attr.get('ownerId') === id) attributes.delete(key);
    });
    const isas = ydoc.getMap(ISAS);
    isas.forEach((value) => {
      const isa = value as Y.Map<unknown>;
      if (isa.get('parentId') === id) isa.set('parentId', null);
      const before = readStringArray(isa, 'childIds');
      const after = before.filter((c) => c !== id);
      if (after.length !== before.length) isa.set('childIds', after);
    });
    // A group must not keep a shape that no longer exists, because the frame is
    // derived from its members.
    const groups = ydoc.getMap(GROUPS);
    groups.forEach((value) => {
      const group = value as Y.Map<unknown>;
      const before = readStringArray(group, 'memberIds');
      const after = before.filter((m) => !removed.has(m));
      if (after.length !== before.length) group.set('memberIds', after);
    });
    groups.forEach((value, key) => {
      if (readStringArray(value as Y.Map<unknown>, 'memberIds').length < 2) groups.delete(key);
    });
  });
}

export function setMeta(ydoc: Y.Doc, patch: Partial<{ name: string; view: 'chen' | 'crowfoot' }>): void {
  const meta = ydoc.getMap(META);
  ydoc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) meta.set(key, value);
    }
  });
}

/**
 * Where a table sits in the Crow's-foot view.
 *
 * Each browser writes its own entry, so two people never write the same key
 * and the document never has to choose between them. The entry says when the
 * move was made and whether it was deliberate, because a person dragging a
 * table is a decision and the app arranging one is not: a deliberate move
 * always wins, and between two of them the later one wins.
 *
 * Without this, the shared position is whichever write the document happens to
 * keep, and a person who was offline while somebody else moved the table comes
 * back and undoes the newer move.
 */
interface CrowPlacement { x: number; y: number; at: number; move: boolean }

const CROW_PREFIX = 'crow_';

/** This browser's own key, so two browsers never write the same entry. */
function writerId(): string {
  const key = 'erd:writer';
  try {
    const stored = localStorage.getItem(key);
    if (stored) return stored;
    const made = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, made);
    return made;
  } catch {
    // A browser that cannot keep state still needs a key that differs.
    return 'anon' + Math.random().toString(36).slice(2, 10);
  }
}

/** Records where this browser puts a table. */
export function setCrowPlacement(ydoc: Y.Doc, entityId: string, x: number, y: number,
  move: boolean, origin?: unknown): void {
  const map = ydoc.getMap(ENTITIES).get(entityId) as Y.Map<unknown> | undefined;
  if (!map) return;
  const placement: CrowPlacement = { x, y, at: Date.now(), move };
  ydoc.transact(() => { map.set(CROW_PREFIX + writerId(), placement); }, origin);
}

/** The position to show for a table: the newest deliberate move, else the newest arrangement. */
export function crowPlacement(map: Y.Map<unknown>): { x: number; y: number } | undefined {
  let best: CrowPlacement | undefined;
  for (const [key, value] of map.entries()) {
    if (!key.startsWith(CROW_PREFIX) || !value || typeof value !== 'object') continue;
    const entry = value as Partial<CrowPlacement>;
    if (typeof entry.x !== 'number' || typeof entry.y !== 'number' || typeof entry.at !== 'number') continue;
    const placement: CrowPlacement = { x: entry.x, y: entry.y, at: entry.at, move: entry.move === true };
    if (!best || (placement.move && !best.move) ||
      (placement.move === best.move && placement.at > best.at)) best = placement;
  }
  return best ? { x: best.x, y: best.y } : undefined;
}

/** Materialises the Yjs state into the plain document the renderers consume. */
export function snapshotFromYdoc(ydoc: Y.Doc): ErdDocument {
  const doc = emptyDocument();
  const meta = ydoc.getMap(META);
  doc.name = readString(meta, 'name', doc.name);
  doc.view = readString(meta, 'view', 'chen') === 'crowfoot' ? 'crowfoot' : 'chen';

  ydoc.getMap(ENTITIES).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const placed = crowPlacement(m);
    const crowX = placed?.x ?? readOptionalNumber(m, 'crowX');
    const crowY = placed?.y ?? readOptionalNumber(m, 'crowY');
    doc.entities.push({
      id: key,
      name: readString(m, 'name', 'Entity'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      // Absent stays absent: it means "this browser has not placed the table
      // yet", which is different from a placement at the origin.
      ...(crowX !== undefined && crowY !== undefined ? { crowX, crowY } : {}),
      kind: ENTITY_KINDS.find(kind => kind === m.get('kind')) ?? 'strong',
    });
  });

  ydoc.getMap(ATTRIBUTES).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const kind = readString(m, 'kind', 'simple');
    const kinds = ['simple', 'key', 'unique', 'multivalued', 'derived', 'composite'] as const;
    const dataType = normalizeDataType(m.get('dataType'));
    doc.attributes.push({
      id: key,
      name: readString(m, 'name', 'attribute'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      kind: kinds.find((k) => k === kind) ?? 'simple',
      ownerId: typeof m.get('ownerId') === 'string' ? (m.get('ownerId') as string) : null,
      ...(dataType ? { dataType } : {}),
    });
  });

  ydoc.getMap(RELATIONSHIPS).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const bendX = readOptionalNumber(m, 'bendX');
    const bendY = readOptionalNumber(m, 'bendY');
    doc.relationships.push({
      id: key,
      name: readString(m, 'name', 'relationship'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      kind: readString(m, 'kind', 'strong') === 'weak' ? 'weak' : 'strong',
      /*
       * Absent stays absent: it means automatic, and materialising `'auto'` on
       * every relationship would make a document that never chose a route differ
       * from the one it was saved from. A peer can send any string here, so the
       * value is checked rather than trusted.
       */
      ...(ROUTE_SIDES.includes(m.get('route') as RouteSide) ? { route: m.get('route') as RouteSide } : {}),
      /*
       * A dragged corner, or absent for "the router decides". Both halves have to
       * be finite and present: a peer can send anything, and a corner at
       * Infinity would put the line somewhere nobody can scroll to.
       */
      ...(bendX !== undefined && bendY !== undefined ? { bendX, bendY } : {}),
      ...(normalizeRoutePoints(m.get('routePoints')) ? { routePoints: normalizeRoutePoints(m.get('routePoints')) } : {}),
    });
  });

  ydoc.getMap(ISAS).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const parentId = m.get('parentId');
    doc.isas.push({
      id: key,
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      parentId: typeof parentId === 'string' ? parentId : null,
      childIds: readStringArray(m, 'childIds'),
    });
  });

  ydoc.getMap(LEGS).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const fromId = m.get('fromId');
    const toId = m.get('toId');
    if (typeof fromId !== 'string' || typeof toId !== 'string') return;
    const card = readString(m, 'cardinality', '1');
    const maxRaw = m.get('max');
    doc.legs.push({
      id: key,
      fromId,
      toId,
      cardinality: card === 'N' || card === 'M' ? card : '1',
      participation: {
        min: Math.max(0, Math.floor(readNumber(m, 'min', 0))),
        max: maxRaw === 'N' ? 'N' : Math.max(1, Math.floor(readNumber(m, 'max', 1))),
      },
      ...(typeof m.get('columnId') === 'string' && m.get('columnId') ? { columnId: m.get('columnId') as string } : {}),
      ...(crowNames(m.get('columnNames')) ? { columnNames: crowNames(m.get('columnNames'))! } : {}),
    });
  });

  ydoc.getMap(GROUPS).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const memberIds = readStringArray(m, 'memberIds');
    if (memberIds.length < 2) return;
    doc.groups.push({ id: key, name: readString(m, 'name', 'Group'), memberIds });
  });

  // Drop references to nodes that no longer exist, so a mid-merge state can
  // never render a connector to nowhere.
  const ids = new Set([
    ...doc.entities.map((e) => e.id),
    ...doc.relationships.map((r) => r.id),
    ...doc.isas.map((i) => i.id),
  ]);
  doc.legs = doc.legs.filter((l) => ids.has(l.fromId) && ids.has(l.toId));
  doc.attributes = normalizeAttributeOwners(doc);

  // Group members can be any positioned shape, including attributes, so they are
  // checked against the full set and emptied groups are dropped.
  const nodeIds = new Set([...doc.entities, ...doc.attributes, ...doc.relationships, ...doc.isas].map((n) => n.id));
  doc.groups = doc.groups
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((id) => nodeIds.has(id)) }))
    .filter((g) => g.memberIds.length > 1);

  // Yjs maps are unordered, so two peers can iterate the same state in
  // different orders. Sorting by id makes the materialised document
  // byte-identical across peers, which keeps render order stable (no flicker)
  // and makes state comparisons meaningful.
  const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  doc.entities.sort(byId);
  doc.attributes.sort(byId);
  doc.relationships.sort(byId);
  doc.isas.sort(byId);
  doc.legs.sort(byId);
  doc.groups.sort(byId);

  return doc;
}
