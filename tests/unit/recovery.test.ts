import { expect, it } from 'vitest';
import { needsReconnect } from '../../src/collab/recovery';

it('recovers failed signalling and blocked peers without disrupting healthy or offline rooms', () => {
  expect(needsReconnect({ direct: 0, blocked: 0, signalling: false }, true)).toBe(true);
  expect(needsReconnect({ direct: 0, blocked: 1, signalling: true }, true)).toBe(true);
  expect(needsReconnect({ direct: 1, blocked: 1, signalling: false }, true)).toBe(false);
  expect(needsReconnect({ direct: 0, blocked: 1, signalling: false }, false)).toBe(false);
  expect(needsReconnect({ direct: 0, blocked: 0, signalling: true }, true)).toBe(false);
});
