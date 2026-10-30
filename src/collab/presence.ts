/**
 * The gestures a collaborator can publish alongside its cursor.
 *
 * A human peer only needs a position and a selection. The AI also names what it
 * is doing — hovering, clicking, carrying a shape, lassoing a group, thinking —
 * so the app can draw each gesture without inferring intent from cursor speed.
 */
export type IntentKind = 'hover' | 'press' | 'drag' | 'lasso' | 'think';

export interface PeerIntent {
  kind: IntentKind;
  /** The shape the gesture is aimed at, when there is one. */
  targetId?: string;
  /** Trail of an in-flight lasso, in the notation's own coordinates. */
  lasso?: Array<{ x: number; y: number }>;
}

const KINDS = new Set<string>(['hover', 'press', 'drag', 'lasso', 'think']);
/** A loop needs enough points to read as one; beyond this it is just traffic. */
const LASSO_POINT_LIMIT = 128;

/** Reads an intent from untrusted awareness state, tolerating older peers. */
export function readIntent(raw: unknown): PeerIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { kind?: unknown; targetId?: unknown; lasso?: unknown };
  if (typeof candidate.kind !== 'string' || !KINDS.has(candidate.kind)) return null;
  const intent: PeerIntent = { kind: candidate.kind as IntentKind };
  if (typeof candidate.targetId === 'string') intent.targetId = candidate.targetId;
  if (Array.isArray(candidate.lasso)) {
    const points: Array<{ x: number; y: number }> = [];
    for (const point of candidate.lasso) {
      if (points.length >= LASSO_POINT_LIMIT) break;
      const p = point as { x?: unknown; y?: unknown } | null;
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      points.push({ x: p.x, y: p.y });
    }
    if (points.length > 0) intent.lasso = points;
  }
  return intent;
}
