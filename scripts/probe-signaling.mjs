/**
 * Signaling server probe.
 *
 * Opening a WebSocket is not proof that a server works: `demos.yjs.dev/ws` is a
 * y-websocket server, so the socket connects and then nothing ever happens,
 * which is worse than an obvious failure because it looks like it is working.
 *
 * The y-webrtc signaling protocol is JSON over WebSocket:
 *
 *   -> { type: 'subscribe', topics: [room] }
 *   -> { type: 'announce',  from: peerId }
 *   -> { type: 'signal',    to, from, signal }
 *   <- { type: 'peers',     ... }   (sent to others in the room)
 *
 * This probe subscribes two clients to the same room, announces from the first,
 * and checks that the second receives an announcement. That is the minimum
 * behaviour the app depends on.
 *
 * Usage: node scripts/probe-signaling.mjs
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const CANDIDATES = [
  'wss://signaling.yjs.dev',
  'wss://demos.yjs.dev/ws',
  'wss://y-webrtc-eu.fly.dev',
  'wss://signaling.fly.dev',
  'wss://y-webrtc-signaling-us.herokuapp.com',
  'wss://y-webrtc-signaling-eu.herokuapp.com',
];

function probe(url, room, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const result = { url, connected: false, subscribed: false, delivered: false, detail: '' };
    let settled = false;
    const sockets = [];
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    timer = setTimeout(() => {
      result.detail = result.detail || 'timed out';
      finish();
    }, timeoutMs);

    let a;
    let b;
    try {
      a = new WebSocket(url);
      b = new WebSocket(url);
    } catch (err) {
      result.detail = `constructor threw: ${err.message}`;
      finish();
      return;
    }
    sockets.push(a, b);

    const peerIdA = randomUUID();
    const peerIdB = randomUUID();
    let opened = 0;

    const onOpen = () => {
      opened += 1;
      result.connected = opened === 2;
      if (opened < 2) return;
      a.send(JSON.stringify({ type: 'subscribe', topics: [room] }));
      b.send(JSON.stringify({ type: 'subscribe', topics: [room] }));
      result.subscribed = true;
      // Let the server register both subscriptions before publishing.
      setTimeout(() => {
        try {
          // The server relays `publish` to every other subscriber of the topic
          // (see y-webrtc/bin/server.js). `announce` is only sent after the
          // connection is known good, so `publish` is the honest test.
          a.send(JSON.stringify({ type: 'publish', topic: room, from: peerIdA, data: { probe: true } }));
        } catch (err) {
          result.detail = `publish failed: ${err.message}`;
          finish();
        }
      }, 700);
    };

    a.on('open', onOpen);
    b.on('open', onOpen);
    a.on('message', () => {});
    b.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        // The relayed frame is the published message, echoed to other clients.
        if (message && message.type === 'publish') {
          result.delivered = true;
          result.detail = `relayed publish received (clients=${message.clients ?? '?'})`;
          finish();
        } else if (message && message.type === 'pong') {
          result.detail = result.detail || 'pong only';
        }
      } catch {
        /* not JSON */
      }
    });

    for (const s of [a, b]) {
      s.on('error', (err) => {
        result.detail = result.detail || err.message;
        finish();
      });
      s.on('unexpected-response', (_req, res) => {
        result.detail = `HTTP ${res.statusCode}`;
        finish();
      });
    }
  });
}

const room = `probe-${Date.now()}`;
console.log('Signaling server probe (subscribe + announce + relay)\n');

const working = [];
for (const url of CANDIDATES) {
  const r = await probe(url, room);
  const verdict = r.delivered ? 'WORKS  ' : r.subscribed ? 'PARTIAL' : r.connected ? 'SOCKET ' : 'FAIL   ';
  console.log(`${verdict} ${url}\n         ${r.detail}`);
  if (r.delivered) working.push(url);
}

console.log('\nWORKS = usable for peer introduction.');
console.log('PARTIAL/SOCKET = the socket opens but peers are never introduced, so it must not be used.\n');
if (working.length > 0) {
  console.log('Usable servers:');
  for (const url of working) console.log(`  '${url}',`);
} else {
  console.log('No usable public server found.');
  console.log('The app still works within one browser (BroadcastChannel) and via share-link snapshots.');
  console.log('For cross-device sync, run your own: npx y-webrtc-signaling');
}
