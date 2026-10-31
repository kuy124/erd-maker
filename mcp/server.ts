/**
 * The stdio server: the local entry point.
 *
 * All it does is choose the Node implementations of the two things the tools
 * need — a directory to store diagrams in, and a way to open a relay socket —
 * then hand them to the shared registration in tools.ts.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './tools';
import { FileWorkspace } from './fileWorkspace';
import { env } from './env';
import { nodeSocketFactory } from './nodeSocket';
import { useSocketFactory } from './live';
import { errorMessage, useWorkspace, workspaceLabel } from './diagram';

useWorkspace(new FileWorkspace({
  root: env('ERD_MCP_ROOT') ?? process.cwd(),
  diagramsDir: env('ERD_MCP_DIR') ?? 'diagrams',
}));
useSocketFactory(nodeSocketFactory);

const transport = new StdioServerTransport();

createServer().connect(transport).then(
  () => console.error(`ERD Maker MCP ready. Workspace: ${workspaceLabel()}`),
  (error: unknown) => {
    console.error('ERD Maker MCP failed to start:', errorMessage(error));
    process.exit(1);
  },
);
