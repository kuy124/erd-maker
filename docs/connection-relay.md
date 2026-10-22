# Connecting through restrictive networks

The app retries failed peer connections every 45 seconds and reconnects when
the browser comes back online. STUN alone cannot traverse every firewall.
For those networks, deploy with a TURN service you operate or pay for:

```dotenv
VITE_ICE_SERVERS=[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:relay.example.com:3478","turns:relay.example.com:443?transport=tcp"],"username":"temporary-user","credential":"temporary-token"}]
```

Set this in `.env.local` and restart Vite (or rebuild for production). Values
are exposed to browsers: use scoped, short-lived credentials, never an admin
key or a TURN shared secret. For a public deployment, provision fresh credentials
through your own authenticated service rather than shipping an expiring token
in a permanent build. TURN incurs relay traffic and is not supplied by this app.

`VITE_SIGNALING` continues to accept comma-separated y-webrtc signaling URLs.
A working signaling service is necessary even when TURN is configured.

Verify with two devices on different networks, including the restricted network;
local unit tests do not establish that a public signaling or TURN service works.
