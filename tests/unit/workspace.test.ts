import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getDiagramIssues, validParticipation } from '../../src/model/issues';
import { createExample, EXAMPLES } from '../../src/model/examples';
import { writeParticipants, type RelationshipParticipant } from '../../src/collab/participants';
import { seedDocument, snapshotFromYdoc, upsertEntity } from '../../src/collab/ydoc';
import { parseJsonImport } from '../../src/export';
import { documentBounds } from '../../src/canvas/geometry';
import { applyLayout } from '../../src/model/layout';
import { occupiedBoxes, findFreeSlot } from '../../src/model/placement';
import { emptyDocument } from '../../src/model/types';

describe('diagram checks', () => {
  it('reports names, missing keys, free attributes, and incomplete relationships without changing the model', () => {
    const doc = emptyDocument();
    doc.entities.push({ id: 'e', name: ' ', x: 0, y: 0, kind: 'strong' });
    doc.attributes.push({ id: 'a', name: 'email', x: 0, y: 0, kind: 'simple', ownerId: null });
    doc.relationships.push({ id: 'r', name: '', x: 0, y: 0, kind: 'strong' });
    const before = structuredClone(doc);
    expect(getDiagramIssues(doc).map(({ code, nodeId }) => [code, nodeId])).toEqual([
      ['unnamed', 'e'], ['unnamed', 'r'], ['unattached-attribute', 'a'], ['missing-key', 'e'], ['incomplete-relationship', 'r'],
    ]);
    expect(doc).toEqual(before);
  });
  it('checks participation on its affected line', () => {
    const doc = createExample('orders');
    doc.legs[0]!.participation = { min: 3, max: 2 };
    expect(getDiagramIssues(doc)).toEqual([expect.objectContaining({ code: 'invalid-participation', nodeId: 'example_leg_0' })]);
  });
  it.each([[-1, 'N'], [0.5, 'N'], [0, 0], [3, 2], [NaN, 'N'], [0, Infinity], [1e100, 'N']] as const)(
    'rejects invalid range %s / %s', (min, max) => expect(validParticipation(min, max)).toBe(false),
  );
  it.each([[0, 1], [1, 1], [3, 5], [8, 'N']] as const)(
    'allows valid range %s / %s', (min, max) => expect(validParticipation(min, max)).toBe(true),
  );
  it.each(EXAMPLES.map((example) => [example.id] as const))('examples are editable and pass common checks: %s', (id) => {
    const doc = createExample(id);
    expect(doc.entities).toHaveLength(2);
    expect(doc.legs).toHaveLength(2);
    expect(getDiagramIssues(doc)).toEqual([]);
  });
});

const participant = (entityId: string, legId?: string): RelationshipParticipant => ({
  entityId, legId, cardinality: 'N', participation: { min: 0, max: 'N' },
});
function room() {
  const ydoc = new Y.Doc();
  seedDocument(ydoc, createExample('orders'));
  return ydoc;
}
describe('participant transactions', () => {
  it('edits endpoints while preserving the same leg map and ID', () => {
    const ydoc = room();
    const oldMap = ydoc.getMap('legs').get('example_leg_0');
    writeParticipants(ydoc, 'example_relationship', [
      participant('example_entity_1', 'example_leg_0'), participant('example_entity_0', 'example_leg_1'),
    ], () => 'new');
    expect(ydoc.getMap('legs').get('example_leg_0')).toBe(oldMap);
    expect(snapshotFromYdoc(ydoc).legs[0]).toMatchObject({ id: 'example_leg_0', toId: 'example_entity_1', cardinality: 'N' });
  });
  it('keeps an entity-to-relationship leg oriented the same way', () => {
    const ydoc = room();
    const leg = ydoc.getMap<Y.Map<unknown>>('legs').get('example_leg_0')!;
    leg.set('fromId', 'example_entity_0'); leg.set('toId', 'example_relationship');
    writeParticipants(ydoc, 'example_relationship', [participant('example_entity_1', 'example_leg_0')], () => 'new');
    expect(snapshotFromYdoc(ydoc).legs[0]).toMatchObject({ fromId: 'example_entity_1', toId: 'example_relationship' });
  });
  it('retains drafts, n-ary associations and repeated entities for recursive relationships', () => {
    const ydoc = room();
    writeParticipants(ydoc, 'example_relationship', [], () => 'new');
    expect(snapshotFromYdoc(ydoc).relationships).toHaveLength(1);
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(0);
    let id = 0;
    writeParticipants(ydoc, 'example_relationship', [
      participant('example_entity_0'), participant('example_entity_1'), participant('example_entity_0'),
    ], () => 'new' + ++id);
    expect(snapshotFromYdoc(ydoc).legs).toHaveLength(3);
  });
  it('rejects all changes before publishing if any participant is invalid', () => {
    const ydoc = room();
    const before = snapshotFromYdoc(ydoc);
    expect(() => writeParticipants(ydoc, 'example_relationship', [
      participant('example_entity_0', 'example_leg_0'), participant('missing'),
    ], () => 'new')).toThrow('no longer available');
    expect(snapshotFromYdoc(ydoc)).toEqual(before);
    expect(() => writeParticipants(ydoc, 'example_relationship', [
      { ...participant('example_entity_0'), participation: { min: 4, max: 2 } },
    ], () => 'new')).toThrow('Correct');
    expect(snapshotFromYdoc(ydoc)).toEqual(before);
  });
  it('undoes a participant operation in one step while retaining remote edits', () => {
    const alice = room();
    const bob = new Y.Doc();
    Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
    const undo = new Y.UndoManager(alice.getMap('legs'));
    writeParticipants(alice, 'example_relationship', [participant('example_entity_0', 'example_leg_0')], () => 'new');
    upsertEntity(bob, { id: 'remote', name: 'Remote work', x: 10, y: 20, kind: 'strong' });
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(bob));
    expect(snapshotFromYdoc(alice).legs).toHaveLength(1);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(snapshotFromYdoc(alice).legs).toHaveLength(2);
    expect(snapshotFromYdoc(alice).entities.some((entity) => entity.id === 'remote')).toBe(true);
  });
});

describe('imports and active rendering bounds', () => {
  it.each(['null', '[]', '{}', '"diagram"', '{"entities":{}}', '{"entities":null}', 'broken'])(
    'rejects invalid JSON documents before normalization: %s', (input) => {
      expect(parseJsonImport(input).error).toBeTruthy();
      expect(parseJsonImport(input).doc).toBeNull();
    },
  );
  it('accepts legacy documents with entities and missing optional fields', () => {
    const result = parseJsonImport('{"entities":[{"id":"old","name":"Legacy","x":0,"y":0}],"view":"crowfoot"}');
    expect(result.error).toBeNull();
    expect(result.doc?.view).toBe('crowfoot');
  });
  it('frames the table height and ignores invisible Chen concepts in table view', () => {
    const doc = createExample('orders');
    doc.view = 'crowfoot';
    doc.isas.push({ id: 'hidden', x: 9999, y: 9999, parentId: null, childIds: [] });
    const boxes = occupiedBoxes(doc);
    const bounds = documentBounds(doc, 0);
    expect(bounds.maxY).toBe(Math.max(...boxes.map((box) => box.y + box.h)));
    expect(bounds.maxX).toBeLessThan(9999);
  });
  it('arranges tall tables without overlapping them', () => {
    const doc = createExample('orders');
    doc.view = 'crowfoot';
    for (let index = 0; index < 20; index++) doc.attributes.push({
      id: 'tall' + index, name: 'field' + index, x: 0, y: 0, kind: 'simple', ownerId: doc.entities[0]!.id,
    });
    const boxes = occupiedBoxes(applyLayout(doc));
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue;
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });
  it('finds a safe fallback beyond an unusually large occupied area', () => {
    const slot = findFreeSlot([{ x: -100, y: -100, w: 10000, h: 10000 }]);
    expect(slot.y).toBeGreaterThan(9900);
  });
});
