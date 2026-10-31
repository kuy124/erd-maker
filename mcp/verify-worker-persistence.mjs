/**
 * Proves the deployed Worker persists diagrams in Durable Object storage.
 *
 * Two separate MCP sessions: the first writes a diagram, the second (a fresh
 * session, so a fresh object) must not see it, while a *new* session that
 * reopens the same session id must. This is the difference between real
 * persistence and state that dies with the request.
 */
const BASE = 'https://erd-maker-mcp.cerberus-tusk-proxy.workers.dev';
const MCP = BASE + '/mcp';

function client(sessionId = null) {
  let sid = sessionId;
  let id = 1;
  return {
    get sessionId() { return sid; },
    async rpc(method, params, notify = false) {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      if (sid) headers['mcp-session-id'] = sid;
      const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: id++, method, params };
      const res = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify(body) });
      const got = res.headers.get('mcp-session-id');
      if (got) sid = got;
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (notify || !text) return null;
      return JSON.parse(text);
    },
    async open() {
      try {
        await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '1' } });
        await this.rpc('notifications/initialized', {}, true);
      } catch (error) {
        // "Server already initialized" is the expected answer when the same
        // session id is reused: it proves the object survived.
        if (!String(error.message).includes('already initialized')) throw error;
      }
    },
  };
}

const a = client();
await a.open();
await a.rpc('tools/call', {
  name: 'create_diagram',
  arguments: { name: 'Persisted', text: 'Widget\n  id: INT key\nPart\n  id: INT key\nWidget 1:N Part as contains', save: true, path: 'persisted.json' },
});

// A brand new session: its object must be empty.
const b = client();
await b.open();
const listB = await b.rpc('tools/call', { name: 'list_diagrams', arguments: {} });
const diagramsB = JSON.parse(listB.result.content[0].text).diagrams;
console.log('fresh session sees', diagramsB.length, 'diagram(s) -> isolation', diagramsB.length === 0 ? 'OK' : 'LEAK');

// Reusing the first session id must land on the same object.
const c = client(a.sessionId);
await c.open();
const listC = await c.rpc('tools/call', { name: 'list_diagrams', arguments: {} });
const diagramsC = JSON.parse(listC.result.content[0].text).diagrams;
const found = diagramsC.some((d) => d.path === 'persisted.json');
console.log('reopened session sees', diagramsC.length, 'diagram(s) -> persistence', found ? 'OK' : 'LOST');

const pass = diagramsB.length === 0 && found;
console.log(pass ? 'PASS: storage is durable and per-client.' : 'FAIL');
process.exitCode = pass ? 0 : 1;
