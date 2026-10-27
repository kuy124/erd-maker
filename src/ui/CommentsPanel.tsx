import { useEffect, useState } from 'react';
import { colorFromSeed, initials, presenceInk } from '../collab/identity';
import type { DiagramComment } from '../model/types';
import type { EditorState } from '../state/useEditor';
import { WorkspaceIcon } from './WorkspaceIcon';

export function CommentAuthor({ state, comment, timestamp = false }: { state: EditorState; comment?: DiagramComment; timestamp?: boolean }) {
  const mine = !comment || comment.authorId === state.identity.userId;
  const name = mine ? state.identity.name : state.peers.find(peer => peer.userId === comment.authorId)?.name ?? comment.authorName;
  const id = comment?.authorId ?? state.identity.userId;
  const { color } = colorFromSeed(id.charCodeAt(0));
  return <div className="comment-author" title={`Author ID: ${id}`}>
    <span className="comment-avatar" aria-hidden="true" style={{ background: color, color: presenceInk(color) }}>{initials(name)}</span>
    <div className="comment-author__name"><strong>{name}</strong>{mine ? <span className="comment-you">You</span> : null}
      {comment && name !== comment.authorName ? <small>Posted as {comment.authorName}</small> : null}
      {timestamp && comment ? <time dateTime={new Date(comment.createdAt).toISOString()} title={new Date(comment.createdAt).toLocaleString()}>
        {new Date(comment.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
      </time> : null}
    </div>
  </div>;
}

export function CommentsPanel({ state, open, hasDraft, onPlace, onLocate }: {
  state: EditorState; open: boolean; hasDraft: boolean; onPlace: () => void; onLocate: (comment: DiagramComment) => void;
}) {
  const [query, setQuery] = useState('');
  const [thisView, setThisView] = useState(false);
  const comments = state.threads;
  const search = query.trim().toLocaleLowerCase();
  const visible = comments.map(({ comment, replies }, index) => ({ comment, replies, number: index + 1, latest: replies[replies.length - 1] ?? comment }))
    .sort((a, b) => b.latest.createdAt - a.latest.createdAt || b.number - a.number).filter(({ comment, replies }) => {
    if (thisView && comment.location?.view !== state.view) return false;
    return !search || [comment, ...replies].some(message => {
      const name = message.authorId === state.identity.userId ? state.identity.name : state.peers.find(peer => peer.userId === message.authorId)?.name;
      return [message.text, message.authorName, name ?? ''].some(value => value.toLocaleLowerCase().includes(search));
    });
  });
  useEffect(() => {
    if (open && state.selectedCommentId) document.getElementById('comment-' + state.selectedCommentId)?.scrollIntoView({ block: 'nearest' });
  }, [open, state.selectedCommentId]);

  return <section className="comments-panel" aria-label="Diagram comments">
    <div className="comments-panel__tools">
      <button type="button" className="btn btn--primary comment-new" disabled={!state.loaded} onClick={onPlace}>
        <WorkspaceIcon name="comments" />{hasDraft ? 'Continue draft' : 'New comment'}<kbd>M</kbd>
      </button>
      {hasDraft ? <p className="comment-hint">Your draft is kept while you choose a spot.</p> : null}
      {comments.length > 0 ? <>
        <label className="comment-search"><WorkspaceIcon name="search" />
          <input type="search" aria-label="Search comments" placeholder="Search comments or people…" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="comment-filters" role="group" aria-label="Filter comments">
          <button type="button" className="btn btn--ghost" aria-pressed={!thisView} onClick={() => setThisView(false)}>All comments</button>
          <button type="button" className="btn btn--ghost" aria-pressed={thisView} onClick={() => setThisView(true)}>This view</button>
          <span className="comment-count" aria-label={`${visible.length} comments`}>{visible.length}</span>
        </div>
      </> : null}
    </div>
    {visible.length ? <ol className="comment-list" aria-label="Comments">
      {visible.map(({ comment, replies, number, latest }) => <li key={comment.id} id={'comment-' + comment.id}
        className={`comment-item${state.selectedCommentId === comment.id ? ' comment-item--selected' : ''}`}
        data-comment-id={comment.id} data-author-id={comment.authorId}>
        <button type="button" className="comment-card" aria-label={`Open comment ${number}: ${comment.deleted ? 'Deleted comment' : comment.text}${replies.length ? `, ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : ''}`}
          aria-pressed={state.selectedCommentId === comment.id} onClick={() => onLocate(comment)}>
          <CommentAuthor state={state} comment={comment} />
          <p className={`comment-preview${comment.deleted ? ' comment-removed' : ''}`}>{comment.deleted ? 'Comment deleted by its author.' : comment.text}</p>
          {replies.length > 0 ? <p className="comment-latest-reply"><span>{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>{latest.text}</p> : null}
          <div className="comment-card__footer">
            <span><WorkspaceIcon name="pin" />{comment.location ? `Pin ${number} · ${comment.location.view === 'chen' ? 'Chen' : "Crow's-foot"}` : 'Diagram comment'}</span>
            <time dateTime={new Date(latest.createdAt).toISOString()} title={new Date(latest.createdAt).toLocaleString()}>
              {new Date(latest.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </time>
          </div>
        </button>
      </li>)}
    </ol> : <div className="comments-empty">
      <span className="comments-empty__icon" aria-hidden="true"><WorkspaceIcon name={comments.length ? 'search' : 'comments'} /></span>
      <h3>{comments.length ? 'No matching comments' : 'No comments yet'}</h3>
      <p>{comments.length ? 'Try another search or view all comments.' : 'Click a spot on the diagram to start a thread. Anyone in this room can reply.'}</p>
      {comments.length ? <button type="button" className="btn btn--ghost" onClick={() => { setQuery(''); setThisView(false); }}>Clear filters</button> :
        <span className="comment-hint">Press M to place a comment.</span>}
    </div>}
  </section>;
}
