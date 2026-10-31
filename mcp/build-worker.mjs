#!/usr/bin/env node
/**
 * Builds the Cloudflare Worker bundle.
 *
 * The Worker cannot use `node:fs` or `ws`, so this build does not reuse the
 * single-file local bundle. It bundles `worker.ts` for the workerd runtime,
 * marking the Node-only modules external so esbuild does not try to pull `fs`
 * or `net` in through them.
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, 'dist', 'worker.mjs');

const result = await build({
  entryPoints: [join(here, 'worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile,
  // `cloudflare:workers` is provided by the runtime, not by node_modules.
  external: ['cloudflare:workers'],
  conditions: ['worker', 'browser', 'import', 'default'],
  mainFields: ['module', 'main'],
  // A Worker has no `process`, and `env.ts` already guards for that, so the
  // guard only needs to survive bundling rather than be rewritten.
  define: { __ERD_WORKER__: 'true' },
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`Built ${outfile} (${(bytes / 1024).toFixed(0)} KB)`);
