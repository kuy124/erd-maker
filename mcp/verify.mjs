/**
 * Proves the built bundle is self-contained: copy it to an empty directory with
 * no `node_modules`, no `package.json` and no checkout, run it, and complete a
 * real MCP handshake plus one create_diagram call.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'erd-mcp-iso-'));
const target = join(dir, 'erd-maker-mcp.mjs');
await copyFile(new URL('./dist/erd-maker-mcp.mjs', import.meta.url), target);

const entries = await readdir(dir);
console.log('isolated dir contains only:', entries.join(', '));

const child = spawn(process.execPath, [target], {
  cwd: dir,
  env: { ...process.env, ERD_MCP_ROOT: dir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
let stderr = '';

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});

const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'isolation-check', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const tools = await send('tools/list', {});
console.log('server:', init.result.serverInfo.name, '| tools:', tools.result.tools.length);

const made = await send('tools/call', {
  name: 'create_diagram',
  arguments: {
    name: 'Isolation',
    text: 'Customer\n  customer_id: INT key\n  email: TEXT unique\nOrder\n  order_id: INT key\nCustomer 1:N Order as places',
  },
});

const text = made.result?.content?.[0]?.text ?? '';
console.log('create_diagram ok:', !made.result?.isError);
console.log(text.split('\n').slice(0, 6).join('\n'));

const files = await readdir(join(dir, 'diagrams')).catch(() => []);
console.log('wrote into its own workspace:', files.join(', ') || '(none)');

child.kill();
// Windows keeps the file handle briefly after kill; a short wait avoids EBUSY.
await new Promise((resolve) => child.once('exit', resolve));
await new Promise((resolve) => setTimeout(resolve, 200));
await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

if (made.result?.isError || !text.includes('Customer')) {
  console.error('FAILED\n' + stderr);
  process.exit(1);
}
console.log('PASS: single file, no dependencies, full round trip.');
