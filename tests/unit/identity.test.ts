import { describe, expect, it } from 'vitest';
import {
  colorFromSeed,
  contrastRatio,
  identityFor,
  nameFromSeed,
  PRESENCE_COLORS,
  presenceInk,
} from '../../src/collab/identity';

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
