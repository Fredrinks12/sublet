// Audits the chain of trust from public data, so nobody has to take the project's word for it.
import crypto from 'node:crypto';
import fs from 'node:fs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(text) {
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
}

function sshBlob(line) {
  return Buffer.from(line.trim().split(/\s+/)[1], 'base64');
}

/**
 * Each check answers one question a server owner should ask before trusting a contract.
 * `ok: null` means "not checked", for checks that need input the caller did not give.
 */
export async function doctor(near, contract, unitId, { caFile, wasmFile } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const unit = await near.view(contract, 'get_unit', { id: unitId });
  if (!unit) return [{ name: 'Unit exists', ok: false, detail: `no unit ${unitId}` }];
  add('Unit exists', true, `${unitId}, owned by ${unit.owner}`);

  const keys = await near.accessKeys(contract);
  const fullAccess = keys.filter((k) => k.access_key.permission === 'FullAccess');
  add(
    'Nobody holds a key to the contract',
    keys.length === 0,
    keys.length === 0
      ? 'the account has zero access keys, so nobody can change its code or sign as it'
      : `${fullAccess.length} full-access and ${keys.length - fullAccess.length} other keys exist. Whoever holds them can change the rules. Fine for a dev deployment only.`,
  );

  const about = await near.view(contract, 'about');
  const path = `unit/${unit.owner}/${unitId}`;
  const expected = await near.rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: about.mpc,
    method_name: 'derived_public_key',
    args_base64: Buffer.from(JSON.stringify({ path, predecessor: contract, domain_id: about.sign_domain })).toString('base64'),
  });
  const derived = JSON.parse(Buffer.from(expected.result).toString('utf8'));
  const raw = b58decode(derived.replace(/^ed25519:/, ''));
  const onChain = unit.ca_public_key ? sshBlob(unit.ca_public_key) : Buffer.alloc(0);
  add(
    'The CA key can only be used by this contract',
    onChain.length === 51 && onChain.subarray(19).equals(raw),
    `${about.mpc} derives it from this contract's account and the path ${path}`,
  );

  if (caFile) {
    const onServer = sshBlob(fs.readFileSync(caFile, 'ascii'));
    add('This server trusts that CA key', onServer.equals(onChain), caFile);
  } else {
    add('This server trusts that CA key', null, 'pass --ca-file /etc/ssh/sublet_ca.pub to check');
  }

  const account = await near.accountState(contract);
  if (wasmFile) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(wasmFile)).digest();
    add('Deployed code matches the local build', b58decode(account.code_hash).equals(digest), `code hash ${account.code_hash}`);
  } else {
    add('Deployed code matches the local build', null, `code hash ${account.code_hash}. Pass --wasm to compare`);
  }
  return checks;
}
