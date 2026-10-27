import { useRef } from 'react';
import { colorFromSeed, initials, presenceInk } from '../collab/identity';
import type { EditorState } from '../state/useEditor';
import type { Point } from './geometry';

/** Capture placement before shapes, connectors, or tables can start an edit. */
export function useCommentPlacement(state: EditorState, toWorld: (x: number, y: number) => Point) {
  const press = useRef<{ id: number; x: number; y: number } | null>(null);
  const place = (x: number, y: number) => {
    state.setCommentLocation({ ...toWorld(x, y), view: state.view });
    state.setTool('select');
  };
  return {
    onPointerDownCapture: (event: React.PointerEvent<SVGSVGElement>) => {
      if (state.tool !== 'comment' || !state.loaded || event.button !== 0 ||
        (event.target as Element).closest('.comment-pin')) return;
      event.preventDefault();
      event.stopPropagation();
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerUpCapture: (event: React.PointerEvent<SVGSVGElement>) => {
      const start = press.current;
      if (!start || start.id !== event.pointerId) return;
      press.current = null;
      event.preventDefault();
      event.stopPropagation();
      if (state.tool === 'comment' && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) {
        place(event.clientX, event.clientY);
      }
    },
    onPointerCancelCapture: () => { press.current = null; },
    onLostPointerCapture: () => { press.current = null; },
    onKeyDownCapture: (event: React.KeyboardEvent<SVGSVGElement>) => {
      if (state.tool !== 'comment' || !state.loaded || event.key !== 'Enter' ||
        (event.target as Element).closest('.comment-pin')) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      place(rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
  };
}

const PIN_PATH = 'M0 0 L-10 -12 A16 16 0 1 1 10 -12 Z';

export function CommentPins({ state, onSelect }: { state: EditorState; onSelect: (id: string) => void }) {
  const draft = state.commentLocation?.view === state.view ? state.commentLocation : null;
  return <g className="comment-pins">
    {state.threads.map(({ comment, replies }, index) => {
      const point = comment.location;
      if (!point || point.view !== state.view) return null;
      const name = comment.authorId === state.identity.userId ? state.identity.name : state.peers.find(peer => peer.userId === comment.authorId)?.name ?? comment.authorName;
      const { color } = colorFromSeed(comment.authorId.charCodeAt(0));
      return <g key={comment.id} className={`comment-pin${state.selectedCommentId === comment.id ? ' comment-pin--selected' : ''}`}
        data-comment-id={comment.id} transform={`translate(${point.x} ${point.y}) scale(${1 / state.viewport.zoom})`}
        role="button" tabIndex={0} aria-label={`Comment ${index + 1} by ${name}: ${comment.text}`} aria-pressed={state.selectedCommentId === comment.id}
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }}
        onClick={event => { event.stopPropagation(); onSelect(comment.id); }}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault(); event.stopPropagation(); onSelect(comment.id);
        }}>
        <title>{name}{name !== comment.authorName ? ` (posted as ${comment.authorName})` : ''}: {comment.deleted ? 'Comment deleted' : comment.text}{replies.length ? ` (${replies.length} replies)` : ''}</title>
        <rect className="hit-target" x={-22} y={-44} width={44} height={44} />
        <circle className="comment-pin__ring" cx={0} cy={-24} r={23} />
        <path d={PIN_PATH} />
        <circle cx={0} cy={-24} r={12} fill={color} pointerEvents="none" />
        <text x={0} y={-24} textAnchor="middle" dominantBaseline="central" style={{ fill: presenceInk(color) }}>{initials(name)}</text>
        {replies.length > 0 ? <g className="comment-pin__reply-count" aria-hidden="true">
          <rect x={8} y={-48} width={24} height={18} rx={4} />
          <text x={20} y={-35} textAnchor="middle">{replies.length > 99 ? '99+' : replies.length}</text>
        </g> : null}
      </g>;
    })}
    {draft ? <g className="comment-pin comment-pin--draft" aria-hidden="true" pointerEvents="none"
      transform={`translate(${draft.x} ${draft.y}) scale(${1 / state.viewport.zoom})`}>
      <path d={PIN_PATH} />
      <text x={0} y={-24} textAnchor="middle" dominantBaseline="central">+</text>
    </g> : null}
  </g>;
}
