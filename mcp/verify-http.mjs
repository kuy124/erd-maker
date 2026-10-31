/**
 * Same round trip as verify.mjs, but over Streamable HTTP and from a directory
 * containing nothing but the bundle — the "nothing to install" claim, tested.
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'erd-mcp-http-'));
const target = join(dir, 'erd-maker-mcp.mjs');
await copyFile(new URL('./dist/erd-maker-mcp.mjs', import.meta.url), target);

const port = 8791;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [target, '--http', '--port', String(port)], {
  cwd: dir,
  env: { ...process.env, ERD_MCP_ROOT: dir },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

// Wait for the listener rather than sleeping a fixed amount.
const deadline = Date.now() + 20_000;
let up = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${base}/health`);
    if (response.ok) { up = true; break; }
  } catch { /* not listening yet */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!up) {
  console.error('server never listened\n' + stderr);
  child.kill();
  process.exit(1);
}
console.log('GET /health ok');

let sessionId;
const rpc = async (body) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const assigned = response.headers.get('mcp-session-id');
  if (assigned) sessionId = assigned;
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}\n--- server stderr ---\n${stderr}`);
  // A notification is answered with 202 and no body, by spec.
  if (text.trim() === '') return null;
  // Stateless JSON responses; fall back to SSE framing if the server streams.
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
};

const init = await rpc({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'http-check', version: '0' } },
});
console.log('server:', init.result.serverInfo.name);

await rpc({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
console.log('tools over HTTP:', tools.result.tools.length);

const made = await rpc({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: {
    name: 'create_diagram',
    arguments: {
      name: 'HttpCheck',
      text: 'Author\n  author_id: INT key\n  name: TEXT\nBook\n  book_id: INT key\nAuthor 1:N Book as writes',
    },
  },
});

const text = made.result?.content?.[0]?.text ?? '';
const files = await readdir(join(dir, 'diagrams')).catch(() => []);
console.log('create_diagram ok:', !made.result?.isError);
console.log('wrote:', files.join(', ') || '(none)');

child.kill();
await new Promise((resolve) => child.once('exit', resolve));
await new Promise((resolve) => setTimeout(resolve, 200));
await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

if (made.result?.isError || !text.includes('Author')) {
  console.error('FAILED\n' + stderr);
  process.exit(1);
}
console.log('PASS: HTTP transport, single file, no dependencies.');
