# Threat model

Sublet is unaudited hackathon software on testnet. This page says what it protects, what it does not, and who you have to trust.

## What is enforced, and by whom

| Rule | Enforced by | Can a tenant get around it? |
| --- | --- | --- |
| Only a paid-up tenant gets a certificate | The contract | No |
| A certificate opens one machine, as one Unix user | OpenSSH, from the signed certificate | No |
| A certificate stops working at its end time | OpenSSH, from the signed certificate | No |
| A fixed command is the only thing that runs | OpenSSH, from the signed `force-command` | No |
| No port forwarding unless the owner allows it | OpenSSH, from the signed certificate | No |
| One tenant at a time | The contract | No |
| An open session ends when the lease ends | A timer running as the tenant | **Yes, see below** |

## The main limit: a hostile tenant can outstay an open session

OpenSSH checks a certificate only when a session starts. It never closes a session because a certificate expired.

So the contract signs a command into each certificate that starts a timer. When the lease ends, the timer kills the tenant's processes. This works for an honest tenant, and for anything that merely forgets to stop, including `nohup` and `setsid` jobs. The Attack Lab tests that.

The timer runs as the tenant's own Unix user, though. A tenant who deliberately looks for it can kill it and keep an already-open session alive until they disconnect. They still cannot open a new connection, because OpenSSH refuses the expired certificate.

**If you let to strangers, assume they can do this.** Set the unit's `command` to start a container, and limit that container's lifetime from outside it. We have not tested a container recipe.

## Other limits

- **Tenants share a Unix user over time.** Files left in the home directory stay there for the next tenant. A tenant who beat the timer could leave a process running. For strangers, use a container, or clean the account between leases.
- **A rented machine is the owner's computer.** The owner has root, so they can read anything a tenant does. Never put secrets on a rented machine. If you need that, you want a TEE, not this.
- **Abuse.** A tenant can do anything that Unix user can do, including sending spam or attacking other hosts. Limit the user's network access if you let to strangers.
- **No proof of service.** A contract cannot tell whether a server really worked. An owner can take rent and switch the machine off. Buying one tick at a time limits the loss to one tick, and paid renewals are public, so they work as a costly signal of a machine that does work. They are not a guarantee.
- **The server's clock matters.** OpenSSH and the timer use the server's clock. If it runs fast, a lease ends early. We measured 9 seconds of drift in an emulated VM, and the session ended about 7 seconds early. Any server with NTP is fine.
- **Latency.** Cutting a key took 7 to 35 seconds on testnet. This suits starting a session, not authorising each command.
- **Contract wallets cannot claim foreign payments.** The claim needs an EIP-191 signature from the address that paid, so smart wallets are not supported.
- **`evict_user` is powerful.** It runs `kill -9 -1` as the tenant's Unix user. It is opt-in and root is refused, but an owner who sets it on an account they also use will lose their own processes when a lease ends.
- **Owners can change terms.** If an owner raises the price after a tenant pays on Base, that payment may no longer cover a tick. The claim is refused and the money stays with the owner. The loss is bounded by what was sent, so send one tick at a time.

## What you have to trust

| Who | If they turn hostile |
| --- | --- |
| NEAR's MPC network, above its threshold (11 of 16 on testnet today) | They could sign a certificate for any unit, and attest payments that never happened. This is the same trust every Chain Signatures user places in them. |
| The RPC providers the MPC nodes read from | A quorum of them could misreport a foreign chain. The network's quorum for Base is listed on chain in `allowed_foreign_chain_providers`. |
| The chain you accept rent on | With `finality: Latest`, a reorg could undo a payment after the key is cut. Choose `Safe` or `Finalized` if that matters. The owner chooses and bears this risk, per unit. |
| OpenSSH | Its certificate checks are the last line of defence. |

## What you do not have to trust

- **The deployer.** The deployed contract has zero access keys, so nobody can change its code or sign as it. Run `sublet doctor` or `scripts/verify-evidence.mjs` to check. Reproducible builds are configured but not yet verified, so comparing the code hash needs the same toolchain.
- **Any server of ours.** The website is static and there is no backend.
- **The certificate on chain.** Certificates are public by design. One is useless without the matching private key, which never leaves the tenant's machine. The Attack Lab tests this too.

## Failure cases

| What happens | Result |
| --- | --- |
| An owner loses their NEAR key | They can no longer change terms or pause on chain, but the server is still theirs. Removing the `TrustedUserCAKeys` line stops all new logins at once. |
| An owner's key is stolen | The thief can change the terms, or redirect rent. They cannot reach the server unless it still trusts that unit's key, in which case they could rent it for free. Remove the trust line. |
| A tenant loses their private key | They wait for the lease to end. Certificates are bound to one key, and the contract cannot move a lease to a new one. |
| A tenant goes offline mid-lease | The lease runs out. Nothing more is owed. |
| An owner goes offline | Tenants lose at most the ticks they bought. A pending approval can be cancelled by the tenant, with a full refund. |
| NEAR or the MPC network stops | No new keys are cut. Live certificates work until they expire. The owner's own SSH access never depended on any of this, so they are not locked out. |
| The MPC network will not confirm a real payment | The claim fails after about two minutes, the payment is marked unspent, and the tenant can claim it again. |
| Base payment arrives while the unit is occupied | The claim is refused with `E_OCCUPIED` and the payment stays unspent. The tenant can claim it when the unit is free. |
| A key is being cut when the owner pauses | That lease completes. Pausing stops new keys only. |
| A contract bug appears | No foreign rent is at risk, because the contract never holds it. NEAR rent is held only for the seconds it takes to cut a key. The worst case is unauthorised certificates for machines that trust the contract, and every owner can cut that off with one line. |
