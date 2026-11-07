import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTransfer, toContractLog } from '../src/evm.js';
import { refusalCode } from '../src/near.js';

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
