// Downloads the published bundle and runs it in an empty directory.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = 'https://raw.githubusercontent.com/kuy124/erd-maker/main/mcp/dist/erd-maker-mcp.mjs';

const response = await fetch(URL);
if (!response.ok) throw new Error(`download failed: ${response.status}`);
const source = await response.text();
console.log(`downloaded ${source.length} chars over HTTPS`);

const dir = await mkdtemp(join(tmpdir(), 'erd-remote-'));
const file = join(dir, 'erd-maker-mcp.mjs');
await writeFile(file, source);
await mkdir(join(dir, 'diagrams'), { recursive: true });

const child = spawn(process.execPath, [file], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
child.stdout.on('data', (d) => { buffer += d; });
child.stderr.on('data', () => {});

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
const waitFor = (id) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = setInterval(() => {
    for (const line of buffer.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === id) { clearInterval(tick); resolve(m); }
      } catch {}
    }
    if (Date.now() - started > 30000) { clearInterval(tick); reject(new Error(`timeout on ${id}`)); }
  }, 50);
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote', version: '0' } } });
const init = await waitFor(1);
console.log('server:', init.result.serverInfo.name);
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
  name: 'create_diagram',
  arguments: { name: 'Remote', text: 'Customer\n  customer_id: INT key\nOrder\n  order_id: INT key\nCustomer 1:N Order as places' },
} });
const made = await waitFor(2);
console.log('create_diagram isError:', made.result?.isError ?? false);

child.kill();
await new Promise((r) => setTimeout(r, 400));
const saved = await readFile(join(dir, 'diagrams', 'remote.json'), 'utf8');
await rm(dir, { recursive: true, force: true });

console.log(saved.includes('Customer') ? 'PASS: downloaded bundle built a diagram with no clone.' : 'FAIL: no diagram written.');
