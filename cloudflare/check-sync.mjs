import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const [, , port, room] = process.argv;
const origin = 'http://localhost:5173';

async function refused(name, requestOrigin, status) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${name}`, { origin: requestOrigin });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Upgrade did not finish')); }, 2500);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      try { assert.equal(response.statusCode, status); resolve(); }
      catch (error) { reject(error); }
    });
    socket.once('open', () => { clearTimeout(timer); socket.close(); reject(new Error('Invalid upgrade accepted')); });
    socket.on('error', () => {});
  });
}

await refused(room, 'https://not-allowed.invalid', 403);
await refused('bad', origin, 400);
assert.equal((await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' })).status, 426);

class BrowserSocket extends WebSocket {
  constructor(url, protocols) { super(url, protocols, { origin }); }
}

const wait = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

const connect = (doc) => new WebsocketProvider(
  `ws://127.0.0.1:${port}`, room, doc,
  { WebSocketPolyfill: BrowserSocket, disableBc: true },
);

const docs = [new Y.Doc(), new Y.Doc()];
const providers = docs.map((doc) => connect(doc));
try {
  if (!(await wait(() => providers.every((p) => p.synced)))) throw new Error('sync timed out');
  docs[0].getMap('keep').set('survives', 'a restart');
  if (!(await wait(() => docs[1].getMap('keep').get('survives') === 'a restart'))) {
    throw new Error('Second client never received the write');
  }
  console.log('PASS: two clients sync, and a write reaches both');
} finally {
  providers.forEach((p) => p.destroy());
  docs.forEach((d) => d.destroy());
}
process.exit(0);
