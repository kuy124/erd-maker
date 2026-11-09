import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { bridgeRelayPresence } from '../../src/collab/relayPresence';

it('keeps browser motion off the relay while receiving MCP presence and departures', () => {
  const doc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const direct = new Awareness(doc);
  const relay = new Awareness(doc);
  const remote = new Awareness(remoteDoc);
  const stop = bridgeRelayPresence(direct, relay);
  try {
    direct.setLocalState({ name: 'Browser', color: '#123456', cursor: null });
    let updates = 0;
    relay.on('update', () => { updates += 1; });
    for (let x = 0; x < 100; x++) {
      direct.setLocalStateField('cursor', { x, y: 10 });
      direct.setLocalStateField('dragging', { dx: x, dy: 0 });
    }
    expect(updates).toBe(0);
    expect(relay.getLocalState()).toEqual({ transport: 'webrtc', name: 'Browser', color: '#123456', userId: undefined });
    const deliver = () => applyAwarenessUpdate(relay, encodeAwarenessUpdate(remote, [remote.clientID]), 'server');
    remote.setLocalState({ name: 'AI', cursor: { x: 20, y: 30 } });
    deliver();
    expect(direct.getStates().get(remote.clientID)?.cursor).toEqual({ x: 20, y: 30 });
    remote.setLocalState(null);
    deliver();
    expect(direct.getStates().has(remote.clientID)).toBe(false);
    remote.setLocalState({ name: 'Other browser', transport: 'webrtc' });
    deliver();
    expect(direct.getStates().has(remote.clientID)).toBe(false);
    direct.setLocalState(null);
    expect(relay.getLocalState()).toBe(null);
  } finally {
    stop();
    direct.destroy(); relay.destroy(); remote.destroy();
    doc.destroy(); remoteDoc.destroy();
  }
});
