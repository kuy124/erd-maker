import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awareness from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MAX_MESSAGE = 512 * 1024;
const MAX_MESSAGES_PER_SECOND = 200;

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
    // Socket attachments preserve ownership and throttling across hibernation.
    this.clients = new Map();
    this.limits = new Map();
    this.unpersisted = new Set();
    this.hibernating = typeof ctx.acceptWebSocket === 'function';
    this.dirty = false;
    this.saving = null;
    this.retryDelay = null;
    // Awareness's interval prevents Durable Object hibernation.
    if (this.hibernating) {
      for (const socket of this.liveSockets()) {
        const saved = socket.deserializeAttachment();
        if (!saved) continue;
        this.clients.set(socket, new Set(saved.ids));
        if (saved.limit) this.limits.set(socket, saved.limit);
        awareness.applyAwarenessUpdate(this.presence, saved.awareness, this);
        for (const [id, lastUpdated] of saved.updatedAt) {
          const meta = this.presence.meta.get(id);
          if (meta) meta.lastUpdated = lastUpdated;
        }
      }
      this.expirePresence();
      this.updateHibernation();
    }
    /*
     * Rooms outlive their last connection.
     *
     * A share link names only the room, so whoever opens it expects the
     * diagram whether or not anybody else is online. Keeping the room in
     * Durable Object storage is what makes that true: a hibernated object is
     * out of memory, and without this the link opened onto an empty canvas.
     */
    this.ready = ctx.storage.get('doc').then((saved) => {
      if (saved) Y.applyUpdate(this.doc, new Uint8Array(saved), this);
    });
    this.doc.on('update', (update, origin) => {
      // Loading a snapshot is not an edit; do not broadcast or save it again.
      if (origin === this) return;
      const out = encoding.createEncoder();
      encoding.writeVarUint(out, 0);
      sync.writeUpdate(out, update);
      this.dirty = true;
      this.saveSoon();
      this.broadcast(encoding.toUint8Array(out), origin);
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
      this.broadcast(encoding.toUint8Array(out), origin);
    });
  }

  expirePresence() {
    const now = Date.now();
    const expired = [...this.presence.meta]
      .filter(([id, meta]) => id !== this.doc.clientID && this.presence.states.has(id) && now - meta.lastUpdated >= awareness.outdatedTimeout)
      .map(([id]) => id);
    if (expired.length) {
      awareness.removeAwarenessStates(this.presence, expired, null);
      for (const socket of this.unpersisted) this.rememberSocket(socket);
    }
  }

  updateHibernation() {
    if (!this.hibernating) return;
    if (this.unpersisted.size && this.presence._checkInterval == null) {
      // ponytail: presence above the 2 KiB attachment limit keeps the room awake; compact it if common.
      this.presence._checkInterval = setInterval(() => this.expirePresence(), 3000);
    } else if (!this.unpersisted.size && this.presence._checkInterval != null) {
      clearInterval(this.presence._checkInterval);
      this.presence._checkInterval = null;
    }
  }

  rememberSocket(socket) {
    if (!this.hibernating) return;
    try {
      const ids = [...this.clients.get(socket)];
      socket.serializeAttachment({
        ids,
        limit: this.limits.get(socket),
        awareness: awareness.encodeAwarenessUpdate(this.presence, ids),
        updatedAt: ids.map(id => [id, this.presence.meta.get(id).lastUpdated]),
      });
      this.unpersisted.delete(socket);
    } catch {
      this.unpersisted.add(socket);
    }
    this.updateHibernation();
  }

  broadcast(message, except) {
    // getWebSockets includes sockets still attached to a sleeping object, so a
    // room that is not resident still receives this. Sockets that are gone no
    // matter how looked up are dropped on send.
    for (const socket of this.liveSockets()) {
      if (socket === except) continue;
      try { socket.send(message); } catch { this.close(socket); }
    }
  }

  liveSockets() {
    return typeof this.ctx.getWebSockets === 'function' ? this.ctx.getWebSockets() : [...this.clients.keys()];
  }

  close(socket) {
    const ids = this.clients.get(socket);
    this.clients.delete(socket);
    this.limits.delete(socket);
    this.unpersisted.delete(socket);
    this.updateHibernation();
    if (ids) awareness.removeAwarenessStates(this.presence, [...ids], socket);
    try { socket.close(); } catch { /* Already closed. */ }
    // The last client leaving is the moment the room would otherwise be lost.
    // Filtered: webSocketClose may fire just before the runtime drops the
    // socket from getWebSockets, so the count would otherwise still see it.
    // The save is returned: a Node host that is about to be killed can await
    // it, otherwise a hard shutdown truncates the write and the room is lost.
    if (this.liveSockets().filter(s => s !== socket).length === 0) return this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    let written;
    if (this.saving) {
      written = this.saving.then(() => this.save());
    } else {
      if (!this.dirty) return Promise.resolve();
      const snapshot = Y.encodeStateAsUpdate(this.doc);
      this.dirty = false;
      written = Promise.resolve()
        .then(() => this.ctx.storage.put('doc', snapshot))
        .then(async () => {
          this.retryDelay = null;
          if (!this.dirty && this.alarmArmed && this.ctx.storage.deleteAlarm) {
            this.alarmArmed = false;
            await this.ctx.storage.deleteAlarm();
          }
        })
        .catch(error => {
          this.dirty = true;
          this.retryDelay = Math.min((this.retryDelay ?? 500) * 2, 30_000);
          this.saveSoon();
          throw error;
        })
        .finally(() => { this.saving = null; });
      this.saving = written;
    }
    // Keep the object alive until the write lands; eviction right after the
    // last disconnect is exactly when this matters. Returned so a plain Node
    // host can await it on shutdown.
    try { this.ctx.waitUntil(written); } catch { /* No waitUntil outside a handler. */ }
    return written;
  }
  /** Coalesce edits; the timer keeps unsaved state alive until storage finishes. */
  saveSoon() {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(error => console.error('Room save failed', error)), this.retryDelay ?? 500);
    // The alarm caps the debounce window during a continuous stream of edits.
    try {
      if (this.retryDelay || !this.ctx.storage.getAlarm) return;
      if (this.alarmArmed) return;
      this.alarmArmed = true;
      Promise.resolve(this.ctx.storage.setAlarm(Date.now() + 2000)).catch(error => {
        this.alarmArmed = false;
        console.error('Room alarm failed', error);
      });
    } catch { this.alarmArmed = false; /* Alarms unsupported; the debounce still runs. */ }
  }

  async alarm() {
    this.alarmArmed = false;
    await this.save();
  }

  async fetch() {
    await this.ready;
    if (this.liveSockets().length >= 32) return new Response('Room full', { status: 429 });
    const [client, socket] = Object.values(new WebSocketPair());
    // acceptWebSocket, not accept(): a socket accepted with the standard
    // listener pattern keeps the object resident for the whole session, and an
    // occupied room bills Durable Object duration around the clock — the
    // free-tier budget this relay exhausted. Hibernation keeps the connection
    // open at the network layer while the object sleeps, and bills nothing.
    this.ctx.acceptWebSocket?.(socket);
    this.sendState(socket);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The initial sync a new socket needs: the room's state, then who is in it.
   *
   * Kept apart from `fetch` because a plain Node host runs the same room
   * without a WebSocketPair — see `relay-node.mjs` — and the handshake is the
   * one piece both transports share.
   */
  sendState(socket) {
    if (this.hibernating) this.expirePresence();
    const initial = encoding.createEncoder();
    encoding.writeVarUint(initial, 0);
    sync.writeSyncStep1(initial, this.doc);
    socket.send(encoding.toUint8Array(initial));
    const present = encoding.createEncoder();
    encoding.writeVarUint(present, 1);
    encoding.writeVarUint8Array(present, awareness.encodeAwarenessUpdate(this.presence, [...this.presence.getStates().keys()]));
    socket.send(encoding.toUint8Array(present));
  }

  /**
   * A socket sent a frame.
   *
   * This method is the only reason the object is resident at all, and the
   * reason `this.clients` may be empty when it runs: a socket attached before
   * the object last slept wakes it here. Re-register first, so awareness is
   * cleaned up correctly when the socket later leaves.
   */
  webSocketMessage(socket, message) {
    try {
      if (this.hibernating) this.expirePresence();
      if (!this.clients.has(socket)) this.clients.set(socket, new Set());
      if (!this.limits.has(socket) || Date.now() - this.limits.get(socket).since > 1000) this.limits.set(socket, { count: 0, since: Date.now() });
      const limit = this.limits.get(socket);
      if ((limit.count += 1) > MAX_MESSAGES_PER_SECOND || !(message instanceof ArrayBuffer) || message.byteLength > MAX_MESSAGE) {
        socket.close(1008, 'Message limit'); return;
      }
      const input = decoding.createDecoder(new Uint8Array(message));
      const type = decoding.readVarUint(input);
      if (type === 0) {
        const out = encoding.createEncoder();
        encoding.writeVarUint(out, 0);
        sync.readSyncMessage(input, out, this.doc, socket);
        if (encoding.length(out) > 1) socket.send(encoding.toUint8Array(out));
      } else if (type === 1) {
        awareness.applyAwarenessUpdate(this.presence, decoding.readVarUint8Array(input), socket);
      } else throw new Error('Unknown message');
      this.rememberSocket(socket);
    } catch { socket.close(1008, 'Invalid message'); }
  }

  webSocketClose(socket) { return this.close(socket); }
  webSocketError(socket) { return this.close(socket); }
}
