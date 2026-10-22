import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MAX_MESSAGE = 512 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (!origin || !env.ALLOWED_ORIGINS.split(',').includes(origin)) return new Response('Forbidden', { status: 403 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    // Room IDs are bearer capabilities. Never list them or use guessable names.
    if (!/^\/[A-Za-z0-9_-]{8,128}$/.test(url.pathname)) return new Response('Invalid room', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(url.pathname)).fetch(request);
  },
};

export class DiagramRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.doc = new Y.Doc();
    this.presence = new awareness.Awareness(this.doc);
    this.presence.setLocalState(null);
    this.clients = new Map();
    // ponytail: active-room memory, browser IndexedDB supplies durable diagrams.
    // Add durable snapshots if rooms must survive without any client reopening.
    this.doc.on('update', update => {
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 0);
      sync.writeUpdate(out, update);
      this.broadcast(encoding.toUint8Array(out));
    });
    this.presence.on('update', ({ added, updated, removed }, origin) => {
      const ids = this.clients.get(origin);
      for (const id of added) ids?.add(id);
      for (const id of removed) ids?.delete(id);
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 1);
      encoding.writeVarUint8Array(out, awareness.encodeAwarenessUpdate(this.presence, [...added, ...updated, ...removed]));
      this.broadcast(encoding.toUint8Array(out));
    });
  }

  broadcast(message) {
    for (const socket of this.clients.keys()) {
      try { socket.send(message); } catch { this.close(socket); }
    }
  }

  close(socket) {
    const ids = this.clients.get(socket);
    this.clients.delete(socket);
    if (ids) awareness.removeAwarenessStates(this.presence, [...ids], null);
    try { socket.close(); } catch { /* Already closed. */ }
  }

  async fetch() {
    if (this.clients.size >= 32) return new Response('Room full', { status: 429 });
    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    this.clients.set(socket, new Set());
    let count = 0, since = Date.now();
    socket.addEventListener('message', event => {
      try {
        if (Date.now() - since > 1000) { count = 0; since = Date.now(); }
        if (++count > 200 || !(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_MESSAGE) {
          socket.close(1008, 'Message limit'); return;
        }
        const input = decoding.createDecoder(new Uint8Array(event.data));
        const type = decoding.readVarUint(input);
        if (type === 0) {
          const out = encoding.createEncoder();
          encoding.writeVarUint(out, 0);
          sync.readSyncMessage(input, out, this.doc, socket);
          if (encoding.length(out) > 1) socket.send(encoding.toUint8Array(out));
        } else if (type === 1) {
          awareness.applyAwarenessUpdate(this.presence, decoding.readVarUint8Array(input), socket);
        } else throw new Error('Unknown message');
      } catch { socket.close(1008, 'Invalid message'); }
    });
    socket.addEventListener('close', () => this.close(socket));
    socket.addEventListener('error', () => this.close(socket));
    const initial = encoding.createEncoder();
    encoding.writeVarUint(initial, 0);
    sync.writeSyncStep1(initial, this.doc);
    socket.send(encoding.toUint8Array(initial));
    const present = encoding.createEncoder();
    encoding.writeVarUint(present, 1);
    encoding.writeVarUint8Array(present, awareness.encodeAwarenessUpdate(this.presence, [...this.presence.getStates().keys()]));
    socket.send(encoding.toUint8Array(present));
    return new Response(null, { status: 101, webSocket: client });
  }
}
