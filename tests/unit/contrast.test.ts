/**
 * Contrast regression test.
 *
 * The palette lives in `styles.css`, so a change there is invisible to the type
 * checker and to every other test. A too-light grey reads fine to whoever picks
 * it on a bright screen and is unreadable to someone else, which is exactly the
 * kind of defect that never gets caught by looking at it.
 *
 * The token values are duplicated here on purpose. Reading them out of the CSS
 * would mean parsing it, and a test that parses its own source is easy to break
 * in a way that makes it pass. If a token changes, this file must change too —
 * that is the point, not a maintenance burden.
 */

import { describe, expect, it } from 'vitest';

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** WCAG contrast ratio between two hex colours. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

interface Theme {
  paper: string;
  paperRaised: string;
  ink: string;
  inkSecondary: string;
  inkTertiary: string;
  inkInverse: string;
  signal: string;
  signalQuiet: string;
  signalStrong: string;
  danger: string;
  dangerQuiet: string;
  warn: string;
  ruleStrong: string;
}

const LIGHT: Theme = {
  paper: '#f2f4f3',
  paperRaised: '#fbfcfb',
  ink: '#16181a',
  inkSecondary: '#5b6167',
  inkTertiary: '#666e73',
  inkInverse: '#fbfcfb',
  signal: '#0f7b8a',
  signalQuiet: '#d9ebee',
  signalStrong: '#0a5c68',
  danger: '#a32d1f',
  dangerQuiet: '#f7e4e1',
  warn: '#8a5a00',
  ruleStrong: '#7f8a87',
};

const DARK: Theme = {
  paper: '#14171a',
  paperRaised: '#1b1f22',
  ink: '#e8eceb',
  inkSecondary: '#a4adb2',
  inkTertiary: '#98a1a6',
  inkInverse: '#14171a',
  signal: '#3fa8b8',
  signalQuiet: '#17383d',
  signalStrong: '#6cc4d2',
  danger: '#e0776a',
  dangerQuiet: '#3a2320',
  warn: '#d9a441',
  ruleStrong: '#68737a',
};

/** Every text pair that actually appears in the interface. */
const TEXT_PAIRS: [keyof Theme, keyof Theme, string][] = [
  ['ink', 'paper', 'body text on paper'],
  ['ink', 'paperRaised', 'body text on a raised panel'],
  ['inkSecondary', 'paper', 'secondary text on paper'],
  ['inkSecondary', 'paperRaised', 'secondary text on a raised panel'],
  ['inkTertiary', 'paper', 'helper text on paper'],
  ['inkTertiary', 'paperRaised', 'helper text on a raised panel'],
  ['signal', 'paper', 'active text on paper'],
  ['signalStrong', 'paper', 'strong signal on paper'],
  ['signalStrong', 'signalQuiet', 'strong signal on a quiet signal fill'],
  ['danger', 'paper', 'danger text on paper'],
  ['danger', 'dangerQuiet', 'danger text on a quiet danger fill'],
  ['warn', 'paper', 'warning text on paper'],
  ['inkInverse', 'signal', 'inverse text on signal'],
  ['inkInverse', 'signalStrong', 'inverse text on strong signal'],
  ['inkInverse', 'danger', 'inverse text on danger'],
];

describe.each([
  ['light', LIGHT],
  ['dark', DARK],
])('%s theme contrast', (themeName, theme) => {
  it.each(TEXT_PAIRS)('meets 4.5:1 for %s on %s', (fg, bg, label) => {
    const ratio = contrast(theme[fg], theme[bg]);
    expect(ratio, `${label} in ${themeName} mode is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('meets 3:1 for control borders, so an input is identifiable', () => {
    // A border is a UI component, not text, so it is held to 3:1. Without this
    // a form field is only locatable by its placeholder, which disappears the
    // moment someone types.
    expect(contrast(theme.ruleStrong, theme.paper)).toBeGreaterThanOrEqual(3);
    expect(contrast(theme.ruleStrong, theme.paperRaised)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the signal colour distinguishable from plain ink', () => {
    // Selection and presence are carried by colour, so signal must not collapse
    // into the body text colour.
    const signalVsInk = contrast(theme.signal, theme.ink);
    expect(signalVsInk).toBeGreaterThan(1.2);
  });
});
