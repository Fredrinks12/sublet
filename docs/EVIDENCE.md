# Evidence

Everything here can be re-checked from public data, with no account or funds:

```sh
cd cli && npm ci && cd ..
node scripts/verify-evidence.mjs
```

## The contract

| | |
| --- | --- |
| Account | [`sublet.testnet`](https://testnet.nearblocks.io/address/sublet.testnet) |
| Build | release, version 0.1.0 |
| Code hash | `4ZYDk168yzsDGNiMZTLkc5HpqRnfNVY7WyERwnnJYTv2` |
| Access keys | 0 |
| MPC contract | `v1.signer-prod.testnet` |

## Real leases

Each of these is a certificate on the public record. The verifier checks each one's Ed25519 signature itself.

| Lease | Unit | Tenant | Ticks | Status |
| --- | --- | --- | --- | --- |
| 13 | debian-vm | sublet-tenant-0ekmh.testnet | 2 | Issued |
| 14 | debian-vm | sublet-tenant-0ekmh.testnet | 1 | Issued |
| 15 | debian-vm | sublet-tenant-0ekmh.testnet | 1 | Issued |
| 16 | debian-vm | sublet-tenant-0ekmh.testnet | 2 | Issued |
| 17 | debian-vm | sublet-tenant-0ekmh.testnet | 1 | Issued |

## The Attack Lab

37 of 37 attacks stopped, run on 2026-11-07 against this contract and stock OpenSSH 10.0p2 on Debian 13. To run it yourself, see `scripts/attack-lab.mjs`.

| Attack | What stopped it |
| --- | --- |
| Pay less than the rent | [E_UNDERPAID](https://testnet.nearblocks.io/txns/FTmeutWh2gm4Njr36b78msz8JRVTxtdc9jzipUQdKsdf) |
| Ask for more time than the owner allows | [E_BAD_TICKS](https://testnet.nearblocks.io/txns/CArKF8DAVE9sEMJJwVDF6A1aVrXckqgTYdzDAJSCbaj) |
| Rent a machine the owner has paused | [E_PAUSED](https://testnet.nearblocks.io/txns/JD8vZcuykXhvu7QR6QzJooD6L2MpjoEamQRe1oEJjgb1) |
| Rent a private machine as a stranger | [E_NOT_ALLOWED](https://testnet.nearblocks.io/txns/DEShWmmn5FN8Fgya6GvUu1Vy3JaNviDQt9V75eBNCEmu) |
| Smuggle a shell command in as an IP address | [E_BAD_SOURCE_ADDRESS](https://testnet.nearblocks.io/txns/3tBdL64262k8WNz5wTWnniKMcdnWiqmctDrCpqQ5PdMo) |
| Rewrite another owner's terms | [E_NOT_OWNER](https://testnet.nearblocks.io/txns/9raSUBxGMEJXYgfhLx4NCzpXqbDWsffBtEDMKzvuvPde) |
| Pause another owner's machine | [E_NOT_OWNER](https://testnet.nearblocks.io/txns/HnLzUbBafJoCRsKQB9gQH8RFMWD744EVZoNTNJ6wEYMQ) |
| Delist another owner's machine | [E_NOT_OWNER](https://testnet.nearblocks.io/txns/2cpeoUVy8sKjyUYAWk6cjjXDamxNLm5aC4acDNbf1Qy1) |
| Take over a listed machine's name | [E_UNIT_EXISTS](https://testnet.nearblocks.io/txns/GxkT8uxpjwiaQPCFaXYndjeonvaQDUzFhoRYKtwBM8wv) |
| List a machine as root | [E_ROOT_NOT_ALLOWED](https://testnet.nearblocks.io/txns/8wybSfirzp53oCt1dHga4svUtU29fQZPaEx6KnDANK8F) |
| List one Unix user twice, so two tenants share it | [E_USER_ALREADY_LISTED](https://testnet.nearblocks.io/txns/Am68cmWdK4UGfrAq81RQqTbUngSDp1fuGf4LeFhcyckD) |
| Hide a shell command in a server address, for a visitor to paste | [E_BAD_HOST](https://testnet.nearblocks.io/txns/BtpPoXuLm46Dtz7BR3gt6Dgpny3srPxHitpbKxgS3Gay) |
| Hide an ssh option in a Unix user name | [E_BAD_PRINCIPAL](https://testnet.nearblocks.io/txns/2uDwMvZhefTkUVV8HGtNhgLdTe1Njmgn4Ft1K63QP5TF) |
| Hide terminal escape codes in a listing | [E_BAD_TITLE](https://testnet.nearblocks.io/txns/AVHviZ7EsEzyr9wp1udnA7te4txKix4H2BkL5Rmtqets) |
| Approve your own request | [E_NOT_OWNER](https://testnet.nearblocks.io/txns/43TbHX34zT5GSNhLqCurAMfsXjfGYKaeV3ZCQ1RMxNp4) |
| Cancel someone else's request | [E_NOT_TENANT](https://testnet.nearblocks.io/txns/C2LTygejzQ4BFb5gAMVA51RP2PKuKETWBkSsQxgxUbhd) |
| Call the signing callback directly, to forge a certificate | [Method on_signed is private](https://testnet.nearblocks.io/txns/CWdx8Gfod8WjiBHwN5bD3Grqg1u7gqJaSM9vVAwTJ48U) |
| Claim a stranger's real payment for your own key | [E_WRONG_PAYER](https://testnet.nearblocks.io/txns/GqdzhqWmsRBC3uKau32v2d2JUQeSBCYBWnCRgSoL8kTQ) |
| Claim a payment made in another token | [E_WRONG_TOKEN](https://testnet.nearblocks.io/txns/7eGis756HvY4eMZghVa8dR6KxhdTBYm73NxmQkph5h5Z) |
| Claim a payment sent to someone else | [E_WRONG_RECIPIENT](https://testnet.nearblocks.io/txns/4BkLHz6HxW2bV5L1zvDx9x5BwUSMdDxWz31sP43Sd57A) |
| Pass off a different event as a transfer | [E_NOT_A_TRANSFER](https://testnet.nearblocks.io/txns/9uTSg5HMWacRbyEFfAcNheCDXm88NB6wNQVxDLe5iB2u) |
| Claim on a chain the owner does not accept | [E_CHAIN_NOT_ACCEPTED](https://testnet.nearblocks.io/txns/F57jf2UHTubNsadB7HZKDSVFivQSRJnvQFtr1rdRUmg) |
| Rent a machine priced on Base for free through NEAR | [E_PAY_ON_ANOTHER_CHAIN](https://testnet.nearblocks.io/txns/Bt8J3SeknnbShEpR2SQXphAc6429q4R5ULcCqsAr8b5a) |
| Log in with no lease | Permission denied |
| Rent a machine someone else holds | [E_OCCUPIED](https://testnet.nearblocks.io/txns/ZG4BRWRWpEZGaDyL6ZArAwXcauTq3spyd1ikvbXVRN8) |
| Copy a tenant's public certificate from the chain and use it | Permission denied |
| Edit a certificate to last another year | Permission denied |
| Use a key cut for one machine on another | Permission denied |
| Tunnel through the machine to another service | Forwarding refused |
| Make the machine listen on a port for you | Forwarding refused |
| Run your own command on a fixed-command machine | The owner's command ran instead |
| Inject a command past the fixed command | The owner's command ran instead |
| Leave nohup and setsid processes running past the end | All processes killed |
| Log back in after the lease ends | Permission denied |
| Block a real payment by forging a claim on its transaction | [The real payment stays claimable](https://testnet.nearblocks.io/txns/J5MGvmNoX9uNzmiza1gB3fh94j45Y1nUPqoLyWppvCMR) |
| Tie up a machine with a claim the network will refuse | [Other tenants can still rent](https://testnet.nearblocks.io/txns/7qdwVufgaTWiVyaAyBWqLuJ53y1WexcTAaFRKZEAzsmi) |
| Invent a payment that never happened | [No key cut](https://testnet.nearblocks.io/txns/J5MGvmNoX9uNzmiza1gB3fh94j45Y1nUPqoLyWppvCMR) |

**Leave nohup and setsid processes running past the end:** Confirmed gone 6s after the lease ended, by the server's clock.

**Invent a payment that never happened:** The MPC network would not attest it. Lease status Failed after 119s. The real payment stayed claimable: true. Left no record in contract state: true.

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
