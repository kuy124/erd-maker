import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MAX_COMMENT_LENGTH } from '../model/comments';
import type { DiagramComment } from '../model/types';
import type { EditorState } from '../state/useEditor';
import { CommentAuthor } from './CommentsPanel';
import { Modal } from './Modals';
import { WorkspaceIcon } from './WorkspaceIcon';

export function CommentPopover({ state, svgRef, draft, setDraft, panel, canvasArea, onPlace, onClose }: {
  state: EditorState; svgRef: React.MutableRefObject<SVGSVGElement | null>;
  draft: string; setDraft: (value: string) => void; panel: string | null;
  canvasArea: () => { x: number; y: number; width: number; height: number } | null;
  onPlace: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const nearEnd = useRef(true);
  const openThread = useRef<string>();
  const title = useId();
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [showLatest, setShowLatest] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const thread = state.threads.find(item => item.comment.id === state.selectedCommentId);
  // A remote deletion must not hide a reply someone is still writing.
  const comment = thread?.comment ?? state.doc.comments.find(item =>
    item.id === state.selectedCommentId && !item.parentId && replyDrafts[item.id]?.trim());
  const replies = thread?.replies ?? [];
  const value = comment ? replyDrafts[comment.id] ?? '' : draft;
  const deleting = state.doc.comments.find(item => item.id === deletingId && !item.deleted && item.authorId === state.identity.userId);
  const location = comment?.location ?? (!state.selectedCommentId ? state.commentLocation : null);
  const visible = !!(comment || location) && (!location || location.view === state.view) && state.tool !== 'comment';
  const number = thread ? state.threads.indexOf(thread) + 1 : null;

  useLayoutEffect(() => {
    const node = ref.current;
    const svg = svgRef.current;
    if (!visible || !node || !svg) return;
    const position = () => {
      if (window.matchMedia('(max-width: 767px)').matches) {
        node.style.removeProperty('left'); node.style.removeProperty('top'); node.style.removeProperty('max-height'); node.style.removeProperty('max-width');
        return;
      }
      const area = canvasArea();
      const matrix = svg.querySelector<SVGGElement>('[data-viewport]')?.getScreenCTM();
      if (!area || !matrix) return;
      const rect = svg.getBoundingClientRect();
      const scale = rect.width / Math.max(1, svg.clientWidth);
      const viewport = window.visualViewport;
      const right = Math.min(area.x + area.width, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - rect.left - 12) / scale;
      const bottom = Math.min(area.y + area.height, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - rect.top - 12) / scale;
      const minX = Math.min(area.x / scale, right - 24), minY = Math.min(area.y / scale, bottom - 24);
      const anchor = location ? new DOMPoint(location.x, location.y).matrixTransform(matrix) :
        { x: rect.left + area.x + area.width / 2, y: rect.top + area.y + area.height / 2 };
      const x = (anchor.x - rect.left) / scale, y = (anchor.y - rect.top) / scale;
      node.style.maxWidth = `${right - minX}px`;
      node.style.maxHeight = `${Math.min(bottom - minY, comment ? 600 : bottom - minY)}px`;
      const width = node.offsetWidth, height = node.offsetHeight;
      const left = x + 28 + width <= right ? x + 28 : x - width - 28;
      node.style.left = `${Math.max(minX, Math.min(left, right - width))}px`;
      node.style.top = `${Math.max(minY, Math.min(y - 44, bottom - height))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(node); observer.observe(svg);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.visualViewport?.removeEventListener('resize', position); };
  }, [visible, location, state.viewport, panel, canvasArea, svgRef]);

  useEffect(() => {
    setError(null); setDeletingId(null); setAnnouncement('');
    if (!visible) return;
    (comment ? ref.current : input.current)?.focus({ preventScroll: true });
    if (!location || !window.matchMedia('(max-width: 767px)').matches) return;
    const revealPin = () => {
      const svg = svgRef.current, node = ref.current;
      const matrix = svg?.querySelector<SVGGElement>('[data-viewport]')?.getScreenCTM();
      if (!svg || !node || !matrix) return;
      const point = new DOMPoint(location.x, location.y).matrixTransform(matrix);
      const rect = svg.getBoundingClientRect();
      const top = rect.top + (canvasArea()?.y ?? 124) + 44, bottom = node.getBoundingClientRect().top - 12;
      if (bottom < top) return;
      const dx = Math.max(rect.left + 28, Math.min(point.x, rect.right - 28)) - point.x;
      const dy = Math.max(top, Math.min(point.y, bottom)) - point.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) state.setViewport(view => ({ ...view, x: view.x + dx, y: view.y + dy }));
    };
    let frame = requestAnimationFrame(revealPin);
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(revealPin); };
    window.visualViewport?.addEventListener('resize', resize);
    return () => { cancelAnimationFrame(frame); window.visualViewport?.removeEventListener('resize', resize); };
  }, [visible, comment?.id, location?.x, location?.y, location?.view]);

  useLayoutEffect(() => {
    const node = messages.current;
    if (!visible || !node) return;
    if (openThread.current !== comment?.id || nearEnd.current) {
      node.scrollTop = node.scrollHeight;
      nearEnd.current = true;
      setShowLatest(false);
    }
    openThread.current = comment?.id;
  }, [visible, comment?.id, replies.length]);

  if (!visible) return null;
  return <>
    <div ref={ref} className="comment-popover" data-thread={!!comment} role="dialog" aria-labelledby={title} tabIndex={-1}
      onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}>
      <header className="comment-popover__header">
        <h2 id={title}><WorkspaceIcon name="pin" />{comment ? number ? `Comment ${number}` : 'Comment' : 'New comment'}
          <span>{location?.view === 'chen' ? 'Chen' : location ? "Crow's-foot" : 'Diagram'}</span>
        </h2>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Close comment" title="Close (Esc)" onClick={onClose}><WorkspaceIcon name="close" /></button>
      </header>
      {comment ? <div className="comment-thread-scroll" ref={messages} onScroll={event => {
        const node = event.currentTarget;
        nearEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
        setShowLatest(!nearEnd.current);
      }}>
        <CommentMessage state={state} comment={comment} onDelete={id => { setError(null); setDeletingId(id); }} />
        <h3 className="comment-reply-heading">{replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</h3>
        <ol className="comment-replies" aria-label="Replies">
          {replies.map(reply => <li key={reply.id}><CommentMessage state={state} comment={reply}
            onDelete={id => { setError(null); setDeletingId(id); }} /></li>)}
        </ol>
      </div> : <CommentAuthor state={state} />}
      {comment && showLatest ? <button type="button" className="btn btn--ghost comment-jump" onClick={() => {
        if (messages.current) messages.current.scrollTop = messages.current.scrollHeight;
        nearEnd.current = true; setShowLatest(false);
      }}>Jump to latest reply</button> : null}
      <form className={`comment-form${comment ? ' comment-reply-form' : ''}`} onSubmit={event => {
          event.preventDefault();
          if (!value.trim()) return;
          try {
            if (!(comment ? state.addReply(comment.id, value) : state.addComment(value))) {
              setError('Could not post your message. Your draft is still here.'); return;
            }
            if (comment) setReplyDrafts(current => ({ ...current, [comment.id]: '' }));
            else setDraft('');
            nearEnd.current = true;
            setError(null); setAnnouncement(comment ? 'Reply posted.' : 'Comment posted.');
            input.current?.focus({ preventScroll: true });
          } catch { setError('Could not post your message. Your draft is still here.'); }
        }}>
          <div className={comment ? 'comment-reply-label' : 'visually-hidden'}>
            <label htmlFor={title + '-input'}>{comment ? 'Reply' : 'New comment'}</label>
            {comment ? <span>{state.identity.name}</span> : null}
          </div>
          <textarea ref={input} id={title + '-input'} className="field__input" placeholder={comment ? 'Write a reply…' : 'What would you like to point out?'} rows={comment ? 2 : 4}
            required maxLength={MAX_COMMENT_LENGTH} value={value} disabled={!state.loaded}
            onChange={event => {
              if (comment) setReplyDrafts(current => ({ ...current, [comment.id]: event.target.value }));
              else setDraft(event.target.value);
              setError(null); setAnnouncement('');
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
          <div className="comment-compose__meta">
            {!comment ? <button type="button" className="btn btn--ghost" onClick={onPlace}><WorkspaceIcon name="pin" />Move pin</button> : null}
            <span className="comment-hint">{value.length > MAX_COMMENT_LENGTH - 500 ? `${value.length}/${MAX_COMMENT_LENGTH}` : 'Ctrl/⌘ + Enter to post'}</span>
            {comment ? <button type="submit" className="btn btn--primary" disabled={!state.loaded || !value.trim()}>Reply</button> : null}
          </div>
          {error ? <p className="field__help field__help--error" role="alert">{error}</p> : null}
          {!comment ? <button type="submit" className="btn btn--primary comment-submit" disabled={!state.loaded || !value.trim()}>Post comment</button> : null}
        </form>
      <span className="visually-hidden" role="status">{announcement}</span>
    </div>
    {deleting ? createPortal(<Modal title={deleting.parentId ? 'Delete reply?' : 'Delete comment?'} onClose={() => setDeletingId(null)} footer={<>
      <button type="button" className="btn btn--ghost" autoFocus onClick={() => setDeletingId(null)}>Cancel</button>
      <button type="button" className="btn btn--danger" onClick={() => {
        try {
          if (!state.removeComment(deleting.id)) { setError('Could not delete this message. Please try again.'); return; }
          setDeletingId(null); setError(null); input.current?.focus({ preventScroll: true });
        } catch { setError('Could not delete this message. Please try again.'); }
      }}>{deleting.parentId ? 'Delete reply' : 'Delete comment'}</button>
    </>}>
      <p>{deleting.parentId ? 'Your other messages stay in the thread.' : 'Replies stay in this thread.'}</p>
      <blockquote className="comment-text">{deleting.text}</blockquote>
      {error ? <p className="field__help field__help--error" role="alert">{error}</p> : null}
    </Modal>, document.body) : null}
  </>;
}

function CommentMessage({ state, comment, onDelete }: { state: EditorState; comment: DiagramComment; onDelete: (id: string) => void }) {
  return <article className="comment-message" data-message-id={comment.id} data-author-id={comment.authorId}>
    <header className="comment-message__header">
      <CommentAuthor state={state} comment={comment} timestamp />
      {!comment.deleted && comment.authorId === state.identity.userId ? <button type="button" className="btn btn--ghost btn--icon comment-delete"
        aria-label={comment.parentId ? 'Delete reply' : 'Delete comment'} title={comment.parentId ? 'Delete reply' : 'Delete comment'}
        onClick={() => onDelete(comment.id)}><WorkspaceIcon name="trash" /></button> : null}
    </header>
    <p className={`comment-text${comment.deleted ? ' comment-removed' : ''}`}>{comment.deleted ? 'Comment deleted by its author.' : comment.text}</p>
    {!comment.deleted ? <details className="comment-attribution"><summary>Author details</summary>
      <p>Posted as <strong>{comment.authorName}</strong></p>
      <code title={`Author ID: ${comment.authorId}`}>#{comment.authorId}</code>
    </details> : null}
  </article>;
}
