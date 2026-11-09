import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
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

/** Keep browser motion off the relay; receive legacy/MCP presence without echoing it back. */
export function bridgeRelayPresence(direct: Awareness, relay: Awareness): () => void {
  relay.setLocalState(null);
  const publishIdentity = () => {
    const state = direct.getLocalState();
    const identity = state ? {
      transport: 'webrtc', name: state.name, color: state.color, userId: state.userId,
    } : null;
    if (JSON.stringify(identity) !== JSON.stringify(relay.getLocalState())) relay.setLocalState(identity);
  };
  const imported = new Set<number>();
  const receive = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    const ids = [...added, ...updated, ...removed].filter(id => {
      if (id === direct.clientID) return false;
      const state = relay.getStates().get(id);
      if (state?.transport === 'webrtc') return false;
      if (state) { imported.add(id); return true; }
      return imported.delete(id);
    });
    if (ids.length) applyAwarenessUpdate(direct, encodeAwarenessUpdate(relay, ids), relay);
  };
  direct.on('change', publishIdentity);
  relay.on('update', receive);
  publishIdentity();
  return () => {
    direct.off('change', publishIdentity);
    relay.off('update', receive);
  };
}
