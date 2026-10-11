/**
 * Groups.
 *
 * The pure half: the derived frame, the pruning rule, what a drag carries, and
 * how groups survive a share link. The behaviour is covered end to end in
 * editor.spec.ts; these are the parts that can be pinned exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  allNodes,
  emptyDocument,
  groupFrame,
  pruneGroups,
  removeNode,
  sizeOf,
  type ErdDocument,
} from '../../src/model/types';
import { dragSet } from '../../src/canvas/geometry';
import { decodeSnapshot, encodeSnapshot } from '../../src/model/snapshot';

function scene(): ErdDocument {
  const doc = emptyDocument('Grouped');
  doc.entities = [
    { id: 'a', name: 'Alpha', x: 0, y: 0, kind: 'strong' },
    { id: 'b', name: 'Beta', x: 400, y: 200, kind: 'strong' },
    { id: 'c', name: 'Gamma', x: 900, y: 0, kind: 'strong' },
  ];
  doc.groups = [{ id: 'g1', name: 'Pair', memberIds: ['a', 'b'] }];
  return doc;
}

describe('groupFrame', () => {
  it('spans its members with a margin, and ignores everything else', () => {
    const doc = scene();
    const frame = groupFrame(doc, doc.groups[0]!)!;
    const sizeA = sizeOf(doc, 'a');
    const sizeB = sizeOf(doc, 'b');
    expect(frame.minX).toBe(0 - 18);
    expect(frame.minY).toBe(0 - 18);
    expect(frame.maxX).toBe(400 + sizeB.w + 18);
    expect(frame.maxY).toBe(200 + sizeB.h + 18);
    expect(frame.minX).toBeLessThan(sizeA.w);
  });

  it('is null for a group with nothing to draw around', () => {
    const doc = scene();
    expect(groupFrame(doc, { id: 'x', name: 'Empty', memberIds: [] })).toBeNull();
    expect(groupFrame(doc, { id: 'x', name: 'Gone', memberIds: ['nope'] })).toBeNull();
  });

  it('tracks a member as it moves, because nothing about the frame is stored', () => {
    const doc = scene();
    const before = groupFrame(doc, doc.groups[0]!)!;
    doc.entities[1]!.y = 600;
    const after = groupFrame(doc, doc.groups[0]!)!;
    expect(after.maxY - after.minY).toBeGreaterThan(before.maxY - before.minY);
  });
});

describe('pruneGroups', () => {
  it('dissolves a group whose members no longer all exist', () => {
    const doc = scene();
    doc.entities = doc.entities.filter((e) => e.id !== 'b');
    // Alpha is left holding a frame around itself, which says nothing.
    expect(pruneGroups(doc).groups).toEqual([]);
  });

  it('keeps a group whose members are all still there', () => {
    const doc = scene();
    doc.entities = doc.entities.filter((e) => e.id !== 'c');
    expect(pruneGroups(doc).groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('drops a group left with fewer than two members', () => {
    const doc = scene();
    doc.groups.push({ id: 'g2', name: 'Loner', memberIds: ['c'] });
    // Gamma was alone, so it never should have been a group at all.
    const pruned = pruneGroups(doc);
    expect(pruned.groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('returns the same document when nothing needs pruning', () => {
    const doc = scene();
    doc.groups = [{ id: 'g1', name: 'Pair', memberIds: ['a', 'b'] }];
    expect(pruneGroups(doc)).toBe(doc);
  });

  it('removes a deleted shape from its group', () => {
    const doc = removeNode(scene(), 'a');
    expect(doc.groups.map((g) => g.id)).toEqual([]);
  });
});

describe('dragSet', () => {
  it('carries the whole group when a member is dragged', () => {
    const doc = scene();
    expect(dragSet(doc, 'a', [])).toEqual(['a', 'b']);
    expect(dragSet(doc, 'b', [])).toEqual(['a', 'b']);
  });

  it('carries just that shape when it is in no group', () => {
    expect(dragSet(scene(), 'c', [])).toEqual(['c']);
  });

  it('lets an explicit selection win over membership', () => {
    const doc = scene();
    // Two shapes chosen by hand are what the person meant to move, even if one
    // of them is grouped with something else.
    expect(dragSet(doc, 'a', ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('still carries the group when only one of its members is selected', () => {
    // Clicking a grouped shape selects just that shape, and dragging it has to
    // bring the group along anyway. Otherwise the same shape would behave
    // differently depending on whether it happened to be selected.
    expect(dragSet(scene(), 'a', ['a'])).toEqual(['a', 'b']);
  });
});

describe('groups in a share link', () => {
  it('round-trips through the snapshot', () => {
    const doc = scene();
    const decoded = decodeSnapshot(encodeSnapshot(doc))!;
    expect(decoded.groups).toEqual(doc.groups);
  });

  it('loads an older link that had no groups at all', () => {
    const legacy = { ...emptyDocument(), groups: undefined } as unknown as ErdDocument;
    const decoded = decodeSnapshot(encodeSnapshot(legacy as ErdDocument))!;
    expect(decoded.groups).toEqual([]);
  });

  it('discards a group whose members the link did not carry', () => {
    const doc = emptyDocument('Partial');
    doc.entities = [{ id: 'a', name: 'Alpha', x: 0, y: 0, kind: 'strong' }];
    doc.groups = [{ id: 'g1', name: 'Pair', memberIds: ['a', 'missing'] }];
    const decoded = decodeSnapshot(encodeSnapshot(doc))!;
    // One member left is no longer a group.
    expect(decoded.groups).toEqual([]);
    expect(decoded.entities.map((e) => e.id)).toEqual(['a']);
  });

  it('ignores a group claiming a shape that is not positioned', () => {
    const doc = scene();
    doc.groups.push({ id: 'g3', name: 'Legs', memberIds: ['nope'] });
    const decoded = decodeSnapshot(encodeSnapshot(doc))!;
    expect(decoded.groups.some((g) => g.id === 'g3')).toBe(false);
    expect(allNodes(decoded)).toHaveLength(3);
  });
});
