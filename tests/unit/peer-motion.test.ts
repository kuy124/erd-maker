import { describe, expect, it } from 'vitest';
import {
  createTrack,
  prefersReducedMotion,
  pushTrail,
  stepTrack,
  trackSpeed,
  trailOpacity,
  trailPoints,
} from '../../src/canvas/peerMotion';

/** Runs the track at a frame rate until it settles or the budget runs out. */
function settle(track: ReturnType<typeof createTrack>, target: { x: number; y: number }, ms: number, frame = 16) {
  let elapsed = 0;
  let close = -1;
  let far = 0;
  while (elapsed < ms) {
    stepTrack(track, target, frame);
    const gap = Math.max(Math.abs(track.x - target.x), Math.abs(track.y - target.y));
    far = Math.max(far, gap);
    if (close < 0 && gap <= 2) close = elapsed + frame;
    elapsed += frame;
    if (track.x === target.x && track.y === target.y && track.vx === 0 && track.vy === 0) break;
  }
  return { elapsed, close, far };
}

describe('cursor spring', () => {
  it('starts a new peer parked on its first position', () => {
    // A cursor that flew in from 0,0 would read as a swoosh across the whole diagram.
    const track = createTrack({ x: 640, y: 220 });
    expect(track).toEqual({ x: 640, y: 220, vx: 0, vy: 0 });
  });

  it('reaches a hop and comes to a true rest', () => {
    const track = createTrack({ x: 0, y: 0 });
    const target = { x: 300, y: 120 };
    const { elapsed, close } = settle(track, target, 1000);
    expect(track.x).toBe(300);
    expect(track.y).toBe(120);
    expect(track.vx).toBe(0);
    // On screen it is at the shape inside a fifth of a second; the last fraction
    // of a pixel is what the longer rest clock is measuring.
    expect(close).toBeLessThan(200);
    expect(elapsed).toBeLessThan(600);
  });

  it('never swings past the target, which is what an overshoot transition looked like', () => {
    const track = createTrack({ x: 0, y: 0 });
    let crossed = false;
    for (let frame = 0; frame < 40 && !crossed; frame += 1) {
      stepTrack(track, { x: 200, y: 0 }, 16);
      crossed = track.x > 200.5;
    }
    expect(crossed).toBe(false);
  });

  it('survives a throttled tab handing back one huge frame', () => {
    const track = createTrack({ x: 0, y: 0 });
    stepTrack(track, { x: 500, y: 500 }, 400);
    expect(Number.isFinite(track.x) && Number.isFinite(track.y)).toBe(true);
    const settled = settle(track, { x: 500, y: 500 }, 1000);
    expect(track.x).toBe(500);
    expect(settled.elapsed).toBeLessThan(600);
  });

  it('keeps moving when the feed goes quiet, then lands on the last position', () => {
    const track = createTrack({ x: 0, y: 0 });
    // One awareness burst mid-hop, and nothing after it — the old transition
    // would have restarted on every message and wobbled.
    stepTrack(track, { x: 120, y: 0 }, 16);
    stepTrack(track, { x: 240, y: 0 }, 16);
    const before = track.x;
    stepTrack(track, { x: 240, y: 0 }, 16);
    expect(track.x).toBeGreaterThan(before);
    settle(track, { x: 240, y: 0 }, 1000);
    expect(track.x).toBe(240);
  });

  it('reads speed in world pixels per millisecond', () => {
    const track = createTrack({ x: 0, y: 0 });
    expect(trackSpeed(track)).toBe(0);
    stepTrack(track, { x: 1000, y: 0 }, 8);
    expect(trackSpeed(track)).toBeGreaterThan(0.05);
  });

  it('ignores a zero-length frame instead of dividing by it', () => {
    const track = createTrack({ x: 10, y: 10 });
    expect(stepTrack(track, { x: 90, y: 90 }, 0)).toEqual({ x: 10, y: 10, vx: 0, vy: 0 });
  });
});

describe('motion trail', () => {
  it('drops samples the eye can no longer read as one stroke', () => {
    const trail = [{ x: -400, y: 0, at: 800 }, { x: -200, y: 0, at: 890 }, { x: -50, y: 0, at: 990 }];
    const kept = pushTrail(trail, { x: 0, y: 0 }, 1000);
    expect(kept.every((sample) => 1000 - sample.at <= 110)).toBe(true);
    expect(kept.map((sample) => sample.x)).toEqual([-200, -50, 0]);
  });

  it('does not sample a jittering pointer to death', () => {
    const kept = pushTrail([{ x: 0, y: 0, at: 1000 }], { x: 0.4, y: 0.2 }, 1005);
    expect(kept).toHaveLength(1);
  });

  it('is drawn relative to the arrow, so a parked cursor has no tail', () => {
    const moving = pushTrail([{ x: 100, y: 100, at: 0 }], { x: 200, y: 100 }, 50);
    expect(trailPoints(moving, { x: 200, y: 100 })).toBe('-100.0,0.0 0.0,0.0');
    expect(trailPoints([{ x: 5, y: 5, at: 0 }], { x: 5, y: 5 })).toBe('');
  });

  it('fades in with speed and caps below a smudge', () => {
    expect(trailOpacity(0)).toBe(0);
    expect(trailOpacity(0.1)).toBeGreaterThan(0);
    expect(trailOpacity(0.45)).toBeLessThanOrEqual(0.4);
    expect(trailOpacity(10)).toBe(0.4);
    expect(trailOpacity(Number.NaN)).toBe(0);
  });

  it('is opt-out in the browser', () => {
    expect(typeof prefersReducedMotion()).toBe('boolean');
  });
});
