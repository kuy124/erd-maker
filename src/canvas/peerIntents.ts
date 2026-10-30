/**
 * What an AI peer's published gesture draws on the paper.
 *
 * The intent is a fact the peer states about itself, so these read it into the
 * shapes a renderer needs and return nothing when the gesture has no one shape
 * to point at. Kept out of the SVG component so the rule is testable without a
 * DOM and the lasso's point parsing has one implementation.
 */

import type { PeerState } from '../collab/provider';

export interface ShapeBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The gestures that aim at one shape, as opposed to sweeping an area. */
const HALO_KINDS = new Set(['hover', 'press', 'drag']);

/** The shape a gesture points at, when it names one. */
export function intentHalo(peer: PeerState): string | null {
  const intent = peer.intent;
  if (!intent || !intent.targetId) return null;
  return HALO_KINDS.has(intent.kind) ? intent.targetId : null;
}

/**
 * The lasso trail as SVG polygon points.
 *
 * Two points are a line, not an enclosure, so a loop is drawn only once it has
 * swept an area. Points arrive from the network and have already been bounded
 * by `readIntent`; rounding keeps the attribute short on every publish.
 */
export function lassoPolygon(peer: PeerState): string | null {
  const intent = peer.intent;
  if (!intent || intent.kind !== 'lasso' || !intent.lasso || intent.lasso.length < 3) return null;
  return intent.lasso.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
