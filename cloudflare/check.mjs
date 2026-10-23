import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');
const { Awareness, removeAwarenessStates } = require('y-protocols/awareness');

/*
 * A room has to outlive its last connection.
 *
 * A short share link names only the room, so a joiner can arrive hours after
 * everyone closed their tabs. Drive the storage contract directly: no
 * WebSocket, no server, just the object and a stand-in for Durable Object
 * storage.
 */
const saved = new Map();
const state = { storage: {
  get: async key => saved.get(key),
  put: async (key, value) => { saved.set(key, value); },
}, waitUntil() {} };
const early = new DiagramRoom(state);
await early.ready;
const source = new Y.Doc();
source.getMap('check').set('kept', 'after everyone left');
Y.applyUpdate(early.doc, Y.encodeStateAsUpdate(source));
early.save();
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(saved.get('doc'), 'Room was never written to storage');

const later = new DiagramRoom({ storage: state.storage, waitUntil() {} });
await later.ready;
assert.equal(later.doc.getMap('check').get('kept'), 'after everyone left',
  'A visitor arriving after everyone left got an empty room');
console.log('PASS: a room survives with nobody connected');

class BrowserSocket extends WebSocket {
  constructor(url, protocols) { super(url, protocols, { origin: process.env.CHECK_ORIGIN ?? 'https://kuy124.github.io' }); }
}
const docs = [new Y.Doc(), new Y.Doc()];
const room = 'test-' + crypto.randomUUID();
const providers = docs.map(doc => new WebsocketProvider('ws://127.0.0.1:8787', room, doc,
  { WebSocketPolyfill: BrowserSocket, disableBc: true }));
const legacyPresence = new Awareness(docs[0]);
const wait = async predicate => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for sync');
};
try {
  await wait(() => providers.every(p => p.synced));
  docs[0].getMap('check').set('value', 'connected');
  await wait(() => docs[1].getMap('check').get('value') === 'connected');
  docs[1].getMap('check').set('reply', 'received');
  await wait(() => docs[0].getMap('check').get('reply') === 'received');
  providers[0].awareness.setLocalStateField('name', 'Alice');
  removeAwarenessStates(legacyPresence, [docs[0].clientID], 'disconnect');
  assert.equal(providers[0].awareness.getLocalState().name, 'Alice', 'Legacy disconnect must not clear cloud presence');
  await wait(() => [...providers[1].awareness.getStates().values()].some(s => s.name === 'Alice'));
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:8787/' + room, { origin: 'https://untrusted.example' });
    socket.on('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode); });
    socket.on('open', () => { socket.close(); reject(new Error('Untrusted origin accepted')); });
    socket.on('error', reject);
  });
  assert.equal(status, 403);
  console.log('PASS: bidirectional sync, awareness, origin restrictions');
} finally {
  providers.forEach(p => p.destroy());
  legacyPresence.destroy();
  docs.forEach(doc => doc.destroy());
}
