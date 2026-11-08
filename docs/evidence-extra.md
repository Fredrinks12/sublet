## A request the owner never answered

The Attack Lab runs on 7 November left two requests on machines that need the owner's approval. The owner never answered, and later delisted both machines. About 17 hours later, the tenant withdrew both with `sublet cancel`. Each returned the whole 0.04 NEAR deposit, made up of rent, change and the storage fee. Both left no record in contract state.

| Lease | Withdrawn | Refunded | Event |
| --- | --- | --- | --- |
| 1 | [`DStokjsm...jN5i`](https://testnet.nearblocks.io/txns/DStokjsmzmNYQMdifUW1KtprdZNKqDB9tcseVDtnjN5i) | 0.04 NEAR to the tenant | `lease_closed`, `Cancelled` |
| 7 | [`Ea9sTmTj...ZvQ3`](https://testnet.nearblocks.io/txns/Ea9sTmTjC1ZsRjdoJyKsEu5TjPWMEeYkwoMGXhmDvZQ3) | 0.04 NEAR to the tenant | `lease_closed`, `Cancelled` |

## A real payment on Base, read by the MPC network

The MPC network read a real USDC transfer on Base Sepolia, the contract rebuilt the same hash from public data, and stock OpenSSH accepted the certificate that came out. The whole claim took 14.6 seconds.

**One check was off in this run.** The transfer was made by a stranger, so we could not sign for it. It ran on a separate test build, `dev-any-payer`, which skips only the check that the payer signed the claim. That build reports itself in `about()`, and the release contract above does not have this flag. Everything else was live.

| | |
| --- | --- |
| Base Sepolia transfer | [`0x4059b56d...b762`](https://sepolia.basescan.org/tx/0x4059b56deba6a3cc43708d62366bba2308edee864807c498ef1aab167027b762) |
| NEAR transaction | [`3RiGjT4A...aLWd`](https://testnet.nearblocks.io/txns/3RiGjT4AwtudrZz1REYgkfaKiZR3cy9ZtkgMCtK4aLWd) |
| Test contract | [`cmw6iw3j9.sublet-dev-0ekmh.testnet`](https://testnet.nearblocks.io/address/cmw6iw3j9.sublet-dev-0ekmh.testnet) |
| Result | `paid on Base, logged in as tenant`, and replaying the payment gave `E_PAYMENT_ALREADY_USED` |

To repeat it, see `scripts/vm/foreign-live.mjs`. The contract's payer check is covered by tests using signatures from a real wallet library. The Attack Lab also ran it live against the release build, where a stranger's real payment was refused with `E_WRONG_PAYER`.

## What has not been run

A payment on the release build, from a wallet we control, all the way to a login. It needs Base Sepolia gas and USDC, which only a browser faucet provides. The website's Base payment path has not been run in a real browser wallet for the same reason.

The agent example has only run with its fixed script, not a real NEAR AI model. The GitHub workflows have not run, because the repository is not on GitHub yet. The contract tests have only run on Windows.
