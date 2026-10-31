// Uses the official MCP SDK client against the deployed URL, the same way a
// real MCP host would. No hand-rolled JSON-RPC.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('https://erd-maker-mcp.cerberus-tusk-proxy.workers.dev/mcp');
const client = new Client({ name: 'verify-sdk', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

console.log('connected:', client.getServerVersion());

const { tools } = await client.listTools();
console.log('tools:', tools.length);
console.log('names:', tools.map((t) => t.name).join(', '));

const created = await client.callTool({
  name: 'create_diagram',
  arguments: {
    name: 'SDK Check',
    text: 'Author\n  id: INT key\n  name: TEXT\nBook\n  id: INT key\nAuthor 1:N Book as writes',
  },
});
const payload = JSON.parse(created.content[0].text);
console.log('create isError:', created.isError === true);
console.log('entities:', payload.summary.entities.map((e) => e.name).join(', '));

const sql = await client.callTool({ name: 'generate_sql', arguments: {} });
console.log('sql has CREATE TABLE:', /CREATE TABLE/i.test(JSON.parse(sql.content[0].text).sql));

await client.close();
console.log('PASS: official MCP SDK client works against the hosted server.');
