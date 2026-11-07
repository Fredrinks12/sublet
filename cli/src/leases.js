// The tenant side of a lease: key handling, renting, and connecting. Used by the CLI and MCP server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSsh, newKeyPair, saveCertificate, subletHome } from './ssh.js';
import { refusalCode } from './near.js';
import { findTransfer, payToken, toContractLog } from './evm.js';

function workDir(contract) {
  return path.join(subletHome(), 'leases', contract, crypto.randomBytes(6).toString('hex'));
}

function finalDir(contract, leaseId) {
  return path.join(subletHome(), 'leases', contract, String(leaseId));
}

/** Moves a fresh key directory to its lease number once the contract has assigned one. */
function adoptKey(contract, leaseId, temp, certificate) {
  const dir = finalDir(contract, leaseId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(temp, dir);
  const keyPath = path.join(dir, 'id_ed25519');
  const certPath = certificate ? saveCertificate(keyPath, certificate) : null;
  return { keyPath, certPath };
}

function failed(outcome) {
  const code = refusalCode(outcome.error);
  const error = new Error(code ? `${code}: the contract refused this.` : `Transaction failed: ${outcome.error}`);
  error.code = code;
  error.hash = outcome.hash;
  return error;
}

export function leaseConnection(contract, unit, lease) {
  const keyPath = path.join(finalDir(contract, lease.id), 'id_ed25519');
  return {
    keyPath,
    certPath: `${keyPath}-cert.pub`,
    host: unit.terms.host,
    port: unit.terms.port,
    user: unit.terms.principal,
    knownHosts: path.join(subletHome(), 'known_hosts'),
  };
}

/** Rents with NEAR. Returns the lease and where its key and certificate were saved. */
export async function rentWithNear(near, contract, unitId, ticks, { sourceAddress } = {}) {
  const unit = await near.view(contract, 'get_unit', { id: unitId });
  if (!unit) throw new Error(`No unit ${unitId}`);
  const rent = BigInt(unit.terms.near_per_tick) * BigInt(ticks);
  const { lease_fee: leaseFee } = await near.view(contract, 'about');
  const temp = workDir(contract);
  const key = newKeyPair(temp);
  const outcome = await near.call(
    contract,
    'rent',
    { unit_id: unitId, ticks, ssh_key: key.publicLine, source_address: sourceAddress ?? null },
    { gasTera: 150, depositYocto: rent + BigInt(leaseFee) },
  );
  if (!outcome.success) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw failed(outcome);
  }
  const lease = outcome.value;
  const paths = adoptKey(contract, lease.id, temp, lease.certificate);
  return { unit, lease, hash: outcome.hash, ...paths };
}

/**
 * Buys more time on a machine you are already renting. Logging in once with the new certificate
 * records its later end time on the server, so sessions that are already running carry on.
 */
export async function renewLease(near, contract, unitId, ticks) {
  const result = await rentWithNear(near, contract, unitId, ticks);
  const options = leaseConnection(contract, result.unit, result.lease);
  const login = execSsh(options, 'true');
  return { ...result, extended: login.code === 0 };
}

/**
 * Claims a payment already made on another chain. `signMessage` signs with the paying wallet.
 * Returns the lease, or throws with a refusal code.
 */
export async function claimForeign(near, contract, unitId, chain, log, signMessage, { sourceAddress } = {}) {
  const temp = workDir(contract);
  const key = newKeyPair(temp);
  const message = await near.view(contract, 'claim_message', {
    unit_id: unitId,
    ssh_key: key.publicLine,
    chain,
    tx: log.transaction_hash,
    log_index: log.log_index,
  });
  const signature = await signMessage(message);
  const { lease_fee: leaseFee } = await near.view(contract, 'about');
  const outcome = await near.call(
    contract,
    'rent_foreign',
    {
      unit_id: unitId,
      chain,
      log,
      ssh_key: key.publicLine,
      payer_signature: signature,
      source_address: sourceAddress ?? null,
    },
    { gasTera: 300, depositYocto: BigInt(leaseFee) },
  );
  if (!outcome.success) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw failed(outcome);
  }
  const lease = outcome.value;
  if (!lease || lease.status !== 'Issued') {
    fs.rmSync(temp, { recursive: true, force: true });
    const error = new Error(`The MPC network did not confirm this payment (lease status: ${lease?.status ?? 'none'}).`);
    error.code = 'E_NOT_ATTESTED';
    error.hash = outcome.hash;
    throw error;
  }
  const unit = await near.view(contract, 'get_unit', { id: unitId });
  const paths = adoptKey(contract, lease.id, temp, lease.certificate);
  return { unit, lease, hash: outcome.hash, ...paths };
}

/** Pays the owner directly on another chain, then claims the lease. */
export async function payAndClaim(near, contract, unitId, chain, ticks, account, { rpcUrl, sourceAddress } = {}) {
  const unit = await near.view(contract, 'get_unit', { id: unitId });
  if (!unit) throw new Error(`No unit ${unitId}`);
  const rent = unit.terms.foreign.find((r) => r.chain === chain);
  if (!rent) throw new Error(`${unitId} does not take rent on ${chain}.`);
  const amount = BigInt(rent.amount_per_tick) * BigInt(ticks);
  const receipt = await payToken({ chain, token: rent.token, to: rent.pay_to, amount, account, rpcUrl });
  const transfer = findTransfer(receipt, rent.token, rent.pay_to);
  if (!transfer) throw new Error(`No matching Transfer log in ${receipt.transactionHash}`);
  const log = toContractLog(transfer);
  const result = await claimForeign(
    near,
    contract,
    unitId,
    chain,
    log,
    (message) => account.signMessage({ message }),
    { sourceAddress },
  );
  return { ...result, paymentTx: receipt.transactionHash };
}
