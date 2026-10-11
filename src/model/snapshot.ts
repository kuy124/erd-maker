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
import { emptyDocument, type ErdDocument } from './types';

export interface ShareLink {
  room: string;
  doc: ErdDocument;
}

const SCHEMA_VERSION = 1;

interface Snapshot {
  v: number;
  d: ErdDocument;
}

/**
 * Encodes a document into a URL-safe string. Round-trips losslessly for every
 * field the model uses; unknown fields are dropped, which keeps old links
 * loadable after the model grows.
 */
export function encodeSnapshot(doc: ErdDocument): string {
  const snapshot: Snapshot = { v: SCHEMA_VERSION, d: doc };
  const json = JSON.stringify(snapshot);
  return LZString.compressToEncodedURIComponent(json);
}

export function decodeSnapshot(encoded: string): ErdDocument | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json) as Snapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.d) return null;
    return normalizeDocument(parsed.d);
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
 */
export function newRoomId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
  }
  return out;
}

/**
 * Builds a full share URL. `base` is the page URL without fragment or search.
 *
 * LZString's URI alphabet includes `+`, which `URLSearchParams` decodes as a
 * space when the fragment is parsed. Escaping `+` as `%2B` keeps the payload
 * intact through a round trip; every other character in the alphabet is
 * already fragment-safe.
 */
export function buildShareUrl(base: string, doc: ErdDocument, room: string): string {
  const clean = base.split('#')[0]!.split('?')[0]!;
  const encoded = encodeSnapshot(doc).replace(/\+/g, '%2B');
  return `${clean}#room=${encodeURIComponent(room)}&d=${encoded}`;
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
      return [
        {
          id: o.id,
          name: asString(o.name, 'Entity'),
          x: asNumber(o.x),
          y: asNumber(o.y),
          kind: o.kind === 'weak' ? 'weak' : 'strong',
        },
      ];
    }),
    attributes: asArray(raw.attributes).flatMap((a) => {
      const o = asObject(a);
      if (!o || typeof o.id !== 'string') return [];
      const kinds = ['simple', 'key', 'multivalued', 'derived', 'composite'] as const;
      const kind = kinds.find((k) => k === o.kind) ?? 'simple';
      return [
        {
          id: o.id,
          name: asString(o.name, 'attribute'),
          x: asNumber(o.x),
          y: asNumber(o.y),
          kind,
          ownerId: typeof o.ownerId === 'string' ? o.ownerId : null,
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
  };

  // Drop legs and attribute owners that reference nodes the link did not carry.
  const ids = new Set([
    ...doc.entities.map((e) => e.id),
    ...doc.relationships.map((r) => r.id),
    ...doc.isas.map((i) => i.id),
  ]);
  doc.legs = doc.legs.filter((l) => ids.has(l.fromId) && ids.has(l.toId));
  doc.attributes = doc.attributes.map((a) =>
    a.ownerId && !ids.has(a.ownerId) ? { ...a, ownerId: null } : a,
  );

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
