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
import type { Awareness } from 'y-protocols/awareness';

export interface PeerState {
  clientId: number;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selectedId: string | null;
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

/**
 * The local awareness state shape. Kept small: it is broadcast on every
 * pointer move, and every byte here is paid for on every peer's connection.
 */
export interface LocalPresence {
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selectedId: string | null;
}

export function createRoom(room: string, options: RoomOptions = {}): RoomHandle {
  const ydoc = new Y.Doc();
  const connect = options.connect ?? true;
  const persist = options.persist ?? true;

  const persistence = new IndexeddbPersistence(`erd:${room}`, ydoc);

  const provider = new WebrtcProvider(room, ydoc, {
    // The room id is the encryption key; the same id on two peers means the
    // same key, so a relay only ever holds ciphertext.
    password: room,
    signaling: options.signalling ?? resolveSignallingServers(),
    maxConns: 24,
    filterBcConns: true,
  });

  if (!connect) {
    // Still created, so awareness has a home, but with no transports.
    provider.disconnect();
  }
  if (!persist) {
    persistence.destroy();
  }

  return {
    room,
    ydoc,
    awareness: provider.awareness,
    provider,
    persistence,
    whenLoaded: persistence.whenSynced.then(() => undefined),
    destroy: () => {
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    },
  };
}

/** Reads every remote peer's presence, excluding our own client. */
export function readPeers(awareness: Awareness, localClientId: number): PeerState[] {
  const peers: PeerState[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const raw = state as Partial<LocalPresence>;
    peers.push({
      clientId,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : `Peer ${clientId}`,
      color: typeof raw.color === 'string' ? raw.color : '#5B6167',
      cursor:
        raw.cursor && typeof raw.cursor.x === 'number' && typeof raw.cursor.y === 'number'
          ? { x: raw.cursor.x, y: raw.cursor.y }
          : null,
      selectedId: typeof raw.selectedId === 'string' ? raw.selectedId : null,
    });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** Number of peers currently connected through the WebRTC provider. */
export function connectedPeerCount(provider: WebrtcProvider): number {
  try {
    // `room.webrtcConns` is the provider's live connection map.
    const room = (provider as unknown as { room?: { webrtcConns?: Map<unknown, unknown> } }).room;
    return room?.webrtcConns?.size ?? 0;
  } catch {
    return 0;
  }
}

export { DEFAULT_SIGNALLING };