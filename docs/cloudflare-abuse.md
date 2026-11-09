# Cloudflare event abuse controls

The relay and MCP are intentionally public. A room ID or MCP session ID is a
bearer capability, not user authentication. Browser Origin checks can be forged
by non-browser clients; they are not a billing-abuse defense.

## Implemented limits

| Entry point | Limit | Rejected before |
| --- | --- | --- |
| Relay upgrades | 30 per IP per minute | Durable Object lookup |
| MCP requests | 120 per IP per minute | Durable Object lookup |
| New MCP sessions | 10 per IP per minute | Durable Object creation |
| Relay room | 32 sockets | WebSocket acceptance |
| Relay socket | 200 frames and 2 MiB per second | Protocol decoding |
| Relay presence | 16 KiB/frame; 16 claimed IDs/socket | Awareness application |
| MCP POST | 1 MiB, including streamed bodies | Durable Object lookup |

MCP only accepts `/mcp` POST/DELETE requests and `/health` GET. Session IDs must
be UUIDs; sessionless POSTs must be JSON-RPC initialization requests. GET SSE is
not needed: this server uses JSON responses. Invalid routes no longer allocate
objects. Existing-session bodies are also bounded before forwarding.

Presence IDs cannot be claimed or removed by another live socket. Updates are
fully validated before application. A rejected socket is ignored while its
close handshake completes. Frame byte counters survive Durable Object
hibernation through socket attachments.

Local-only presence publishing avoids echo amplification. MCP cursor-only
relationship gestures use the same 5 Hz cap as its other cursor animations;
semantic transitions still publish immediately. Worker observability samples
1% of requests; sampling reduces logs, not execution charges.

## Remaining cost risks

- Worker rate-limit bindings are approximate and local to Cloudflare locations,
  not global hard spending caps. Shared NATs also share their IP allowance.
- Rejected HTTP requests still invoke the Worker. Use Cloudflare edge rate
  limiting/WAF on a supported zone, or Access/authentication for a private MCP,
  to reject attackers before Worker execution. Do not use browser challenges on
  MCP clients or WebSocket upgrades without testing compatibility.
- A distributed attacker can rotate IPs and room IDs. Public anonymous room
  creation cannot be made abuse-proof by an Origin allowlist. Paid/private
  deployments should require authenticated creation or signed capabilities.
- Valid small edits can still grow a room's stored Yjs document over time.
  Frame limits bound throughput, not lifetime storage. Room/document quotas and
  retention need an explicit product policy; silently evicting shared diagrams
  would cause data loss.
- The MCP session transport lives in memory; object eviction invalidates its
  transport state. Clients must initialize a new session after eviction.

Deployment must include both Wrangler configurations so their rate-limit
bindings exist. Run `npm test`, `npm run build`, `npm run mcp:build`,
`node mcp/build-worker.mjs`, and `npm --prefix cloudflare run check:node`.
