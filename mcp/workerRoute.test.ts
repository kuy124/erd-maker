// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { routeRequest } from './workerRoute';
import type { Env } from './worker';

function setup() {
  const forward = vi.fn(async () => new Response('forwarded'));
  const env = {
    ERD_MCP: { idFromName: vi.fn((name: string) => name), get: vi.fn(() => ({ fetch: forward })) },
    REQUEST_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    SESSION_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
  };
  return { env, route: (request: Request) => routeRequest(request, env as unknown as Env) };
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
function post(body = initialize, headers: Record<string, string> = {}) {
  return new Request('https://example.com/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

describe('MCP edge abuse checks', () => {
  it('rejects invalid requests before creating an object', async () => {
    const { env, route } = setup();
    const requests = [
      [new Request('https://example.com/anything'), 404],
      [new Request('https://example.com/mcp'), 405],
      [post(initialize, { 'mcp-session-id': 'arbitrary-object' }), 400],
      [post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })), 400],
      [post('invalid JSON'), 400],
      [post('null'), 400],
      [post(' '.repeat(1024 * 1024 + 1)), 413],
      [post(initialize, { 'Content-Type': 'text/plain' }), 415],
    ] as const;
    for (const [request, status] of requests) expect((await route(request)).status).toBe(status);
    expect(env.ERD_MCP.get).not.toHaveBeenCalled();
  });

  it('limits requests and session creation before forwarding', async () => {
    const { env, route } = setup();
    env.SESSION_LIMIT.limit.mockResolvedValueOnce({ success: false });
    expect((await route(post())).status).toBe(429);
    env.REQUEST_LIMIT.limit.mockResolvedValueOnce({ success: false });
    expect((await route(post())).status).toBe(429);
    expect(env.ERD_MCP.get).not.toHaveBeenCalled();
    expect((await route(post())).status).toBe(200);
    expect(env.ERD_MCP.idFromName).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9-]{36}$/));
    const session = 'b3667ae4-26b1-47b4-80c4-b03ac99943a5';
    expect((await route(post(initialize, { 'mcp-session-id': session }))).status).toBe(200);
    expect(env.ERD_MCP.idFromName).toHaveBeenLastCalledWith(session);
  });
});
