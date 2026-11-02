import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DiagramRoom } from './worker.js';

/*
 * The relay, without Durable Objects.
 *
 * `worker.js` holds the protocol logic — room state, sync, awareness, saves —
 * and this file is only an adapter: a `ws` server in place of a WebSocketPair,
 * one file per room in place of Durable Object storage. A single Node process
 * is one room for every collaborator regardless of where they connect, which is
 * what Durable Objects were buying us on Workers — and what an idle Workers
 * isolate cannot give us for free.
 *
 * Run: PORT=8080 ALLOWED_ORIGINS=https://YOUR-FRONTEND node relay-node.mjs
 */

const PORT = Number(process.env.PORT ?? 8080);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, process.env.RELAY_DATA_DIR ?? 'rooms');

const ROOM_ID = /^\/[A-Za-z0-9_-]{8,128}$/;
const MAX_SOCKETS_PER_ROOM = 32;

/** One stored room per file, so a share link still means something after a restart. */
const storageFor = (name) => {
  const file = path.join(DATA_DIR, `${name.replace(/^\//, '')}.bin`);
  return {
    get: async () => { try { return await fs.readFile(file); } catch { return undefined; } },
    put: async (_key, value) => { await fs.mkdir(DATA_DIR, { recursive: true }); await fs.writeFile(file, value); },
  };
};

/** The ws library takes a Buffer; the room protocol speaks Uint8Array. */
const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(data));

const rooms = new Map();

const makeRoom = async (name) => {
  const live = new Set();
  let room;
  const ctx = {
    storage: storageFor(name),
    waitUntil: (promise) => { promise.catch(() => {}); },
    getWebSockets: () => [...live],
    acceptWebSocket: (socket) => { live.add(socket); },
  };
  room = new DiagramRoom(ctx);
  await room.ready;
  room.doc.on('update', () => console.error('doc-update'));
  return { room, live };
};

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(426, { 'content-type': 'text/plain' });
  response.end('This relay speaks WebSocket only. Connect a y-websocket client.');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, request) => {
  const origin = request.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) { ws.close(1008, 'Forbidden'); return; }
  const pathname = decodeURIComponent(new URL(request.url, 'http://relay').pathname);
  if (!ROOM_ID.test(pathname)) { ws.close(1008, 'Invalid room'); return; }

  let entry = rooms.get(pathname);
  if (!entry) { entry = makeRoom(pathname); rooms.set(pathname, entry); }
  const { room, live } = await entry;

  if (live.size >= MAX_SOCKETS_PER_ROOM) { ws.close(1013, 'Room full'); return; }

  // The room keys its per-socket state by identity, so every method below must
  // receive this same object.
  const socket = {
    send: (data) => { try { console.error('out', data.byteLength ?? data.length); ws.send(toBuffer(data)); } catch { /* Already gone. */ } },
    close: (code, reason) => { try { console.error('relay-close', code); ws.close(code, reason); } catch { /* Already closed. */ } },
  };
  live.add(socket);
  console.error('connect', pathname);

  ws.on('message', (buffer) => {
    const frame = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    room.webSocketMessage(socket, frame);
  });
  ws.on('close', () => {
    live.delete(socket);
    room.webSocketClose(socket);
  });
  ws.on('error', () => {
    live.delete(socket);
    room.webSocketError(socket);
  });

  room.sendState(socket);
  console.error('sent-state');
});

server.listen(PORT, async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  console.log(`Relay listening on :${PORT}, rooms in ${DATA_DIR}`);
});

// Free hosts spin idle processes down on a timer; whatever was debounced when
// the signal arrives should still land on disk.
const flush = async (signal) => {
  wss.close();
  await Promise.all([...rooms.values()].map(async (entry) => (await entry).room.save()));
  console.log(`Flushed on ${signal}`);
  process.exit(0);
};
process.on('SIGTERM', () => flush('SIGTERM'));
process.on('SIGINT', () => flush('SIGINT'));
