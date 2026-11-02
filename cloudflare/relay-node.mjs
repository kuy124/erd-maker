import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DiagramRoom } from './worker.js';

const PORT = Number(process.env.PORT ?? 8080);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map(origin => origin.trim());
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), process.env.RELAY_DATA_DIR ?? 'rooms');
const ROOM_ID = /^\/[A-Za-z0-9_-]{8,128}$/;
const rooms = new Map();
let shuttingDown = false;

function storageFor(name) {
  const file = path.join(DATA_DIR, `${name.slice(1)}.bin`);
  let writes = Promise.resolve();
  return {
    async get() {
      try { return await fs.readFile(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    put(_key, value) {
      // Serialize atomic replacements so a close/save cannot overwrite a newer snapshot.
      const written = writes.then(async () => {
        await fs.writeFile(`${file}.tmp`, value);
        await fs.rename(`${file}.tmp`, file);
      });
      writes = written.catch(() => {});
      return written;
    },
  };
}

async function makeRoom(name) {
  const live = new Set();
  const room = new DiagramRoom({
    storage: storageFor(name),
    waitUntil: promise => { void promise.catch(error => console.error('Room save failed:', error)); },
    getWebSockets: () => [...live],
  });
  await room.ready;
  return { room, live };
}

const server = http.createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 426, { 'content-type': 'text/plain' });
  response.end(request.url === '/health' ? 'ok' : 'WebSocket required');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', async (request, socket, head) => {
  const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  try {
    if (shuttingDown) return reject('503 Service Unavailable');
    if (!ALLOWED_ORIGINS.includes(request.headers.origin)) return reject('403 Forbidden');
    const name = new URL(request.url, 'http://relay').pathname;
    if (!ROOM_ID.test(name)) return reject('400 Bad Request');
    let entry = rooms.get(name);
    if (!entry) { entry = makeRoom(name); rooms.set(name, entry); }
    // Complete disk loading before the client can send its initial sync frames.
    const { room, live } = await entry;
    if (socket.destroyed) return;
    if (shuttingDown) return reject('503 Service Unavailable');
    if (live.size >= 32) return reject('429 Too Many Requests');
    wss.handleUpgrade(request, socket, head, ws => {
      const client = {
        send: data => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      };
      live.add(client);
      ws.on('message', (buffer, binary) => {
        if (!binary) { ws.close(1008, 'Binary messages required'); return; }
        room.webSocketMessage(client, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        live.delete(client);
        const save = room.webSocketClose(client);
        if (save) void save.then(() => {
          if (live.size === 0 && rooms.get(name) === entry) {
            rooms.delete(name);
            room.doc.destroy();
          }
        }).catch(error => console.error('Room save failed:', error));
      };
      ws.on('close', close);
      ws.on('error', close);
      room.sendState(client);
    });
  } catch (error) {
    console.error('Room connection failed:', error);
    reject('503 Service Unavailable');
  }
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  try {
    await Promise.all([...rooms.values()].map(async entry => (await entry).room.save()));
    for (const ws of wss.clients) ws.terminate();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown save failed:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
// IPC lets the Windows check request a graceful exit without a public HTTP endpoint.
process.on('message', message => { if (message === 'shutdown') void shutdown(); });

await fs.mkdir(DATA_DIR, { recursive: true });
server.listen(PORT, () => {
  const port = server.address().port;
  console.log(`Relay listening on :${port}, rooms in ${DATA_DIR}`);
  process.send?.({ port });
});
