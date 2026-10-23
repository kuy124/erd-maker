/**
 * Collaboration provider.
 *
 * Wires together the four pieces that make live editing work with no server:
 *
 *   Y.Doc            the shared state
 *   y-indexeddb      local persistence, so a reload does not lose the diagram
 *   y-webrtc         peer-to-peer transport over free public signalling servers
 *   awareness        ephemeral presence: cursors, selections, names
 *
 * Awareness is deliberately separate from the document. Cursor positions
 * change many times a second and must never be persisted or merged into
 * history, which is exactly what awareness is for.
 *
 * Encryption: the room id doubles as the shared secret, so a signalling server
 * only ever sees ciphertext. That is the reason room ids are generated with a
 * wide alphabet rather than being sequential.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { needsReconnect } from './recovery';

const relays = new WeakMap<WebrtcProvider, WebsocketProvider>();

export interface PeerState {
  clientId: number;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  /** Every shape this peer has selected; may be empty. */
  selectedIds: string[];
  /**
   * Which notation the peer is looking at.
   *
   * Published so a cursor is only drawn for a peer who is looking at the same
   * thing. The two notations place the same schema at different coordinates, so
   * a peer's arrow in the other one points at a shape that is not there.
   */
  view: 'chen' | 'crowfoot';
  /** Client id that this peer is following (null when alone/not following). */
  following: number | null;
  /** True while this peer holds the pointer down: drives click animation. */
  pressing: boolean;
  /** True while this peer is typing in a text field. */
  typing: boolean;
  /** In-flight positions while the peer carries (drags) shapes. Ephemeral. */
  dragging: {
    ids: string[];
    /** Where each shape sat when the drag started; the peer-offset is added to these. */
    start: Record<string, { x: number; y: number }>;
    dx: number;
    dy: number;
  } | null;
}

export interface RoomHandle {
  room: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  provider: WebrtcProvider;
  persistence: IndexeddbPersistence;
  /** Resolves once IndexedDB has loaded, so the first render is not empty. */
  whenLoaded: Promise<void>;
  destroy: () => void;
  /** Force a fresh sign-in to the transports and signalling. */
  reconnect: () => void;
}

export interface RoomOptions {
  /** Set false to disable the network transport (used in tests). */
  connect?: boolean;
  /** Set false to disable IndexedDB (used in tests). */
  persist?: boolean;
  signalling?: string[];
}

/**
 * Signaling servers.
 *
 * A signaling server does one small job: introduce two peers so they can open
 * a direct connection, then get out of the way. It never sees diagram content,
 * because the room id doubles as the encryption key.
 *
 * IMPORTANT: this must be a y-webrtc *signaling* server, not a y-websocket
 * server. They are different protocols over the same WebSocket, and pointing
 * at the wrong one fails silently — the socket opens, but peers are never
 * introduced. The list was verified end-to-end with two browser contexts
 * (`npm run test:e2e -- -g multiplayer`), not merely by checking that the
 * socket connects.
 *
 * Override in any of three ways, in priority order:
 *   1. `window.__ERD_SIGNALING__` — a runtime array, used by the E2E tests
 *   2. `?signaling=wss://host1,wss://host2` — handy for a self-hosted server
 *   3. `VITE_SIGNALING` at build time — comma-separated
 *
 * If no server is reachable the app still works: tabs in the same browser sync
 * over BroadcastChannel, and share links carry a snapshot of the diagram. Only
 * cross-device live editing is lost, and the status indicator says so.
 */
const DEFAULT_SIGNALLING = ['wss://signaling.fly.dev'];

function fromQuery(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('signaling');
    if (!raw) return null;
    const list = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

function fromGlobal(): string[] | null {
  if (typeof window === 'undefined') return null;
  const value = (window as unknown as { __ERD_SIGNALING__?: unknown }).__ERD_SIGNALING__;
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return list.length > 0 ? list : null;
  }
  return null;
}

function fromEnv(): string[] | null {
  const raw = import.meta.env?.VITE_SIGNALING as string | undefined;
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** The signaling servers to use, honouring every override. */
export function resolveSignallingServers(): string[] {
  return fromGlobal() ?? fromQuery() ?? fromEnv() ?? DEFAULT_SIGNALLING;
}

/** Deployment-owned TURN credentials; never embed a private long-lived secret. */
export function resolveIceServers(raw = import.meta.env?.VITE_ICE_SERVERS as string | undefined): RTCIceServer[] {
  if (!raw) return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }];
  const servers: unknown = JSON.parse(raw);
  if (!Array.isArray(servers) || !servers.length || !servers.every(server => server &&
    (typeof server.urls === 'string' || Array.isArray(server.urls) && server.urls.every((url: unknown) => typeof url === 'string')))) {
    throw new Error('VITE_ICE_SERVERS must be a JSON array of ICE servers.');
  }
  return servers;
}

/**
 * The local awareness state shape. Kept small: it is broadcast on every
 * pointer move, and every byte here is paid for on every peer's connection.
 */
export interface LocalPresence {
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selectedIds: string[];
  /** Which notation this browser is looking at. */
  view: 'chen' | 'crowfoot';
  /** Client id that this peer is following (null when alone/not following). */
  following: number | null;
  /** Ephemeral in-flight drag; peers see carried shapes move before drop. */
  dragging: {
    ids: string[];
    start: Record<string, { x: number; y: number }>;
    dx: number;
    dy: number;
  } | null;
  /** True while the pointer button is held: drives click/press animations. */
  pressing: boolean;
  /** Ephemeral flag: true while typing in the properties form. */
  typing: boolean;
}

export function createRoom(room: string, options: RoomOptions = {}): RoomHandle {
  const ydoc = new Y.Doc();
  const connect = options.connect ?? true;
  const persist = options.persist ?? true;
  const relayUrl = import.meta.env.VITE_SYNC_URL as string | undefined;

  const persistence = new IndexeddbPersistence(`erd:${room}`, ydoc);

  const provider = new WebrtcProvider(room, ydoc, {
    // The room id is the encryption key; the same id on two peers means the
    // same key, so a relay only ever holds ciphertext.
    password: room,
    signaling: relayUrl ? [] : options.signalling ?? resolveSignallingServers(),
    maxConns: 24,
    filterBcConns: true,
    peerOpts: { config: { iceServers: resolveIceServers() } },
  });
  watchPeers(provider);
  const relay = relayUrl ? new WebsocketProvider(relayUrl, room, ydoc, {
    awareness: new Awareness(ydoc), connect, maxBackoffTime: 10000,
  }) : undefined;
  const presence = relay?.awareness ?? provider.awareness;
  if (relay) {
    relays.set(provider, relay);
    provider.disconnect();
    relay.on('status', () => announceTransport(provider));
    relay.awareness.on('change', () => announceTransport(provider));
  }

  if (!connect) {
    // Still created, so awareness has a home, but with no transports.
    provider.disconnect();
  }
  if (!persist) {
    persistence.destroy();
  }

  /*
   * Leave loudly.
   *
   * Awareness drops a silent client only after `outdatedTimeout`, which is 30
   * seconds in y-protocols. Without this, closing a tab parks the departing
   * collaborator's cursor and name on the diagram for half a minute, and
   * `Editing with` keeps claiming someone is there. Clearing the local state
   * while the transports are still open turns that into an instant removal.
   *
   * `pagehide` rather than `unload` because the latter blocks navigation and is
   * unreliable on mobile, and because a bfcache restore re-fires it.
   */
  const announceLeave = () => presence.setLocalState(null);
  window.addEventListener('pagehide', announceLeave);
  let lastReconnect = 0;
  const reconnect = () => {
    if (!connect || navigator.onLine === false) return;
    if (relay) {
      if (!relay.wsconnected && !relay.wsconnecting) relay.connect();
      return;
    }
    const status = transportState(provider);
    if (status.direct > 0 || Date.now() - lastReconnect < 10000) return;
    lastReconnect = Date.now();
    provider.disconnect();
    // y-webrtc appends on connect but does not empty this array on disconnect.
    // Do not accumulate destroyed signalling clients after every retry.
    provider.signalingConns.length = 0;
    peerLinks.get(provider)?.clear();
    provider.connect();
    announceTransport(provider);
  };
  let suspendedPresence: ReturnType<Awareness['getLocalState']> = null;
  const rememberPresence = () => { suspendedPresence = presence.getLocalState(); };
  // Capture before announceLeave clears presence on a bfcache navigation.
  window.addEventListener('pagehide', rememberPresence, true);
  const resume = () => {
    if (suspendedPresence && !presence.getLocalState()) {
      presence.setLocalState(suspendedPresence);
      suspendedPresence = null;
    }
    if (needsReconnect(transportState(provider), navigator.onLine !== false)) reconnect();
  };
  const onVisible = () => { if (document.visibilityState === 'visible') resume(); };
  window.addEventListener('online', reconnect);
  window.addEventListener('pageshow', resume);
  document.addEventListener('visibilitychange', onVisible);
  // lib0 retries individual sockets; also refresh failed room introductions.
  const retry = window.setInterval(() => {
    if (document.visibilityState === 'visible' && needsReconnect(transportState(provider), navigator.onLine !== false)) reconnect();
  }, 15000);

  return {
    room,
    ydoc,
    awareness: presence,
    provider,
    persistence,
    whenLoaded: persistence.whenSynced.then(() => undefined),
    reconnect,
    destroy: () => {
      window.removeEventListener('pagehide', announceLeave);
      window.removeEventListener('pagehide', rememberPresence, true);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('pageshow', resume);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(retry);
      relay?.destroy();
      if (relay) presence.destroy();
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    },
  };
}

/** Reads a peer's selection, tolerating the single-id shape used before multi-select. */
function readSelectedIds(raw: Partial<LocalPresence> & { selectedId?: unknown }): string[] {
  if (Array.isArray(raw.selectedIds)) return raw.selectedIds.filter((id): id is string => typeof id === 'string');
  if (typeof raw.selectedId === 'string') return [raw.selectedId];
  return [];
}

/** Reads an ephemeral drag, tolerating old or missing shapes. */
function readDragging(raw: Partial<LocalPresence>): PeerState['dragging'] {
  const d = (raw as { dragging?: unknown }).dragging;
  if (!d || typeof d !== 'object') return null;
  const candidate = d as Partial<{ ids: unknown; start: unknown; dx: unknown; dy: unknown }>;
  if (!Array.isArray(candidate.ids) || !candidate.start || typeof candidate.start !== 'object' || typeof candidate.dx !== 'number' || typeof candidate.dy !== 'number') return null;
  const ids = candidate.ids.filter((id): id is string => typeof id === 'string');
  const start: Record<string, { x: number; y: number }> = {};
  for (const [key, value] of Object.entries(candidate.start as Record<string, unknown>)) {
    const p = value as { x?: unknown; y?: unknown } | null;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') start[key] = { x: p.x, y: p.y };
  }
  return { ids, start, dx: candidate.dx, dy: candidate.dy };
}

/** Reads every remote peer's presence, excluding our own client. */
export function readPeers(awareness: Awareness, localClientId: number): PeerState[] {
  const peers: PeerState[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const raw = state as Partial<LocalPresence>;
    const dragging = readDragging(raw);
    peers.push({
      clientId,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : `Peer ${clientId}`,
      color: typeof raw.color === 'string' ? raw.color : '#5B6167',
      cursor:
        raw.cursor && typeof raw.cursor.x === 'number' && typeof raw.cursor.y === 'number'
          ? { x: raw.cursor.x, y: raw.cursor.y }
          : null,
      // Accepts the older single `selectedId` so a peer on a previous build
      // still shows its selection rather than nothing.
      selectedIds: readSelectedIds(raw),
      // A peer on an older build never published a view. Chen was the default
      // then, so assuming Chen keeps them visible instead of silently gone.
      view: raw.view === 'crowfoot' ? 'crowfoot' : 'chen',
      pressing: raw.pressing === true,
      typing: raw.typing === true,
      following: typeof raw.following === 'number' ? raw.following : null,
      dragging,
    });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** Number of peers currently connected through the WebRTC provider. */
export function connectedPeerCount(provider: WebrtcProvider): number {
  const relay = relays.get(provider);
  if (relay) return relay.wsconnected ? Math.max(0, relay.awareness.getStates().size - 1) : 0;
  try {
    // `room.webrtcConns` is the provider's live connection map.
    const room = (provider as unknown as { room?: { webrtcConns?: Map<unknown, unknown> } }).room;
    return room?.webrtcConns?.size ?? 0;
  } catch {
    return 0;
  }
}

/** What the connection to the room is doing, so the app can explain it. */
export interface TransportState {
  /** The signalling server is reachable, so a peer in another device can be found. */
  signalling: boolean;
  /** Peers with an open direct connection. */
  direct: number;
  /** Peers the signalling server found, but the network refused to reach. */
  blocked: number;
}

type PeerLink = { state: 'pending' | 'connected' | 'failed' };

const peerLinks = new WeakMap<WebrtcProvider, Map<string, PeerLink>>();
const transportListeners = new WeakMap<WebrtcProvider, Set<() => void>>();

/**
 * Listen for the connection changing.
 *
 * The provider's own events do not cover it: a data channel can open between
 * two of its events, and that is the moment the room becomes live.
 */
export function onTransport(provider: WebrtcProvider, listener: () => void): () => void {
  const listeners = transportListeners.get(provider) ?? new Set<() => void>();
  transportListeners.set(provider, listeners);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The data channel of a peer, when there is one.
 *
 * The provider keeps its connections in a map that its own types do not
 * describe, so it is reached through a narrow cast rather than a wide one.
 */
function peerChannel(provider: WebrtcProvider, id: string) {
  const room = (provider as unknown as {
    room?: { webrtcConns?: Map<string, { peer?: { on?: (name: string, fn: () => void) => void } }> };
  }).room;
  return room?.webrtcConns?.get(id)?.peer;
}

/**
 * Watch the peers the signalling server introduces.
 *
 * A peer that is announced and then dropped before its data channel ever
 * opened was blocked, not gone: something between the two browsers refused the
 * connection. That is the difference between "nobody is in this room" and
 * "this room cannot reach you", and the person waiting in the room has to be
 * told which one it is.
 */
function watchPeers(provider: WebrtcProvider): void {
  const links = new Map<string, PeerLink>();
  peerLinks.set(provider, links);
  provider.on('peers', (event: unknown) => {
    const payload = (Array.isArray(event) ? event[0] : event) as { added?: string[]; removed?: string[] } | undefined;
    for (const id of payload?.added ?? []) {
      const link: PeerLink = { state: 'pending' };
      links.set(id, link);
      // The connection is real only once the data channel opens.
      peerChannel(provider, id)?.on?.('connect', () => {
        link.state = 'connected';
        announceTransport(provider);
      });    }
    for (const id of payload?.removed ?? []) {
      const link = links.get(id);
      if (!link) continue;
      // A peer that was connected and left is gone. One that never connected was blocked.
      if (link.state === 'connected') links.delete(id);
      else link.state = 'failed';
    }
    announceTransport(provider);
  });
}

/** Tell the app that the connection changed, so it can say so. */
function announceTransport(provider: WebrtcProvider): void {
  for (const listener of transportListeners.get(provider) ?? []) listener();
}

/** What the room connection is doing right now. */
export function transportState(provider: WebrtcProvider): TransportState {
  const relay = relays.get(provider);
  if (relay) return { signalling: relay.wsconnected, direct: connectedPeerCount(provider), blocked: 0 };
  const links = peerLinks.get(provider);
  let direct = 0;
  let blocked = 0;
  for (const link of links?.values() ?? []) {
    if (link.state === 'connected') direct += 1;
    else if (link.state === 'failed') blocked += 1;
  }
  return {
    // lib0's websocket client reconnects on its own, so this is the live answer.
    signalling: provider.signalingConns.some((conn) => conn.connected),
    direct,
    blocked,
  };
}

export { DEFAULT_SIGNALLING };
