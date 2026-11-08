// The four things an agent needs: find a machine, rent it, use it, and check on it.
// Shared by the MCP server and the example agent. Each returns plain JSON-ready data.
import { leaseConnection, rentWithNear } from './leases.js';
import { execSsh } from './ssh.js';

const ONE_NEAR = 10n ** 24n;

export function createTools({ near, contract, maxNear = 1 }) {
  let spentYocto = 0n;
  const budget = BigInt(Math.round(maxNear * 1000)) * 10n ** 21n;

  const describe = (unit) => {
    const seconds = unit.terms.tick_secs;
    return {
      id: unit.id,
      title: unit.terms.title,
      description: unit.terms.blurb,
      accepts_near: BigInt(unit.terms.near_per_tick) > 0n || unit.terms.foreign.length === 0,
      near_per_minute: Number((BigInt(unit.terms.near_per_tick) * 60n * 1000000n) / BigInt(seconds) / ONE_NEAR) / 1e6,
      billing_seconds: seconds,
      longest_lease_minutes: (seconds * unit.terms.max_ticks) / 60,
      vacant: Number(unit.occupied_until) * 1000 <= Date.now() && !unit.paused,
      fixed_command: unit.terms.command,
      past_leases: Number(unit.leases),
      renewals: Number(unit.renewals),
    };
  };

  return {
    /** Machines for rent, cheapest first, with whether each is free right now. */
    async listMachines() {
      const units = await near.view(contract, 'list_units', { limit: 100 });
      return units.map(describe).filter((u) => u.accepts_near).sort((a, b) => a.near_per_minute - b.near_per_minute);
    },

    /** Rents a machine. Refuses to go over the session's spending limit. */
    async rentMachine({ unit: unitId, minutes }) {
      const unit = await near.view(contract, 'get_unit', { id: unitId });
      if (!unit) throw new Error(`No machine called ${unitId}.`);
      const ticks = Math.max(1, Math.ceil((minutes * 60) / unit.terms.tick_secs));
      const cost = BigInt(unit.terms.near_per_tick) * BigInt(ticks);
      if (spentYocto + cost > budget) {
        throw new Error(`Over budget: this lease costs ${Number(cost / 10n ** 18n) / 1e6} NEAR and the limit is ${maxNear} NEAR.`);
      }
      const { lease, hash } = await rentWithNear(near, contract, unitId, ticks);
      // The rent is held from the moment it is paid, even while an owner decides, so it counts now.
      spentYocto += cost;
      if (lease.status !== 'Issued') {
        return {
          lease: lease.id,
          status: lease.status,
          note: `The owner must approve this lease before a key is cut. Check on it with lease_status. To withdraw it for a full refund, run "sublet cancel ${lease.id}" as this NEAR account.`,
          spent_near: Number(spentYocto / 10n ** 18n) / 1e6,
        };
      }
      return {
        lease: lease.id,
        status: lease.status,
        ends_at: new Date(Number(lease.valid_before) * 1000).toISOString(),
        seconds_left: Number(lease.valid_before) - Math.floor(Date.now() / 1000),
        transaction: `${near.config.explorer}${hash}`,
        spent_near: Number(spentYocto / 10n ** 18n) / 1e6,
      };
    },

    /** Runs one shell command on a rented machine. */
    async runCommand({ lease: leaseId, command }) {
      const lease = await near.view(contract, 'get_lease', { id: String(leaseId) });
      if (!lease) throw new Error(`No lease ${leaseId}.`);
      const unit = await near.view(contract, 'get_unit', { id: lease.unit });
      const result = execSsh(leaseConnection(contract, unit, lease), command, process.env.SUBLET_SSH ?? 'ssh', 120_000);
      return { exit_code: result.code, stdout: result.stdout, stderr: result.stderr };
    },

    /** Whether a lease is still live, and for how long. */
    async leaseStatus({ lease: leaseId }) {
      const lease = await near.view(contract, 'get_lease', { id: String(leaseId) });
      if (!lease) throw new Error(`No lease ${leaseId}.`);
      // A request still waiting for its owner has no end time yet, so it has not expired.
      const issued = lease.status === 'Issued';
      const left = issued ? Number(lease.valid_before) - Math.floor(Date.now() / 1000) : 0;
      return { lease: lease.id, unit: lease.unit, status: lease.status, seconds_left: Math.max(0, left), expired: issued && left <= 0 };
    },
  };
}
