import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  colorFromSeed,
  contrastRatio,
  createLocalIdentity,
  identityFor,
  nameFromSeed,
  PRESENCE_COLORS,
  presenceInk,
  rememberIdentity,
} from '../../src/collab/identity';

/**
 * A real in-memory storage.
 *
 * `localStorage` is a gated global under Node 25 and jsdom's is not reachable
 * from here, so identity's remember-and-reuse path had no coverage at all. A
 * working stub also means a failure below is a failure of the logic rather than
 * of the environment — the module's own try/catch cannot hide anything.
 */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  });
  return store;
}

describe('a remembered name', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubStorage();
  });

  it('is reused by a later session instead of a new animal name', () => {
    rememberIdentity({ name: 'Priya', color: '#0F7B8A' });
    expect(createLocalIdentity(12345).name).toBe('Priya');
  });

  it('falls back to a generated name when storage is empty', () => {
    expect(createLocalIdentity(7).name).toBe(nameFromSeed(7));
  });

  it('keeps the same author identity across renames, diagrams, and new Yjs clients', () => {
    const first = createLocalIdentity(7);
    expect(createLocalIdentity(99).name).toBe(first.name);
    rememberIdentity({ name: 'Renamed elsewhere', color: first.color });
    const next = createLocalIdentity(12345);
    expect(next.name).toBe('Renamed elsewhere');
    expect(next.userId).toBe(first.userId);
    expect(next.clientId).not.toBe(first.clientId);
  });

  it('ignores a stored name that is blank or the wrong shape', () => {
    store.set('erd:identity', JSON.stringify({ name: '   ' }));
    expect(createLocalIdentity(7).name).toBe(nameFromSeed(7));
    store.set('erd:identity', JSON.stringify({ name: 42 }));
    expect(createLocalIdentity(7).name).toBe(nameFromSeed(7));
    store.set('erd:identity', 'not json at all');
    expect(createLocalIdentity(7).name).toBe(nameFromSeed(7));
  });

  it('keeps the stored name within what the cursor chip can draw', () => {
    // The chip is sized from the name's length, so an unbounded name would run
    // off the end of it.
    store.set('erd:identity', JSON.stringify({ name: 'x'.repeat(200) }));
    expect(createLocalIdentity(7).name.length).toBeLessThanOrEqual(32);
  });

  it('survives storage that throws, which private modes do', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => rememberIdentity({ name: 'Priya', color: '#0F7B8A' })).not.toThrow();
    expect(createLocalIdentity(7).name).toBe(nameFromSeed(7));
  });
});

describe('presence identities', () => {
  it('gives every peer a name and a colour derived from its client id', () => {
    const identity = identityFor(7);
    expect(identity.name).toBe(nameFromSeed(7));
    expect(identity.color).toBe(colorFromSeed(7).color);
    expect(identity.colorIndex).toBe(colorFromSeed(7).colorIndex);
  });

  it('is deterministic, so a peer keeps the same name on reload', () => {
    expect(identityFor(42).name).toBe(identityFor(42).name);
    expect(identityFor(42).color).toBe(identityFor(42).color);
  });

  it('stays within the palette for any client id', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      expect(PRESENCE_COLORS).toContain(colorFromSeed(seed).color);
    }
  });
});

describe('presenceInk', () => {
  it('picks readable ink for every colour in the palette', () => {
    // The avatars draw two initials at 10px bold, which is text, so this is a
    // 4.5:1 requirement rather than the 3:1 that a plain UI component would
    // need. Presence colours are fixed and ignore the theme, so this choice has
    // to hold for both.
    for (const fill of PRESENCE_COLORS) {
      const ink = presenceInk(fill);
      expect(
        contrastRatio(ink, fill),
        `ink ${ink} on fill ${fill} is ${contrastRatio(ink, fill).toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('chooses whichever ink actually contrasts better', () => {
    for (const fill of PRESENCE_COLORS) {
      const light = contrastRatio('#fbfcfb', fill);
      const dark = contrastRatio('#14171a', fill);
      expect(presenceInk(fill)).toBe(light >= dark ? '#fbfcfb' : '#14171a');
    }
  });

  it('handles a colour outside the palette', () => {
    // Identity can be overridden from localStorage, so this has to be a
    // computed choice rather than a lookup.
    expect(contrastRatio(presenceInk('#000000'), '#000000')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(presenceInk('#ffffff'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('contrastRatio', () => {
  it('matches the known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });
});
