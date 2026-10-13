import LZString from 'lz-string';
import { describe, expect, it } from 'vitest';
import {
  buildShareUrl,
  decodeSnapshot,
  encodeSnapshot,
  newRoomId,
  normalizeDocument,
  parseShareHash,
  ROOM_ID_LENGTH,
} from '../../src/model/snapshot';
import { emptyDocument, type ErdDocument } from '../../src/model/types';

function richDocument(): ErdDocument {
  const doc = emptyDocument('University schema');
  doc.view = 'crowfoot';
  doc.entities.push(
    { id: 'e1', name: 'Student', x: 10, y: 20, kind: 'strong' },
    { id: 'e2', name: 'Dependent', x: 400, y: 20, kind: 'weak' },
  );
  doc.attributes.push(
    { id: 'a1', name: 'student_id', x: 0, y: -80, kind: 'key', ownerId: 'e1' },
    { id: 'a2', name: 'phone', x: 0, y: 80, kind: 'multivalued', ownerId: 'e1' },
    { id: 'a3', name: 'age', x: 100, y: 80, kind: 'derived', ownerId: 'e1' },
    { id: 'a4', name: 'floating', x: 500, y: 500, kind: 'simple', ownerId: null },
  );
  doc.relationships.push({ id: 'r1', name: 'enrolls', x: 200, y: 20, kind: 'strong' });
  doc.isas.push({ id: 'i1', x: 300, y: 20, parentId: 'e1', childIds: ['e2'] });
  doc.legs.push({
    id: 'l1',
    fromId: 'e1',
    toId: 'r1',
    cardinality: 'N',
    participation: { min: 1, max: 'N' },
  });
  return doc;
}

describe('encodeSnapshot / decodeSnapshot', () => {
  /** The schema 1 payload: the document as a plain JSON object. */
  const legacyEncode = (doc: ErdDocument) =>
    LZString.compressToEncodedURIComponent(JSON.stringify({ v: 1, d: doc }));

  it('round-trips a full document losslessly', () => {
    const doc = richDocument();
    const decoded = decodeSnapshot(encodeSnapshot(doc));
    expect(decoded).toEqual(doc);
  });

  it('round-trips the fields the row format adds columns for', () => {
    // Data types, groups, and bound columns are the fields a positional
    // encoding is most likely to drop, so they get their own document rather
    // than riding along in `richDocument`.
    const doc = richDocument();
    doc.attributes[0]!.dataType = 'UUID';
    doc.attributes[1]!.dataType = 'VARCHAR(255)';
    doc.legs[0]!.columnId = 'attribute:a1';
    doc.groups.push({ id: 'g1', name: 'Cohort', memberIds: ['e1', 'r1'] });
    const decoded = decodeSnapshot(encodeSnapshot(doc));
    expect(decoded).toEqual(doc);
    expect(decoded!.legs[0]!.columnId).toBe('attribute:a1');
    expect(decoded!.groups).toEqual([{ id: 'g1', name: 'Cohort', memberIds: ['e1', 'r1'] }]);
  });

  it('still reads a schema 1 link produced by an older build', () => {
    // Schema 1 payloads are objects where schema 2 is an array. A link someone
    // bookmarked has to keep opening after this ships.
    const doc = richDocument();
    doc.attributes[0]!.dataType = 'UUID';
    expect(decodeSnapshot(legacyEncode(doc))).toEqual(doc);
  });

  it('is materially smaller than the schema 1 encoding it replaced', () => {
    // The whole point of the row format. Without this, a change that quietly
    // reverts to objects would pass every other test here.
    const doc = emptyDocument('Warehouse');
    for (let t = 0; t < 10; t += 1) {
      doc.entities.push({ id: `e${t}`, name: `Table ${t}`, x: t * 420, y: 140, kind: 'strong' });
      for (let a = 0; a < 8; a += 1) {
        doc.attributes.push({
          id: `a${t}_${a}`, name: `column_${a}`, kind: a === 0 ? 'key' : 'simple', ownerId: `e${t}`, x: 0, y: 0,
        });
      }
    }
    expect(encodeSnapshot(doc).length).toBeLessThan(legacyEncode(doc).length * 0.65);
  });

  it('rejects an unknown array schema rather than guessing at it', () => {
    const future = LZString.compressToEncodedURIComponent(JSON.stringify([99, 'name', 'chen']));
    expect(decodeSnapshot(future)).toBeNull();
  });

  it('round-trips an empty document', () => {
    const doc = emptyDocument();
    expect(decodeSnapshot(encodeSnapshot(doc))).toEqual(doc);
  });

  it('produces output that survives URLSearchParams round-tripping', () => {
    // LZString's URI alphabet includes `+`, so the *URL* must escape it:
    // URLSearchParams decodes a bare `+` as a space. This is the regression
    // guard for the share-link corruption bug.
    const doc = richDocument();
    const url = buildShareUrl('https://example.com/app/', doc, 'room1');
    const parsed = parseShareHash(new URL(url).hash);
    expect(parsed.doc).toEqual(doc);
  });

  it('compresses a large document well under the raw JSON size', () => {
    const doc = emptyDocument('Big');
    for (let i = 0; i < 200; i += 1) {
      doc.entities.push({ id: `e${i}`, name: `Entity number ${i}`, x: i * 10, y: i * 5, kind: 'strong' });
    }
    const raw = JSON.stringify(doc).length;
    const encoded = encodeSnapshot(doc).length;
    expect(encoded).toBeLessThan(raw / 2);
  });

  it('returns null for corrupt input instead of throwing', () => {
    expect(decodeSnapshot('not-a-valid-snapshot!!!')).toBeNull();
    expect(decodeSnapshot('')).toBeNull();
  });

  it('returns null when the payload is valid base64 but not JSON', () => {
    const encoded = LZString.compressToEncodedURIComponent('plain text, not json');
    expect(decodeSnapshot(encoded)).toBeNull();
  });

  it('preserves unicode names', () => {
    const doc = emptyDocument('スキーマ');
    doc.entities.push({ id: 'e1', name: '学生 🎓', x: 0, y: 0, kind: 'strong' });
    const decoded = decodeSnapshot(encodeSnapshot(doc));
    expect(decoded?.name).toBe('スキーマ');
    expect(decoded?.entities[0]?.name).toBe('学生 🎓');
  });
});

describe('newRoomId', () => {
  it('is eight characters from an unambiguous alphabet', () => {
    // Pinned explicitly: this is the length of a share link, so changing it
    // should be a decision rather than an accident.
    expect(ROOM_ID_LENGTH).toBe(8);
    const id = newRoomId();
    expect(id).toHaveLength(ROOM_ID_LENGTH);
    // No l, o, 0, or 1 — easy to misread when typed from a screen.
    expect(id).not.toMatch(/[lo01]/);
  });

  it('never emits a confusable character, across the whole alphabet', () => {
    // Walk every index deterministically. Asserting on a single random id only
    // catches a bad character by luck — this fails on every run that the
    // alphabet contains one.
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const id = newRoomId(() => i / 60);
      seen.add(id[0]!);
      expect(id).toHaveLength(ROOM_ID_LENGTH);
      expect(id).not.toMatch(/[lo01]/);
      expect(id).toMatch(/^[a-z2-9]+$/);
    }
    // The walk must actually reach a spread of characters, or it proves little.
    expect(seen.size).toBeGreaterThan(30);
  });

  it('is deterministic given a fixed random source', () => {
    expect(newRoomId(() => 0)).toBe('a'.repeat(ROOM_ID_LENGTH));
    expect(newRoomId(() => 0.999999)).toBe(newRoomId(() => 0.999999));
  });

  it('produces different ids across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRoomId()));
    expect(ids.size).toBe(50);
  });
});

describe('buildShareUrl / parseShareHash', () => {
  it('can build a short live room URL without embedding the document', () => {
    const url = buildShareUrl('https://example.com/app/?old=test#old', richDocument(), 'abc234', false);
    expect(url).toBe('https://example.com/app/#room=abc234');
    expect(parseShareHash(new URL(url).hash)).toEqual({ room: 'abc234' });
  });

  it('preserves a custom signaling server in live and snapshot links', () => {
    for (const includeSnapshot of [false, true]) {
      const url = buildShareUrl('https://example.com/app/?signaling=ws%3A%2F%2Flocalhost%3A4444&old=1#stale', richDocument(), 'abc234', includeSnapshot);
      expect(new URL(url).searchParams.get('signaling')).toBe('ws://localhost:4444');
      expect(new URL(url).searchParams.has('old')).toBe(false);
    }
  });

  it('keeps room identifiers URL-safe in short links', () => {
    const url = buildShareUrl('https://example.com/', emptyDocument(), 'room&with space', false);
    expect(parseShareHash(new URL(url).hash)).toEqual({ room: 'room&with space' });
    expect(url).not.toContain('&d=');
  });
  it('round-trips a room and document through a URL', () => {
    const doc = richDocument();
    const url = buildShareUrl('https://example.com/app/', doc, 'abc123xyz789');
    const hash = new URL(url).hash;
    const parsed = parseShareHash(hash);
    expect(parsed.room).toBe('abc123xyz789');
    expect(parsed.doc).toEqual(doc);
  });

  it('never puts the diagram in the query string', () => {
    const url = buildShareUrl('https://example.com/app/', richDocument(), 'room1');
    const u = new URL(url);
    expect(u.search).toBe('');
    expect(u.hash.length).toBeGreaterThan(10);
  });

  it('strips an existing hash and query from the base url', () => {
    const url = buildShareUrl('https://example.com/app/?old=1#stale', richDocument(), 'r');
    expect(url).not.toContain('old=1');
    expect(url).not.toContain('stale');
  });

  it('handles a hash with only a room', () => {
    const parsed = parseShareHash('#room=onlyroom');
    expect(parsed.room).toBe('onlyroom');
    expect(parsed.doc).toBeUndefined();
  });

  it('handles a hash with only a document', () => {
    const encoded = encodeSnapshot(richDocument());
    const parsed = parseShareHash(`#d=${encoded}`);
    expect(parsed.room).toBeUndefined();
    expect(parsed.doc).toEqual(richDocument());
  });

  it('returns an empty object for an empty or bare hash', () => {
    expect(parseShareHash('')).toEqual({});
    expect(parseShareHash('#')).toEqual({});
  });

  it('ignores a corrupt document but keeps the room', () => {
    const parsed = parseShareHash('#room=r1&d=garbage!!!');
    expect(parsed.room).toBe('r1');
    expect(parsed.doc).toBeUndefined();
  });
});

describe('normalizeDocument', () => {
  it('rejects non-objects and returns an empty document', () => {
    expect(normalizeDocument(null)).toEqual(emptyDocument());
    expect(normalizeDocument('nope')).toEqual(emptyDocument());
    expect(normalizeDocument(42)).toEqual(emptyDocument());
  });

  it('drops malformed nodes rather than throwing', () => {
    const doc = normalizeDocument({
      entities: [{ id: 'good', name: 'Ok' }, { name: 'no id' }, null, 'junk'],
    });
    expect(doc.entities).toHaveLength(1);
    expect(doc.entities[0]?.id).toBe('good');
  });

  it('coerces missing coordinates to zero', () => {
    const doc = normalizeDocument({ entities: [{ id: 'e', name: 'E' }] });
    expect(doc.entities[0]?.x).toBe(0);
    expect(doc.entities[0]?.y).toBe(0);
  });

  it('coerces an unknown attribute kind to simple', () => {
    const doc = normalizeDocument({ attributes: [{ id: 'a', name: 'A', kind: 'nonsense' }] });
    expect(doc.attributes[0]?.kind).toBe('simple');
  });

  it('drops legs referencing nodes that were not carried', () => {
    const doc = normalizeDocument({
      entities: [{ id: 'e1', name: 'E1' }],
      legs: [
        { id: 'l1', fromId: 'e1', toId: 'e1', cardinality: '1', participation: { min: 0, max: 1 } },
        { id: 'l2', fromId: 'e1', toId: 'missing', cardinality: 'N', participation: { min: 0, max: 'N' } },
      ],
    });
    expect(doc.legs.map((l) => l.id)).toEqual(['l1']);
  });

  it('detaches attributes whose owner disappeared', () => {
    const doc = normalizeDocument({
      entities: [{ id: 'e1', name: 'E1' }],
      attributes: [{ id: 'a1', name: 'A', ownerId: 'gone' }],
    });
    expect(doc.attributes[0]?.ownerId).toBeNull();
  });

  it('keeps participation maxima of N and clamps bad values', () => {
    const doc = normalizeDocument({
      entities: [{ id: 'e1', name: 'E1' }],
      legs: [
        { id: 'l1', fromId: 'e1', toId: 'e1', cardinality: 'N', participation: { min: -5, max: 'N' } },
      ],
    });
    expect(doc.legs[0]?.participation.max).toBe('N');
    expect(doc.legs[0]?.participation.min).toBe(0);
  });

  it('defaults the view to chen for an unknown value', () => {
    expect(normalizeDocument({ view: 'holographic' }).view).toBe('chen');
    expect(normalizeDocument({ view: 'crowfoot' }).view).toBe('crowfoot');
  });
});
