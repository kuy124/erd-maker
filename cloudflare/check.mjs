import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Y = require('../node_modules/yjs');
const { WebsocketProvider } = require('../node_modules/y-websocket');
const WebSocket = require('../node_modules/ws');

class BrowserSocket extends WebSocket {
  constructor(url, protocols) { super(url, protocols, { origin: 'http://127.0.0.1:5173' }); }
}
const docs = [new Y.Doc(), new Y.Doc()];
const room = 'test-' + crypto.randomUUID();
const providers = docs.map(doc => new WebsocketProvider('ws://127.0.0.1:8787', room, doc,
  { WebSocketPolyfill: BrowserSocket, disableBc: true }));
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
  docs.forEach(doc => doc.destroy());
}
