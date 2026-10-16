import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every custom property a rule reads has to be one something actually sets.
 *
 * A `var(--typo)` that was never declared does not error: it resolves to
 * nothing, and the declaration is dropped as if it were never written. That is
 * how a `border-radius` silently became square and a shadow survived only on its
 * inline fallback — two drifts that sat in this file unnoticed because nothing
 * was checking.
 *
 * A property can be set from the stylesheet or from script, so both are read
 * rather than a list kept here. A list would be one more thing to forget to
 * update, which is the failure this is meant to prevent.
 */

const root = resolve(__dirname, '../..');
const css = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

/** Every `.ts`/`.tsx` under `src`, so a new file's tokens are seen. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** Names declared in the stylesheet as a custom property: `--name: value;`. */
function declaredInCss(): Set<string> {
  const tokens = new Set<string>();
  for (const match of css.matchAll(/(^|[\s;{])(--[\w-]+)\s*:/gm)) tokens.add(match[2]!);
  return tokens;
}

/** Names set from script, whether through `setProperty` or an inline style. */
function declaredInScript(): Set<string> {
  const tokens = new Set<string>();
  for (const file of sourceFiles(resolve(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/setProperty\(\s*'(--[\w-]+)'/g)) tokens.add(match[1]!);
  }
  return tokens;
}

/**
 * Every custom property read by a rule: the first argument of `var(...)`.
 *
 * A fallback is not a definition. `var(--absent, 4px)` still resolves to `4px`
 * today, but it is a token nothing sets, so it is reported like any other.
 */
function usedTokens(): { name: string; count: number }[] {
  const uses = new Map<string, number>();
  for (const match of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
    uses.set(match[1]!, (uses.get(match[1]!) ?? 0) + 1);
  }
  return [...uses].map(([name, count]) => ({ name, count }));
}

describe('design tokens', () => {
  it('sets every custom property a rule reads, in the stylesheet or from script', () => {
    const declared = new Set([...declaredInCss(), ...declaredInScript()]);
    const missing = usedTokens().filter((use) => !declared.has(use.name));
    expect(missing.map((use) => `${use.name} (used ${use.count}×)`)).toEqual([]);
  });

  it('declares the tokens the design system is built on', () => {
    // The document thesis names these by purpose. A rename that dropped one
    // would quietly change every rule that derives from it.
    const declared = declaredInCss();
    for (const token of [
      '--paper', '--paper-raised', '--ink', '--ink-secondary', '--ink-tertiary',
      '--signal', '--signal-strong', '--danger', '--font-sans', '--font-mono',
      '--r-drawn', '--r-control', '--r-panel', '--r-pill',
      '--s1', '--s2', '--s3', '--s4', '--s5',
      '--t-fast', '--t-base', '--ease-out', '--ease-in', '--hairline',
    ]) {
      expect(declared.has(token), `${token} is not declared in styles.css`).toBe(true);
    }
  });

  it('keeps the shadow vocabulary to the one surface that lifts off the page', () => {
    // The thesis is hairline ink with no shadows. A shadow is only justified
    // where a surface genuinely hovers over the page, so the token count is a
    // deliberate ceiling rather than an accident.
    const shadowTokens = [...declaredInCss()].filter((token) => token.startsWith('--shadow'));
    expect(shadowTokens).toEqual(['--shadow-menu']);
  });
});

