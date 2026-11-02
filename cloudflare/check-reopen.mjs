import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const [, , port, room, expected] = process.argv;
const origin = 'http://localhost:5173';

class BrowserSocket extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { origin });
  }
}

const doc = new Y.Doc();
const provider = new WebsocketProvider(
  `ws://127.0.0.1:${port}`, room, doc,
  { WebSocketPolyfill: BrowserSocket, disableBc: true },
);

let result = 'timeout';
for (let i = 0; i < 100 && result === 'timeout'; i++) {
  const value = doc.getMap('keep').get('survives');
  if (provider.synced && value === expected) result = 'ok';
  if (provider.synced && i > 20 && value !== expected) result = `wrong-value:${String(value)}`;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
provider.destroy();
doc.destroy();
console.log(`reopen:${result}`);
process.exit(result === 'ok' ? 0 : 1);
