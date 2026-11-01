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
    /*
     * Rooms outlive their last connection.
     *
     * A share link names only the room, so whoever opens it expects the
     * diagram whether or not anybody else is online. Keeping the room in
     * Durable Object storage is what makes that true: the object is evicted
     * when idle, and without this the link opened onto an empty canvas.
     *
     * ponytail: one blob per room, written when the room empties. Add
     * periodic writes if a deploy or crash must never lose the last edits.
     */
    this.ready = ctx.storage.get('doc').then((saved) => {
      if (saved) Y.applyUpdate(this.doc, new Uint8Array(saved));
    });
    this.doc.on('update', update => {
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 0);
      sync.writeUpdate(out, update);
      this.broadcast(encoding.toUint8Array(out));
      this.saveSoon();
    });

    // Debounced-save timer; see `saveSoon` below.
    this.saveTimer = null;
    // Whether the flush alarm is armed; see `saveSoon`.
    this.alarmArmed = false;
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
    // The last client leaving is the moment the room would otherwise be lost.
    if (this.clients.size === 0) this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const written = this.ctx.storage.put('doc', Y.encodeStateAsUpdate(this.doc));
    // Keep the object alive until the write lands; eviction right after the
    // last disconnect is exactly when this matters.
    try { this.ctx.waitUntil(written); } catch { /* No waitUntil outside a handler. */ }
  }

  /**
   * Records the room without waiting for it to empty out.
   *
   * Saving only on the last disconnect assumes the object lives forever, but a
   * relay object can be evicted with a hibernated socket still nominally
   * attached — a client that never sends a close event, or one that lost its
   * last frame silently. Then `close()` runs, the room stays in memory, and an
   * eviction loses every shape streamed into it. The room is what a watcher
   * loads, so losing it is not just losing history: the watcher lands in an
   * empty room and cannot edit what is not there.
   *
   * Debounced because the AI streams many small writes in a burst, and
   * encoding a whole state per write would dwarf the writes themselves.
   */
  saveSoon() {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
    // Storage writes outside a request context (the debounce timer, a close
    // event that arrives silently) are not guaranteed to be flushed by the
    // time the object goes idle. An alarm wakes the object with a full
    // context, away from the last message, so the write is not lost.
    try {
      if (!this.ctx.storage.getAlarm) return;
      if (this.alarmArmed) return;
      this.alarmArmed = true;
      this.ctx.storage.setAlarm(Date.now() + 2000);
    } catch { /* Alarms unsupported; the debounce still runs. */ }
  }

  async alarm() {
    this.alarmArmed = false;
    this.save();
  }

  async fetch() {
    await this.ready;
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
