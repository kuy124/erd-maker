import { Awareness } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';

/** Remote presence is already broadcast by the relay; never send it back. */
export function sendOnlyLocalPresence(provider: WebsocketProvider): void {
  const awareness = provider.awareness;
  const send = provider._awarenessUpdateHandler;
  awareness.off('update', send);
  provider._awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
    const local = (ids: number[]) => ids.filter(id => id === awareness.clientID);
    const changes = { added: local(added), updated: local(updated), removed: local(removed) };
    if (changes.added.length || changes.updated.length || changes.removed.length) send(changes, origin);
  };
  awareness.on('update', provider._awarenessUpdateHandler);
}

/**
 * How often relay-only rooms carry pointer motion.
 *
 * A Durable Object is billed by the message, so this one number decides what a
 * moving mouse costs. Four frames a second is smooth once the app's own spring
 * interpolates between them, and a fraction of the 20/s a directly connected
 * room publishes.
 */
const RELAY_CURSOR_MS = 250;

/**
 * Mirror this browser's presence onto the relay.
 *
 * Presence is split across transports, each carrying what it is cheapest at.
 * The relay always carries the name badge, because that is what tells a person
 * somebody is in the room when no direct connection can be opened. The pointer
 * rides the relay only when it has to: while every relay peer also holds a
 * direct connection, WebRTC already carries the arrow for free and nothing
 * extra is spent.
 *
 * It used to be identity-only, which is why a room whose peers could not open a
 * direct connection showed an avatar and no mouse — the edits arrived over the
 * relay while the cursor, the selection, and the typing dots had nowhere to go.
 * Mirroring the fields the WebRTC path publishes makes the arrow appear exactly
 * as it does between directly connected browsers.
 */
export function bridgeRelayPresence(direct: Awareness, relay: Awareness): () => void {
  relay.setLocalState(null);
  /** What the relay was last told, and whether motion went with it. */
  let sent: string | null = null;
  let sentFull = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = 0;
  let queued: { state: Record<string, unknown>; full: boolean } | null = null;

  /**
   * Is anybody reading this browser through the relay and nothing else?
   *
   * Only then does motion need mirroring. Both awarenesses share the doc, so
   * our own id has to be skipped or we would count ourselves.
   */
  const relayOnlyPeers = () => {
    for (const id of relay.getStates().keys()) {
      if (id !== relay.clientID && !direct.getStates().has(id)) return true;
    }
    return false;
  };

  const flush = () => {
    timer = undefined;
    const next = queued;
    queued = null;
    if (!next) return;
    const json = JSON.stringify(next.state);
    if (json === sent) return;
    sent = json;
    sentFull = next.full;
    lastSentAt = Date.now();
    relay.setLocalState(next.state);
  };

  const publish = () => {
    const state = direct.getLocalState() as Record<string, unknown> | null;
    /*
     * A transport teardown is not a departure.
     *
     * `recover()` disconnects the WebRTC provider to retry signalling, and
     * y-webrtc clears this browser's local awareness on the way out. Publishing
     * that blank made the room forget everybody every retry, which is why a
     * conversation reachable only through the relay kept saying "Waiting for
     * others" while edits flowed. Leaving is announced explicitly instead.
     */
    if (!state) {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      queued = null;
      return;
    }
    const identity = {
      transport: 'webrtc', name: state.name, color: state.color, userId: state.userId,
    };
    const full = relayOnlyPeers();
    const next = !full ? identity : {
      ...identity,
      cursor: state.cursor ?? null,
      selectedIds: Array.isArray(state.selectedIds) ? state.selectedIds : [],
      view: state.view,
      pressing: state.pressing === true,
      typing: state.typing === true,
    };
    queued = { state: next as Record<string, unknown>, full };
    /*
     * Only a pointer move is worth throttling.
     *
     * Arriving, selecting, typing, or changing notation is a state change a
     * watcher has to see at once, and it happens far less often than a mouse
     * moves. Gaining or losing a relay-only peer flips what is carried, so that
     * frame is not throttled either.
     */
    const motion = sent !== null && sentFull === full &&
      JSON.stringify({ ...JSON.parse(sent), cursor: null }) ===
      JSON.stringify({ ...next, cursor: null });
    if (!motion) {
      if (timer !== undefined) clearTimeout(timer);
      flush();
      return;
    }
    if (timer !== undefined) return;
    const wait = RELAY_CURSOR_MS - (Date.now() - lastSentAt);
    if (wait <= 0) flush();
    else timer = setTimeout(flush, wait);
  };

  const onRelayChange = (_changes: unknown, origin: unknown) => { if (origin !== 'local') publish(); };
  direct.on('change', publish);
  // A relay peer joining or leaving decides whether motion is mirrored at all.
  relay.on('change', onRelayChange);
  publish();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    direct.off('change', publish);
    relay.off('change', onRelayChange);
  };
}
