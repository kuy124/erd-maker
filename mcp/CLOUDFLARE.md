# Hosted MCP on Cloudflare

The same twenty tools, running as a Worker, with nothing to install.

    https://erd-maker-mcp.cerberus-tusk-proxy.workers.dev/mcp

Point any Streamable HTTP MCP client at that URL and you are done. No clone, no
`npm install`, no local process.

## Why a Durable Object

The service keeps one diagram open at a time in module-level state, which works
because a stdio server is one long-lived process. A plain Worker has no such
thing: every request may land on a fresh isolate, so that state would vanish
between calls.

A Durable Object is the one Workers primitive that matches the old contract. One
object is one instance, handling one request at a time, with memory kept between
requests, so `diagram.ts` runs unchanged. Diagrams themselves are written to the
object's own storage, which means the Worker needs nothing provisioned beyond
itself — no bucket, no database, no account setup.

Routing gives each MCP client its own object, keyed by session id, so two clients
never see each other's diagrams.

## Deploying

    npm run mcp:deploy

That builds `mcp/dist/worker.mjs` and pushes it with `wrangler`. The first deploy
creates the Durable Object class automatically.

## Verifying

    npm run mcp:verify:worker              # tools, create, summarize, SQL
    node mcp/verify-worker-persistence.mjs # durability and per-client isolation

Both run against the deployed URL, not a local copy.

## Configuration

Set these as Worker variables in `mcp/wrangler.jsonc` under `vars`, or leave them
alone for the defaults:

| Variable | Meaning |
| --- | --- |
| `DIAGRAMS_PREFIX` | Storage key prefix, default `diagrams` |
| `ERD_MCP_APP_URL` | Where the ERD Maker app is served, for share links |
| `ERD_MCP_RELAY_URL` | Yjs relay for live rooms |
| `ERD_MCP_RELAY_ORIGIN` | Origin the relay allowlists |
| `ERD_MCP_AI_NAME` | Name shown for the AI in a live room |
| `ERD_MCP_AI_COLOR` | Cursor colour for the AI |

## Limits worth knowing

- **Anyone with the URL can write diagrams** into their own object. Objects are
  isolated, so this is not a way to read anyone else's work, but it is not
  authenticated either. Add a bearer token check in `worker.ts` before putting
  this somewhere public and permanent.
- **Live rooms need a reachable relay.** `open_room` works, but the WebSocket
  adapter (`workerSocket.ts`) connects out to whatever `ERD_MCP_RELAY_URL` names.
- **Free-tier Durable Object limits apply**: storage and duration are metered per
  account.
