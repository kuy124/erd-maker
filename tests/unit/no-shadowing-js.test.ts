/**
 * No compiled JavaScript may sit next to TypeScript.
 *
 * This is not housekeeping. Vite resolves `.js` ahead of `.ts` by default, so a
 * stray compiled file wins over the source it was generated from and every
 * build bundles stale JavaScript. That failure is silent and expensive: the
 * output is byte-identical after each edit, no error is raised, and tests run
 * against code that no longer exists on disk. It cost a whole debugging session
 * here before the cause was found.
 *
 * The usual source is `tsc -b --noEmit false`. `npm run typecheck` no longer
 * does that, and this test makes sure nothing else starts.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
/** Only source trees matter; `node_modules` and build output are excluded. */
const ROOTS = ['src', 'tests', 'scripts'];

const COMPILED = ['.js', '.jsx', '.mjs', '.cjs'];
const SOURCE = ['.ts', '.tsx', '.mts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('no shadowing compiled JavaScript', () => {
  const files = ROOTS.filter((dir) => existsSync(join(ROOT, dir))).flatMap((dir) => walk(join(ROOT, dir)));

  it('finds the source tree at all', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('has no .js file beside a same-named .ts file', () => {
    const shadowed = files
      .filter((file) => COMPILED.some((ext) => file.endsWith(ext)))
      .filter((file) => SOURCE.some((ext) => existsSync(file.replace(/\.[^.]+$/, ext))))
      .map((file) => relative(ROOT, file));

    expect(
      shadowed,
      'these compiled files shadow the TypeScript next to them, so vite bundles the stale copy.\n' +
        'Delete them, and do not run `tsc -b --noEmit false`.',
    ).toEqual([]);
  });
});
