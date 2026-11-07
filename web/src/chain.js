// Reads the chain directly from the browser. The site has no backend: every public endpoint it needs
// allows cross-origin requests, including the testnet faucet.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, FailoverRpcProvider } from 'near-api-js';

export const CONTRACT = import.meta.env.VITE_CONTRACT ?? 'sublet.testnet';
export const RPC = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
export const EXPLORER = 'https://testnet.nearblocks.io/txns/';
const FAUCET = 'https://helper.nearprotocol.com/account';
const STORAGE_FEE = 10n ** 22n;
const TGAS = 10n ** 12n;

const encode = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function rpc(method, params) {
  let lastError;
  for (const url of RPC) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'sublet', method, params }),
      });
      const body = await response.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function view(method, args = {}, contract = CONTRACT) {
  const result = await rpc('query', {
    request_type: 'call_function',
    finality: 'optimistic',
    account_id: contract,
    method_name: method,
    args_base64: encode(JSON.stringify(args)),
  });
  if (result.error) throw new Error(result.error);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result)));
}

export const accessKeys = (account) =>
  rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: account }).then((r) => r.keys);

export const accountState = (account) =>
  rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });

// ---- The pocket account ------------------------------------------------------------------------
// A free testnet account kept in this browser, so a visitor with no wallet can still rent a machine.

const POCKET = 'sublet.pocket.v1';

function stored() {
  try {
    return JSON.parse(localStorage.getItem(POCKET));
  } catch {
    return null;
  }
}

function store(pocket) {
  try {
    localStorage.setItem(POCKET, JSON.stringify(pocket));
  } catch {
    // Private windows may block storage. The account still works until the page closes.
  }
}

let session = stored();

export const pocket = () => session;

export async function openPocket() {
  if (session) return session;
  const pair = KeyPair.fromRandom('ed25519');
  const accountId = `sublet-${crypto.randomUUID().slice(0, 13).replaceAll('-', '')}.testnet`;
  const response = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: pair.getPublicKey().toString() }),
  });
  if (!response.ok) {
    throw new Error('The testnet faucet is busy. Try again in a few minutes, or use the CLI with your own account.');
  }
  session = { accountId, secretKey: pair.toString() };
  store(session);
  await sleep(1500);
  return session;
}

function signer() {
  const provider = new FailoverRpcProvider(RPC.map((url) => new JsonRpcProvider({ url })));
  return { provider, account: new Account(session.accountId, provider, KeyPairSigner.fromSecretKey(session.secretKey)) };
}

/** Polls until the transaction and its receipts finish. Reports each stage as it is reached. */
async function follow(hash, onLog) {
  const seen = new Set();
  const deadline = Date.now() + 300_000;
  for (;;) {
    try {
      const result = await rpc('tx', { tx_hash: hash, sender_account_id: session.accountId, wait_until: 'INCLUDED' });
      const receipts = result.receipts_outcome ?? [];
      for (const receipt of receipts) {
        for (const line of receipt.outcome.logs) {
          if (!seen.has(line)) {
            seen.add(line);
            onLog?.(line);
          }
        }
      }
      if (result.status && ('SuccessValue' in result.status || 'Failure' in result.status)) {
        return finish(hash, result);
      }
    } catch {
      // Not indexed yet, or a dropped connection. Keep polling.
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for the network.');
    await sleep(1500);
  }
}

function finish(hash, result) {
  if ('Failure' in result.status) {
    const text = JSON.stringify(result.status.Failure);
    const code = text.match(/E_[A-Z0-9_]+/)?.[0];
    const error = new Error(code ?? 'The transaction failed.');
    error.code = code;
    error.hash = hash;
    throw error;
  }
  let value;
  if (result.status.SuccessValue) {
    const text = new TextDecoder().decode(Uint8Array.from(atob(result.status.SuccessValue), (c) => c.charCodeAt(0)));
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { hash, value };
}

export async function call(method, args, { gasTera = 150, deposit = 0n, onLog } = {}) {
  const { provider, account } = signer();
  const signed = await account.createSignedTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall(method, args, BigInt(gasTera) * TGAS, deposit)],
  });
  const sent = await provider.sendTransactionUntil(signed, 'INCLUDED');
  return follow(sent.transaction?.hash ?? sent.transaction_outcome?.id, onLog);
}

export const rent = (unit, ticks, sshKey, onLog) =>
  call('rent', { unit_id: unit.id, ticks, ssh_key: sshKey, source_address: null }, {
    deposit: BigInt(unit.terms.near_per_tick) * BigInt(ticks) + STORAGE_FEE,
    onLog,
  });

export const rentForeign = (unit, chain, log, sshKey, signature, onLog) =>
  call('rent_foreign', { unit_id: unit.id, chain, log, ssh_key: sshKey, payer_signature: signature, source_address: null }, {
    gasTera: 300,
    deposit: STORAGE_FEE,
    onLog,
  });

export const listUnit = (id, terms) =>
  call('list_unit', { id, terms }, { gasTera: 100, deposit: 2n * STORAGE_FEE });
