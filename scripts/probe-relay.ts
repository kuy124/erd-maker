/**
 * Round-trip against a relay URL: connect, sync, write, late-rejoin, and read
 * back. Prints what it finds; exits 0 only if the late reader saw the write.
 */
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const relay = process.argv[2];
const room = 'relaycheck-' + Math.random().toString(36).slice(2, 10);
process.env.WS_PROXY ??= '';
import WebSocket from 'ws';
const probe = new WebSocket(`${relay}/${room}`, { headers: { origin: 'https://kuy124.github.io' } });
await new Promise((resolve) => {
  probe.once('open', () => { console.log('upgrade accepted'); resolve(); });
  probe.once('unexpected-response', (_r, response) => { console.log('upgrade rejected:', response.statusCode); resolve(); });
  probe.once('error', (error) => { console.log('upgrade error:', error.message); resolve(); });
});
probe.close();

const wait = (predicate) =>
  new Promise((resolve, reject) => {
    let tries = 0;
    const tick = setInterval(() => {
      if (predicate()) { clearInterval(tick); resolve(); }
      else if (++tries > 100) { clearInterval(tick); reject(new Error('never connected')); }
    }, 100);
  });

const doc = new Y.Doc();
const provider = new WebsocketProvider(relay, room, doc, { connect: true });
await wait(() => provider.synced);
doc.getMap('check').set('written', 'by the first client');
await new Promise((r) => setTimeout(r, 2500));
provider.destroy();
await new Promise((r) => setTimeout(r, 1500));

const late = new Y.Doc();
const lateProvider = new WebsocketProvider(relay, room, late, { connect: true });
await wait(() => lateProvider.synced);
console.log('late reader sees:', JSON.stringify(late.getMap('check').get('written')));
lateProvider.destroy();
const ok = late.getMap('check').get('written') === 'by the first client';
process.exit(ok ? 0 : 1);
