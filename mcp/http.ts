/**
 * The same tools over Streamable HTTP, for clients that cannot launch a process.
 *
 *     node erd-maker-mcp.mjs --http            # http://127.0.0.1:8787/mcp
 *     PORT=3000 node erd-maker-mcp.mjs --http
 *
 * The transport is stateless: every POST builds its own server and transport,
 * so there is no session table and any number of clients can share one process.
 * That also means no client-specific state survives between calls — which is
 * fine here, because the diagram lives in a file on disk, not in the session.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server';
import { errorMessage, WORKSPACE_ROOT } from './diagram';

const PORT = Number(process.env.PORT ?? process.env.ERD_MCP_PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const PATH = process.env.ERD_MCP_PATH ?? '/mcp';

/** Reads and parses a JSON body, so the transport does not have to. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const http = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, server: 'erd-maker', workspace: WORKSPACE_ROOT }));
    return;
  }

  if (url.pathname !== PATH) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${PATH}.` }));
    return;
  }

  // One server + transport per request: the stateless transport refuses to be
  // reused, and this is what makes concurrent clients safe.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    const message = errorMessage(error);
    console.error('ERD Maker HTTP request failed:', message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
    }
  }
});

http.listen(PORT, HOST, () => {
  console.error(`ERD Maker MCP (HTTP) ready at http://${HOST}:${PORT}${PATH}`);
  console.error(`Workspace: ${WORKSPACE_ROOT}`);
});
