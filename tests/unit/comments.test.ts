import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addComment, readComments, removeComment } from '../../src/collab/comments';
import { seedDocument, snapshotFromYdoc } from '../../src/collab/ydoc';
import { commentThreads, MAX_COMMENT_LENGTH, normalizeComments } from '../../src/model/comments';
import { decodeSnapshot, encodeSnapshot, normalizeDocument } from '../../src/model/snapshot';
import { emptyDocument } from '../../src/model/types';

describe('diagram comments', () => {
  it('keeps attribution across renamed rooms and checks ownership by ID, never name', () => {
    const firstRoom = new Y.Doc();
    const anotherRoom = new Y.Doc();
    const author = { userId: 'same-browser', name: 'Original name' };
    const firstId = addComment(firstRoom, author, '  Please review this.  ')!;
    const renamed = { ...author, name: 'Renamed beforehand' };
    addComment(anotherRoom, renamed, 'A comment in another diagram');
    addComment(firstRoom, renamed, 'Back in the first diagram');
    expect(readComments(firstRoom)).toContainEqual(expect.objectContaining({
      id: firstId, authorId: author.userId, authorName: 'Original name', text: 'Please review this.',
    }));
    expect(readComments(firstRoom).every(comment => comment.authorId === renamed.userId)).toBe(true);
    expect(removeComment(firstRoom, firstId, 'different-browser')).toBe(false);
    expect(removeComment(firstRoom, firstId, renamed.name)).toBe(false);
    expect(removeComment(firstRoom, firstId, renamed.userId)).toBe(true);
    expect(commentThreads(readComments(firstRoom))).toHaveLength(1);
    expect(readComments(firstRoom).find(comment => comment.id === firstId)?.text).toBe('');
    firstRoom.destroy();
    anotherRoom.destroy();
  });

  it('merges concurrent posts and preserves attribution through snapshots and reloads', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    seedDocument(a, emptyDocument());
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    addComment(a, { userId: 'alice', name: 'Same name' }, 'From Alice', { view: 'chen', x: 125.25, y: -60.5 });
    addComment(b, { userId: 'bob', name: 'Same name' }, 'From Bob', { view: 'crowfoot', x: -23.5, y: 300 });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readComments(a)).toEqual(readComments(b));
    expect(readComments(a)).toHaveLength(2);
    expect(readComments(a).find(comment => comment.authorId === 'alice')?.location).toEqual({ view: 'chen', x: 125.25, y: -60.5 });
    expect(readComments(a).find(comment => comment.authorId === 'bob')?.location?.view).toBe('crowfoot');
    const doc = snapshotFromYdoc(a);
    const decoded = decodeSnapshot(encodeSnapshot(doc))!;
    expect(decoded).toEqual(doc);
    expect(normalizeDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(normalizeDocument({ name: 'Legacy diagram' }).comments).toEqual([]);
    const reloaded = new Y.Doc();
    seedDocument(reloaded, decoded);
    seedDocument(reloaded, { ...decoded, comments: decoded.comments.map(comment => ({ ...comment, authorName: 'Forged name' })) });
    expect(snapshotFromYdoc(reloaded)).toEqual(doc);
    a.destroy(); b.destroy(); reloaded.destroy();
  });

  it('keeps concurrent replies and attribution when the opening comment is deleted offline', () => {
    const a = new Y.Doc(), b = new Y.Doc();
    const alice = { userId: 'alice', name: 'Alice' }, bob = { userId: 'bob', name: 'Alice' };
    const root = addComment(a, alice, 'Opening comment', { view: 'chen', x: 50, y: -20 })!;
    const original = snapshotFromYdoc(a);
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const firstReply = addComment(a, { ...alice, name: 'Renamed elsewhere' }, 'First reply', undefined, root)!;
    const secondReply = addComment(b, bob, 'Concurrent reply', undefined, root)!;
    expect(addComment(a, alice, 'Missing thread', undefined, 'missing')).toBeNull();
    expect(addComment(a, alice, 'Nested reply', undefined, firstReply)).toBeNull();
    expect(removeComment(b, root, bob.userId)).toBe(false);
    expect(removeComment(a, root, alice.userId)).toBe(true);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(readComments(a)).toEqual(readComments(b));
    const thread = commentThreads(readComments(a))[0]!;
    expect(thread.comment).toMatchObject({ id: root, deleted: true, text: '', location: { view: 'chen', x: 50, y: -20 } });
    expect(thread.replies).toHaveLength(2);
    expect(thread.replies.find(reply => reply.id === firstReply)).toMatchObject({ authorId: 'alice', authorName: 'Renamed elsewhere', parentId: root });
    expect(removeComment(a, secondReply, alice.userId)).toBe(false);
    const continued = addComment(a, bob, 'Continue the thread', undefined, root)!;
    const snapshot = snapshotFromYdoc(a);
    const decoded = decodeSnapshot(encodeSnapshot(snapshot))!;
    expect(decoded).toEqual(snapshot);
    expect(normalizeDocument(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const reloaded = new Y.Doc();
    seedDocument(reloaded, decoded);
    seedDocument(reloaded, original);
    expect(readComments(reloaded)).toEqual(readComments(a));
    expect(removeComment(a, firstReply, alice.userId)).toBe(true);
    expect(removeComment(a, secondReply, bob.userId)).toBe(true);
    expect(removeComment(a, continued, bob.userId)).toBe(true);
    expect(commentThreads(readComments(a))).toEqual([]);
    a.destroy(); b.destroy(); reloaded.destroy();
  });

  it('rejects empty, oversized, unattributed, and malformed comments at the shared boundary', () => {
    const ydoc = new Y.Doc();
    const author = { userId: 'alice', name: 'Alice' };
    expect(addComment(ydoc, author, '   ')).toBeNull();
    expect(addComment(ydoc, author, 'x'.repeat(MAX_COMMENT_LENGTH + 1))).toBeNull();
    const valid = { id: 'c', authorId: 'alice', authorName: 'Alice', text: 'Hello', createdAt: 1 };
    expect(normalizeComments([
      null, [], { ...valid, authorId: undefined }, { ...valid, authorName: '' },
      { ...valid, createdAt: NaN }, { ...valid, createdAt: 9e15 }, { ...valid, text: 42 },
      { ...valid, parentId: '' }, { ...valid, parentId: 42 }, { ...valid, parentId: valid.id }, { ...valid, deleted: 'true' },
      { ...valid, parentId: 'thread', location: { view: 'chen', x: 0, y: 0 } },
      ...[null, {}, { view: 'other', x: 0, y: 0 }, { view: 'chen', x: Infinity, y: 1 },
        { view: 'crowfoot', x: 1, y: NaN }, { view: 'chen', x: 1e20, y: 0 }].map(location => ({ ...valid, location })),
    ])).toEqual([]);
    expect(normalizeComments([valid, valid])).toEqual([valid]);
    ydoc.destroy();
  });
});
