/**
 * The MCP server as a Durable Object, plus the Worker that routes to it.
 *
 * A Durable Object is the one Workers primitive that matches what this server
 * already assumes: one instance, one request at a time, memory kept between
 * requests. That is the same contract stdio gets from a process, so the
 * module-level session in diagram.ts works here unchanged.
 *
 * One object serves one MCP client, and its storage holds that client's
 * diagrams. Routing is by session id, so two clients never share an object.
 */

import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './tools';
import { ObjectStorageWorkspace } from './objectWorkspace';
import { workerSocketFactory } from './workerSocket';
import { useSocketFactory } from './live';
import { useWorkspace } from './diagram';
import { useEnv } from './env';

export interface Env {
  /** Durable Object namespace that owns the sessions. */
  ERD_MCP: DurableObjectNamespace;
  /** Optional settings, passed straight to env(). */
  DIAGRAMS_PREFIX?: string;
  ERD_MCP_RELAY_URL?: string;
  ERD_MCP_RELAY_ORIGIN?: string;
  ERD_MCP_APP_URL?: string;
  ERD_MCP_AI_NAME?: string;
  ERD_MCP_AI_COLOR?: string;
}

export class ErdMcpServer extends DurableObject<Env> {
  private readonly transport: WebStandardStreamableHTTPServerTransport;
  private readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Configuration arrives as bindings, not env vars.
    const settings: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') settings[key] = value;
    }
    useEnv(settings);

    // Diagrams live in this object's own storage: durable across restarts,
    // and needing nothing provisioned beyond the Worker itself.
    const prefix = env.DIAGRAMS_PREFIX ?? 'diagrams';
    useWorkspace(new ObjectStorageWorkspace({
      storage: ctx.storage as never,
      prefix,
      label: 'durable-object://' + prefix,
    }));
    useSocketFactory(workerSocketFactory);

    // One transport for the object's whole life. The object is single
    // threaded, so one transport cannot interleave two requests, and the MCP
    // session id it issues is stable for this client.
    //
    // The id must be the object's *name*, not its internal id: the Worker
    // routes on the session header, so if the two disagreed every follow-up
    // request would land on a different, uninitialized object.
    const sessionName = this.ctx.id.name ?? this.ctx.id.toString();
    // The Worker names this object after the client's session id, so echoing
    // that name keeps routing consistent for the rest of the conversation.
    this.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionName,
      enableJsonResponse: true,
    });
    this.ready = createServer().connect(this.transport);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    return this.transport.handleRequest(request);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, server: 'erd-maker', transport: 'durable-object' });
    }

    // Every client gets its own object, so two people never share a diagram
    // or fight over one MCP session.
    //
    // A client that already has a session id is routed by it. A client on its
    // first call has none yet, so it is given a fresh object named after a
    // random id, which that object then reports as the session id.
    const sessionId = request.headers.get('mcp-session-id') ?? crypto.randomUUID();
    const id = env.ERD_MCP.idFromName(sessionId);
    return env.ERD_MCP.get(id).fetch(request);
  },
};
