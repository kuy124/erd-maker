# Sync relay

## Node relay without Cloudflare

The Node relay reuses `DiagramRoom` from `worker.js`. It uses one WebSocket per
client, makes no Cloudflare requests, and reloads disconnected rooms from disk.
Run it on your own computer or a Node host. It requires Node 20 or newer.

```sh
cd cloudflare
npm ci
npm start
```

Set these environment variables before starting:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listening port; hosts may supply their own |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated app origins, without paths |
| `RELAY_DATA_DIR` | `cloudflare/rooms` | Room files; use persistent storage for durable links |

For the hosted ERD Maker app, set `ALLOWED_ORIGINS=https://kuy124.github.io`.
Use a TLS-enabled host to obtain a `wss://` URL for that HTTPS app. Both clients
must use the same relay:

```dotenv
# Frontend build environment; rebuild the app after changing it.
VITE_SYNC_URL=wss://YOUR-RELAY-HOST

# MCP environment; restart the MCP after changing it.
ERD_MCP_RELAY_URL=wss://YOUR-RELAY-HOST
ERD_MCP_RELAY_ORIGIN=https://kuy124.github.io
```

For local testing, both URLs can be `ws://localhost:8080`, with
`ERD_MCP_RELAY_ORIGIN=http://localhost:5173`. Run the app locally, not the HTTPS
GitHub Pages site, when using an unencrypted local WebSocket.

To avoid Cloudflare entirely, also run the existing Node/stdio MCP instead of
the Cloudflare-hosted MCP. See [the MCP instructions](../mcp/README.md).

### Free hosting limitations

For [Render Free](https://render.com/docs/free), use a Web Service with root
directory `cloudflare`, build command `npm ci --omit=dev`, start command
`npm start`, and instance type **Free**. Set the allowed app origin as above.
No account or service has been created by these instructions.

Render Free sleeps after inactivity and deletes local files on restart,
redeploy, or sleep. It is suitable for live sessions, not guaranteed room
persistence. Export your diagram before leaving; use your own disk if durable
share links are required. Free plans have usage limits; avoid adding a payment
method if you do not want automatic bandwidth overage charges.

## Cloudflare relay and GitHub Pages

Cloudflare free limits [reset daily at 00:00 UTC](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Incoming WebSocket messages count at 20:1 for compute request billing; outgoing
messages do not count. Cursor updates are capped at 20 per second, while local
animation still renders at 60 fps. This reduces traffic, not every source of
duration or storage usage. Do not use artificial keep-alive HTTP polling.

`Exceeded allowed duration in Durable Objects free tier` means the account's
daily duration allowance is exhausted. The request can fail even when nested
fetch/subrequest logs say `OK`; those are not proof of a successful WebSocket
handshake. Deploying does not reset the allowance: wait until 00:00 UTC
(07:00 Jakarta), use the Node relay, or upgrade the account if needed.
The relay uses WebSocket hibernation and disconnects clients whose presence
cannot fit Cloudflare's 2 KiB socket attachment limit (close code 1009), rather
than keeping the room awake indefinitely. Keep presence payloads small.

1. In `wrangler.jsonc`, set `ALLOWED_ORIGINS` to your exact frontend origin,
   such as `https://YOUR-NAME.github.io`, without the repository path or a
   trailing slash. Multiple origins are comma-separated.
2. From `cloudflare`, run `npm ci`, `npx wrangler login`, then `npm run deploy`.
3. Change the printed Worker URL from `https://` to `wss://`. Use it for both
   `VITE_SYNC_URL` and `ERD_MCP_RELAY_URL`, as described above. For the hosted MCP,
   set its Worker environment and redeploy it.
4. Rebuild and redeploy the frontend. For GitHub Pages, set `VITE_SYNC_URL` in
   the Actions build environment. For local Vite, use the root `.env.local`.

The relay accepts only allowlisted origins and valid room IDs. Room IDs are
bearer capabilities: do not enumerate rooms or use guessable names. Message
size, rate, and per-room connection limits apply. Browser peers can still use
the existing WebRTC transport without this relay, but the MCP needs a relay.

## Verification

From the repository root after installing its dependencies:

```sh
node cloudflare/check-node.mjs
node cloudflare/check-room.mjs
```

The Node check covers origin and room validation, two-way sync, idle-room
reload, and process restart. It uses temporary room files and cleans up only
the processes it starts. The room check covers storage and the Worker handler
contract without a Cloudflare account.

With `npm run dev` running in `cloudflare`, `node cloudflare/check.mjs` from
the repository root checks a local workerd instance. These checks do not
verify public deployment availability or unused hosting quota.
