# Cloudflare sync + GitHub Pages

Users only open a share link. You, the app owner, do this setup once.

1. Create a Cloudflare account. Review current Workers / Durable Objects free-tier
   limits; this backend uses an active Durable Object per open room, not WebSocket
   hibernation. Long-lived rooms consume duration quota. Free is not unlimited.
2. In `cloudflare/wrangler.jsonc`, set `ALLOWED_ORIGINS` to your exact frontend
   origin, e.g. `https://YOUR-NAME.github.io` (no repository path or trailing slash).
   Multiple origins are comma-separated.
3. In this directory run:

   ```sh
   npm install
   npx wrangler login
   npm run deploy
   ```

4. Copy the printed Worker URL, change `https://` to `wss://`, and set the
   frontend build variable `VITE_SYNC_URL`, for example:

   ```dotenv
   VITE_SYNC_URL=wss://erd-sync.YOUR-SUBDOMAIN.workers.dev
   ```

   For local testing put this in the root `.env.local` and restart Vite.
   For GitHub Pages add it to the build step's `env` in your Actions workflow,
   then rebuild/redeploy. This URL is public; no Cloudflare API token belongs
   in frontend code. Without it the app continues using its old P2P transport.

## Limits and privacy

- HTTPS WebSockets replace direct peer connections; TURN is not required.
- Rooms are accessible to anyone with the room ID/share link. There are no
  accounts or per-user authorization. Allowed origins are a browser safeguard,
  not authentication. Do not use this deployment for sensitive diagrams.
- Unlike the old encrypted P2P transport, the sync server can read diagrams.
  Traffic is encrypted in transit using TLS, not end-to-end encrypted.
- Room content lives in server memory while active, and is written to Durable
  Object storage when the last collaborator leaves, so a share link opens with
  nobody online. Nothing expires it yet: an abandoned room occupies storage
  until the worker is cleared. This is still not a backup or version history.
- Limits: 32 connections/room, 512 KiB/message, 200 messages/second/connection.
  Oversized diagrams may need these limits raised and a chunked protocol.
- All collaborators must use the rebuilt frontend with the same sync URL.

## Local check

`node cloudflare/check-room.mjs` (from the repository root) needs no server: it
drives the room object with a stand-in for Durable Object storage and proves a
room still opens after everyone has left. Run `npm install` in this directory
first.

With `npm run dev` running here, `node cloudflare/check.mjs` from the repository
root opens two independent Yjs clients, verifies a document update reaches the
other client, and checks the origin allowlist. It does not test the public
Cloudflare deployment or cross-network availability.
