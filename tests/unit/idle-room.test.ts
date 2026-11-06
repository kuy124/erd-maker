import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { LiveRoom } from '../../mcp/live';
import { emptyDocument } from '../../src/model/types';
import { createRoom, transportState } from '../../src/collab/provider';

vi.mock('y-indexeddb', () => ({ IndexeddbPersistence: class {
  whenSynced = Promise.resolve();
  destroy() {}
} }));

afterEach(() => vi.useRealTimers());

it('disconnects idle humans without automatic recovery and allows explicit rejoin', () => {
  vi.useFakeTimers();
  const room = createRoom('idle-test-room', { persist: false, signalling: [] });
  try {
    room.awareness.setLocalState({ name: 'Human' });
    vi.advanceTimersByTime(4 * 60_000);
    window.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(4 * 60_000);
    expect(transportState(room.provider).idle).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(transportState(room.provider).idle).toBe(true);
    expect(room.awareness.getLocalState()).toBeNull();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('pageshow'));
    window.dispatchEvent(new Event('pointermove'));
    vi.advanceTimersByTime(30_000);
    expect(transportState(room.provider).idle).toBe(true);
    room.reconnect();
    expect(transportState(room.provider).idle).toBe(false);
    expect(room.awareness.getLocalState()).toEqual({ name: 'Human' });
  } finally {
    room.destroy();
  }
});

it('closes an idle assistant and preserves a snapshot before destroying it', () => {
  vi.useFakeTimers();
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const destroy = vi.fn();
  const live = new LiveRoom('idle-test-room', doc, { on() {}, off() {}, connect() {}, destroy }, awareness, '', '');
  const onIdle = vi.fn(() => live.snapshot());
  live.onIdle = onIdle;
  live.flash(emptyDocument(), null);
  vi.advanceTimersByTime(59_999);
  expect(destroy).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onIdle).toHaveBeenCalledOnce();
  expect(destroy).toHaveBeenCalledOnce();
  live.close();
  expect(destroy).toHaveBeenCalledOnce();
});
