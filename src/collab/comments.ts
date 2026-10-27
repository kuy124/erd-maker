import type * as Y from 'yjs';
import type { Identity } from './identity';
import type { CommentLocation, DiagramComment } from '../model/types';
import { normalizeComments } from '../model/comments';

export const COMMENTS = 'comments';

export function readComments(ydoc: Y.Doc): DiagramComment[] {
  return normalizeComments([...ydoc.getMap<unknown>(COMMENTS)].map(([id, value]) =>
    value && typeof value === 'object' ? { ...value, id } : null));
}

export function addComment(ydoc: Y.Doc, identity: Pick<Identity, 'userId' | 'name'>, text: string, location?: CommentLocation, parentId?: string): string | null {
  if (parentId !== undefined && !readComments(ydoc).some(comment => comment.id === parentId && !comment.parentId)) return null;
  const [comment] = normalizeComments([{
    id: crypto.randomUUID(), authorId: identity.userId, authorName: identity.name, text, createdAt: Date.now(),
    ...(location === undefined ? {} : { location }),
    ...(parentId === undefined ? {} : { parentId }),
  }]);
  if (!comment) return null;
  ydoc.getMap<DiagramComment>(COMMENTS).set(comment.id, comment);
  return comment.id;
}

export function removeComment(ydoc: Y.Doc, id: string, authorId: string): boolean {
  const comments = ydoc.getMap<DiagramComment>(COMMENTS);
  const comment = readComments(ydoc).find(item => item.id === id);
  if (!comment || comment.authorId !== authorId || comment.deleted) return false;
  // Retain the anchor even when a concurrent reply has not reached this peer yet.
  comments.set(id, { ...comment, text: '', deleted: true });
  return true;
}
