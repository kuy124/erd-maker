import { createRequire } from 'node:module';
import * as Y from 'yjs';
const require = createRequire(new URL('../package.json', import.meta.url));
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const [mode, room] = process.argv.slice(2);
class BrowserSocket extends WebSocket {
  constructor(url: string, protocols: string[]) { super(url, protocols, { headers: { origin: 'http://localhost:5173' } }); }
}

if (mode === 'w') {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider('ws://127.0.0.1:8099', room, doc,
    { WebSocketPolyfill: BrowserSocket, disableBc: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  doc.getMap('keep').set('survives', 'a restart');
  await new Promise((resolve) => setTimeout(resolve, 900));
  provider.destroy();
  console.log('wrote');
  process.exit(0);
}

if (mode === 'r') {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider('ws://127.0.0.1:8099', room, doc,
    { WebSocketPolyfill: BrowserSocket, disableBc: true });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log('synced:', provider.synced, 'value:', doc.getMap('keep').get('survives'));
  provider.destroy();
  process.exit(0);
}
