import { expect, it, vi } from 'vitest';
import type { WebsocketProvider } from 'y-websocket';
import { limitRelayRetries } from '../../src/collab/relayRetry';

it('stops failed relay retries and recovery loops until explicit rejoin', () => {
  const relay = {
    shouldReconnect: (event: CloseEvent) => event.code < 4400 || event.code >= 4500,
    wsUnsuccessfulReconnects: 0,
    wsconnected: false,
    wsconnecting: false,
    connect: vi.fn(),
  } as unknown as WebsocketProvider;
  const recover = limitRelayRetries(relay);
  for (let count = 1; count <= 5; count++) {
    relay.wsUnsuccessfulReconnects = count;
    expect(relay.shouldReconnect(new CloseEvent('close', { code: 1006 }), relay)).toBe(count < 5);
  }
  for (let tick = 0; tick < 100; tick++) recover();
  expect(relay.connect).not.toHaveBeenCalled();
  recover(true);
  expect(relay.connect).toHaveBeenCalledOnce();
  expect(relay.wsUnsuccessfulReconnects).toBe(0);
  relay.wsUnsuccessfulReconnects = 1;
  expect(relay.shouldReconnect(new CloseEvent('close', { code: 4429 }), relay)).toBe(false);
  recover();
  expect(relay.connect).toHaveBeenCalledOnce();
});
