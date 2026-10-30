/**
 * Remote pointer motion.
 *
 * Awareness delivers a peer's cursor in bursts: the relay batches, a background
 * tab throttles its timer, the network jitters. Drawing each arrival as it
 * lands turns a hand moving at an even pace into a cursor that stutters, and
 * the old fix — a 70ms CSS transition with a little overshoot — restarted on
 * every frame, so fast movers wobbled instead of gliding.
 *
 * This keeps a spring per peer and integrates it on animation frames toward the
 * newest published position. The spring carries velocity, so a burst of updates
 * and a single update after a quiet second both resolve into the same continuous
 * motion, and a cursor that stops settles instead of snapping.
 *
 * The trail is the same idea read the other way: recent positions, drawn faintly
 * behind the arrow, so speed is legible at a glance rather than only inferable
 * from how fast the arrow crosses the paper.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CursorTrack extends Point {
  vx: number;
  vy: number;
}

export interface TrailSample extends Point {
  at: number;
}

/**
 * Spring stiffness, as ω = √K.
 *
 * The number is a trade with the click. A cursor tracking a peer moving at
 * 1300 px/s sits about 2·v/ω behind it, so a soft spring lands the arrow tens of
 * pixels short of the shape it is clicking, and the shape would bloom into
 * existence over empty paper. ω ≈ 95 closes that gap inside ~90ms while still
 * absorbing the 30–80ms holes a relay leaves in the feed, which is the stutter
 * this exists to hide.
 */
const STIFFNESS = 9000;
/** Critical damping: fast to arrive, no bounce to watch. */
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/** Integration substep in ms; the explicit solver drifts on long frames. */
const SUBSTEP_MS = 4;
/** Below this the pointer is considered parked, so it can truly rest. */
const SETTLED_PX = 0.05;
/** How far back the comet tail reaches. */
const TRAIL_WINDOW_MS = 110;
/** A tail this opaque is the fastest it reads as motion, not as a smudge. */
const TRAIL_MAX_OPACITY = 0.4;
/** World pixels per millisecond at which the tail reaches full strength. */
const TRAIL_FULL_SPEED_PX_MS = 0.9;
/** Shorter than this, and the tail is noise rather than a direction cue. */
const TRAIL_MIN_STEP_PX = 1.5;

export function createTrack(target: Point): CursorTrack {
  return { x: target.x, y: target.y, vx: 0, vy: 0 };
}

/**
 * Moves one track a `dtMs` closer to `target`, mutating it.
 *
 * Sub-stepped because a throttled tab can hand back a 100ms frame, and a single
 * explicit step that large overshoots the target and rings like a bell.
 */
export function stepTrack(track: CursorTrack, target: Point, dtMs: number): CursorTrack {
  const dt = Math.max(0, dtMs) / 1000;
  if (dt === 0) return track;
  let remaining = dt;
  while (remaining > 0) {
    const step = Math.min(SUBSTEP_MS / 1000, remaining);
    remaining -= step;
    track.vx += (STIFFNESS * (target.x - track.x) - DAMPING * track.vx) * step;
    track.vy += (STIFFNESS * (target.y - track.y) - DAMPING * track.vy) * step;
    track.x += track.vx * step;
    track.y += track.vy * step;
  }
  if (Math.abs(target.x - track.x) < SETTLED_PX && Math.abs(target.y - track.y) < SETTLED_PX &&
    Math.abs(track.vx) < SETTLED_PX && Math.abs(track.vy) < SETTLED_PX) {
    track.x = target.x;
    track.y = target.y;
    track.vx = 0;
    track.vy = 0;
  }
  return track;
}

/** Pixels per millisecond the track is currently covering. */
export function trackSpeed(track: CursorTrack): number {
  return Math.hypot(track.vx, track.vy) / 1000;
}

/** Drops samples the eye can no longer read as one stroke of the pointer. */
export function pushTrail(trail: TrailSample[], point: Point, at: number): TrailSample[] {
  const kept = trail.filter((sample) => at - sample.at <= TRAIL_WINDOW_MS);
  const last = kept[kept.length - 1];
  if (!last || Math.hypot(point.x - last.x, point.y - last.y) > TRAIL_MIN_STEP_PX) {
    kept.push({ x: point.x, y: point.y, at });
  }
  return kept;
}

/**
 * The tail in the cursor's own coordinates.
 *
 * The polyline lives inside the translated cursor group, so every point has to
 * be measured back from where the arrow is now — which is also what makes the
 * tail collapse to nothing once the pointer stops moving.
 */
export function trailPoints(trail: TrailSample[], head: Point): string {
  if (trail.length < 2) return '';
  return trail.map((sample) => `${(sample.x - head.x).toFixed(1)},${(sample.y - head.y).toFixed(1)}`).join(' ');
}

export function trailOpacity(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.round(Math.min(TRAIL_MAX_OPACITY, (speed / TRAIL_FULL_SPEED_PX_MS) * TRAIL_MAX_OPACITY) * 100) / 100;
}

/**
 * Whether this browser has asked for less motion.
 *
 * The spring is what makes a stuttering feed readable, so it stays; the trail is
 * decoration on top of it, so it goes.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
