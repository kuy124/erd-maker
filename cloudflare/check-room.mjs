import assert from 'node:assert/strict';
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
process.exit(0);
