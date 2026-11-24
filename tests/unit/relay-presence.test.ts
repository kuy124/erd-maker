import { expect, it, vi } from 'vitest';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { bridgeRelayPresence, sendOnlyLocalPresence } from '../../src/collab/relayPresence';
import { readPeers } from '../../src/collab/provider';

it('sends local presence and departures without echoing remote updates', () => {
  const doc = new Y.Doc();
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  const provider = new WebsocketProvider('wss://relay.test', 'room1234', doc, { connect: false });
  const send = vi.fn(provider._awarenessUpdateHandler);
  provider.awareness.off('update', provider._awarenessUpdateHandler);
  provider._awarenessUpdateHandler = send;
  provider.awareness.on('update', send);
  sendOnlyLocalPresence(provider);
  try {
    remote.setLocalState({ name: 'Peer' });
    applyAwarenessUpdate(provider.awareness, encodeAwarenessUpdate(remote, [remote.clientID]), provider);
    expect(provider.awareness.getStates().get(remote.clientID)).toEqual({ name: 'Peer' });
    expect(send).not.toHaveBeenCalled();
    provider.awareness.setLocalState({ name: 'Me' });
    expect(send).toHaveBeenCalledTimes(1);
    provider.awareness.setLocalState(null);
    expect(send).toHaveBeenCalledTimes(2);
    remote.setLocalState(null);
    applyAwarenessUpdate(provider.awareness, encodeAwarenessUpdate(remote, [remote.clientID]), provider);
    expect(send).toHaveBeenCalledTimes(2);
    expect(provider.awareness.getStates().has(remote.clientID)).toBe(false);
  } finally {
    provider.destroy(); provider.awareness.destroy(); remote.destroy();
    doc.destroy(); remoteDoc.destroy();
  }
});

it('carries identity on the relay, and motion only when a peer has no direct link', () => {
  vi.useFakeTimers();
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

    // Nobody is in this room but us, so the relay needs only the name badge.
    for (let x = 0; x < 100; x++) direct.setLocalStateField('cursor', { x, y: 10 });
    vi.advanceTimersByTime(1000);
    expect(updates).toBe(0);
    expect(relay.getLocalState()).toEqual({ transport: 'webrtc', name: 'Browser', color: '#123456', userId: undefined });

    // A peer that is only reachable through the relay needs the pointer too,
    // or the room shows an avatar and no mouse.
    const deliver = () => applyAwarenessUpdate(relay, encodeAwarenessUpdate(remote, [remote.clientID]), 'server');
    remote.setLocalState({ name: 'AI', cursor: { x: 20, y: 30 } });
    deliver();
    // Gaining a relay-only peer is not motion, so the full state goes at once.
    expect(relay.getLocalState()).toMatchObject({ cursor: { x: 99, y: 10 } });

    // Throttled: a burst of pointer moves is coalesced to one frame.
    const before = updates;
    for (let x = 0; x < 20; x++) direct.setLocalStateField('cursor', { x, y: 60 });
    expect(updates).toBe(before);
    vi.advanceTimersByTime(300);
    expect(updates).toBe(before + 1);
    expect(relay.getLocalState()).toMatchObject({ cursor: { x: 19, y: 60 } });

    // A state change is not a pointer move, so it is not held back.
    const beforeTyping = updates;
    direct.setLocalStateField('typing', true);
    expect(updates).toBe(beforeTyping + 1);
    expect(relay.getLocalState()).toMatchObject({ typing: true });

    expect(readPeers(direct, doc.clientID, relay)[0]?.cursor).toEqual({ x: 20, y: 30 });
    expect(direct.meta.has(remote.clientID)).toBe(false);
    remote.setLocalState(null);
    deliver();
    expect(direct.getStates().has(remote.clientID)).toBe(false);
    remote.setLocalState({ name: 'Other browser', transport: 'webrtc' });
    deliver();
    expect(readPeers(direct, doc.clientID, relay)[0]?.name).toBe('Other browser');
    // Even a far-newer relay clock must not poison incoming WebRTC updates.
    for (let i = 0; i < 20; i++) remote.setLocalStateField('name', `Relay ${i}`);
    deliver();
    const rtcDoc = new Y.Doc();
    rtcDoc.clientID = remote.clientID;
    const rtc = new Awareness(rtcDoc);
    rtc.setLocalState({ name: 'Direct browser', cursor: { x: 5, y: 6 } });
    applyAwarenessUpdate(direct, encodeAwarenessUpdate(rtc, [rtc.clientID]), 'webrtc');
    expect(readPeers(direct, doc.clientID, relay)[0]?.cursor).toEqual({ x: 5, y: 6 });
    rtc.destroy(); rtcDoc.destroy();
    // Relay identity refreshes must not replace direct cursor/selection data.
    direct.getStates().set(remote.clientID, { name: 'Direct browser', cursor: { x: 5, y: 6 } });
    remote.setLocalStateField('name', 'Relay browser');
    deliver();
    expect(direct.getStates().get(remote.clientID)?.cursor).toEqual({ x: 5, y: 6 });
    expect(readPeers(direct, doc.clientID, relay)[0]?.cursor).toEqual({ x: 5, y: 6 });

    // A transport retry clears local presence; that is not a departure, and
    // blanking the relay badge is what made rooms read "Waiting for others"
    // while edits kept arriving.
    const identityBefore = relay.getLocalState();
    direct.setLocalState(null);
    expect(relay.getLocalState()).toEqual(identityBefore);
  } finally {
    stop();
    direct.destroy(); relay.destroy(); remote.destroy();
    doc.destroy(); remoteDoc.destroy();
    vi.useRealTimers();
  }
});
