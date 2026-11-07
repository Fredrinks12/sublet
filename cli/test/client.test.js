import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTransfer, toContractLog } from '../src/evm.js';
import { Near, refusalCode } from '../src/near.js';

const TOKEN = '0x036CBD53842C5426634E7929541EC2318F3DCF7E';
const PAY_TO = '0x8d642988e3e7b6db15b6058461d5563835b04bf6';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;

const log = (overrides = {}) => ({
  address: TOKEN,
  topics: [TRANSFER, topic('0x1111111111111111111111111111111111111111'), topic(PAY_TO)],
  data: `0x${'0'.repeat(63)}a`,
  logIndex: 3,
  transactionIndex: 1,
  transactionHash: `0x${'AB'.repeat(32)}`,
  blockHash: `0x${'CD'.repeat(32)}`,
  blockNumber: 12n,
  removed: false,
  ...overrides,
});

test('finds the transfer to the owner among other logs', () => {
  const other = log({ topics: [TRANSFER, topic(PAY_TO), topic('0x2222222222222222222222222222222222222222')], logIndex: 2 });
  const found = findTransfer({ logs: [other, log()] }, TOKEN, PAY_TO);
  assert.equal(found.logIndex, 3);
});

test('ignores the right recipient in the wrong token', () => {
  const wrongToken = log({ address: '0x9999999999999999999999999999999999999999' });
  assert.equal(findTransfer({ logs: [wrongToken] }, TOKEN, PAY_TO), undefined);
});

test('converts a log to the exact lowercase shape the contract hashes', () => {
  const converted = toContractLog(log());
  assert.equal(converted.address, TOKEN.toLowerCase());
  assert.equal(converted.transaction_hash, `0x${'ab'.repeat(32)}`);
  assert.equal(converted.block_number, 12);
  assert.equal(typeof converted.log_index, 'number');
});

test('picks the refusal code out of a contract failure', () => {
  assert.equal(refusalCode('Smart contract panicked: E_UNDERPAID'), 'E_UNDERPAID');
  assert.equal(refusalCode('something else'), null);
  assert.equal(refusalCode(undefined), null);
});

// ---- Reading old transactions ------------------------------------------------------------------

// These replies copy what real archival nodes sent when tested, including that a missing
// transaction comes back as HTTP 200 and that a throttled reply has a JSON body.
const finished = {
  status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E_UNDERPAID' } } } } },
  transaction: { signer_id: 'someone.testnet', receiver_id: 'sublet.testnet' },
  transaction_outcome: { outcome: { logs: [], status: {} } },
  receipts_outcome: [],
};
const found = { status: 200, body: { result: finished } };
const throttled = { status: 429, body: { error: { code: -429, message: 'Rate limits exceeded.' } } };
const missing = { status: 200, body: { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } } };

function withFetch(replies, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, params: JSON.parse(init.body).params });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
  };
  return run(calls).finally(() => {
    globalThis.fetch = original;
  });
}

const lookUp = (options) => new Near().archivedOutcome('hash', 'someone.testnet', { backoffMs: 1, ...options });

test('old transactions are read from an archival node, not an ordinary one', async () => {
  await withFetch([found], async (calls) => {
    const outcome = await lookUp();
    assert.equal(refusalCode(outcome.error), 'E_UNDERPAID');
    assert.match(calls[0].url, /archival/);
  });
});

test('the lookup uses the one wait level that answers at once for a missing hash', async () => {
  await withFetch([found], async (calls) => {
    await lookUp();
    assert.equal(calls[0].params.wait_until, 'NONE');
  });
});

test('the outcome says who really signed and received, which the node does not check', async () => {
  await withFetch([found], async () => {
    const outcome = await lookUp();
    assert.equal(outcome.signerId, 'someone.testnet');
    assert.equal(outcome.receiverId, 'sublet.testnet');
  });
});

test('a throttled node is retried until it answers', async () => {
  await withFetch([throttled, throttled, throttled, found], async (calls) => {
    const outcome = await lookUp();
    assert.equal(outcome.success, false);
    assert.equal(calls.length, 4);
  });
});

test('a node that will not answer means unknown, not failed', async () => {
  await withFetch([throttled], async () => {
    assert.equal(await lookUp({ attempts: 2 }), null);
  });
});

test('a page that is not JSON means unknown, not a crash', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('not JSON'); } });
  try {
    assert.equal(await lookUp({ attempts: 2 }), null);
  } finally {
    globalThis.fetch = original;
  }
});

test('a transaction that does not exist is an error, not unknown', async () => {
  await withFetch([missing], async () => {
    await assert.rejects(lookUp(), /No such transaction/);
  });
});

test('one node losing a transaction does not outvote a node that has it', async () => {
  await withFetch([missing, found], async () => {
    assert.equal((await lookUp()).receiverId, 'sublet.testnet');
  });
});

test('a transaction that has not finished is not read as a result', async () => {
  await withFetch([{ status: 200, body: { result: { final_execution_status: 'NONE' } } }], async () => {
    assert.equal(await lookUp({ attempts: 2 }), null);
  });
});
