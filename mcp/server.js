#!/usr/bin/env node
// An MCP server that lets any compatible AI client rent and use a Linux machine.
//
// Add it to a client's MCP config with SUBLET_ACCOUNT set to a NEAR account whose key is in
// ~/.near-credentials. SUBLET_MAX_NEAR caps what one session may spend. The cap is a convenience
// inside this process, not a security boundary: real limits belong on the account or the unit.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Near } from '../cli/src/near.js';
import { createTools } from '../cli/src/agent-tools.js';

const near = new Near({
  network: process.env.SUBLET_NETWORK ?? 'testnet',
  accountId: process.env.SUBLET_ACCOUNT,
});
const tools = createTools({
  near,
  contract: process.env.SUBLET_CONTRACT ?? 'sublet.testnet',
  maxNear: Number(process.env.SUBLET_MAX_NEAR ?? 1),
});

const reply = async (work) => {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
};

const server = new McpServer({ name: 'sublet', version: '0.1.0' });

server.tool(
  'list_machines',
  'List Linux machines for rent, cheapest first, with prices and whether each is vacant now.',
  {},
  () => reply(() => tools.listMachines()),
);

server.tool(
  'rent_machine',
  'Rent a machine for a number of minutes, paying from your NEAR account. Returns a lease number. A key is generated locally and expires when the lease ends.',
  { unit: z.string().describe('Machine id from list_machines'), minutes: z.number().positive().describe('How long to rent it') },
  (args) => reply(() => tools.rentMachine(args)),
);

server.tool(
  'run_command',
  'Run one shell command on a rented machine and return its output. Each call is a new SSH connection. Anything running when the lease ends is killed.',
  { lease: z.string().describe('Lease number from rent_machine'), command: z.string() },
  (args) => reply(() => tools.runCommand(args)),
);

server.tool(
  'lease_status',
  'Check whether a lease is still live and how many seconds remain.',
  { lease: z.string().describe('Lease number from rent_machine') },
  (args) => reply(() => tools.leaseStatus(args)),
);

await server.connect(new StdioServerTransport());
