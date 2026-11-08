import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createTools } from '../src/agent-tools.js';

// Keys made during these tests go to a scratch folder, not the real ~/.sublet.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sublet-agent-test-'));
process.env.SUBLET_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const NEAR = 10n ** 24n;
const unit = {
  id: 'box-1',
  terms: { title: 'Box', blurb: '', tick_secs: 60, max_ticks: 10, near_per_tick: String((4n * NEAR) / 10n), foreign: [], command: null, needs_approval: true },
  paused: false,
  leases: '0',
  renewals: '0',
  occupied_until: '0',
};

/** A contract whose owner never answers, so every request waits for approval. */
function silentOwner() {
  const paid = [];
  let next = 1;
  const pending = (id) => ({ id: String(id), unit: unit.id, status: 'AwaitingApproval', valid_before: '0', certificate: null });
  const near = {
    config: { explorer: 'https://testnet.nearblocks.io/txns/' },
    async view(_contract, method, args) {
      if (method === 'get_unit') return unit;
      if (method === 'about') return { lease_fee: String(NEAR / 50n) };
      if (method === 'get_lease') return pending(args.id);
      throw new Error(`unexpected view ${method}`);
    },
    async call(_contract, method, _args, options) {
      paid.push({ method, deposit: options.depositYocto });
      const lease = pending(next++);
      return { success: true, hash: `hash-${lease.id}`, value: lease };
    },
  };
  return { near, paid };
}

test('rent held for an unanswered request counts against the spending limit', async () => {
  const { near, paid } = silentOwner();
  const tools = createTools({ near, contract: 'sublet.testnet', maxNear: 0.5 });
  const first = await tools.rentMachine({ unit: 'box-1', minutes: 1 });
  assert.equal(first.status, 'AwaitingApproval');
  await assert.rejects(tools.rentMachine({ unit: 'box-1', minutes: 1 }), /Over budget/);
  assert.equal(paid.length, 1, 'the second request was refused before anything was paid');
  assert.equal(first.spent_near, 0.4);
});

test('an unanswered request says how to get the money back', async () => {
  const { near } = silentOwner();
  const request = await createTools({ near, contract: 'sublet.testnet', maxNear: 1 }).rentMachine({ unit: 'box-1', minutes: 1 });
  assert.match(request.note, /sublet cancel 1/);
});

test('an unanswered request is not reported as expired', async () => {
  const { near } = silentOwner();
  const status = await createTools({ near, contract: 'sublet.testnet' }).leaseStatus({ lease: 1 });
  assert.equal(status.status, 'AwaitingApproval');
  assert.equal(status.expired, false);
});
