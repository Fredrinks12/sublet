# List a public machine

Use any Linux server you control that accepts SSH from the internet. A small VPS is enough. Do this on a machine with nothing important on it, because you are letting strangers log in.

## On your computer

Copy `demo/terms-example.json` to `terms.json` and edit it:

- `title` and `blurb`: what a tenant gets.
- `host` and `port`: your server's public address.
- `principal`: the Unix user tenants log in as. Keep it for tenants only.
- `tick_secs` and `near_per_tick`: how long a tick lasts, and its price in yoctoNEAR. On a machine priced on Base, zero means NEAR is not accepted. With no Base price, zero makes the machine free for anyone.
- `foreign`: set `pay_to` to your own address on Base Sepolia, or set `foreign` to `[]` to take NEAR only.

Then list it, using a testnet account whose key is in `~/.near-credentials/testnet/`:

```sh
node cli/bin/sublet.js list my-box terms.json --account you.testnet
node cli/bin/sublet.js setup my-box
```

## On your server

Run the commands `setup` printed, then check them:

```sh
sudo sshd -T | grep -i trustedusercakeys
```

You should see `trustedusercakeys /etc/ssh/sublet_ca.pub`. Your own SSH access does not change. Make sure the server's clock is set by NTP, since leases end by that clock.

## Check it

From any other machine:

```sh
node cli/bin/sublet.js rent my-box --ticks 1 --account tenant.testnet
node cli/bin/sublet.js ssh <lease> --account tenant.testnet
```

You should get a shell. When the lease ends, the session closes and logging in again gives `Permission denied`.

## To stop

Delete the line in `/etc/ssh/sshd_config.d/sublet.conf` and reload SSH. New logins stop at once, whatever the contract says.

Read [THREAT-MODEL.md](THREAT-MODEL.md) before letting to strangers.
