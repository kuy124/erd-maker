/**
 * End-to-end check against the deployed Worker.
 *
 * Talks the real MCP Streamable HTTP protocol to the public URL, builds a
 * diagram from the compact text form, reads it back, and confirms the result
 * survived in Durable Object storage.
 */

const URL_BASE = process.argv[2] ?? 'https://erd-maker-mcp.cerberus-tusk-proxy.workers.dev';
const MCP = URL_BASE + '/mcp';

let sessionId = null;
let nextId = 1;

async function rpc(method, params, notify = false) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const res = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}: ${text}`);
  if (notify || !text) return null;

  // The transport may answer as JSON or as an SSE frame.
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function main() {
  const health = await (await fetch(URL_BASE + '/health')).json();
  console.log('health:', JSON.stringify(health));

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'deploy-check', version: '1.0.0' },
  });
  console.log('server:', init.result.serverInfo.name, '| session:', sessionId ?? '(none)');

  await rpc('notifications/initialized', {}, true);

  const tools = await rpc('tools/list', {});
  console.log('tools:', tools.result.tools.length);

  // Build a diagram from the compact text form: this exercises the parser, the
  // Durable Object workspace, and the auto-layout in one call.
  const made = await rpc('tools/call', {
    name: 'create_diagram',
    arguments: {
      name: 'Deployed Check',
      text: [
        'Customer',
        '  customer_id: INT key',
        '  email: TEXT unique',
        'Order',
        '  order_id: INT key',
        '  placed_at: TIMESTAMP',
        'Customer 1:N Order as places',
      ].join('\n'),
      save: true,
      path: 'deployed-check.json',
    },
  });
  const created = JSON.parse(made.result.content[0].text);
  console.log('create_diagram isError:', made.result.isError === true);
  console.log('savedTo:', created.filePath ?? '(not saved)');

  // Read it back through a second call: proves the object kept its session.
  const summary = await rpc('tools/call', { name: 'summarize_diagram', arguments: {} });
  const s = JSON.parse(summary.result.content[0].text).summary;
  console.log('entities:', s.entities.map((e) => e.name).join(', '));
  console.log('relationships:', s.relationships.map((r) => r.name).join(', '));
  console.log('attribute count:', s.counts?.attributes);

  const files = await rpc('tools/call', { name: 'list_diagrams', arguments: {} });
  const listed = JSON.parse(files.result.content[0].text);
  console.log('files:', (listed.diagrams ?? []).map((f) => f.path).join(', '));

  const sql = await rpc('tools/call', { name: 'generate_sql', arguments: {} });
  const ddl = JSON.parse(sql.result.content[0].text);
  console.log('sql has CREATE TABLE:', /CREATE TABLE/i.test(ddl.sql ?? ''));

  const ok = s.entities.length === 2 && s.relationships.length === 1;
  console.log(ok ? 'PASS: deployed Worker built and stored a diagram.' : 'FAIL: unexpected content');
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
