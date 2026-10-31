// Same check as verify-sdk.mjs, but against the downloaded single file over
// stdio, which is how a desktop MCP client would run it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'erd-sdk-'));

const client = new Client({ name: 'verify-stdio', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['mcp/dist/erd-maker-mcp.mjs'],
  env: { ...process.env, ERD_MCP_ROOT: dir },
}));

console.log('connected:', client.getServerVersion());
const { tools } = await client.listTools();
console.log('tools:', tools.length);

const created = await client.callTool({
  name: 'create_diagram',
  arguments: { name: 'Stdio Check', text: 'Author\n  id: INT key\nBook\n  id: INT key\nAuthor 1:N Book as writes' },
});
const payload = JSON.parse(created.content[0].text);
console.log('create isError:', created.isError === true);
console.log('entities:', payload.summary.entities.map((e) => e.name).join(', '));

await client.close();
await rm(dir, { recursive: true, force: true });
console.log('PASS: official MCP SDK client works against the local single file.');
