import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const data = await mkdtemp(join(tmpdir(), 'relay-'));
const env = { ...process.env, PORT: '0', ALLOWED_ORIGINS: 'http://localhost:5173', RELAY_DATA_DIR: data };
let relay;

async function start() {
  relay = spawn(process.execPath, ['relay-node.mjs'], { cwd, env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const [ready] = await once(relay, 'message', { signal: AbortSignal.timeout(10000) });
  return ready.port;
}

async function stop() {
  const exited = once(relay, 'exit', { signal: AbortSignal.timeout(10000) });
  relay.send('shutdown');
  const [code] = await exited;
  relay = null;
  assert.equal(code, 0, 'Relay failed to flush its rooms');
}

async function phase(file, args) {
  const client = spawn(process.execPath, [file, ...args.map(String)], { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const [code] = await once(client, 'exit', { signal: AbortSignal.timeout(15000) });
    assert.equal(code, 0, `${file} failed`);
  } finally {
    if (client.exitCode === null) client.kill();
  }
}

try {
  const room = `test-${randomUUID()}`;
  const first = await start();
  await phase('check-sync.mjs', [first, room]);
  // The same live process must also reload a room after its last client leaves.
  await phase('check-reopen.mjs', [first, room, 'a restart']);
  await stop();
  const second = await start();
  await phase('check-reopen.mjs', [second, room, 'a restart']);
  await stop();
  console.log('PASS: Node relay syncs, reloads idle rooms, and survives a restart');
} finally {
  if (relay?.exitCode === null) relay.kill();
  await rm(data, { recursive: true, force: true });
}
