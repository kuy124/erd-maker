#!/usr/bin/env node
/**
 * Builds the single-file MCP server.
 *
 * The point is that a person — or an AI asked to "use the ERD Maker MCP" —
 * never has to clone this repository, run `npm install`, or resolve `tsx` from
 * a checkout. One file, `node`, done.
 *
 * Usage:
 *   node mcp/build.mjs            # writes mcp/dist/erd-maker-mcp.mjs
 *   node mcp/build.mjs --check    # build and confirm it starts, then clean up
 *
 * The bundle inlines zod, the MCP SDK, yjs and ws, so the output has no
 * `node_modules` beside it. Only `node` is required (v20+).
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'main.ts');
const outfile = join(here, 'dist', 'erd-maker-mcp.mjs');

/**
 * `ws` and parts of the MCP SDK reach for `require`, which does not exist in
 * an ES module. This shim restores it so the bundle runs as a plain `.mjs`.
 */
const requireShim = [
  'import { createRequire as __createRequire } from "node:module";',
  'const require = __createRequire(import.meta.url);',
].join('\n');

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: requireShim },
  define: { __ERD_BUNDLED__: 'true' },
  // Keep the shebang so the file is directly executable on Unix.
  legalComments: 'none',
  logLevel: 'warning',
});

const { size } = await stat(outfile);
console.log(`Built ${outfile} (${(size / 1024 / 1024).toFixed(2)} MB, node only)`);

if (!process.argv.includes('--check')) process.exit(0);

// Start it exactly as a client would and confirm the handshake completes.
const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'] });

const ready = await new Promise((resolveReady) => {
  const timer = setTimeout(() => resolveReady('timed out waiting for startup'), 20_000);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (chunk.includes('MCP ready')) {
      clearTimeout(timer);
      resolveReady(null);
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolveReady(`exited early with code ${code}`);
  });
});

child.kill();

if (ready) {
  console.error(`Startup check failed: ${ready}`);
  process.exit(1);
}
console.log('Startup check passed.');
