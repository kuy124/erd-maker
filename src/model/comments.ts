import type { CommentLocation, DiagramComment } from './types';

export const MAX_COMMENT_LENGTH = 2000;

/** Used for both imported snapshots and untrusted peer updates. */
export function normalizeComments(input: unknown): DiagramComment[] {
  if (!Array.isArray(input)) return [];
  const comments = new Map<string, DiagramComment>();
  const validId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value;
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const { id, authorId, authorName, text, createdAt, location, parentId, deleted } = value as Record<string, unknown>;
    if (!validId(id) || !validId(authorId) || typeof authorName !== 'string' || typeof text !== 'string') continue;
    if (parentId !== undefined && (!validId(parentId) || parentId === id || location !== undefined)) continue;
    if (deleted !== undefined && typeof deleted !== 'boolean') continue;
    const name = authorName.trim().slice(0, 32);
    const body = deleted ? '' : text.trim();
    if (!name || (!deleted && !body) || body.length > MAX_COMMENT_LENGTH || typeof createdAt !== 'number' ||
      !Number.isInteger(createdAt) || createdAt < 0 || createdAt > 8.64e15) continue;
    let point: CommentLocation | undefined;
    if (location !== undefined) {
      if (!location || typeof location !== 'object' || Array.isArray(location)) continue;
      const { x, y, view } = location as Record<string, unknown>;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) ||
        Math.abs(x) > Number.MAX_SAFE_INTEGER || Math.abs(y) > Number.MAX_SAFE_INTEGER ||
        (view !== 'chen' && view !== 'crowfoot')) continue;
      point = { x, y, view };
    }
    comments.set(id, { id, authorId, authorName: name, text: body, createdAt,
      ...(point ? { location: point } : {}), ...(parentId ? { parentId } : {}), ...(deleted ? { deleted: true } : {}) });
  }
  return [...comments.values()].sort((a, b) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function commentThreads(comments: readonly DiagramComment[]) {
  const replies = new Map<string, DiagramComment[]>();
  for (const comment of comments) {
    if (!comment.parentId || comment.deleted) continue;
    const thread = replies.get(comment.parentId) ?? [];
    thread.push(comment);
    replies.set(comment.parentId, thread);
  }
  return comments.flatMap(comment => {
    if (comment.parentId) return [];
    const messages = replies.get(comment.id) ?? [];
    return comment.deleted && messages.length === 0 ? [] : [{ comment, replies: messages }];
  });
}
