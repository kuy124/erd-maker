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
import type { Attribute, DiagramComment, Entity, ErdDocument } from '../src/model/types';

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
const MOVE_MIN_MS = 220;
const MOVE_MAX_MS = 700;
const MOVE_MS_PER_PX = 0.7;
/** Long hops bow off the straight line a little; short ones stay exact. */
const MOVE_BOW_FROM_PX = 40;
const MOVE_BOW_RATIO = 0.06;
const MOVE_BOW_MAX_PX = 26;

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
 * A point along the travel path at `t` in 0..1.
 *
 * The path is a quadratic curve rather than a straight line: a real pointer
 * bows as the wrist pivots, and the small arc is what makes a long hop look
 * moved rather than animated by a transition. At t = 1 the result is exactly
 * the destination, so the cursor rests precisely on the shape.
 */
export function travelPoint(from: CursorPoint, to: CursorPoint, t: number): CursorPoint {
  const eased = travelEase(t);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: to.x, y: to.y };
  const bow = length > MOVE_BOW_FROM_PX ? Math.min(MOVE_BOW_MAX_PX, length * MOVE_BOW_RATIO) : 0;
  const control = {
    x: (from.x + to.x) / 2 - (dy / length) * bow,
    y: (from.y + to.y) / 2 + (dx / length) * bow,
  };
  const rest = 1 - eased;
  return {
    x: rest * rest * from.x + 2 * rest * eased * control.x + eased * eased * to.x,
    y: rest * rest * from.y + 2 * rest * eased * control.y + eased * eased * to.y,
  };
}

/** A `ws` socket that claims the origin the relay allowlists. */
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
  private travel: { from: CursorPoint; to: CursorPoint; started: number; duration: number } | null = null;
  private typingOnArrival = false;

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
    live.publishPresence({ cursor: null, selectedIds: [], view: 'chen', typing: false });

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
    if (focusId) this.focusId = focusId;
    const point = presenceAt(doc, this.focusId, this.watchedView(doc.view));
    this.cursorView = point.view;
    this.cursorSelection = point.selectedIds;
    this.moveTo(point.cursor, typing);
  }

  /**
   * Starts, retargets, or finishes a pointer hop.
   *
   * Retargeting mid-hop keeps the in-flight position, so a burst of edits —
   * streaming a whole diagram — reads as one continuous pointer rather than a
   * series of separate animations.
   */
  private moveTo(target: CursorPoint | null, typing: boolean): void {
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
    this.typingOnArrival = typing;
    this.travel = {
      from: { ...this.cursor },
      to: { x: target.x, y: target.y },
      started: Date.now(),
      duration: travelDurationMs(this.cursor, target),
    };
    this.publishPresence({ cursor: this.cursor, selectedIds: this.cursorSelection, view: this.cursorView, typing: false });
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
    this.cursor = travelPoint(travel.from, travel.to, progress);
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

  private publishArrival(typing: boolean): void {
    this.publishPresence({
      cursor: this.cursor,
      selectedIds: this.cursor ? this.cursorSelection : [],
      view: this.cursorView,
      typing,
    });
    this.clearTyping();
    if (typing) {
      this.typingTimer = setTimeout(() => {
        this.typingTimer = undefined;
        this.publishPresence({ typing: false });
      }, 1200);
    }
  }

  private stopMotion(): void {
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.moveTimer = undefined;
    this.travel = null;
  }

  private clearTyping(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
  }

  /** Replaces the room's content, optionally shape by shape for a watcher. */
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

    const steps = doc.entities.length + doc.relationships.length + doc.isas.length + 1;
    const pace = Math.round(Math.min(160, Math.max(45, 2600 / Math.max(1, steps))));
    const written = new Set<string>();

    for (const entity of doc.entities) {
      const attributes = ownedAttributes(doc, entity.id);
      for (const attribute of attributes) written.add(attribute.id);
      this.ydoc.transact(() => {
        upsertEntity(this.ydoc, entity);
        for (const attribute of attributes) upsertAttribute(this.ydoc, attribute);
      });
      this.flash(doc, entity.id, true);
      await pause(pace);
    }

    for (const relationship of doc.relationships) {
      const attributes = ownedAttributes(doc, relationship.id);
      for (const attribute of attributes) written.add(attribute.id);
      const legs = doc.legs.filter((leg) => leg.fromId === relationship.id || leg.toId === relationship.id);
      this.ydoc.transact(() => {
        upsertRelationship(this.ydoc, relationship);
        for (const attribute of attributes) upsertAttribute(this.ydoc, attribute);
        for (const leg of legs) upsertLeg(this.ydoc, leg);
      });
      this.flash(doc, relationship.id, true);
      await pause(pace);
    }

    for (const isa of doc.isas) {
      const attributes = ownedAttributes(doc, isa.id);
      for (const attribute of attributes) written.add(attribute.id);
      this.ydoc.transact(() => {
        upsertIsa(this.ydoc, isa);
        for (const attribute of attributes) upsertAttribute(this.ydoc, attribute);
      });
      this.flash(doc, isa.id, true);
      await pause(pace);
    }

    this.ydoc.transact(() => {
      for (const attribute of doc.attributes) {
        if (!written.has(attribute.id)) upsertAttribute(this.ydoc, attribute);
      }
      for (const group of doc.groups) upsertGroup(this.ydoc, group);
      const comments = this.ydoc.getMap<DiagramComment>(COMMENTS);
      for (const comment of doc.comments) comments.set(comment.id, comment);
    });
    this.flash(doc, null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopMotion();
    this.clearTyping();
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

function ownedAttributes(doc: ErdDocument, ownerId: string): Attribute[] {
  const found: Attribute[] = [];
  const visit = (id: string) => {
    for (const attribute of doc.attributes) {
      if (attribute.ownerId !== id) continue;
      found.push(attribute);
      visit(attribute.id);
    }
  };
  visit(ownerId);
  return found;
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

/** The live cursor position that makes sense in the current notation. */
function focusPoint(doc: ErdDocument, id: string): { x: number; y: number } | null {
  const entity = ownerEntity(doc, id);
  if (entity && doc.view === 'crowfoot' && entity.crowX !== undefined && entity.crowY !== undefined) {
    return { x: entity.crowX + CROW_WIDTH / 2, y: entity.crowY + CROW_HEADER_HEIGHT / 2 };
  }
  if (entity) return { x: entity.x, y: entity.y };
  const node = [...doc.attributes, ...doc.relationships, ...doc.isas].find((candidate) => candidate.id === id);
  return node ? { x: node.x, y: node.y } : null;
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
