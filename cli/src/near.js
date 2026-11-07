// A thin NEAR client. Contract calls that wait on the MPC network can run for minutes, longer than an
// RPC connection reliably stays open, so every call is submitted first and then polled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Account, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';

export const NETWORKS = {
  testnet: {
    rpc: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'],
    mpc: 'v1.signer-prod.testnet',
    explorer: 'https://testnet.nearblocks.io/txns/',
    faucet: 'https://helper.nearprotocol.com/account',
  },
  mainnet: {
    rpc: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.near.org'],
    mpc: 'v1.signer',
    explorer: 'https://nearblocks.io/txns/',
  },
};

const TGAS = 1_000_000_000_000n;

export function loadCredentials(accountId, network = 'testnet') {
  const file = path.join(os.homedir(), '.near-credentials', network, `${accountId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No key for ${accountId}. Expected ${file}.`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).private_key;
}

export class Near {
  constructor({ network = 'testnet', accountId, privateKey } = {}) {
    this.network = network;
    this.config = NETWORKS[network];
    if (!this.config) throw new Error(`Unknown network ${network}`);
    this.provider = new JsonRpcProvider({ url: this.config.rpc[0] });
    this.accountId = accountId;
    if (accountId) {
      const key = privateKey ?? loadCredentials(accountId, network);
      this.account = new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(key));
    }
  }

  async rpc(method, params) {
    let lastError;
    for (const url of this.config.rpc) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'sublet', method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const body = await response.json();
        if (body.error) throw Object.assign(new Error(JSON.stringify(body.error)), { rpc: body.error });
        return body.result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async view(contractId, method, args = {}) {
    return this.provider.callFunction({ contractId, method, args });
  }

  /** Submits a transaction and returns its hash without waiting for receipts. */
  async submit(receiverId, callActions) {
    const signed = await this.account.createSignedTransaction({ receiverId, actions: callActions });
    const sent = await this.provider.sendTransactionUntil(signed, 'INCLUDED');
    return sent.transaction?.hash ?? sent.transaction_outcome?.id;
  }

  /** Polls until the transaction and all its receipts have finished. */
  async outcome(hash, senderId = this.accountId, timeoutMs = 300_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const result = await this.rpc('tx', {
          tx_hash: hash,
          sender_account_id: senderId,
          wait_until: 'EXECUTED_OPTIMISTIC',
        });
        const status = result.status ?? {};
        if ('SuccessValue' in status || 'Failure' in status) return summarize(hash, result);
      } catch {
        // Still executing, or a dropped RPC connection. Either way, keep polling.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${hash}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async call(contractId, method, args, { gasTera = 300, depositYocto = 0n } = {}) {
    const action = actions.functionCall(method, args, BigInt(gasTera) * TGAS, BigInt(depositYocto));
    const hash = await this.submit(contractId, [action]);
    return this.outcome(hash);
  }

  async deploy(wasm, initMethod, initArgs) {
    const hash = await this.submit(this.accountId, [
      actions.deployContract(wasm),
      actions.functionCall(initMethod, initArgs, 30n * TGAS, 0n),
    ]);
    return this.outcome(hash);
  }

  async accessKeys(accountId) {
    const result = await this.rpc('query', {
      request_type: 'view_access_key_list',
      finality: 'final',
      account_id: accountId,
    });
    return result.keys;
  }

  async accountState(accountId) {
    return this.rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  }
}

/** Collects what callers care about from a raw `tx` result. */
function summarize(hash, result) {
  const logs = [];
  const failures = [];
  const scan = (outcome) => {
    logs.push(...outcome.logs);
    if (outcome.status?.Failure) failures.push(failureText(outcome.status.Failure));
  };
  scan(result.transaction_outcome.outcome);
  for (const receipt of result.receipts_outcome) scan(receipt.outcome);
  const success = 'SuccessValue' in result.status;
  let value;
  if (success && result.status.SuccessValue) {
    const text = Buffer.from(result.status.SuccessValue, 'base64').toString('utf8');
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return {
    hash,
    success,
    value,
    logs,
    events: logs
      .filter((line) => line.startsWith('EVENT_JSON:'))
      .map((line) => JSON.parse(line.slice('EVENT_JSON:'.length))),
    error: success ? undefined : failures[0] ?? failureText(result.status.Failure),
    gasBurntTera: result.receipts_outcome.reduce((sum, r) => sum + Number(r.outcome.gas_burnt), 0) / 1e12,
  };
}

function failureText(failure) {
  const action = failure?.ActionError?.kind?.FunctionCallError;
  const message = action?.ExecutionError ?? action?.CompilationError ?? failure;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/** The stable refusal code in a contract failure, such as `E_UNDERPAID`. */
export function refusalCode(text) {
  return String(text ?? '').match(/E_[A-Z0-9_]+/)?.[0] ?? null;
}

/** Creates a free testnet account through the faucet service and returns its id and key. */
export async function createTestnetAccount(accountId, publicKey) {
  const response = await fetch(NETWORKS.testnet.faucet, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Faucet refused ${accountId}: ${response.status} ${await response.text()}`);
  return accountId;
}
