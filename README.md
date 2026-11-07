# Sublet

Rent out any Linux machine by the minute, with nothing installed on it. A NEAR contract checks the rent, on NEAR or on another chain, then has NEAR's MPC network sign an SSH key that expires on its own.

Built at NEAR HACKATHON, in the Open Innovation track. Testnet only and unaudited.

| | |
| --- | --- |
| Contract | [`sublet.testnet`](https://testnet.nearblocks.io/address/sublet.testnet) |
| Website | Add the hosted URL here before submitting |
| Demo video | Add the X post here before submitting |

## The problem

An AI agent can hold USDC, but it cannot open an AWS account. It has no card, no passport and no phone number.

Meanwhile plenty of machines sit idle. To let a stranger use one for ten minutes today, an owner has to hand over a key that never expires, or install a marketplace's daemon and trust whoever runs it.

## What it does

1. **An owner adds one line to `sshd_config`**, trusting a public key that only this contract can use. Nothing is installed. The server never talks to a blockchain.
2. **A tenant pays**, in NEAR or in USDC on Base. Rent on Base goes straight to the owner, so the contract never holds it.
3. **The contract checks the rent.** For Base, it asks NEAR's MPC network to read the payment, with no bridge, solver or oracle.
4. **The contract writes an OpenSSH certificate** from the owner's published terms, and the MPC network signs those exact bytes.
5. **Plain `ssh` works.** When the time runs out, the session ends and the key stops working.

NEAR's function-call keys give someone a limited key to a contract. Sublet does the same for a Linux server.

## Try it

### Run a full lease in one command

Needs Node 20 or later and OpenSSH, including `sshd` (`apt-get install openssh-server` on Debian or Ubuntu). No Docker, funds, wallet or root.

```sh
cd cli && npm ci && cd ..
node scripts/judge.mjs
```

It creates a free testnet account, starts a private `sshd` on a local port, lists it on the live contract, rents it and logs in. You should see these checks pass, then a line such as `11 of 11 checks passed`:

```text
PASS  a key with no lease is refused
PASS  the contract issued a certificate, signed by the MPC network
PASS  stock sshd accepts it
PASS  the open session ended with the lease
PASS  the same certificate is now refused
```

It runs as you, so it uses `evict_user: false` and cannot touch your other processes.

### Re-check the evidence

Needs no account, funds or keys.

```sh
cd cli && npm ci && cd ..
node scripts/verify-evidence.mjs
```

It reads the contract and its leases from public RPC, verifies each certificate's Ed25519 signature itself, and confirms each recorded attack was refused on chain with the same code. You should see `Everything checked out.` Results and links are in [docs/EVIDENCE.md](docs/EVIDENCE.md).

### Run the contract tests

Needs Rust. The toolchain is pinned in `contract/rust-toolchain.toml`.

```sh
cd contract
cargo test --lib
```

You should see `test result: ok. 79 passed`. One test reproduces a hash the live testnet MPC network really signed.

### Rent a machine on the website

```sh
cd web && npm ci && npm run dev
```

Open the page, choose **Rent** on a listing, and confirm. A free testnet account and an SSH key are made in your browser. You should see **Your key is cut**, a countdown, and commands to paste into a terminal. The site has no backend.

To point it at another deployment, set `VITE_CONTRACT` in `web/.env.local`.

### Give an AI agent a machine

Add the MCP server to any compatible client:

```json
{
  "mcpServers": {
    "sublet": {
      "command": "node",
      "args": ["mcp/server.js"],
      "env": { "SUBLET_ACCOUNT": "your-account.testnet", "SUBLET_MAX_NEAR": "0.5" }
    }
  }
}
```

The agent gets `list_machines`, `rent_machine`, `run_command` and `lease_status`. Run `npm ci` in `mcp/` first. `SUBLET_ACCOUNT` needs a key in `~/.near-credentials/testnet/`.

To watch an agent do a job on a machine it rented, run `node examples/agent-rents-a-box.mjs`. With `NEAR_AI_API_KEY` set, a model on NEAR AI Cloud makes the decisions. Without one, a fixed script uses the same tools.

### Let your own machine

```sh
sublet list my-box terms.json    # terms.json: see demo/terms-example.json
sublet setup my-box              # prints the commands for your server
sublet doctor my-box             # audits the chain of trust
```

The website has a form for this too. Use a Unix user kept only for tenants. The contract refuses `root`.

## How NEAR is used

| NEAR feature | What it does here |
| --- | --- |
| Chain Signatures, `sign` with Ed25519 | Signs SSH certificates. It accepts any payload from 32 to 1,232 bytes, so it is not limited to blockchain transactions. |
| Foreign chain verification, `verify_foreign_transaction` | Lets the contract read a payment on another chain with no bridge. The MPC network serves 12 chains. Sublet supports the EVM ones, and is tested on Base Sepolia. |
| Derived keys | Each machine gets its own CA key, from the path `unit/<owner>/<id>`. Only this contract can use it. |
| Contract state and events | Terms, tenants and leases are public. Every session is tied to a lease in the server's log, through the certificate's key ID. |
| Accounts with zero keys | Nobody can change the deployed contract or sign as it. |

The contract builds the whole certificate itself, so no caller can influence it beyond choosing their own public key. See [contract/src/ssh.rs](contract/src/ssh.rs).

## Why use a contract at all?

Teleport and HashiCorp Vault already issue short-lived SSH certificates. They need an account, a central authority that can mint anything, and an operator you trust. They do not take payment, and they do not work between strangers.

| | Vault or Teleport | A compute marketplace | Sublet |
| --- | --- | --- | --- |
| Software on the server | Sometimes | Yes | None |
| Who can mint a key | Whoever holds the CA | The operator | Only the contract's rules |
| Sign-up | Account | Account, often a card | None |
| An agent can pay by itself | No | Rarely | Yes |
| Public record of access | Private logs | Private logs | On chain |

The cost is latency, since cutting a key takes seconds, and that a key needs NEAR and the MPC network to be up. A server's own SSH access never depends on them.

## Failure cases

These are the short answers. [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) has the full list, including what Sublet does not protect against.

| Case | Result |
| --- | --- |
| An owner loses their NEAR key | The server is still theirs. Removing one line stops new logins. |
| A hostile owner takes rent and goes dark | The tenant loses at most the ticks they bought. Buy one at a time. |
| A hostile tenant | They cannot log in after expiry. They could kill the timer and outstay an open session, so use a container for strangers. |
| An owner is offline during an approval | The tenant can cancel and get a full refund. |
| NEAR or the MPC network stops | No new keys are cut. Live ones work until they expire. |
| The MPC network will not confirm a payment | The claim fails and the payment stays unspent, so it can be claimed again. |

## What is in this repository

| Path | What it is |
| --- | --- |
| [contract/](contract/) | The Rust contract: leases, payment checks and the certificate encoder |
| [cli/](cli/) | The `sublet` command, and the client library the other parts share |
| [web/](web/) | The website, static with no backend |
| [mcp/](mcp/) | An MCP server for AI agents |
| [examples/](examples/) | An agent that rents a machine to do a job |
| [scripts/](scripts/) | The judge run, the Attack Lab and the evidence verifier |
| [docs/](docs/) | The threat model and evidence |

## Limits

Sublet is unaudited and runs on testnet. Rent on other chains needs an EIP-191 signature from the paying address, so contract wallets cannot claim yet. The website supports browser wallets on EVM chains, and its own free testnet account on NEAR, but not NEAR wallets yet.

## Credits

Written during the hackathon window, from 19 October 2026, with no earlier code.

**Libraries:** `near-sdk`, `near-api-js`, `viem`, `vite`, `@modelcontextprotocol/sdk`, `zod`, `base64`, `hex`, `puppeteer-core` and `ed25519-dalek` for tests.

**AI tools:** written with Claude Code.

**License:** MIT.
