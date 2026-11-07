// Talks to the MCP server the way a real client does, over stdio.
//   SUBLET_ACCOUNT=... SUBLET_CONTRACT=... node mcp/test.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, 'server.js')],
  env: { ...process.env },
});
const client = new Client({ name: 'sublet-test', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

const list = await client.callTool({ name: 'list_machines', arguments: {} });
console.log('list_machines:', list.content[0].text.slice(0, 400));

const refused = await client.callTool({ name: 'rent_machine', arguments: { unit: 'no-such-machine', minutes: 1 } });
console.log('a bad rent is an error, not a crash:', refused.isError === true, refused.content[0].text);

await client.close();
