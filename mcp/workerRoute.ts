import type { Env } from './worker';

const MAX_BODY = 1024 * 1024;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET') {
    return Response.json({ ok: true, server: 'erd-maker', transport: 'durable-object' });
  }
  if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
  // JSON responses are enabled; an idle SSE GET only keeps an object awake.
  if (!['POST', 'DELETE'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST, DELETE' } });
  }
  const session = request.headers.get('mcp-session-id');
  if (session !== null && !SESSION.test(session)) return new Response('Invalid session', { status: 400 });
  if (!session && request.method !== 'POST') return new Response('Session required', { status: 400 });
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.REQUEST_LIMIT.limit({ key: ip })).success ||
      (!session && !(await env.SESSION_LIMIT.limit({ key: ip })).success)) {
    return new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60' } });
  }
  if (request.method === 'POST') {
    if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
      return new Response('JSON required', { status: 415 });
    }
    if (Number(request.headers.get('Content-Length')) > MAX_BODY) return new Response('Body too large', { status: 413 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY) {
          await reader.cancel();
          return new Response('Body too large', { status: 413 });
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try {
      const message = JSON.parse(new TextDecoder().decode(body));
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' ||
          !(typeof message.method === 'string' || message.id != null && ('result' in message || 'error' in message)) ||
          (!session && (message.method !== 'initialize' || message.id == null))) {
        return new Response('Invalid MCP request', { status: 400 });
      }
    } catch { return new Response('Invalid JSON', { status: 400 }); }
    request = new Request(request, { body });
  }
  const id = env.ERD_MCP.idFromName(session ?? crypto.randomUUID());
  return env.ERD_MCP.get(id).fetch(request);
}
