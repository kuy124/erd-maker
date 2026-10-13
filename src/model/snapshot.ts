/**
 * URL snapshot codec.
 *
 * The whole app is peer-to-peer with no server, so there is nowhere to persist
 * a document when every tab closes. The fix: a share link carries a compressed
 * snapshot of the document in its fragment, *and* the room id to join for live
 * editing. Opening the link reconstructs the diagram immediately, even if
 * nobody is online, and then syncs with anyone who is.
 *
 * The fragment is used rather than the query string because fragments are not
 * sent to servers, so a static host never sees the diagram contents.
 */

import LZString from 'lz-string';
import { emptyDocument, ROUTE_SIDES, type ErdDocument, type RouteSide } from './types';
import { normalizeDataType } from './dataTypes';
import { normalizeAttributeOwners } from './attributes';
import { normalizeRoutePoints } from './connectorRouting';

export interface ShareLink {
  room: string;
  doc: ErdDocument;
}

const SCHEMA_VERSION = 3;

/**
 * Characters in a room id.
 *
 * One constant because it is the single thing that decides how short a share
 * link is, and tests assert against it.
 */
export const ROOM_ID_LENGTH = 8;

interface Snapshot {
  v: number;
  d: ErdDocument;
}

/**
 * Wire format: positional rows, not objects.
 *
 * Schema 1 wrote the document as JSON objects and left the work to
 * compression, which spends most of the link on repeated key names — `id`,
 * `name`, `kind`, and `ownerId` appear once per node and compress well but not
 * to nothing. Writing each node as a positional row removes them entirely, and
 * measures about 40% smaller on real diagrams (a 90-node schema goes from 3726
 * to 2223 characters). That is the only reduction available while there is no
 * server to hold the document, so the column order below is worth stating
 * explicitly.
 *
 * Schema 1 payloads are still read: they are objects where schema 2 is an
 * array, so the two never collide and an old link keeps working.
 */
function toRows(doc: ErdDocument): unknown[] {
  // Tolerate a missing collection the same way `normalizeDocument` does on the
  // way in. A document can reach here from a hand-edited file or a link written
  // before a field existed, and an encoder that throws is worse than one that
  // drops the field.
  const list = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  const entities = list(doc.entities);
  const attributes = list(doc.attributes);
  return [
    doc.name,
    doc.view,
    entities.map((e) => [e.id, e.name, e.x, e.y, e.kind, e.crowX ?? '', e.crowY ?? '']),
    attributes.map((a) => [a.id, a.name, a.x, a.y, a.kind, a.ownerId, a.dataType ?? '']),
    list(doc.relationships).map((r) => [r.id, r.name, r.x, r.y, r.kind, r.route ?? '', r.bendX ?? '', r.bendY ?? '', r.routePoints ?? '']),
    list(doc.isas).map((i) => [i.id, i.x, i.y, i.parentId, i.childIds]),
    list(doc.legs).map((l) => [
      l.id, l.fromId, l.toId, l.columnId ?? '', l.cardinality, l.participation.min, l.participation.max,
    ]),
    list(doc.groups).map((g) => [g.id, g.name, g.memberIds]),
  ];
}

/**
 * Rebuilds a document from rows. Values are placed loosely on purpose:
 * `normalizeDocument` runs straight afterwards and is already the place that
 * coerces a partial or hand-edited document into a valid one, so this only has
 * to get the columns in the right order.
 */
function fromRows(rows: unknown[]): unknown {
  const [name, view, entities, attributes, relationships, isas, legs, groups] = rows;
  const rowsOf = (list: unknown) => (Array.isArray(list) ? (list as unknown[][]) : []);
  return {
    name,
    view,
    entities: rowsOf(entities).map((r) => ({ id: r[0], name: r[1], x: r[2], y: r[3], kind: r[4],
      // Empty string means "this browser had not placed the table", which is
      // different from a placement at zero, so it must survive as absent.
      ...(r[5] !== '' && r[6] !== '' ? { crowX: r[5], crowY: r[6] } : {}) })),
    attributes: rowsOf(attributes).map((r) => ({
      id: r[0], name: r[1], x: r[2], y: r[3], kind: r[4], ownerId: r[5], dataType: r[6],
    })),
    relationships: rowsOf(relationships).map((r) => ({ id: r[0], name: r[1], x: r[2], y: r[3], kind: r[4],
      // Absent is automatic, so an older snapshot reads without the field.
      ...(r[5] ? { route: r[5] } : {}),
      ...(typeof r[6] === 'number' && typeof r[7] === 'number' ? { bendX: r[6], bendY: r[7] } : {}),
      ...(normalizeRoutePoints(r[8]) ? { routePoints: normalizeRoutePoints(r[8]) } : {}) })),
    isas: rowsOf(isas).map((r) => ({ id: r[0], x: r[1], y: r[2], parentId: r[3], childIds: r[4] })),
    legs: rowsOf(legs).map((r) => ({
      id: r[0], fromId: r[1], toId: r[2], columnId: r[3], cardinality: r[4],
      participation: { min: r[5], max: r[6] },
    })),
    groups: rowsOf(groups).map((r) => ({ id: r[0], name: r[1], memberIds: r[2] })),
  };
}

/**
 * Encodes a document into a URL-safe string. Round-trips losslessly for every
 * field the model uses; unknown fields are dropped, which keeps old links
 * loadable after the model grows.
 */
export function encodeSnapshot(doc: ErdDocument): string {
  const json = JSON.stringify([SCHEMA_VERSION, ...toRows(doc)]);
  return LZString.compressToEncodedURIComponent(json);
}

export function decodeSnapshot(encoded: string): ErdDocument | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) {
      const [version, ...rows] = parsed;
      // Schema 2 is the same columns without the Crow's-foot positions, so it
      // decodes with those absent rather than being rejected: a link somebody
      // bookmarked before this change has to keep opening.
      if (version !== 3 && version !== 2) return null;
      return normalizeDocument(fromRows(rows));
    }
    // Schema 1: an object carrying the document.
    const legacy = parsed as Snapshot | null;
    if (!legacy || typeof legacy !== 'object' || !legacy.d) return null;
    return normalizeDocument(legacy.d);
  } catch {
    return null;
  }
}

/**
 * Generates a short, URL-safe room id that is hard to guess by accident.
 *
 * The alphabet omits `l`, `o`, `0`, and `1`: a room id gets read off a screen
 * and typed into another device by hand, and those four are the pairs people
 * transcribe wrongly. Getting this wrong is subtle — a stray `o` still produces
 * a valid-looking id, it just occasionally costs someone a failed join.
 *
 * Eight characters over 31 symbols is about 40 bits. That is deliberate: the id
 * has to be short enough to say out loud, and the thing it protects against is
 * somebody guessing the room, not somebody attacking the key. Note this is also
 * the live-editing key, so it is a real reduction from the twelve characters
 * this used to be — if the key strength matters more than being sayable, raise
 * the one constant below.
 */
export function newRoomId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
  }
  return out;
}

/**
 * Builds a live-room URL with an optional snapshot. Only the signaling query
 * is retained so recipients can reach the same collaboration server.
 *
 * LZString's URI alphabet includes `+`, which `URLSearchParams` decodes as a
 * space when the fragment is parsed. Escaping `+` as `%2B` keeps the payload
 * intact through a round trip; every other character in the alphabet is
 * already fragment-safe.
 */
export function buildShareUrl(base: string, doc: ErdDocument, room: string, includeSnapshot = true): string {
  const [path, query] = base.split('#')[0]!.split('?');
  const signaling = new URLSearchParams(query).get('signaling');
  const clean = path + (signaling ? '?' + new URLSearchParams({ signaling }).toString() : '');
  const live = `${clean}#room=${encodeURIComponent(room)}`;
  if (!includeSnapshot) return live;
  const encoded = encodeSnapshot(doc).replace(/\+/g, '%2B');
  return `${live}&d=${encoded}`;
}

/**
 * Parses a location hash. Returns the room and document when present, and
 * tolerates a hash with only a room (live-join with no seed) or only a
 * document.
 */
export function parseShareHash(hash: string): Partial<ShareLink> {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return {};
  const params = new URLSearchParams(raw);
  const result: Partial<ShareLink> = {};

  const room = params.get('room');
  if (room && room.trim().length > 0) result.room = room.trim();

  const encoded = params.get('d');
  if (encoded) {
    const doc = decodeSnapshot(encoded);
    if (doc) result.doc = doc;
  }
  return result;
}

/**
 * Defensive normalisation: a link may have been produced by an older build, or
 * hand-edited. Every field is coerced to a valid value so a bad link degrades
 * to a partial diagram instead of crashing the app.
 */
const numberOrAbsent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function normalizeDocument(input: unknown): ErdDocument {
  const base = emptyDocument();
  if (!input || typeof input !== 'object') return base;
  const raw = input as Record<string, unknown>;

  const doc: ErdDocument = {
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : base.name,
    view: raw.view === 'crowfoot' ? 'crowfoot' : 'chen',
    entities: asArray(raw.entities).flatMap((e) => {
      const o = asObject(e);
      if (!o || typeof o.id !== 'string') return [];
      const crowX = numberOrAbsent(o.crowX);
      const crowY = numberOrAbsent(o.crowY);
      return [
        {
          id: o.id,
          name: asString(o.name, 'Entity'),
          x: asNumber(o.x),
          y: asNumber(o.y),
          // Both or neither: half a position is not a position.
          ...(crowX !== undefined && crowY !== undefined ? { crowX, crowY } : {}),
          kind: o.kind === 'weak' ? 'weak' : 'strong',
        },
      ];
    }),
    attributes: asArray(raw.attributes).flatMap((a) => {
      const o = asObject(a);
      if (!o || typeof o.id !== 'string') return [];
      const kinds = ['simple', 'key', 'multivalued', 'derived', 'composite'] as const;
      const kind = kinds.find((k) => k === o.kind) ?? 'simple';
      const dataType = normalizeDataType(o.dataType);
      return [
        {
          id: o.id,
          name: asString(o.name, 'attribute'),
          x: asNumber(o.x),
          y: asNumber(o.y),
          kind,
          ownerId: typeof o.ownerId === 'string' ? o.ownerId : null,
          ...(dataType ? { dataType } : {}),
        },
      ];
    }),
    relationships: asArray(raw.relationships).flatMap((r) => {
      const o = asObject(r);
      if (!o || typeof o.id !== 'string') return [];
      return [
        {
          id: o.id,
          name: asString(o.name, 'relationship'),
          x: asNumber(o.x),
          y: asNumber(o.y),
          kind: o.kind === 'weak' ? 'weak' : 'strong',
          // Absent stays absent, meaning automatic, so a snapshot written
          // before routes existed reads exactly as it did.
          ...(ROUTE_SIDES.includes(o.route as RouteSide) ? { route: o.route as RouteSide } : {}),
          ...(typeof o.bendX === 'number' && Number.isFinite(o.bendX) &&
            typeof o.bendY === 'number' && Number.isFinite(o.bendY) ? { bendX: o.bendX, bendY: o.bendY } : {}),
          ...(normalizeRoutePoints(o.routePoints) ? { routePoints: normalizeRoutePoints(o.routePoints) } : {}),
        },
      ];
    }),
    isas: asArray(raw.isas).flatMap((i) => {
      const o = asObject(i);
      if (!o || typeof o.id !== 'string') return [];
      return [
        {
          id: o.id,
          x: asNumber(o.x),
          y: asNumber(o.y),
          parentId: typeof o.parentId === 'string' ? o.parentId : null,
          childIds: asArray(o.childIds).filter((c): c is string => typeof c === 'string'),
        },
      ];
    }),
    legs: asArray(raw.legs).flatMap((l) => {
      const o = asObject(l);
      if (!o || typeof o.id !== 'string') return [];
      if (typeof o.fromId !== 'string' || typeof o.toId !== 'string') return [];
      const card = o.cardinality === 'N' || o.cardinality === 'M' ? o.cardinality : '1';
      const part = asObject(o.participation);
      const max = part && part.max === 'N' ? 'N' : asNumber(part?.max, 1);
      return [
        {
          id: o.id,
          fromId: o.fromId,
          toId: o.toId,
          ...(typeof o.columnId === 'string' && o.columnId ? { columnId: o.columnId } : {}),
          cardinality: card,
          participation: {
            min: Math.max(0, Math.floor(asNumber(part?.min, 0))),
            max,
          },
        },
      ];
    }),
    // Absent from older links, which is why the schema version did not move:
    // `asArray` turns a missing field into an empty list, so old links load
    // with no groups rather than failing.
    groups: asArray(raw.groups).flatMap((g) => {
      const o = asObject(g);
      if (!o || typeof o.id !== 'string') return [];
      const memberIds = asArray(o.memberIds).filter((m): m is string => typeof m === 'string');
      if (memberIds.length < 2) return [];
      return [{ id: o.id, name: asString(o.name, 'Group'), memberIds }];
    }),
  };

  // Drop legs and attribute owners that reference nodes the link did not carry.
  const ids = new Set([
    ...doc.entities.map((e) => e.id),
    ...doc.relationships.map((r) => r.id),
    ...doc.isas.map((i) => i.id),
  ]);
  doc.legs = doc.legs.filter((l) => ids.has(l.fromId) && ids.has(l.toId));
  doc.attributes = normalizeAttributeOwners(doc);

  // Group members may be attributes too, so they are matched against every
  // positioned shape and empty groups are discarded.
  const nodeIds = new Set([...doc.entities, ...doc.attributes, ...doc.relationships, ...doc.isas].map((n) => n.id));
  doc.groups = doc.groups
    .map((g) => ({ ...g, memberIds: g.memberIds.filter((id) => nodeIds.has(id)) }))
    .filter((g) => g.memberIds.length > 1);

  return doc;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
