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
  Isa,
  Leg,
  Relationship,
} from '../model/types';
import { emptyDocument } from '../model/types';

export const META = 'meta';
export const ENTITIES = 'entities';
export const ATTRIBUTES = 'attributes';
export const RELATIONSHIPS = 'relationships';
export const ISAS = 'isas';
export const LEGS = 'legs';

type Primitive = string | number | boolean | null;

function setFields(map: Y.Map<unknown>, fields: Record<string, Primitive | string[]>): void {
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
  if (existing) {
    setFields(existing, { ...attribute });
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, { ...attribute });
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
    setFields(existing, fields);
    return;
  }
  const next = new Y.Map<unknown>();
  setFields(next, fields);
  map.set(leg.id, next);
}

/** Removes a node and the legs and attributes that depended on it. */
export function deleteNodeFromYdoc(ydoc: Y.Doc, id: string): void {
  ydoc.transact(() => {
    for (const key of [ENTITIES, ATTRIBUTES, RELATIONSHIPS, ISAS] as const) {
      ydoc.getMap(key).delete(id);
    }
    const legs = ydoc.getMap(LEGS);
    legs.forEach((value, key) => {
      const leg = value as Y.Map<unknown>;
      if (leg.get('fromId') === id || leg.get('toId') === id) legs.delete(key);
    });    const attributes = ydoc.getMap(ATTRIBUTES);
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

/** Materialises the Yjs state into the plain document the renderers consume. */
export function snapshotFromYdoc(ydoc: Y.Doc): ErdDocument {
  const doc = emptyDocument();
  const meta = ydoc.getMap(META);
  doc.name = readString(meta, 'name', doc.name);
  doc.view = readString(meta, 'view', 'chen') === 'crowfoot' ? 'crowfoot' : 'chen';

  ydoc.getMap(ENTITIES).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    doc.entities.push({
      id: key,
      name: readString(m, 'name', 'Entity'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      kind: readString(m, 'kind', 'strong') === 'weak' ? 'weak' : 'strong',
    });
  });

  ydoc.getMap(ATTRIBUTES).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    const kind = readString(m, 'kind', 'simple');
    const kinds = ['simple', 'key', 'multivalued', 'derived', 'composite'] as const;
    doc.attributes.push({
      id: key,
      name: readString(m, 'name', 'attribute'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      kind: kinds.find((k) => k === kind) ?? 'simple',
      ownerId: typeof m.get('ownerId') === 'string' ? (m.get('ownerId') as string) : null,
    });
  });

  ydoc.getMap(RELATIONSHIPS).forEach((value, key) => {
    const m = value as Y.Map<unknown>;
    doc.relationships.push({
      id: key,
      name: readString(m, 'name', 'relationship'),
      x: readNumber(m, 'x'),
      y: readNumber(m, 'y'),
      kind: readString(m, 'kind', 'strong') === 'weak' ? 'weak' : 'strong',
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
    });
  });

  // Drop references to nodes that no longer exist, so a mid-merge state can
  // never render a connector to nowhere.
  const ids = new Set([
    ...doc.entities.map((e) => e.id),
    ...doc.relationships.map((r) => r.id),
    ...doc.isas.map((i) => i.id),
  ]);
  doc.legs = doc.legs.filter((l) => ids.has(l.fromId) && ids.has(l.toId));
  doc.attributes = doc.attributes.map((a) =>
    a.ownerId && !ids.has(a.ownerId) ? { ...a, ownerId: null } : a,
  );

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

  return doc;
}
