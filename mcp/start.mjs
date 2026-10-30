#!/usr/bin/env node
/**
 * Launches the MCP server without a build step.
 *
 * MCP clients start the server with a command and arguments, so this file is the
 * entry point they point at. It resolves tsx from this checkout rather than
 * relying on PATH, so the same configuration works from any working directory.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (!existsSync(tsx)) {
  console.error(`erd-maker MCP: tsx is not installed. Run npm install in ${root}.`);
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, resolve(root, 'mcp', 'server.ts')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error(`erd-maker MCP: could not start tsx: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
