/**
 * One entry point for both transports.
 *
 *     node erd-maker-mcp.mjs                 # stdio (what an MCP client launches)
 *     node erd-maker-mcp.mjs --http          # Streamable HTTP on :8787
 *     node erd-maker-mcp.mjs --http --port 9000
 *
 * `mcp/build.mjs` bundles this into `mcp/dist/erd-maker-mcp.mjs`, which needs
 * nothing but `node` — no clone, no `npm install`, no `tsx`.
 */

const wantsHttp = process.argv.includes('--http') || process.env.ERD_MCP_TRANSPORT === 'http';

// The transport modules read this at import time, so it has to be set first.
process.env.ERD_MCP_TRANSPORT = wantsHttp ? 'http' : 'stdio';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'ERD Maker MCP',
    '',
    'Usage:',
    '  node erd-maker-mcp.mjs                stdio transport (default)',
    '  node erd-maker-mcp.mjs --http         Streamable HTTP on 127.0.0.1:8787',
    '  node erd-maker-mcp.mjs --http --port 9000 --host 0.0.0.0',
    '',
    'Environment:',
    '  ERD_MCP_ROOT   Folder diagrams are read from and written to (default: cwd).',
    '  ERD_MCP_DIR    Subfolder for new diagrams (default: diagrams).',
    '  PORT / HOST    Same as --port / --host for the HTTP transport.',
  ].join('\n'));
  process.exit(0);
}

// `--port` and `--host` are convenience forms of the env vars the HTTP
// transport reads, so a one-off launch does not need shell syntax.
const arg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};
if (arg('--port')) process.env.PORT = arg('--port');
if (arg('--host')) process.env.HOST = arg('--host');

// Two literal specifiers, not one computed one: esbuild can only bundle a
// dynamic import it can see through, and the bundler is the point of this file.
if (wantsHttp) await import('./http');
else await import('./server');
