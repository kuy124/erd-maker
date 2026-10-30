/**
 * Live room connection for the MCP.
 *
 * The deployed app syncs through a Cloudflare relay, so the MCP can join the
 * same room as an ordinary Yjs client. Its edits reach every open tab without a
 * refresh, and its awareness state makes it look like any other collaborator.
 *
 * The relay allowlists browser origins, and Node's WebSocket sends none, so
 * every socket claims the app's origin.
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import NodeWebSocket from 'ws';
import { CROW_HEADER_HEIGHT, CROW_WIDTH } from '../src/model/crowfoot';
import { normalizeDocument, parseShareHash } from '../src/model/snapshot';
import { COMMENTS } from '../src/collab/comments';
import {
  ATTRIBUTES,
  ENTITIES,
  GROUPS,
  ISAS,
  LEGS,
  META,
  RELATIONSHIPS,
  setMeta,
  snapshotFromYdoc,
  upsertAttribute,
  upsertEntity,
  upsertGroup,
  upsertIsa,
  upsertLeg,
  upsertRelationship,
} from '../src/collab/ydoc';
import { NODE_SIZE, type DiagramComment, type Entity, type ErdDocument } from '../src/model/types';

const FALLBACK_RELAY = 'wss://erd-sync.cerberus-tusk-proxy.workers.dev';
const FALLBACK_ORIGIN = 'https://kuy124.github.io';
const AI_USER_ID = 'erd-mcp';
const AI_COLOR = '#6B3FA0';
const ROOM_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Pointer travel, in the same cadence the app publishes a real mouse at.
 *
 * A cursor that jumps from shape to shape reads as the page teleporting, not
 * as somebody working. Publishing a frame every 16ms along an eased path gives
 * watchers the same stream of positions a human pointer produces, and the app
 * only needs the awareness field it already reads.
 */
const MOVE_FRAME_MS = 16;
const MOVE_MIN_MS = 320;
const MOVE_MAX_MS = 1250;
const MOVE_MS_PER_PX = 0.95;
/** Long hops bow off the straight line a little; short ones stay exact. */
const MOVE_BOW_FROM_PX = 40;
const MOVE_BOW_RATIO = 0.085;
const MOVE_BOW_MAX_PX = 48;
/** How far a hop's arc may deviate from its nominal bow, as a fraction of it. */
const MOVE_BOW_SPREAD = 0.35;
/**
 * How far past the target the pointer carries before easing back, as a
 * fraction of the hop, and where that follow-through begins.
 *
 * A hand stopping a mouse does not decelerate in a straight line: it travels a
 * hair past the goal and takes it back. Without it every landing looks placed by
 * a transition, however good the approach curve is.
 */
const SETTLE_RATIO = 0.04;
const SETTLE_FROM_T = 0.75;
/**
 * Velocity carried into a retarget, in px/ms, and how much of the hop's length
 * it is allowed to bend the new path.
 *
 * A pointer that is already moving does not restart its muscles: when a new
 * target appears mid-hop, the first part of the new path still leans the way it
 * was going. Below the minimum the previous hop is over, so there is nothing to
 * carry.
 */
const CARRY_MIN_PX_PER_MS = 0.2;
const CARRY_RATIO = 0.18;
/**
 * How much of a stitched route's leg keeps the minimum-jerk shape.
 *
 * At 0 a leg is linear, so the pointer crosses an interior knot at its cruising
 * speed; at 1 it stops dead there, which is the stop-start stream this replaces.
 * A third of the curve makes each knot a check — slow down, click, carry on.
 */
const ROUTE_EASE_BLEND = 0.65;
/** How long the typing indicator is held before the AI leaves a room. */
const FAREWELL_MS = 700;
/** How long a click stays published when the pointer is not moving on. */
const PRESS_MS = 380;

export interface RoomLink {
  room?: string;
  /** App URL without its fragment, for building links back into the room. */
  baseUrl?: string;
  origin?: string;
  /** The snapshot carried by the link, when it had one. */
  doc?: ErdDocument;
}

/**
 * Reads a share URL, a bare fragment, or a room id.
 *
 * A URL without a room is still useful: it names where the app lives, so the
 * caller can generate a room and hand back a link that opens there.
 */
export function roomFromLink(input: string): RoomLink {
  const raw = input.trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return {};

  if (raw.startsWith('#')) {
    const parsed = parseShareHash(raw);
    return {
      ...(parsed.room ? { room: parsed.room } : {}),
      ...(parsed.doc ? { doc: parsed.doc } : {}),
    };
  }

  if (/^https?:\/\//i.test(raw) || raw.includes('#room=')) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return {};
    }
    const parsed = parseShareHash(url.hash);
    return {
      ...(parsed.room ? { room: parsed.room } : {}),
      baseUrl: `${url.origin}${url.pathname}${url.search}`,
      origin: url.origin,
      ...(parsed.doc ? { doc: parsed.doc } : {}),
    };
  }

  if (ROOM_PATTERN.test(raw)) return { room: raw };
  return {};
}

export interface LiveRoomOptions {
  room: string;
  relayUrl?: string;
  relayOrigin?: string;
  /** Content to write when the room has never been used. */
  seed?: ErdDocument;
  /** Where the pointer stood when it last left, so a rejoin does not snap. */
  startCursor?: CursorPoint;
  timeoutMs?: number;
}

export interface LivePeer {
  name: string;
  color: string;
}

export interface CursorPoint {
  x: number;
  y: number;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Minimum-jerk easing: the acceleration profile of a hand moving a mouse. */
export function travelEase(t: number): number {
  const value = Math.min(1, Math.max(0, t));
  return value * value * value * (10 - 15 * value + 6 * value * value);
}

/** How long a hop between two shapes should take, from its distance. */
export function travelDurationMs(from: CursorPoint, to: CursorPoint): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  return Math.round(Math.min(MOVE_MAX_MS, Math.max(MOVE_MIN_MS, distance * MOVE_MS_PER_PX)));
}

/**
 * How far a hop arcs sideways, signed so the arc can fall on either side.
 *
 * A fixed bow makes every hop curve the same way, and a stream of fifty of them
 * reads as a transition replaying rather than as a hand working. Which way the
 * pointer swings is derived from the two endpoints, so it varies from hop to hop
 * but the same pair always arcs identically — a reviewer can rerun the demo and
 * watch the same path.
 */
export function travelBow(from: CursorPoint, to: CursorPoint): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length <= MOVE_BOW_FROM_PX) return 0;
  const nominal = Math.min(MOVE_BOW_MAX_PX, length * MOVE_BOW_RATIO);
  // FNV-1a over the rounded coordinates: cheap, and stable across a restart.
  let hash = 2166136261;
  for (const value of [Math.round(from.x), Math.round(from.y), Math.round(to.x), Math.round(to.y)]) {
    hash = Math.imul(hash ^ (value & 0xff), 16777619) >>> 0;
    hash = Math.imul(hash ^ ((value >> 8) & 0xff), 16777619) >>> 0;
    hash = Math.imul(hash ^ ((value >> 16) & 0xff), 16777619) >>> 0;
    hash = Math.imul(hash ^ ((value >> 24) & 0xff), 16777619) >>> 0;
  }
  const spread = (hash % 1000) / 1000 * 2 - 1;
  return nominal * (1 + spread * MOVE_BOW_SPREAD) * (hash % 2 ? 1 : -1);
}

/**
 * How far past the target a hop carries at `t` in 0..1, along its own line.
 *
 * One half-sine, so the pointer eases out of the cruise into the overshoot and
 * back to zero exactly at the destination. Only the last quarter of the reach
 * has any: a hand does not overshoot while it is still accelerating.
 */
export function settleOffset(t: number, length: number): number {
  if (t <= SETTLE_FROM_T || t >= 1) return 0;
  const part = (t - SETTLE_FROM_T) / (1 - SETTLE_FROM_T);
  return length * SETTLE_RATIO * Math.sin(Math.PI * part);
}

/**
 * The control point of a hop's quadratic, given its sideways bow.
 *
 * A quadratic leaves its first point aimed at the control, so bending the
 * control is how the path is steered. When the pointer was already moving — a
 * retarget, not a cold start — part of that velocity is folded into the control
 * so the new path leaves along the old direction instead of restarting from it.
 */
export function travelControl(
  from: CursorPoint,
  to: CursorPoint,
  bow: number,
  incoming: CursorPoint | null = null,
): CursorPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const plain = {
    x: (from.x + to.x) / 2 - (dy / length) * bow,
    y: (from.y + to.y) / 2 + (dx / length) * bow,
  };
  const speed = incoming ? Math.hypot(incoming.x, incoming.y) : 0;
  if (!incoming || !(speed > CARRY_MIN_PX_PER_MS)) return plain;
  const carry = length * CARRY_RATIO;
  return {
    x: plain.x + (incoming.x / speed) * carry,
    y: plain.y + (incoming.y / speed) * carry,
  };
}

/**
 * A point along the travel path at `t` in 0..1.
 *
 * The path is a quadratic curve rather than a straight line: a real pointer
 * bows as the wrist pivots, and the small arc is what makes a long hop look
 * moved rather than animated by a transition. At t = 1 the result is exactly
 * the destination, so the cursor rests precisely on the shape.
 */
export function travelPoint(
  from: CursorPoint,
  to: CursorPoint,
  t: number,
  incoming: CursorPoint | null = null,
): CursorPoint {
  const eased = travelEase(t);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: to.x, y: to.y };
  const control = travelControl(from, to, travelBow(from, to), incoming);
  const rest = 1 - eased;
  const settle = settleOffset(t, length);
  return {
    x: rest * rest * from.x + 2 * rest * eased * control.x + eased * eased * to.x + (dx / length) * settle,
    y: rest * rest * from.y + 2 * rest * eased * control.y + eased * eased * to.y + (dy / length) * settle,
  };
}

/**
 * Progress along one leg of a stitched route, given whether its ends are rests.
 *
 * A route is travelled as one continuous stroke, so an interior knot must not be
 * reached at zero speed — that is the stop-start stream this replaces. The ends
 * of the whole route keep the full minimum-jerk shape, since the pointer does
 * start from rest there and has to stop somewhere to click the last shape.
 */
export function legEase(p: number, restStart: boolean, restEnd: boolean): number {
  const value = Math.min(1, Math.max(0, p));
  if (restStart && restEnd) return travelEase(value);
  if (restStart) return value * value;
  if (restEnd) return 1 - (1 - value) * (1 - value);
  return value + ROUTE_EASE_BLEND * (travelEase(value) - value);
}

/**
 * A point along a route through several shapes, at `u` in 0..knots-1.
 *
 * Catmull-Rom, so the curve passes exactly through every knot — each one is
 * where a shape gets clicked — while the tangent at a knot is set by its
 * neighbours. That is what stitches separate hops into one stroke: the pointer
 * never leaves the shape it stopped at, and never kinks on the way through it.
 */
export function routePoint(knots: CursorPoint[], u: number): CursorPoint | null {
  if (knots.length === 0) return null;
  const last = knots.length - 1;
  if (last === 0) return { x: knots[0]!.x, y: knots[0]!.y };
  const value = Math.min(last, Math.max(0, u));
  const i = Math.min(last - 1, Math.floor(value));
  const t = value - i;
  const p0 = knots[i - 1] ?? knots[i]!;
  const p1 = knots[i]!;
  const p2 = knots[i + 1]!;
  const p3 = knots[i + 2] ?? knots[i + 1]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const blend = (a: number, b: number, c: number, d: number): number =>
    0.5 * ((2 * b) + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
  return {
    x: blend(p0.x, p1.x, p2.x, p3.x),
    y: blend(p0.y, p1.y, p2.y, p3.y),
  };
}

/** How long each leg of a route takes, timed by its own chord. */
export function routeDurationsMs(knots: CursorPoint[]): number[] {
  const durations: number[] = [];
  for (let i = 1; i < knots.length; i += 1) {
    durations.push(travelDurationMs(knots[i - 1]!, knots[i]!));
  }
  return durations;
}

/** One stitched pass over a stream of shapes. */
interface StreamRoute {
  doc: ErdDocument;
  steps: LiveStep[];
  /** Every shape the pointer passes through, starting where it already is. */
  knots: CursorPoint[];
  /** When each knot is reached, in ms from the start of the route. */
  reaches: number[];
  started: number;
  /** Knots whose shape has been written. */
  written: number;
  /** Set on the frame a knot is crossed; the click lands on the frame after it. */
  arming: boolean;
  resolve: () => void;
}

/** A ws socket that claims the origin the relay allowlists. */
function socketWithOrigin(origin: string): typeof WebSocket {
  class OriginSocket extends NodeWebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { origin });
    }
  }
  return OriginSocket as unknown as typeof WebSocket;
}

export class LiveRoom {
  readonly room: string;
  readonly ydoc: Y.Doc;
  readonly relayUrl: string;
  readonly relayOrigin: string;
  private readonly provider: WebsocketProvider;
  private readonly awareness: Awareness;
  private typingTimer: ReturnType<typeof setTimeout> | undefined;
  private focusId: string | null = null;
  private closed = false;
  private seededRoom = false;
  private cursor: CursorPoint | null = null;
  private cursorView: ErdDocument['view'] = 'chen';
  private cursorSelection: string[] = [];
  private moveTimer: ReturnType<typeof setInterval> | undefined;
  private travel: {
    from: CursorPoint;
    to: CursorPoint;
    started: number;
    duration: number;
    velocity: CursorPoint | null;
  } | null = null;
  private typingOnArrival = false;
  /** Resolves the glide whose landing the caller is awaiting. */
  private arrival: (() => void) | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | undefined;
  /** Selection takes effect on arrival, the way a click does. */
  private pendingSelection: string[] | null = null;
  private route: StreamRoute | null = null;
  private routeTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    room: string,
    ydoc: Y.Doc,
    provider: WebsocketProvider,
    awareness: Awareness,
    relayUrl: string,
    relayOrigin: string,
  ) {
    this.room = room;
    this.ydoc = ydoc;
    this.provider = provider;
    this.awareness = awareness;
    this.relayUrl = relayUrl;
    this.relayOrigin = relayOrigin;
  }

  /**
   * Connects before handing the room back, so a caller never writes into a
   * socket that has not finished its first sync and then silently loses it.
   */
  static async join(options: LiveRoomOptions): Promise<LiveRoom> {
    const room = options.room.trim();
    if (!ROOM_PATTERN.test(room)) {
      throw new Error('A room id is 8 to 128 letters, digits, hyphens, or underscores. Paste a share link or a room id.');
    }
    const relayUrl = (options.relayUrl ?? process.env.ERD_MCP_RELAY_URL ?? FALLBACK_RELAY).trim();
    const relayOrigin = (options.relayOrigin ?? process.env.ERD_MCP_RELAY_ORIGIN ?? FALLBACK_ORIGIN).trim();
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const provider = new WebsocketProvider(relayUrl, room, ydoc, {
      connect: false,
      awareness,
      WebSocketPolyfill: socketWithOrigin(relayOrigin),
      disableBc: true,
      maxBackoffTime: 10000,
    });
    const live = new LiveRoom(room, ydoc, provider, awareness, relayUrl, relayOrigin);
    // Rejoining a room the assistant left keeps the pointer where it stopped:
    // arriving at a shape is a move, not a teleport onto the first one.
    if (options.startCursor) live.cursor = { x: options.startCursor.x, y: options.startCursor.y };
    live.publishPresence({ cursor: live.cursor, selectedIds: [], view: 'chen', typing: false });

    try {
      await live.waitForSync(options.timeoutMs ?? 12_000);
    } catch {
      live.close();
      throw new Error(
        `Could not join room "${room}" through ${relayUrl}. ` +
        `Check the relay is running and that ${relayOrigin} is in its ALLOWED_ORIGINS.`,
      );
    }

    if (options.seed && live.isEmpty()) {
      live.writeAll(options.seed);
      live.seededRoom = true;
    }
    await pause(150);
    return live;
  }

  /** Whether this join wrote the seed content into a room that had none. */
  get seeded(): boolean {
    return this.seededRoom;
  }

  /** People currently in the room, excluding this process. */
  get watching(): number {
    return Math.max(0, this.awareness.getStates().size - 1);
  }

  get peers(): LivePeer[] {
    const peers: LivePeer[] = [];
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return;
      const raw = state as { name?: unknown; color?: unknown };
      peers.push({
        name: typeof raw.name === 'string' && raw.name ? raw.name : `Peer ${clientId}`,
        color: typeof raw.color === 'string' ? raw.color : '#5B6167',
      });
    });
    return peers;
  }

  snapshot(): ErdDocument {
    return snapshotFromYdoc(this.ydoc);
  }

  isEmpty(): boolean {
    return [ENTITIES, ATTRIBUTES, RELATIONSHIPS, ISAS, LEGS, GROUPS, COMMENTS]
      .every((name) => this.ydoc.getMap(name).size === 0);
  }

  /**
   * Shows the AI working at a shape.
   *
   * The app reads presence from awareness, so moving the cursor and selection
   * is enough to make the change look authored rather than teleported. A hop to
   * a different shape is played out as an eased, slightly arched path instead of
   * a single jump, because that is what a pointer being moved looks like.
   *
   * The last shape is kept: a commit with no focus (a re-arrange, a room-level
   * change) used to publish a null cursor, so the arrow vanished mid-session
   * even though the AI was still connected.
   */
  flash(doc: ErdDocument, focusId: string | null, typing = false): void {
    this.aimAt(doc, focusId);
    this.moveTo(presenceAt(doc, this.focusId, this.cursorView).cursor, typing);
  }

  /**
   * Glides to a shape and resolves once the pointer has landed on it.
   *
   * Streaming a diagram uses this so the shape is only written after the
   * cursor arrives: the watcher sees the pointer travel, click, and the shape
   * appear under it, instead of shapes popping in while the cursor lags behind.
   */
  async glideTo(doc: ErdDocument, focusId: string | null, typing = false): Promise<void> {
    // A stream in flight owns the pointer and moves it faster than any single
    // glide could, so an edit that lands mid-stream simply follows it.
    if (this.route) return;
    this.aimAt(doc, focusId);
    const target = presenceAt(doc, this.focusId, this.cursorView).cursor;
    if (!target) {
      this.moveTo(null, false);
      return;
    }
    await new Promise<void>((resolve) => {
      this.arrival = resolve;
      this.moveTo(target, typing);
    });
  }

  /** Points future frames at one shape without starting a hop. */
  private aimAt(doc: ErdDocument, focusId: string | null): void {
    if (focusId) this.focusId = focusId;
    const point = presenceAt(doc, this.focusId, this.watchedView(doc.view));
    this.cursorView = point.view;
    this.pendingSelection = point.selectedIds;
  }

  /**
   * Starts, retargets, or finishes a pointer hop.
   *
   * Retargeting mid-hop keeps the in-flight position, so a burst of edits — a
   * rename and a move in one call — reads as one continuous pointer rather than
   * a series of separate animations.
   */
  private moveTo(target: CursorPoint | null, typing: boolean): void {
    if (this.route) return;
    if (!target) {
      this.stopMotion();
      this.cursor = null;
      this.publishArrival(false);
      return;
    }
    if (!this.cursor) {
      this.cursor = { x: target.x, y: target.y };
      this.publishArrival(typing);
      return;
    }
    const distance = Math.hypot(target.x - this.cursor.x, target.y - this.cursor.y);
    if (distance < 0.75) {
      this.cursor = { x: target.x, y: target.y };
      this.publishArrival(typing);
      return;
    }

    this.clearTyping();
    this.clearPress();
    this.typingOnArrival = typing;
    const incoming = this.hopVelocity();
    this.travel = {
      from: { ...this.cursor },
      to: { x: target.x, y: target.y },
      started: Date.now(),
      duration: travelDurationMs(this.cursor, target),
      velocity: incoming,
    };
    this.publishPresence({
      cursor: this.cursor,
      selectedIds: this.cursorSelection,
      view: this.cursorView,
      typing: false,
      pressing: false,
    });
    if (this.moveTimer) return;
    this.moveTimer = setInterval(() => this.advanceMotion(), MOVE_FRAME_MS);
  }

  /** Publishes the next frame of the current hop, and lands it when due. */
  private advanceMotion(): void {
    const travel = this.travel;
    if (!travel) {
      this.stopMotion();
      return;
    }
    const progress = Math.min(1, (Date.now() - travel.started) / travel.duration);
    this.cursor = travelPoint(travel.from, travel.to, progress, travel.velocity);
    if (progress >= 1) {
      this.cursor = { x: travel.to.x, y: travel.to.y };
      this.travel = null;
      this.stopMotion();
      this.publishArrival(this.typingOnArrival);
      this.typingOnArrival = false;
      return;
    }
    this.publishPresence({
      cursor: this.cursor,
      selectedIds: this.cursorSelection,
      view: this.cursorView,
      typing: false,
    });
  }

  /** The speed the pointer is travelling at now, in px per ms. */
  private hopVelocity(): CursorPoint | null {
    const travel = this.travel;
    if (!travel) return null;
    const progress = (Date.now() - travel.started) / travel.duration;
    if (progress <= 0 || progress >= 1) return null;
    const step = 0.02;
    const before = travelPoint(travel.from, travel.to, progress - step, travel.velocity);
    const after = travelPoint(travel.from, travel.to, progress + step, travel.velocity);
    const span = travel.duration * step * 2;
    return { x: (after.x - before.x) / span, y: (after.y - before.y) / span };
  }

  /**
   * Travels a whole stream of shapes as one continuous stroke.
   *
   * Every shape is a knot of a Catmull-Rom route, so the pointer passes through
   * each one without ever coming to rest between two: it checks — slows to a
   * third of cruising speed, clicks, and carries on. Writing on the crossing is
   * what keeps the shape appearing under the cursor rather than ahead of it, and
   * one hop's travel for fifty shapes is what makes it read as a hand at work
   * rather than a transition replaying.
   */
  private travelRoute(doc: ErdDocument, steps: LiveStep[]): Promise<void> {
    const view = this.watchedView(doc.view);
    this.cursorView = view;
    const knots: CursorPoint[] = this.cursor ? [{ ...this.cursor }] : [];
    for (const step of steps) {
      const point = presenceAt(doc, step.id, view).cursor;
      if (point) knots.push(point);
    }
    const expected = steps.length + (this.cursor ? 1 : 0);
    if (knots.length < 2 || knots.length !== expected) {
      // No curve to stitch through: visit each shape on its own rather than
      // dropping the ones that could not be aimed at.
      return this.travelEach(doc, steps);
    }
    const reaches: number[] = [0];
    for (const duration of routeDurationsMs(knots)) reaches.push(reaches[reaches.length - 1]! + duration);
    return new Promise<void>((resolve) => {
      this.route = { doc, steps, knots, reaches, started: Date.now(), written: 0, arming: false, resolve };
      this.advanceRoute();
      this.routeTimer = setInterval(() => this.advanceRoute(), MOVE_FRAME_MS);
    });
  }

  /** The fallback: one glide and one write per shape, in stream order. */
  private async travelEach(doc: ErdDocument, steps: LiveStep[]): Promise<void> {
    for (const step of steps) {
      await this.glideTo(doc, step.id);
      this.writeStep(doc, step);
    }
  }

  /** Publishes the next frame of the route, clicking every knot it crosses. */
  private advanceRoute(): void {
    const route = this.route;
    if (!route) {
      this.stopRoute();
      return;
    }
    const elapsed = Date.now() - route.started;
    const last = route.knots.length - 1;
    let leg = 0;
    while (leg < last - 1 && elapsed >= route.reaches[leg + 1]!) leg += 1;
    const start = route.reaches[leg]!;
    const end = route.reaches[leg + 1]!;
    const progress = end > start ? Math.min(1, (elapsed - start) / (end - start)) : 1;
    const point = routePoint(route.knots, leg + legEase(progress, leg === 0, leg === last - 1));
    if (point) this.cursor = point;

    let crossed = 0;
    while (crossed < last && elapsed >= route.reaches[crossed + 1]!) crossed += 1;

    if (crossed === last && route.written === last) {
      this.cursor = { x: route.knots[last]!.x, y: route.knots[last]!.y };
      this.stopRoute();
      this.publishArrival(false);
      return;
    }
    if (route.written >= crossed) {
      this.publishRoute(false);
      return;
    }
    if (route.arming) {
      route.arming = false;
      const step = route.steps[route.written]!;
      route.written += 1;
      this.focusId = step.id;
      this.cursorSelection = [step.id];
      this.writeStep(route.doc, step);
      this.publishRoute(true);
      return;
    }
    // Release the previous click one frame before the next is pressed. Published
    // in the same tick they arrive as one awareness message, and the app only
    // replays its press animation when the flag actually changes.
    route.arming = true;
    this.publishRoute(false);
  }

  private publishRoute(pressing: boolean): void {
    this.publishPresence({
      cursor: this.cursor,
      selectedIds: this.cursor ? this.cursorSelection : [],
      view: this.cursorView,
      typing: false,
      pressing,
    });
  }

  private publishArrival(typing: boolean): void {
    if (this.pendingSelection) {
      this.cursorSelection = this.pendingSelection;
      this.pendingSelection = null;
    }
    // Landing is a click: the app plays its press animation from this flag.
    this.publishPresence({
      cursor: this.cursor,
      selectedIds: this.cursor ? this.cursorSelection : [],
      view: this.cursorView,
      typing,
      ...(this.cursor ? { pressing: true } : {}),
    });
    this.clearPress();
    if (this.cursor) {
      this.pressTimer = setTimeout(() => {
        this.pressTimer = undefined;
        this.publishPresence({ pressing: false });
      }, PRESS_MS);
    }
    this.clearTyping();
    if (typing) {
      this.typingTimer = setTimeout(() => {
        this.typingTimer = undefined;
        this.publishPresence({ typing: false });
      }, 1200);
    }
    this.land();
  }

  private stopMotion(): void {
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.moveTimer = undefined;
    this.travel = null;
    this.stopRoute();
  }

  /** Ends the route loop, resolving whoever is awaiting the stream. */
  private stopRoute(): void {
    if (this.routeTimer) clearInterval(this.routeTimer);
    this.routeTimer = undefined;
    const route = this.route;
    if (!route) return;
    this.route = null;
    route.resolve();
  }

  /** Resolves whoever is awaiting the current glide, so a close cannot hang it. */
  private land(): void {
    const resolve = this.arrival;
    this.arrival = null;
    resolve?.();
  }

  private clearTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
  }

  private clearPress(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = undefined;
  }

  /**
   * Replaces the room's content, optionally shape by shape for a watcher.
   *
   * Every step is a glide, a click, and then the shape: the pointer moves to
   * the spot, lands, and the shape appears under it. Writing on arrival (rather
   * than on a shared timer) is what makes the stream read as someone drawing
   * instead of shapes popping in while the cursor lags a shape behind.
   */
  async replace(source: ErdDocument, stream: boolean): Promise<void> {
    const doc = normalizeDocument(source);
    if (!stream || this.watching === 0) {
      this.ydoc.transact(() => {
        this.clearMaps();
        setMeta(this.ydoc, { name: doc.name, view: doc.view });
        writeCollections(this.ydoc, doc);
      });
      this.flash(doc, null);
      return;
    }

    this.ydoc.transact(() => {
      this.clearMaps();
      setMeta(this.ydoc, { name: doc.name, view: doc.view });
    });

    await this.travelRoute(doc, liveSteps(doc));

    this.ydoc.transact(() => {
      for (const group of doc.groups) upsertGroup(this.ydoc, group);
      const comments = this.ydoc.getMap<DiagramComment>(COMMENTS);
      for (const comment of doc.comments) comments.set(comment.id, comment);
    });
  }

  /** Writes one streamed shape, with the lines that make it meaningful. */
  private writeStep(doc: ErdDocument, step: LiveStep): void {
    this.ydoc.transact(() => {
      if (step.kind === 'entity') {
        const entity = doc.entities.find((candidate) => candidate.id === step.id);
        if (entity) upsertEntity(this.ydoc, entity);
        return;
      }
      if (step.kind === 'attribute') {
        const attribute = doc.attributes.find((candidate) => candidate.id === step.id);
        if (attribute) upsertAttribute(this.ydoc, attribute);
        return;
      }
      const relationships = step.kind === 'relationship'
        ? doc.relationships.filter((candidate) => candidate.id === step.id)
        : [];
      for (const relationship of relationships) upsertRelationship(this.ydoc, relationship);
      const isas = step.kind === 'isa' ? doc.isas.filter((candidate) => candidate.id === step.id) : [];
      for (const isa of isas) upsertIsa(this.ydoc, isa);
      for (const leg of doc.legs) {
        if (leg.fromId === step.id || leg.toId === step.id) upsertLeg(this.ydoc, leg);
      }
    });
  }

  /** Where the pointer is right now, for a caller that means to come back. */
  get pointer(): CursorPoint | null {
    return this.cursor ? { x: this.cursor.x, y: this.cursor.y } : null;
  }

  /**
   * Finishes in front of the watchers, then disconnects.
   *
   * Dropping the socket mid-sentence reads as a network failure. Gliding back to
   * the last shape and holding the typing indicator for a beat makes it a
   * departure, and the room's own leaving notice then lands on an exit.
   */
  async leave(doc: ErdDocument): Promise<void> {
    if (this.watching > 0 && this.focusId) {
      await this.glideTo(doc, this.focusId, true);
      await pause(FAREWELL_MS);
    }
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopMotion();
    this.clearTyping();
    this.clearPress();
    this.land();
    try {
      this.awareness.setLocalState(null);
    } catch {
      // Already gone; destroying the rest is still worth doing.
    }
    this.provider.destroy();
    this.awareness.destroy();
    this.ydoc.destroy();
  }

  private writeAll(source: ErdDocument): void {
    const doc = normalizeDocument(source);
    this.ydoc.transact(() => {
      setMeta(this.ydoc, { name: doc.name, view: doc.view });
      writeCollections(this.ydoc, doc);
    });
  }

  private publishPresence(patch: Record<string, unknown>): void {
    // Awareness starts at `{}`, not null, so the identity has to be merged in
    // on every publish: spreading only the state would send a leftover empty
    // one, and watchers would see "Peer 1234" instead of the AI's name.
    const base = {
      userId: AI_USER_ID,
      name: (process.env.ERD_MCP_AI_NAME ?? 'AI assistant').trim() || 'AI assistant',
      color: (process.env.ERD_MCP_AI_COLOR ?? AI_COLOR).trim() || AI_COLOR,
      cursor: null,
      selectedIds: [],
      view: 'chen',
      following: null,
      pressing: false,
      typing: false,
      dragging: null,
      ...(this.awareness.getLocalState() ?? {}),
    };
    this.awareness.setLocalState({ ...base, ...patch });
  }

  /**
   * The notation somebody in the room is actually reading.
   *
   * Cursors are drawn only in the notation the reader chose, so an AI that
   * always published its document's view disappeared for anyone working in the
   * other one. Following a watcher keeps the arrow on their screen.
   */
  private watchedView(fallback: ErdDocument['view']): ErdDocument['view'] {
    let view: ErdDocument['view'] | null = null;
    this.awareness.getStates().forEach((state, clientId) => {
      if (view || clientId === this.awareness.clientID) return;
      const candidate = (state as { view?: unknown }).view;
      if (candidate === 'chen' || candidate === 'crowfoot') view = candidate;
    });
    return view ?? fallback;
  }

  private waitForSync(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.provider.off('sync', onSync);
        if (error) reject(error);
        else resolve();
      };
      const onSync = (synced: boolean) => {
        if (synced) finish();
      };
      timer = setTimeout(() => finish(new Error('Timed out waiting for the relay.')), timeoutMs);
      this.provider.on('sync', onSync);
      this.provider.connect();
    });
  }

  private clearMaps(): void {
    for (const name of [ENTITIES, ATTRIBUTES, RELATIONSHIPS, ISAS, LEGS, GROUPS, COMMENTS, META]) {
      this.ydoc.getMap(name).clear();
    }
  }
}

function writeCollections(ydoc: Y.Doc, doc: ErdDocument): void {
  for (const entity of doc.entities) upsertEntity(ydoc, entity);
  for (const attribute of doc.attributes) upsertAttribute(ydoc, attribute);
  for (const relationship of doc.relationships) upsertRelationship(ydoc, relationship);
  for (const isa of doc.isas) upsertIsa(ydoc, isa);
  for (const leg of doc.legs) upsertLeg(ydoc, leg);
  for (const group of doc.groups) upsertGroup(ydoc, group);
  const comments = ydoc.getMap<DiagramComment>(COMMENTS);
  for (const comment of doc.comments) comments.set(comment.id, comment);
}

export type LiveStepKind = 'entity' | 'attribute' | 'relationship' | 'isa';

export interface LiveStep {
  id: string;
  kind: LiveStepKind;
}

/**
 * The order a streamed diagram is drawn in: every shape the pointer visits.
 *
 * Attributes are steps of their own, right after the shape that owns them. A
 * column that appears while the arrow still sits on the table reads as the AI
 * never touching it; a click on each attribute is what makes the stream look
 * like someone filling the diagram in by hand.
 */
export function liveSteps(doc: ErdDocument): LiveStep[] {
  const steps: LiveStep[] = [];
  const seen = new Set<string>();
  const visitAttributes = (ownerId: string) => {
    for (const attribute of doc.attributes) {
      if (attribute.ownerId !== ownerId || seen.has(attribute.id)) continue;
      seen.add(attribute.id);
      steps.push({ id: attribute.id, kind: 'attribute' });
      visitAttributes(attribute.id);
    }
  };

  for (const entity of doc.entities) {
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    steps.push({ id: entity.id, kind: 'entity' });
    visitAttributes(entity.id);
  }
  for (const relationship of doc.relationships) {
    if (seen.has(relationship.id)) continue;
    seen.add(relationship.id);
    steps.push({ id: relationship.id, kind: 'relationship' });
    visitAttributes(relationship.id);
  }
  for (const isa of doc.isas) {
    if (seen.has(isa.id)) continue;
    seen.add(isa.id);
    steps.push({ id: isa.id, kind: 'isa' });
    visitAttributes(isa.id);
  }
  // An attribute whose owner is missing still belongs in the room, so it gets
  // its own click at the end rather than being dropped from the stream.
  for (const attribute of doc.attributes) {
    if (seen.has(attribute.id)) continue;
    seen.add(attribute.id);
    steps.push({ id: attribute.id, kind: 'attribute' });
  }
  return steps;
}

export interface PresencePoint {
  view: ErdDocument['view'];
  cursor: { x: number; y: number } | null;
  selectedIds: string[];
}

/** Turns a focused shape into awareness fields, resolved for one notation. */
export function presenceAt(doc: ErdDocument, focusId: string | null, view: ErdDocument['view']): PresencePoint {
  const cursor = focusId ? focusPoint({ ...doc, view }, focusId) : null;
  return { view, cursor, selectedIds: focusId && cursor ? [focusId] : [] };
}

/**
 * The live cursor position that makes sense in the current notation.
 *
 * In Chen the pointer lands in the middle of the shape; an arrow resting on a
 * shape's top-left corner reads as a miss. In crow's-foot a table is drawn from
 * its header, so anything owned by an entity points there instead.
 */
function focusPoint(doc: ErdDocument, id: string): { x: number; y: number } | null {
  if (doc.view === 'crowfoot') {
    const owner = ownerEntity(doc, id);
    if (owner) {
      return owner.crowX !== undefined && owner.crowY !== undefined
        ? { x: owner.crowX + CROW_WIDTH / 2, y: owner.crowY + CROW_HEADER_HEIGHT / 2 }
        : { x: owner.x, y: owner.y };
    }
  }
  const entity = doc.entities.find((candidate) => candidate.id === id);
  if (entity) return centerOf(entity, 'entity');
  const attribute = doc.attributes.find((candidate) => candidate.id === id);
  if (attribute) return centerOf(attribute, 'attribute');
  const relationship = doc.relationships.find((candidate) => candidate.id === id);
  if (relationship) return centerOf(relationship, 'relationship');
  const isa = doc.isas.find((candidate) => candidate.id === id);
  return isa ? centerOf(isa, 'isa') : null;
}

function centerOf(shape: { x: number; y: number }, kind: keyof typeof NODE_SIZE): { x: number; y: number } {
  const size = NODE_SIZE[kind];
  return { x: shape.x + size.w / 2, y: shape.y + size.h / 2 };
}

function ownerEntity(doc: ErdDocument, id: string): Entity | undefined {
  let current: string | null = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const entity = doc.entities.find((candidate) => candidate.id === current);
    if (entity) return entity;
    const attribute = doc.attributes.find((candidate) => candidate.id === current);
    if (attribute) {
      current = attribute.ownerId;
      continue;
    }
    const relationship = doc.relationships.find((candidate) => candidate.id === current);
    if (relationship) {
      const leg = doc.legs.find((candidate) => candidate.fromId === relationship.id || candidate.toId === relationship.id);
      current = leg ? (leg.fromId === relationship.id ? leg.toId : leg.fromId) : null;
      continue;
    }
    const isa = doc.isas.find((candidate) => candidate.id === current);
    current = isa?.parentId ?? null;
  }
  return undefined;
}

/**
 * Writes only what changed between two snapshots.
 *
 * A tool call edits the plain document; sending the whole thing back would
 * overwrite concurrent edits to unrelated shapes and undo other people's work.
 */
export function writeDocumentDiff(ydoc: Y.Doc, before: ErdDocument, after: ErdDocument): string[] {
  const diff = {
    entities: changedIds(before.entities, after.entities),
    attributes: changedIds(before.attributes, after.attributes),
    relationships: changedIds(before.relationships, after.relationships),
    isas: changedIds(before.isas, after.isas),
    legs: changedIds(before.legs, after.legs),
    groups: changedIds(before.groups, after.groups),
    comments: changedIds(before.comments, after.comments),
  };
  const changedNodeIds: string[] = [];

  ydoc.transact(() => {
    for (const entity of diff.entities.changed) {
      upsertEntity(ydoc, entity);
      changedNodeIds.push(entity.id);
    }
    for (const id of diff.entities.removed) ydoc.getMap(ENTITIES).delete(id);

    for (const attribute of diff.attributes.changed) {
      upsertAttribute(ydoc, attribute);
      changedNodeIds.push(attribute.id);
    }
    for (const id of diff.attributes.removed) ydoc.getMap(ATTRIBUTES).delete(id);

    for (const relationship of diff.relationships.changed) {
      upsertRelationship(ydoc, relationship);
      changedNodeIds.push(relationship.id);
    }
    for (const id of diff.relationships.removed) ydoc.getMap(RELATIONSHIPS).delete(id);

    for (const isa of diff.isas.changed) {
      upsertIsa(ydoc, isa);
      changedNodeIds.push(isa.id);
    }
    for (const id of diff.isas.removed) ydoc.getMap(ISAS).delete(id);

    for (const leg of diff.legs.changed) upsertLeg(ydoc, leg);
    for (const id of diff.legs.removed) ydoc.getMap(LEGS).delete(id);

    for (const group of diff.groups.changed) upsertGroup(ydoc, group);
    for (const id of diff.groups.removed) ydoc.getMap(GROUPS).delete(id);

    const comments = ydoc.getMap<DiagramComment>(COMMENTS);
    for (const comment of diff.comments.changed) comments.set(comment.id, comment);
    for (const id of diff.comments.removed) comments.delete(id);

    if (before.name !== after.name || before.view !== after.view) {
      setMeta(ydoc, { name: after.name, view: after.view });
    }
  });

  return changedNodeIds;
}

function changedIds<T extends { id: string }>(before: T[], after: T[]): { changed: T[]; removed: string[] } {
  const versions = new Map(before.map((item) => [item.id, JSON.stringify(item)]));
  const present = new Set(after.map((item) => item.id));
  return {
    changed: after.filter((item) => versions.get(item.id) !== JSON.stringify(item)),
    removed: before.filter((item) => !present.has(item.id)).map((item) => item.id),
  };
}
