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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private closed = false;
  private seededRoom = false;

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
   * is enough to make the change look authored rather than teleported.
   */
  flash(doc: ErdDocument, focusId: string | null, typing = false): void {
    this.publishPresence({
      view: doc.view,
      cursor: focusId ? focusPoint(doc, focusId) : null,
      selectedIds: focusId ? [focusId] : [],
      typing,
    });
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
    if (typing) {
      this.typingTimer = setTimeout(() => {
        this.typingTimer = undefined;
        this.publishPresence({ typing: false });
      }, 1200);
    }
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
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = undefined;
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
