import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as awareness from 'y-protocols/awareness';
import * as sync from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import { DiagramRoom } from './worker.js';

/*
 * A room has to outlive its last connection.
 *
 * A short share link names only the room, so a joiner can arrive hours after
 * everyone closed their tabs. This drives the storage contract directly: no
 * WebSocket, no running worker, just the object and a stand-in for Durable
 * Object storage. Run it when the room storage code changes.
 */
const saved = new Map();
const storage = {
  get: async key => saved.get(key),
  put: async (key, value) => { saved.set(key, value); },
};
const ctx = () => ({
  storage,
  waitUntil: () => {},
  // Stand-ins for the hibernation API; the real runtime manages these.
  acceptWebSocket: () => {},
  getWebSockets: () => [],
});

const first = new DiagramRoom(ctx());
await first.ready;
first.doc.getMap('check').set('kept', 'after everyone left');
first.save();
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(saved.get('doc'), 'Room was never written to storage');

const later = new DiagramRoom(ctx());
await later.ready;
assert.equal(later.doc.getMap('check').get('kept'), 'after everyone left',
  'A visitor arriving after everyone left got an empty room');

// A read schedules no save; a burst of edits schedules one.
const writes = [];
{
  const burst = new DiagramRoom({
    storage: { get: async key => saved.get(key), put: async (key, value) => { writes.push(key); saved.set(key, value); } },
    waitUntil: () => {},
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  });
  await burst.ready;
  assert.equal(burst.saveTimer, null, 'Loading a saved room scheduled another save');
  for (let i = 0; i < 5; i++) burst.doc.getMap('check').set(`key${i}`, 'burst');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writes.length, 0, 'The debounce window wrote mid-burst');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(writes.filter(key => key === 'doc').length, 1,
    'A burst of writes produced more than one save');
}

// Close path: a connect/disconnect cycle must not lose the document.
{
  // A live socket, as workerrd tracks one: registered on accept, and gone by
  // the time webSocketClose has fired.
  const live = [];
  const room = new DiagramRoom({
    storage: { get: async key => saved.get(key), put: async (key, value) => { saved.set(key, value); } },
    waitUntil: () => {},
    acceptWebSocket: ws => live.push(ws),
    getWebSockets: () => [...live],
  });
  await room.ready;
  room.doc.getMap('check').set('close', 'survives');
  const socket = {};
  live.push(socket);
  room.webSocketClose(socket);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(saved.get('doc'), 'A disconnected room was not written');
  const revisit = new DiagramRoom(ctx());
  await revisit.ready;
  assert.equal(revisit.doc.getMap('check').get('close'), 'survives',
    'A room revisited after a disconnect lost its content');
}
console.log('PASS: a room opens with nobody connected');

// Wake-up path: eviction clears the object's memory, but a socket that wakes
// it is still the same connection. webSocketMessage must re-register the
// sender before doing anything else, or the awareness it owns never gets
// cleaned up when the connection finally closes.
{
  const room = new DiagramRoom(ctx());
  await room.ready;
  const socket = { send: () => {}, close: () => {} };
  room.webSocketMessage(socket, new ArrayBuffer(0));
  assert.ok(room.clients.has(socket),
    'A socket that woke a hibernated room was not re-registered');
}

const sockets = new Set();
let stored;
let writeCount = 0;
let deletedAlarms = 0;
let rejectWrite = false;
const state = {
  storage: {
    async get() { return stored; },
    async put(_key, value) {
      if (rejectWrite) throw new Error('Storage unavailable');
      stored = value.slice();
      writeCount += 1;
    },
    async getAlarm() { return null; },
    async setAlarm() {},
    async deleteAlarm() { deletedAlarms += 1; },
  },
  acceptWebSocket(socket) { sockets.add(socket); },
  getWebSockets: () => [...sockets],
  waitUntil(promise) { promise.catch(() => {}); },
};

function connection() {
  let attachment = null;
  const socket = {
    sent: [],
    closed: null,
    send(message) { this.sent.push(message); },
    close(code, reason) { this.closed = { code, reason }; sockets.delete(this); },
    serializeAttachment(value) {
      if (value.awareness.byteLength > 2048) throw new RangeError('Attachment too large');
      attachment = structuredClone(value);
    },
    deserializeAttachment() { return structuredClone(attachment); },
  };
  state.acceptWebSocket(socket);
  return socket;
}

let sender = connection();
const observer = connection();
const peerDoc = new Y.Doc();
const peer = new awareness.Awareness(peerDoc);
let room = new DiagramRoom(state);
const realNow = Date.now;
const sendPresence = (socket = sender) => {
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 1);
  encoding.writeVarUint8Array(out, awareness.encodeAwarenessUpdate(peer, [peerDoc.clientID]));
  room.webSocketMessage(socket, encoding.toUint8Array(out).slice().buffer);
};
const wake = async () => {
  room.doc.destroy();
  room = new DiagramRoom(state);
  await room.ready;
};

try {
  await room.ready;
  assert.equal(room.presence._checkInterval, null, 'idle rooms must be able to hibernate');
  await room.save();
  assert.equal(writeCount, 0, 'an unchanged room does not need a storage write');

  peer.setLocalState({ name: 'Faris' });
  sendPresence();
  assert.equal(sender.sent.length, 0, 'do not echo presence to its sender');
  assert.equal(observer.sent.length, 1, 'other peers still receive presence');

  peer.setLocalState({ name: 'x'.repeat(4096) });
  const oversized = sender;
  sendPresence(oversized);
  assert.equal(oversized.closed?.code, 1009, 'reject presence that cannot survive hibernation');
  assert.equal(room.clients.has(oversized), false);
  assert.equal(room.presence.getStates().has(peerDoc.clientID), false);
  assert.equal(room.presence._checkInterval, null, 'oversized presence must not keep the room awake');
  sender = connection();
  peer.setLocalState({ name: 'Faris' });
  sendPresence();
  assert.equal(room.presence._checkInterval, null);
  assert.ok(room.clients.get(sender).has(peerDoc.clientID), 'reconnected presence must have an owner');

  const sentBeforeEdits = sender.sent.length;
  room.doc.transact(() => {
    room.doc.getMap('meta').set('name', 'First');
    room.doc.getMap('meta').set('name', 'Latest');
  }, sender);
  assert.equal(sender.sent.length, sentBeforeEdits, 'do not echo document updates to their sender');
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(writeCount, 1, 'coalesce edits into one snapshot');
  assert.equal(deletedAlarms, 1, 'cancel the redundant flush alarm');
  await room.alarm();
  await room.save();
  assert.equal(writeCount, 1, 'alarms and disconnects must not rewrite a clean room');

  room.doc.getMap('meta').set('name', 'Retry');
  rejectWrite = true;
  await assert.rejects(room.save(), /Storage unavailable/);
  assert.ok(room.saveTimer, 'dirty state must stay alive until a retry');
  assert.equal(room.retryDelay, 1000, 'storage failures back off instead of spinning');
  rejectWrite = false;
  await Promise.all([room.save(), room.save()]);
  assert.equal(writeCount, 2, 'failed writes remain dirty and can be retried');

  room.presence.meta.get(peerDoc.clientID).lastUpdated = realNow() - awareness.outdatedTimeout - 1;
  room.sendState(observer);
  assert.equal(room.presence.getStates().has(peerDoc.clientID), false, 'expire stale presence without an interval');
  peer.setLocalState({ name: 'Faris' });
  sendPresence();
  let releaseWrite;
  let startedWrites = 0;
  const heldWrite = new Promise(resolve => { releaseWrite = resolve; });
  const put = state.storage.put;
  state.storage.put = async (...args) => {
    startedWrites += 1;
    await heldWrite;
    return put(...args);
  };
  room.doc.getMap('check').set('pending', 'first');
  const inFlight = room.save();
  room.doc.getMap('check').set('pending', 'latest');
  const nextSave = room.save();
  await Promise.resolve();
  assert.equal(startedWrites, 1, 'snapshot writes must not race');
  releaseWrite();
  await Promise.all([inFlight, nextSave]);
  state.storage.put = put;
  assert.equal(startedWrites, 2, 'edits made during a write still need saving');
  await wake();
  assert.equal(room.doc.getMap('meta').get('name'), 'Retry');
  assert.equal(room.doc.getMap('check').get('pending'), 'latest');
  assert.equal(room.presence.getStates().get(peerDoc.clientID).name, 'Faris');
  assert.ok(room.clients.get(sender).has(peerDoc.clientID), 'restore socket ownership after sleep');
  assert.equal(room.presence._checkInterval, null);
  await room.save();
  assert.equal(writeCount, 4, 'loading a saved room is not an edit');

  const now = realNow();
  Date.now = () => now;
  room.limits.get(sender).since = now;
  room.rememberSocket(sender);
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, 0);
  sync.writeSyncStep1(out, peerDoc);
  const ping = encoding.toUint8Array(out).slice().buffer;
  for (let count = room.limits.get(sender).count; count < 200; count += 1) room.webSocketMessage(sender, ping);
  assert.equal(sender.closed, null);
  await wake();
  room.webSocketMessage(sender, ping);
  assert.equal(sender.closed?.reason, 'Message limit', 'sleep must not reset the rate limit');
  await room.close(sender);
  assert.equal(room.presence.getStates().has(peerDoc.clientID), false, 'disconnects clean up restored ownership');
  assert.equal(writeCount, 4);
  console.log('Room persistence, hibernation, presence, and rate limits ok');
} finally {
  Date.now = realNow;
  clearTimeout(room.saveTimer);
  room.doc.destroy();
  peer.destroy();
  peerDoc.destroy();
}
