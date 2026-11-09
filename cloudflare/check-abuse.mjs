import assert from 'node:assert/strict';
import * as encoding from 'lib0/encoding';
import worker, { DiagramRoom } from './worker.js';

let allocated = 0;
const env = {
  ALLOWED_ORIGINS: 'https://example.com',
  CONNECTION_LIMIT: { limit: async () => ({ success: false }) },
  ROOMS: { idFromName() { allocated++; } },
};
const request = new Request('https://relay.example/abcdefgh', {
  headers: { Origin: 'https://example.com', Upgrade: 'websocket' },
});
assert.equal((await worker.fetch(request, env)).status, 429);
assert.equal(allocated, 0);

const room = new DiagramRoom({ storage: { get: async () => undefined } });
await room.ready;
function socket() { return { send() {}, close() { this.closed = true; } }; }
function presence(id, state, clock = 1) {
  const payload = encoding.createEncoder();
  encoding.writeVarUint(payload, 1);
  encoding.writeVarUint(payload, id);
  encoding.writeVarUint(payload, clock);
  encoding.writeVarString(payload, JSON.stringify(state));
  const message = encoding.createEncoder();
  encoding.writeVarUint(message, 1);
  encoding.writeVarUint8Array(message, encoding.toUint8Array(payload));
  return encoding.toUint8Array(message).buffer;
}
try {
  const owner = socket();
  room.webSocketMessage(owner, presence(123, { name: 'Owner' }));
  const attacker = socket();
  room.webSocketMessage(attacker, presence(123, null, 999));
  assert.equal(attacker.closed, true);
  assert.equal(room.presence.getStates().get(123).name, 'Owner');
  const churn = socket();
  for (let id = 200; id < 217; id++) room.webSocketMessage(churn, presence(id, null));
  assert.equal(churn.closed, true);
  assert.equal(room.presence.meta.has(216), false);
  const flood = socket();
  for (let i = 0; i < 201; i++) room.webSocketMessage(flood, presence(300, { name: 'Flood' }, i + 1));
  assert.equal(flood.closed, true);
  room.webSocketMessage(flood, presence(301, { name: 'After close' }));
  assert.equal(room.presence.getStates().has(301), false);
  const large = socket();
  room.webSocketMessage(large, presence(400, { name: 'x'.repeat(17 * 1024) }));
  assert.equal(large.closed, true);
  assert.equal(room.presence.meta.has(400), false);
  const bytes = socket();
  const sync = new Uint8Array(512 * 1024);
  sync[0] = 0; sync[1] = 0; sync[2] = 1; sync[3] = 0;
  for (let i = 0; i < 5; i++) room.webSocketMessage(bytes, sync.buffer);
  assert.equal(bytes.closed, true);
  console.log('PASS: edge limits, presence ownership, ID caps, frame and byte limits');
} finally {
  room.presence.destroy();
  room.doc.destroy();
}
