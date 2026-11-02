import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const PORT = 8099;
const ORIGIN = 'http://localhost:5173';
class BrowserSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin: ORIGIN });
    const send = this.send.bind(this);
    this.send = (...args) => { console.error('c-send', args[0]?.length); return send(...args); };
  }
}

// Windows does not hand a killed listener's port back instantly, so each
// restart listens on the next port. Nothing here cares which port is which.
let starts = 0;
let child;
let url = `ws://127.0.0.1:${PORT}`;
const start = () => new Promise((resolve, reject) => {
  const port = PORT + starts++;
  child = spawn(process.execPath, ['relay-node.mjs'], {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    env: { ...process.env, PORT: String(port), ALLOWED_ORIGINS: ORIGIN },
    stdio: 'inherit',
  });
  child.on('error', reject);
  const tick = setInterval(() => {
    fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => { if (response.ok) { clearInterval(tick); url = `ws://127.0.0.1:${port}`; resolve(); } })
      .catch(() => {});
  }, 100);
});
const stop = () => new Promise((resolve) => {
  child.on('exit', () => resolve());
  child.kill('SIGTERM');
});
const wait = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for sync');
};

const connect = (doc, room) => {
  const provider = new WebsocketProvider(url, room, doc,
    { WebSocketPolyfill: BrowserSocket, disableBc: true });
  const ws = provider.ws;
  if (ws && ws.on) {
    ws.on('open', () => console.error('c-open', provider.synced));
    ws.on('close', (code) => console.error('c-close', code));
    ws.on('error', (e) => console.error('c-error', e?.message));
    ws.on('message', (data) => console.error('c-in', data?.byteLength ?? data?.length));
  }
  return provider;
};

const rooms = await mkdtemp(join(tmpdir(), 'relay-'));
process.env.RELAY_DATA_DIR = rooms;
await start();
try {
  const room = 'test-' + randomUUID();
  const docs = [new Y.Doc(), new Y.Doc()];
  const providers = docs.map((doc) => connect(doc, room));
  try {
    await wait(() => providers.every((p) => p.synced));
    docs[0].getMap('check').set('value', 'connected');
    await wait(() => docs[1].getMap('check').get('value') === 'connected');
    docs[1].getMap('check').set('reply', 'received');
    await wait(() => docs[0].getMap('check').get('reply') === 'received');
    providers.forEach((p) => p.awareness.setLocalStateField('name', 'Alice'));
    await wait(() => [...providers[1].awareness.getStates().values()].some((s) => s.name === 'Alice'));
  } finally {
    providers.forEach((p) => p.destroy());
    docs.forEach((d) => d.destroy());
  }

  const before = new Y.Doc();
  const beforeProvider = connect(before, room);
  await wait(() => beforeProvider.synced);
  before.getMap('keep').set('survives', 'a restart');
  await new Promise((resolve) => setTimeout(resolve, 800));
  beforeProvider.destroy();

  // A share link means the room has to outlive the process, not just the
  // connection: this is what a spin-down on a free host does to it.
  await stop();
  await start();

  const after = new Y.Doc();
  const afterProvider = connect(after, room);
  await wait(() => afterProvider.synced);
  afterProvider.destroy();
  assert.equal(after.getMap('keep').get('survives'), 'a restart',
    'A room revisited after the relay restarted lost its content');
  console.log('PASS: Node relay syncs, and a room survives its own restart');
} finally {
  if (child.exitCode === null) await stop();
  await rm(rooms, { recursive: true, force: true });
}
process.exit(0);

