// An AI agent with a job and no computer of its own. It finds the cheapest vacant machine, rents it,
// does the work there, and reports back. The owner of the machine never hears from it.
//
//   SUBLET_ACCOUNT=you.testnet NEAR_AI_API_KEY=... node examples/agent-rents-a-box.mjs "the job"
//
// With NEAR_AI_API_KEY the agent is a model running in a TEE on NEAR AI Cloud, choosing its own tool
// calls. Without one it follows a fixed script through the same tools, so the rest can be tried free.
import { Near } from '../cli/src/near.js';
import { createTools } from '../cli/src/agent-tools.js';

const JOB = process.argv[2] ?? 'Count the prime numbers below 2,000,000 and report how long it took.';
const near = new Near({ accountId: process.env.SUBLET_ACCOUNT });
const tools = createTools({
  near,
  contract: process.env.SUBLET_CONTRACT ?? 'sublet.testnet',
  maxNear: Number(process.env.SUBLET_MAX_NEAR ?? 0.5),
});

const SCHEMAS = [
  { name: 'list_machines', description: 'List machines for rent, cheapest first.', parameters: { type: 'object', properties: {} } },
  {
    name: 'rent_machine',
    description: 'Rent a machine for some minutes. Returns a lease number.',
    parameters: { type: 'object', properties: { unit: { type: 'string' }, minutes: { type: 'number' } }, required: ['unit', 'minutes'] },
  },
  {
    name: 'run_command',
    description: 'Run one shell command on a rented machine.',
    parameters: { type: 'object', properties: { lease: { type: 'string' }, command: { type: 'string' } }, required: ['lease', 'command'] },
  },
  {
    name: 'lease_status',
    description: 'Check how long a lease has left.',
    parameters: { type: 'object', properties: { lease: { type: 'string' } }, required: ['lease'] },
  },
];

const HANDLERS = {
  list_machines: () => tools.listMachines(),
  rent_machine: (args) => tools.rentMachine(args),
  run_command: (args) => tools.runCommand(args),
  lease_status: (args) => tools.leaseStatus(args),
};

async function use(name, args) {
  console.log(`\n> ${name} ${JSON.stringify(args)}`);
  try {
    const result = await HANDLERS[name](args);
    console.log(JSON.stringify(result, null, 2).slice(0, 900));
    return result;
  } catch (error) {
    console.log(`refused: ${error.message}`);
    return { error: error.message };
  }
}

/** A real agent: a model on NEAR AI Cloud decides each step. */
async function modelLoop() {
  const url = `${process.env.NEAR_AI_URL ?? 'https://cloud-api.near.ai/v1'}/chat/completions`;
  const model = process.env.NEAR_AI_MODEL ?? 'deepseek-ai/DeepSeek-V3.1';
  const messages = [
    {
      role: 'system',
      content:
        'You are an autonomous agent with no computer of your own. Rent the cheapest vacant Linux machine that fits the job, for as few minutes as you need, then do the work with run_command. Each run_command is a new connection. When finished, state the result and what you spent.',
    },
    { role: 'user', content: JOB },
  ];
  for (let turn = 0; turn < 12; turn += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEAR_AI_API_KEY}` },
      body: JSON.stringify({ model, messages, tools: SCHEMAS.map((f) => ({ type: 'function', function: f })) }),
    });
    if (!response.ok) throw new Error(`NEAR AI Cloud answered ${response.status}: ${await response.text()}`);
    const message = (await response.json()).choices[0].message;
    messages.push(message);
    if (!message.tool_calls?.length) {
      console.log(`\nAgent: ${message.content}`);
      return;
    }
    for (const call of message.tool_calls) {
      const result = await use(call.function.name, JSON.parse(call.function.arguments || '{}'));
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  console.log('\nStopped after 12 turns.');
}

/** The same tools in a fixed order, for trying this without a model. */
async function scripted() {
  console.log('No NEAR_AI_API_KEY set, so this run follows a fixed script through the same tools.');
  const machines = await use('list_machines', {});
  const choice = Array.isArray(machines) ? machines.find((m) => m.vacant && !m.fixed_command) : null;
  if (!choice) {
    console.log('\nNo vacant machine to rent right now.');
    return;
  }
  const lease = await use('rent_machine', { unit: choice.id, minutes: 1 });
  if (lease.error) return;
  const program = 'awk "BEGIN{n=2000000;for(i=2;i*i<=n;i++)if(!s[i])for(j=i*i;j<=n;j+=i)s[j]=1;for(i=2;i<=n;i++)if(!s[i])c++;print c}"';
  const run = await use('run_command', { lease: lease.lease, command: `date +%s; ${program}; date +%s; nproc` });
  await use('lease_status', { lease: lease.lease });
  console.log(`\nResult: ${run.stdout?.replaceAll('\n', ' ')}. Spent ${lease.spent_near} NEAR.`);
}

console.log(`Job: ${JOB}`);
await (process.env.NEAR_AI_API_KEY ? modelLoop() : scripted());
