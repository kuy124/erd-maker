import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { connectNodes, seedDocument, snapshotFromYdoc } from '../../src/collab/ydoc';
import { writeParticipants } from '../../src/collab/participants';
import { emptyDocument } from '../../src/model/types';
import { decodeSnapshot, encodeSnapshot, normalizeDocument } from '../../src/model/snapshot';
import { binaryEnds, deriveLinks, deriveTables, foreignKeyDirection } from '../../src/model/crowfoot';
import { generateSql } from '../../src/model/sql';
import { segmentForLeg } from '../../src/canvas/geometry';
import { roundedRoutePath } from '../../src/model/connectorRouting';
import { orthogonalPoints } from './svgPath';
import { NODE_SIZE } from '../../src/model/types';

function employee() {
  const doc = emptyDocument();
  doc.entities = [{ id: 'e', name: 'Employee', kind: 'strong', x: 100, y: 100 }];
  doc.attributes = [{ id: 'key', name: 'employee_id', kind: 'key', ownerId: 'e', dataType: 'UUID', x: 100, y: 0 }];
  return doc;
}

it('creates a unary relationship with two editable roles and one undo step', () => {
  const ydoc = new Y.Doc(); seedDocument(ydoc, employee());
  const undo = new Y.UndoManager([ydoc.getMap('relationships'), ydoc.getMap('legs')]);
  let count = 0;
  const id = connectNodes(ydoc, 'e', 'e', kind => kind + ++count);
  const doc = snapshotFromYdoc(ydoc);
  expect(id).not.toBeNull();
  expect(doc.relationships[0]!.y + NODE_SIZE.relationship.h).toBeLessThan(doc.entities[0]!.y);
  expect(doc.legs.map(leg => [leg.toId, leg.cardinality])).toEqual([['e', '1'], ['e', 'N']]);
  const links = deriveLinks(doc), tables = deriveTables(doc);
  expect(links[0]).toMatchObject({ fromEntityId: 'e', toEntityId: 'e' });
  expect(links[0]!.fromColumnId).not.toBe(links[0]!.toColumnId);
  expect(tables[0]!.rows.filter(row => row.fk)).toHaveLength(1);
  expect(generateSql(doc)).toContain('REFERENCES "employee" ("employee_id")');
  expect(undo.undoStack).toHaveLength(1); undo.undo();
  expect(snapshotFromYdoc(ydoc).legs).toHaveLength(0);
  undo.redo(); expect(snapshotFromYdoc(ydoc)).toEqual(doc);
  const first = segmentForLeg(doc, doc.legs[0]!)!, second = segmentForLeg(doc, doc.legs[1]!)!;
  expect(first.from).not.toEqual(second.from);
  expect(first.to).not.toEqual(second.to);
  const key = doc.attributes[0]!;
  for (const path of [first, second]) for (let i = 1; i < path.points!.length; i++) {
    const a = path.points![i - 1]!, b = path.points![i]!;
    for (let step = 0; step <= 100; step++) {
      const x = a.x + (b.x - a.x) * step / 100, y = a.y + (b.y - a.y) * step / 100;
      expect(((x - key.x - 65) / 65) ** 2 + ((y - key.y - 26) / 26) ** 2).toBeGreaterThan(1);
    }
  }
  writeParticipants(ydoc, id!, doc.legs.map((leg, i) => ({ legId: leg.id, entityId: 'e',
    cardinality: i ? 'M' : 'N', participation: { min: 0, max: 'N' } })), () => 'unused');
  expect(generateSql(snapshotFromYdoc(ydoc))).toContain('"employee_employee_id_2"');
});

it('routes unary roles through separate vertical entity stubs and diamond side corners', () => {
  const doc = employee();
  doc.relationships = [{ id: 'r', name: 'manages', kind: 'strong', x: 100, y: -60 }];
  doc.legs = ['1', 'N'].map((cardinality, i) => ({ id: String(i), fromId: 'r', toId: 'e',
    cardinality: cardinality as '1' | 'N', participation: { min: 1, max: i ? 'N' : 1 } }));
  const paths = doc.legs.map(leg => segmentForLeg(doc, leg)!);
  for (const path of paths) {
    expect(path.points).toHaveLength(3);
    const [corner, shoulder, port] = path.points!;
    expect(port!.y).toBe(100); expect(shoulder!.x).toBe(port!.x);
    expect(port!.y - shoulder!.y).toBe(38);
    expect(corner!.y).toBe(-24);
  }
  expect(paths[0]!.from.x).toBe(100); expect(paths[1]!.from.x).toBe(250);
  expect(paths[0]!.to.x).toBeLessThan(paths[1]!.to.x);
  // Moving the diamond to the side rotates the stubs; reversed legacy legs still work.
  doc.relationships[0]!.x = 400; doc.relationships[0]!.y = 100;
  doc.legs[0] = { ...doc.legs[0]!, fromId: 'e', toId: 'r' };
  const side = segmentForLeg(doc, doc.legs[0]!)!.points!;
  expect(side[0]!.x).toBe(250); expect(side[1]!.y).toBe(side[0]!.y);
  expect(side[1]!.x - side[0]!.x).toBe(38);
  doc.legs.push({ ...doc.legs[1]!, id: '2' });
  for (const leg of doc.legs) {
    const path = segmentForLeg(doc, leg)!;
    const corner = leg.fromId === 'r' ? path.from : path.to;
    expect(Math.abs(corner.x - 475) / 75 + Math.abs(corner.y - 136) / 36).toBeCloseTo(1);
  }
});

it('preserves associative entities, keys, and types through peers, JSON, and snapshot links', () => {
  const doc = normalizeDocument({ ...employee(), entities: [{ ...employee().entities[0], kind: 'associative' }] });
  expect(doc.entities[0]!.kind).toBe('associative');
  const alice = new Y.Doc(), bob = new Y.Doc(); seedDocument(alice, doc);
  Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
  expect(snapshotFromYdoc(bob)).toEqual(doc);
  expect(decodeSnapshot(encodeSnapshot(doc))).toEqual(doc);
  expect(normalizeDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  expect(deriveTables(doc)[0]).toMatchObject({ associative: true });
  expect(generateSql(doc)).toContain('"employee_id" UUID NOT NULL');
});

it('keeps multiple unary roles in distinct foreign-key columns and connection bindings', () => {
  const ydoc = new Y.Doc(); seedDocument(ydoc, employee()); let count = 0;
  for (let i = 0; i < 2; i++) connectNodes(ydoc, 'e', 'e', kind => kind + ++count);
  const doc = snapshotFromYdoc(ydoc), rows = deriveTables(doc)[0]!.rows.filter(row => row.fk);
  expect(rows).toHaveLength(2); expect(rows[0]!.id).not.toBe(rows[1]!.id);
  expect(rows[0]!.name).not.toBe(rows[1]!.name);
  expect(new Set(deriveLinks(doc).map(link => link.toColumnId)).size).toBe(2);
  expect(generateSql(doc).match(/FOREIGN KEY/g)).toHaveLength(2);
});

it('does not automatically share a conventional FK attribute between unary relations, but honors explicit sharing', () => {
  const initial = employee(); initial.attributes[0]!.name = 'id';
  initial.attributes.push({ id: 'fk', name: 'employee_id', kind: 'simple', ownerId: 'e', x: 100, y: 300 });
  const ydoc = new Y.Doc(); seedDocument(ydoc, initial); let count = 0;
  for (let i = 0; i < 2; i++) connectNodes(ydoc, 'e', 'e', kind => kind + ++count);
  const doc = snapshotFromYdoc(ydoc);
  expect(deriveTables(doc)[0]!.rows.filter(row => row.fk)).toHaveLength(2);
  expect(deriveLinks(doc).every(link => link.toColumnId !== 'attribute:key')).toBe(true);
  expect(generateSql(doc)).not.toContain('FOREIGN KEY ("id")');
  doc.legs.filter(leg => leg.cardinality === 'N')[1]!.columnId = 'attribute:fk';
  expect(deriveLinks(doc).every(link => link.toColumnId === 'attribute:fk')).toBe(true);
  expect(generateSql(doc)).not.toContain('FOREIGN KEY ("id")');
  for (const leg of doc.legs) if (leg.cardinality === 'N') leg.columnId = 'attribute:fk';
  expect(deriveLinks(doc).every(link => link.toColumnId === 'attribute:fk')).toBe(true);
  expect(generateSql(doc).match(/FOREIGN KEY/g)).toHaveLength(1);
});

it('preserves explicit unary bindings to legacy generated foreign-key row IDs', () => {
  const ydoc = new Y.Doc(); seedDocument(ydoc, employee()); let count = 0;
  connectNodes(ydoc, 'e', 'e', kind => kind + ++count);
  const doc = snapshotFromYdoc(ydoc), legacyId = 'foreign:e:attribute:key';
  doc.legs.find(leg => leg.cardinality === 'N')!.columnId = legacyId;
  expect(deriveTables(doc)[0]!.rows.find(row => row.id === legacyId)?.fk).toBe(true);
  expect(deriveLinks(doc)[0]!.toColumnId).toBe(legacyId);
  expect(() => generateSql(doc)).not.toThrow();
});

it('treats associative entities as regular entities when inferring foreign-key direction', () => {
  const doc = employee(); doc.entities.push({ id: 'association', name: 'Assignment', kind: 'associative', x: 500, y: 100 });
  doc.relationships = [{ id: 'r', name: 'owns', kind: 'weak', x: 300, y: 100 }];
  doc.legs = [{ id: 'a', fromId: 'r', toId: 'association', cardinality: 'N', participation: { min: 0, max: 'N' } },
    { id: 'b', fromId: 'r', toId: 'e', cardinality: '1', participation: { min: 0, max: 1 } }];
  expect(foreignKeyDirection(doc, binaryEnds(doc, 'r')!)![0].entity.id).toBe('association');
});

it('rounds manual turns while keeping endpoint alignment and avoiding table corners', () => {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 300, y: 100 }];
  const guard = { a: points[0]!, b: points[3]!, aStub: { x: 36, y: 0 }, bStub: { x: 264, y: 100 }, obstacles: [] };
  const path = roundedRoutePath(points, guard);
  expect(path).toContain('Q100 0'); expect(orthogonalPoints(path)).toEqual(points);
  expect(roundedRoutePath(points, { ...guard, obstacles: [{ minX: 92, maxX: 99, minY: 1, maxY: 10 }] })).not.toContain('Q100 0');
});
