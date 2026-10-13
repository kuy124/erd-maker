import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../src/collab/identity';
import { THEMES } from '../../src/ui/theme';

/**
 * Every theme has to be readable.
 *
 * The palettes are other projects', which do not all hold 4.5:1 on their own
 * secondary ink. This parses the stylesheet rather than keeping a copy of the
 * values here, so a token edited by hand cannot drift past the check, and so a
 * theme added without tokens fails immediately.
 *
 * The theme list is read from the module, so a new theme cannot ship untested.
 */

const css = readFileSync(resolve(__dirname, '../../src/styles.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} has no block in styles.css`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  const body = css.slice(start, end);
  const tokens: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = /^\s*(--[\w-]+):\s*(#[0-9a-f]{3,8})\s*;/i.exec(line);
    if (match) tokens[match[1]!] = match[2]!;
  }
  return tokens;
}

const REQUIRED = ['--paper', '--paper-raised', '--ink', '--ink-secondary', '--ink-tertiary', '--signal'] as const;

/** Every theme except "System", which has no tokens of its own by design. */
const themed = THEMES.filter((theme) => theme.id !== 'system' && theme.id !== 'graph');

describe('themes', () => {
  it('offers more than the default, and names them recognisably', () => {
    // Invented names were rejected once already: a theme nobody has seen is one
    // more thing to evaluate every time the app opens.
    expect(themed.length).toBeGreaterThanOrEqual(4);
    for (const theme of themed) {
      expect(theme.name, theme.id).toMatch(/[a-z]/i);
      expect(theme.note.length, theme.id).toBeGreaterThan(10);
    }
  });

  for (const theme of themed) {
    it(`${theme.id} defines every token it needs`, () => {
      const tokens = block(`[data-theme='${theme.id}']`);
      for (const token of REQUIRED) {
        expect(tokens[token], `${theme.id} is missing ${token}`).toMatch(/^#/);
      }
    });

    it(`${theme.id} keeps body text readable on its paper`, () => {
      const tokens = block(`[data-theme='${theme.id}']`);
      for (const token of ['--ink', '--ink-secondary', '--ink-tertiary'] as const) {
        const ratio = contrastRatio(tokens[token]!, tokens['--paper']!);
        expect(ratio, `${theme.id}: ${token} on --paper is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
      // Raised surfaces are where cards and rows sit, so ink has to hold there
      // too, not only on the page.
      const onRaised = contrastRatio(tokens['--ink']!, tokens['--paper-raised']!);
      expect(onRaised, `${theme.id}: --ink on --paper-raised`).toBeGreaterThanOrEqual(4.5);
      // Selection has to be visible against both surfaces.
      expect(contrastRatio(tokens['--signal']!, tokens['--paper']!), `${theme.id}: signal`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(tokens['--signal']!, tokens['--paper-raised']!), `${theme.id}: signal on raised`).toBeGreaterThanOrEqual(3);
    });
  }

  it('names a theme for every id the stylesheet defines', () => {
    const declared = [...css.matchAll(/\[data-theme='([\w-]+)'\]/g)].map((match) => match[1]!);
    for (const id of declared) {
      expect(THEMES.some((theme) => theme.id === id), `data-theme='${id}' has no entry in THEMES`).toBe(true);
    }
  });

  it('keeps the picker controls usable on a phone', () => {
    // A two-column swatch grid at 320px leaves each option about 140px, which
    // cramps the palette name and shrinks the tap target; the type row is a
    // select plus one or two numbers and cannot sit on one line. Asserted
    // against the stylesheet rather than a screenshot, because the rule is the
    // thing that can regress.
    const phone = /@media\s*\(max-width:\s*767px\)\s*\{/.exec(css);
    expect(phone, 'no 767px media query in styles.css').toBeTruthy();
    const body = css.slice(phone!.index);
    const inside = body.slice(0, body.indexOf('\n}'));
    expect(inside, 'the picker is not narrowed on a phone').toContain('.theme-picker__options');
    expect(inside, 'the type row does not wrap on a phone').toContain('.type-fields');
  });
});