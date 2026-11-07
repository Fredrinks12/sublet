//! # Sublet
//!
//! Rent out any Linux machine by the minute, with nothing to install on it.
//!
//! An owner adds one line to `sshd_config`, trusting a public key that only this contract can use.
//! A tenant pays. The contract checks the rent, builds an OpenSSH certificate from the owner's
//! published terms, and has NEAR's MPC network sign it. The server verifies the certificate with
//! stock OpenSSH and needs no NEAR software, wallet or network access to the chain.
//!
//! Rent paid on another chain goes straight to the owner there. The contract never holds it. It
//! asks the MPC network to read the payment, with no bridge or solver.

mod evm;
mod ssh;

use evm::{EvmChain, EvmLog, Finality};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PublicKey,
};

const GAS_DERIVE: Gas = Gas::from_tgas(10);
const GAS_ON_CA: Gas = Gas::from_tgas(10);
const GAS_SIGN: Gas = Gas::from_tgas(40);
const GAS_ON_SIGNED: Gas = Gas::from_tgas(20);
const GAS_VERIFY: Gas = Gas::from_tgas(40);
const GAS_ON_VERIFIED: Gas = Gas::from_tgas(100);

/// Held once per lease to pay for its storage, about 1.5 KB with its certificate. Refunded if the
/// lease fails.
const LEASE_STORAGE_FEE: NearToken = NearToken::from_millinear(20);
/// Held while a unit is listed, to pay for its storage. The longest allowed terms take about 7 KB.
/// Refunded on delisting.
const UNIT_STORAGE_FEE: NearToken = NearToken::from_millinear(100);

/// The MPC contract's limit on an EdDSA payload.
const MAX_SIGNED_BYTES: usize = 1232;
/// Tolerated clock drift between NEAR and the server.
const CLOCK_SKEW_SECS: u64 = 30;
/// Largest reply a callback will read. Every MPC reply is far smaller, so a longer one is an error.
const MAX_PROMISE_RESULT_BYTES: usize = 4096;
/// Longest signed session command. With the other certificate fields at their limits, this keeps a
/// certificate well under MAX_SIGNED_BYTES, so cutting a key can never panic inside a callback.
const MAX_SESSION_COMMAND_BYTES: usize = 640;
/// A key being cut holds its unit for this long at most, in case a callback is ever lost.
const IN_FLIGHT_TIMEOUT_SECS: u64 = 600;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Units,
    Leases,
    Spent,
    Seats,
}

/// A price in a token on another chain, paid straight to the owner's address there.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ForeignRent {
    pub chain: EvmChain,
    /// Lowercase `0x` address of the token contract.
    pub token: String,
    /// Lowercase `0x` address that receives the rent.
    pub pay_to: String,
    /// Raw token units per tick.
    pub amount_per_tick: U128,
    /// How settled a payment must be before the key is cut.
    pub finality: Finality,
}

/// The owner's published terms. Anyone can read them, and the certificate is built only from them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Terms {
    pub title: String,
    pub blurb: String,
    pub host: String,
    pub port: u16,
    /// Unix user the certificate logs in as.
    pub principal: String,
    /// When set, the tenant can run only this command. Enforced by OpenSSH.
    pub command: Option<String>,
    /// When true, a lease's end kills every process of `principal`, including `nohup` and `setsid`
    /// jobs. Set this only for a Unix user kept for tenants, never for an account you log in with.
    pub evict_user: bool,
    pub permit_pty: bool,
    pub permit_port_forwarding: bool,
    /// Length of one unit of rent. A certificate lasts `ticks * tick_secs`.
    pub tick_secs: u32,
    pub max_ticks: u32,
    /// Zero makes a unit free, unless it has oreign rent, in which case NEAR is not accepted.
    pub near_per_tick: U128,
    pub foreign: Vec<ForeignRent>,
    /// When set, only these NEAR accounts may rent.
    pub allowlist: Option<Vec<AccountId>>,
    /// When true, the owner approves each lease before the key is cut.
    pub needs_approval: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Unit {
    owner: AccountId,
    terms: Terms,
    ca: Option<[u8; 32]>,
    paused: bool,
    leases: u64,
    renewals: u64,
    ticks_sold: u64,
    /// Tenants share a Unix user, so a unit has one tenant at a time.
    tenant: Option<String>,
    tenant_until: u64,
    /// The lease whose key is being cut. Blocks other requests until it resolves.
    in_flight: Option<u64>,
    in_flight_at: u64,
}

#[near(serializers = [json])]
pub struct UnitView {
    pub id: String,
    pub owner: AccountId,
    pub terms: Terms,
    /// The single line of trust a server needs, as a `TrustedUserCAKeys` entry.
    pub ca_public_key: Option<String>,
    pub paused: bool,
    pub leases: U64,
    pub renewals: U64,
    pub ticks_sold: U64,
    /// Current tenant, if any. Zero `occupied_until` or a past time means the unit is vacant.
    pub occupied_by: Option<String>,
    pub occupied_until: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseStatus {
    AwaitingApproval,
    Verifying,
    Cutting,
    Issued,
    Failed,
    Rejected,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub enum Paid {
    Near { payer: AccountId, rent: U128, change: U128 },
    Foreign {
        payer: AccountId,
        chain: EvmChain,
        token: String,
        amount: U128,
        tx: String,
        log_index: u64,
        /// Whether this lease marked the payment as used. Only a payment the network has confirmed
        /// can be marked, so a forged claim can never block a real one.
        spent: bool,
    },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Lease {
    pub id: U64,
    pub unit: String,
    /// A NEAR account, or the `0x` address that paid on another chain.
    pub tenant: String,
    /// Hex of the tenant's Ed25519 public key.
    pub subject: String,
    pub ticks: u32,
    pub source_address: Option<String>,
    pub status: LeaseStatus,
    pub paid: Paid,
    pub valid_after: U64,
    pub valid_before: U64,
    /// The complete certificate, as the contents of an `id_ed25519-cert.pub` file.
    pub certificate: Option<String>,
}

#[near(serializers = [json])]
pub struct About {
    pub name: String,
    pub version: String,
    /// `release`, or `dev-any-payer` for a test build that skips the payer check. Never trust one.
    pub build: String,
    /// Yoctonear held per lease, on top of rent.
    pub lease_fee: U128,
    /// Yoctonear held while a unit is listed.
    pub unit_fee: U128,
    pub mpc: AccountId,
    pub sign_domain: u32,
    pub foreign_domain: u32,
    pub units: u32,
    pub leases: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Sublet {
    mpc: AccountId,
    sign_domain: u32,
    foreign_domain: u32,
    units: IterableMap<String, Unit>,
    leases: LookupMap<u64, Lease>,
    next_lease: u64,
    spent: LookupSet<[u8; 32]>,
    /// Each owner's listed host, port and Unix user. See `seat_key`.
    seats: LookupSet<[u8; 32]>,
}

fn refuse(code: &str) -> ! {
    env::panic_str(code)
}

fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn event(name: &str, data: serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({"standard": "sublet", "version": "1.0.0", "event": name, "data": [data]})
    );
}

fn valid_unit_id(id: &str) -> bool {
    (3..=32).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// Clients build shell commands from the principal and host, and tell people to paste them. So
/// these fields carry only characters that mean nothing to a shell, and cannot start with `-`,
/// which `ssh` would read as an option.
fn valid_principal(p: &str) -> bool {
    (1..=32).contains(&p.len())
        && !p.starts_with('-')
        && p.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

fn valid_host(h: &str) -> bool {
    (1..=253).contains(&h.len())
        && !h.starts_with('-')
        && h.bytes().all(|c| c.is_ascii_alphanumeric() || b".-:".contains(&c))
}

/// Listing text reaches terminals through the CLI, so it must not carry escape sequences.
fn printable(text: &str) -> bool {
    text.chars().all(|c| !c.is_control())
}

fn valid_source_address(a: &str) -> bool {
    (1..=64).contains(&a.len()) && a.bytes().all(|c| c.is_ascii_hexdigit() || b".:/,".contains(&c))
}

fn valid_address(a: &str) -> bool {
    a.len() == 42
        && a.starts_with("0x")
        && a[2..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn parse_address(a: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    hex::decode_to_slice(&a[2..], &mut out).unwrap_or_else(|_| refuse("E_BAD_ADDRESS"));
    out
}

fn validate_terms(t: &Terms) {
    require!(t.title.len() <= 80 && !t.title.is_empty() && printable(&t.title), "E_BAD_TITLE");
    require!(t.blurb.len() <= 280 && printable(&t.blurb), "E_BAD_BLURB");
    require!(valid_host(&t.host), "E_BAD_HOST");
    require!(t.port > 0, "E_BAD_PORT");
    require!(valid_principal(&t.principal), "E_BAD_PRINCIPAL");
    require!(t.principal != "root", "E_ROOT_NOT_ALLOWED");
    require!(t.command.as_ref().map_or(true, |c| !c.is_empty() && c.len() <= 300), "E_BAD_COMMAND");
    let longest = ssh::session_command(u64::MAX, t.command.as_deref(), t.evict_user);
    require!(longest.len() <= MAX_SESSION_COMMAND_BYTES, "E_BAD_COMMAND");
    require!((30..=86_400).contains(&t.tick_secs), "E_BAD_TICK");
    require!((1..=1_000).contains(&t.max_ticks), "E_BAD_MAX_TICKS");
    require!(t.foreign.len() <= 8, "E_TOO_MANY_RENTS");
    for rent in &t.foreign {
        require!(valid_address(&rent.token) && valid_address(&rent.pay_to), "E_BAD_ADDRESS");
        require!(rent.amount_per_tick.0 > 0, "E_FREE_FOREIGN_RENT");
    }
    if t.needs_approval {
        require!(t.foreign.is_empty(), "E_APPROVAL_NEEDS_NEAR_RENT");
    }
    if let Some(list) = &t.allowlist {
        require!(list.len() <= 64, "E_ALLOWLIST_TOO_LONG");
        require!(t.foreign.is_empty(), "E_ALLOWLIST_NEEDS_NEAR_RENT");
    }
}

/// `ed25519:<base58>` as the MPC contract returns it.
fn parse_near_ed25519(text: &str) -> Option<[u8; 32]> {
    let key: PublicKey = text.parse().ok()?;
    let bytes = key.as_bytes();
    (bytes.len() == 33 && bytes[0] == 0).then(|| {
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes[1..]);
        out
    })
}

/// The result of the single promise a callback waits on. Callbacks must never panic, so all
/// failure is reported as `None` and handled by the refund path.
fn promise_value() -> Option<Vec<u8>> {
    env::promise_result_checked(0, MAX_PROMISE_RESULT_BYTES).ok()
}

fn ca_path(owner: &AccountId, unit_id: &str) -> String {
    format!("unit/{owner}/{unit_id}")
}

/// Exclusive occupancy is per unit, and the eviction timer is per Unix user, so two units on one
/// user would share a tenant's files and each other's timers. Scoped to the owner, because a global
/// check would let anyone block a stranger's real address by listing it first.
fn seat_key(owner: &AccountId, terms: &Terms) -> [u8; 32] {
    env::sha256_array(format!("{owner}|{}|{}|{}", terms.host, terms.port, terms.principal).into_bytes())
}

fn spent_key(chain: EvmChain, tx: &str, log_index: u64) -> [u8; 32] {
    env::sha256_array(format!("{}:{tx}:{log_index}", chain.name()).into_bytes())
}

#[near]
impl Sublet {
    #[init]
    pub fn new(mpc: AccountId, sign_domain: u32, foreign_domain: u32) -> Self {
        Self {
            mpc,
            sign_domain,
            foreign_domain,
            units: IterableMap::new(StorageKey::Units),
            leases: LookupMap::new(StorageKey::Leases),
            next_lease: 1,
            spent: LookupSet::new(StorageKey::Spent),
            seats: LookupSet::new(StorageKey::Seats),
        }
    }

    // ---- Owners ----------------------------------------------------------------------------

    /// List a machine. Each unit gets its own CA key, derived from the owner and the unit id, so a
    /// certificate for one machine opens no other, and a reused id cannot inherit an old server.
    #[payable]
    pub fn list_unit(&mut self, id: String, terms: Terms) -> Promise {
        require!(valid_unit_id(&id), "E_BAD_UNIT_ID");
        require!(!self.units.contains_key(&id), "E_UNIT_EXISTS");
        require!(env::attached_deposit() >= UNIT_STORAGE_FEE, "E_NEEDS_STORAGE_FEE");
        validate_terms(&terms);

        let owner = env::predecessor_account_id();
        require!(self.seats.insert(seat_key(&owner, &terms)), "E_USER_ALREADY_LISTED");
        let path = ca_path(&owner, &id);
        self.units.insert(
            id.clone(),
            Unit {
                owner,
                terms,
                ca: None,
                paused: false,
                leases: 0,
                renewals: 0,
                ticks_sold: 0,
                tenant: None,
                tenant_until: 0,
                in_flight: None,
                in_flight_at: 0,
            },
        );

        let args = json!({
            "path": path,
            "predecessor": env::current_account_id(),
            "domain_id": self.sign_domain,
        });
        Promise::new(self.mpc.clone())
            .function_call("derived_public_key".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(0), GAS_DERIVE)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CA).on_ca_key(id, env::attached_deposit()))
    }

    #[private]
    pub fn on_ca_key(&mut self, id: String, deposit: NearToken) -> Option<String> {
        let key = promise_value()
            .and_then(|raw| serde_json::from_slice::<String>(&raw).ok())
            .and_then(|text| parse_near_ed25519(&text));
        let Some(unit) = self.units.get_mut(&id) else { return None };
        match key {
            Some(ca) => {
                unit.ca = Some(ca);
                let owner = unit.owner.clone();
                let line = ssh::public_key_line(&ca, &format!("sublet:{id}"));
                if let Some(change) = deposit.checked_sub(UNIT_STORAGE_FEE).filter(|c| !c.is_zero()) {
                    let _ = Promise::new(owner.clone()).transfer(change);
                }
                event("unit_listed", json!({"unit": id, "owner": owner, "ca": line}));
                Some(line)
            }
            None => {
                let owner = unit.owner.clone();
                let seat = seat_key(&owner, &unit.terms);
                self.units.remove(&id);
                self.seats.remove(&seat);
                let _ = Promise::new(owner).transfer(deposit);
                None
            }
        }
    }

    pub fn update_terms(&mut self, id: String, terms: Terms) {
        validate_terms(&terms);
        let unit = self.unit_of_caller(&id);
        let owner = unit.owner.clone();
        let old_seat = seat_key(&owner, &unit.terms);
        let new_seat = seat_key(&owner, &terms);
        unit.terms = terms;
        if old_seat != new_seat {
            self.seats.remove(&old_seat);
            require!(self.seats.insert(new_seat), "E_USER_ALREADY_LISTED");
        }
        event("unit_updated", json!({"unit": id}));
    }

    /// Stops new keys. Keys already cut die at their expiry.
    pub fn set_paused(&mut self, id: String, paused: bool) {
        let unit = self.unit_of_caller(&id);
        unit.paused = paused;
        event("unit_paused", json!({"unit": id, "paused": paused}));
    }

    pub fn delist_unit(&mut self, id: String) {
        let (owner, seat) = {
            let unit = self.unit_of_caller(&id);
            require!(unit.ca.is_some(), "E_CA_NOT_READY");
            require!(!is_busy(unit), "E_BUSY");
            (unit.owner.clone(), seat_key(&unit.owner, &unit.terms))
        };
        self.units.remove(&id);
        self.seats.remove(&seat);
        let _ = Promise::new(owner).transfer(UNIT_STORAGE_FEE);
        event("unit_delisted", json!({"unit": id}));
    }

    /// Owner approves a pending request. The clock starts now, not when the tenant asked.
    pub fn approve(&mut self, lease_id: U64) -> Promise {
        let lease = self.lease_or_refuse(lease_id.0);
        require!(lease.status == LeaseStatus::AwaitingApproval, "E_NOT_AWAITING_APPROVAL");
        let caller = env::predecessor_account_id();
        let unit = self.units.get_mut(&lease.unit).unwrap_or_else(|| refuse("E_NO_UNIT"));
        require!(unit.owner == caller, "E_NOT_OWNER");
        require!(!unit.paused, "E_PAUSED");
        require!(!is_busy(unit), "E_BUSY");
        assert_vacant(unit, &lease.tenant);
        unit.in_flight = Some(lease_id.0);
        unit.in_flight_at = now_secs();
        self.cut_key(lease_id.0)
    }

    pub fn reject(&mut self, lease_id: U64) {
        let lease = self.lease_or_refuse(lease_id.0);
        require!(lease.status == LeaseStatus::AwaitingApproval, "E_NOT_AWAITING_APPROVAL");
        let unit = self.units.get(&lease.unit).unwrap_or_else(|| refuse("E_NO_UNIT"));
        require!(unit.owner == env::predecessor_account_id(), "E_NOT_OWNER");
        self.close_refunded(lease_id.0, LeaseStatus::Rejected);
    }

    // ---- Tenants ---------------------------------------------------------------------------

    /// Tenant withdraws a request the owner has not answered, so money is never stuck.
    pub fn cancel(&mut self, lease_id: U64) {
        let lease = self.lease_or_refuse(lease_id.0);
        require!(lease.status == LeaseStatus::AwaitingApproval, "E_NOT_AWAITING_APPROVAL");
        require!(lease.tenant == env::predecessor_account_id().as_str(), "E_NOT_TENANT");
        self.close_refunded(lease_id.0, LeaseStatus::Cancelled);
    }

    /// Rent with NEAR. The rent reaches the owner only after a valid key exists.
    ///
    /// `ssh_key` is optional: without it, the Ed25519 key that signed this NEAR transaction is the
    /// key that logs in.
    #[payable]
    pub fn rent(
        &mut self,
        unit_id: String,
        ticks: u32,
        ssh_key: Option<String>,
        source_address: Option<String>,
    ) -> PromiseOrValue<Lease> {
        let tenant = env::predecessor_account_id();
        let unit = self.rentable_unit(&unit_id);
        require!(ticks >= 1 && ticks <= unit.terms.max_ticks, "E_BAD_TICKS");
        // A price of zero means free only on a unit that takes no other rent. On a unit priced on
        // another chain, it means NEAR is not accepted.
        require!(unit.terms.near_per_tick.0 > 0 || unit.terms.foreign.is_empty(), "E_PAY_ON_ANOTHER_CHAIN");
        if let Some(list) = &unit.terms.allowlist {
            require!(list.contains(&tenant), "E_NOT_ALLOWED");
        }
        if !unit.terms.needs_approval {
            assert_vacant(&unit, tenant.as_str());
        }
        let rent = unit
            .terms
            .near_per_tick
            .0
            .checked_mul(u128::from(ticks))
            .unwrap_or_else(|| refuse("E_OVERFLOW"));
        let deposit = env::attached_deposit().as_yoctonear();
        let needed = rent.checked_add(LEASE_STORAGE_FEE.as_yoctonear()).unwrap_or_else(|| refuse("E_OVERFLOW"));
        require!(deposit >= needed, "E_UNDERPAID");

        let subject = match &ssh_key {
            Some(line) => ssh::parse_public_key(line).unwrap_or_else(|| refuse("E_BAD_SSH_KEY")),
            None => signer_key(),
        };
        if let Some(addr) = &source_address {
            require!(valid_source_address(addr), "E_BAD_SOURCE_ADDRESS");
        }
        let needs_approval = unit.terms.needs_approval;

        let id = self.open_lease(
            unit_id,
            tenant.to_string(),
            subject,
            ticks,
            source_address,
            if needs_approval { LeaseStatus::AwaitingApproval } else { LeaseStatus::Cutting },
            Paid::Near { payer: tenant, rent: U128(rent), change: U128(deposit - needed) },
        );

        if needs_approval {
            let lease = self.leases.get(&id).cloned().unwrap_or_else(|| refuse("E_NO_LEASE"));
            event("lease_requested", json!({"lease": id.to_string(), "unit": lease.unit, "tenant": lease.tenant}));
            PromiseOrValue::Value(lease)
        } else {
            PromiseOrValue::Promise(self.cut_key(id))
        }
    }

    /// Rent with a token payment already made on another chain, straight to the owner.
    ///
    /// Anyone may submit this, so a tenant needs no NEAR account of their own. `payer_signature` is
    /// an EIP-191 signature by the address that paid, over `claim_message`. Without it, a watcher
    /// could claim the payment for their own SSH key.
    #[payable]
    pub fn rent_foreign(
        &mut self,
        unit_id: String,
        chain: EvmChain,
        log: EvmLog,
        ssh_key: String,
        payer_signature: String,
        source_address: Option<String>,
    ) -> Promise {
        require!(env::attached_deposit() >= LEASE_STORAGE_FEE, "E_NEEDS_STORAGE_FEE");
        let unit = self.rentable_unit(&unit_id);
        let rent = unit
            .terms
            .foreign
            .iter()
            .find(|r| r.chain == chain)
            .cloned()
            .unwrap_or_else(|| refuse("E_CHAIN_NOT_ACCEPTED"));
        let max_ticks = unit.terms.max_ticks;

        let transfer = evm::decode_transfer(&log, &parse_address(&rent.token), &parse_address(&rent.pay_to))
            .unwrap_or_else(|r| refuse(r.code()));
        let ticks = transfer.amount / rent.amount_per_tick.0;
        require!(ticks >= 1, "E_UNDERPAID");
        let ticks = u32::try_from(ticks.min(u128::from(max_ticks))).unwrap_or(max_ticks);

        let subject = ssh::parse_public_key(&ssh_key).unwrap_or_else(|| refuse("E_BAD_SSH_KEY"));
        if let Some(addr) = &source_address {
            require!(valid_source_address(addr), "E_BAD_SOURCE_ADDRESS");
        }

        let message = evm::claim_message(
            env::current_account_id().as_str(),
            &unit_id,
            &subject,
            chain,
            &log.transaction_hash,
            log.log_index,
        );
        let signature = hex::decode(payer_signature.trim_start_matches("0x"))
            .unwrap_or_else(|_| refuse("E_BAD_SIGNATURE"));
        let signer = evm::recover_signer(&message, &signature).unwrap_or_else(|r| refuse(r.code()));
        if !cfg!(feature = "dev-any-payer") {
            require!(signer == transfer.from, evm::Refusal::WrongPayer.code());
        }

        let tenant = format!("0x{}", hex::encode(transfer.from));
        assert_vacant(&unit, &tenant);
        require!(!self.spent.contains(&spent_key(chain, &log.transaction_hash, log.log_index)), "E_PAYMENT_ALREADY_USED");

        // Nothing is held yet. The unit stays free and the payment stays unspent until the network
        // confirms it, so a forged claim blocks nobody. A failed claim is removed, not stored.

        let expected = evm::payload_hash(chain, rent.finality, &log).unwrap_or_else(|r| refuse(r.code()));
        let payer = env::predecessor_account_id();
        let id = self.open_lease(
            unit_id,
            tenant,
            subject,
            ticks,
            source_address,
            LeaseStatus::Verifying,
            Paid::Foreign {
                payer,
                chain,
                token: rent.token.clone(),
                amount: U128(transfer.amount),
                tx: log.transaction_hash.clone(),
                log_index: log.log_index,
                spent: false,
            },
        );

        let args = json!({
            "request": {
                "request": {
                    chain.name(): {
                        "tx_id": log.transaction_hash.trim_start_matches("0x"),
                        "extractors": [{"Log": {"log_index": log.log_index}}],
                        "finality": rent.finality.name(),
                    }
                },
                "domain_id": self.foreign_domain,
                "payload_version": 1,
                "expected_payload_hash": hex::encode(expected),
            }
        });
        Promise::new(self.mpc.clone())
            .function_call(
                "verify_foreign_transaction".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(1),
                GAS_VERIFY,
            )
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_VERIFIED).on_verified(id, hex::encode(expected)))
    }

    #[private]
    pub fn on_verified(&mut self, id: u64, expected: String) -> PromiseOrValue<Option<Lease>> {
        #[near(serializers = [json])]
        struct Attestation {
            payload_hash: String,
        }
        let attested = promise_value()
            .and_then(|raw| serde_json::from_slice::<Attestation>(&raw).ok())
            .is_some_and(|a| a.payload_hash == expected);
        let Some(lease) = self.leases.get(&id).cloned() else { return PromiseOrValue::Value(None) };
        let ready = self.units.get(&lease.unit).is_some_and(|unit| {
            unit.ca.is_some() && !unit.paused && !is_busy(unit) && !held_by_another(unit, &lease.tenant)
        });
        let payment = match &lease.paid {
            Paid::Foreign { chain, tx, log_index, .. } => Some(spent_key(*chain, tx, *log_index)),
            Paid::Near { .. } => None,
        };
        // Marked here, once the network has confirmed it, and not a moment before.
        let confirmed = attested && ready && payment.is_some_and(|key| self.spent.insert(key));
        if !confirmed {
            return PromiseOrValue::Value(self.close_refunded(id, LeaseStatus::Failed));
        }
        if let Some(Lease { paid: Paid::Foreign { spent, .. }, .. }) = self.leases.get_mut(&id) {
            *spent = true;
        }
        if let Some(unit) = self.units.get_mut(&lease.unit) {
            unit.in_flight = Some(id);
            unit.in_flight_at = now_secs();
        }
        event("payment_verified", json!({"lease": id.to_string()}));
        PromiseOrValue::Promise(self.cut_key(id))
    }

    #[private]
    pub fn on_signed(&mut self, id: u64, tbs: String) -> Option<Lease> {
        #[near(serializers = [json])]
        struct Signed {
            signature: Vec<u8>,
        }
        let Some(lease) = self.leases.get(&id).cloned() else { return None };
        let Some(unit) = self.units.get(&lease.unit).cloned() else {
            return self.close_refunded(id, LeaseStatus::Failed);
        };
        let tbs_bytes = hex::decode(&tbs).unwrap_or_default();
        let signature: Option<[u8; 64]> = promise_value()
            .and_then(|raw| serde_json::from_slice::<Signed>(&raw).ok())
            .and_then(|s| s.signature.try_into().ok());

        let verified = match (signature, unit.ca) {
            (Some(sig), Some(ca)) if env::ed25519_verify(&sig, &tbs_bytes, &ca) => Some(sig),
            _ => None,
        };
        let Some(sig) = verified else {
            return self.close_refunded(id, LeaseStatus::Failed);
        };

        let cert = ssh::assemble(&tbs_bytes, &sig);
        let line = ssh::cert_line(&cert, &format!("sublet-lease-{id}"));
        let issued = self.leases.get_mut(&id).map(|lease| {
            lease.certificate = Some(line);
            lease.status = LeaseStatus::Issued;
            lease.clone()
        });
        let issued = issued?;

        if let Some(unit) = self.units.get_mut(&issued.unit) {
            let renewal = unit.tenant.as_deref() == Some(issued.tenant.as_str())
                && issued.valid_after.0 <= unit.tenant_until + u64::from(unit.terms.tick_secs);
            unit.leases += 1;
            unit.renewals += u64::from(renewal);
            unit.ticks_sold += u64::from(issued.ticks);
            unit.tenant = Some(issued.tenant.clone());
            unit.tenant_until = issued.valid_before.0;
            unit.in_flight = None;
        }

        if let Paid::Near { payer, rent, change } = &issued.paid {
            if rent.0 > 0 {
                let _ = Promise::new(unit.owner.clone()).transfer(NearToken::from_yoctonear(rent.0));
            }
            if change.0 > 0 {
                let _ = Promise::new(payer.clone()).transfer(NearToken::from_yoctonear(change.0));
            }
        }

        event(
            "lease_issued",
            json!({
                "lease": id.to_string(),
                "unit": issued.unit,
                "tenant": issued.tenant,
                "ticks": issued.ticks,
                "valid_before": issued.valid_before,
            }),
        );
        Some(issued)
    }

    // ---- Views -----------------------------------------------------------------------------

    pub fn about(&self) -> About {
        About {
            name: "sublet".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            build: if cfg!(feature = "dev-any-payer") { "dev-any-payer" } else { "release" }.to_string(),
            lease_fee: U128(LEASE_STORAGE_FEE.as_yoctonear()),
            unit_fee: U128(UNIT_STORAGE_FEE.as_yoctonear()),
            mpc: self.mpc.clone(),
            sign_domain: self.sign_domain,
            foreign_domain: self.foreign_domain,
            units: self.units.len(),
            leases: U64(self.next_lease - 1),
        }
    }

    pub fn get_unit(&self, id: String) -> Option<UnitView> {
        self.units.get(&id).map(|unit| view_unit(&id, unit))
    }

    pub fn list_units(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<UnitView> {
        self.units
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(id, unit)| view_unit(id, unit))
            .collect()
    }

    pub fn get_lease(&self, id: U64) -> Option<Lease> {
        self.leases.get(&id.0).cloned()
    }

    /// Newest first.
    pub fn recent_leases(&self, limit: Option<u32>) -> Vec<Lease> {
        let take = u64::from(limit.unwrap_or(20).min(50));
        (self.next_lease.saturating_sub(take).max(1)..self.next_lease)
            .rev()
            .filter_map(|id| self.leases.get(&id).cloned())
            .collect()
    }

    /// The exact text a payer signs. Clients call this rather than rebuild it.
    pub fn claim_message(&self, unit_id: String, ssh_key: String, chain: EvmChain, tx: String, log_index: u64) -> String {
        let subject = ssh::parse_public_key(&ssh_key).unwrap_or_else(|| refuse("E_BAD_SSH_KEY"));
        evm::claim_message(env::current_account_id().as_str(), &unit_id, &subject, chain, &tx, log_index)
    }

    /// The hash the MPC network must sign for a given log. Exposed so anyone can audit a claim.
    pub fn payment_hash(&self, chain: EvmChain, finality: Finality, log: EvmLog) -> String {
        hex::encode(evm::payload_hash(chain, finality, &log).unwrap_or_else(|r| refuse(r.code())))
    }

    pub fn is_payment_spent(&self, chain: EvmChain, tx: String, log_index: u64) -> bool {
        self.spent.contains(&spent_key(chain, &tx, log_index))
    }
}

/// Tenants share one Unix user, so they could read or kill each other's work. A tenant renewing
/// their own lease is welcome. Anyone else waits until it ends.
fn held_by_another(unit: &Unit, tenant: &str) -> bool {
    now_secs() < unit.tenant_until && unit.tenant.as_deref() != Some(tenant)
}

fn assert_vacant(unit: &Unit, tenant: &str) {
    require!(!held_by_another(unit, tenant), "E_OCCUPIED");
}

fn is_busy(unit: &Unit) -> bool {
    unit.in_flight.is_some() && now_secs() < unit.in_flight_at + IN_FLIGHT_TIMEOUT_SECS
}

/// The Ed25519 key that signed the current transaction.
fn signer_key() -> [u8; 32] {
    let key = env::signer_account_pk();
    let bytes = key.as_bytes();
    if bytes.len() != 33 || bytes[0] != 0 {
        refuse("E_SIGNER_KEY_NOT_ED25519");
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[1..]);
    out
}

fn view_unit(id: &str, unit: &Unit) -> UnitView {
    UnitView {
        id: id.to_string(),
        owner: unit.owner.clone(),
        terms: unit.terms.clone(),
        ca_public_key: unit.ca.as_ref().map(|ca| ssh::public_key_line(ca, &format!("sublet:{id}"))),
        paused: unit.paused,
        leases: U64(unit.leases),
        renewals: U64(unit.renewals),
        ticks_sold: U64(unit.ticks_sold),
        occupied_by: unit.tenant.clone(),
        occupied_until: U64(unit.tenant_until),
    }
}

impl Sublet {
    fn unit_of_caller(&mut self, id: &str) -> &mut Unit {
        let caller = env::predecessor_account_id();
        let unit = self.units.get_mut(id).unwrap_or_else(|| refuse("E_NO_UNIT"));
        require!(unit.owner == caller, "E_NOT_OWNER");
        unit
    }

    fn rentable_unit(&self, id: &str) -> Unit {
        let unit = self.units.get(id).cloned().unwrap_or_else(|| refuse("E_NO_UNIT"));
        require!(unit.ca.is_some(), "E_CA_NOT_READY");
        require!(!unit.paused, "E_PAUSED");
        require!(!is_busy(&unit), "E_BUSY");
        unit
    }

    fn lease_or_refuse(&self, id: u64) -> Lease {
        self.leases.get(&id).cloned().unwrap_or_else(|| refuse("E_NO_LEASE"))
    }

    #[allow(clippy::too_many_arguments)]
    fn open_lease(
        &mut self,
        unit: String,
        tenant: String,
        subject: [u8; 32],
        ticks: u32,
        source_address: Option<String>,
        status: LeaseStatus,
        paid: Paid,
    ) -> u64 {
        let id = self.next_lease;
        self.next_lease += 1;
        if status == LeaseStatus::Cutting {
            if let Some(unit) = self.units.get_mut(&unit) {
                unit.in_flight = Some(id);
                unit.in_flight_at = now_secs();
            }
        }
        self.leases.insert(
            id,
            Lease {
                id: U64(id),
                unit,
                tenant,
                subject: hex::encode(subject),
                ticks,
                source_address,
                status,
                paid,
                valid_after: U64(0),
                valid_before: U64(0),
                certificate: None,
            },
        );
        id
    }

    /// Builds the certificate from the owner's terms, then has the MPC network sign those bytes.
    /// No caller can influence the certificate beyond choosing their own public key.
    fn cut_key(&mut self, id: u64) -> Promise {
        let lease = self.lease_or_refuse(id);
        let unit = self.units.get(&lease.unit).cloned().unwrap_or_else(|| refuse("E_NO_UNIT"));
        let ca = unit.ca.unwrap_or_else(|| refuse("E_CA_NOT_READY"));
        let mut subject = [0u8; 32];
        hex::decode_to_slice(&lease.subject, &mut subject).unwrap_or_else(|_| refuse("E_BAD_SSH_KEY"));

        // A renewal continues from the current end, so a tenant never loses paid time.
        let now = now_secs();
        let renewing = now < unit.tenant_until && unit.tenant.as_deref() == Some(lease.tenant.as_str());
        let start = if renewing { unit.tenant_until } else { now };
        let valid_after = now.saturating_sub(CLOCK_SKEW_SECS);
        let valid_before = start + u64::from(lease.ticks) * u64::from(unit.terms.tick_secs);

        let mut seed = env::random_seed();
        seed.extend_from_slice(&id.to_le_bytes());
        let nonce = env::sha256_array(seed);

        let command = ssh::session_command(valid_before, unit.terms.command.as_deref(), unit.terms.evict_user);
        let key_id = format!("sublet:{}:{id}:{}", lease.unit, lease.tenant);
        let tbs = ssh::to_be_signed(&ssh::CertSpec {
            nonce: &nonce,
            subject: &subject,
            ca: &ca,
            serial: id,
            key_id: &key_id,
            principal: &unit.terms.principal,
            valid_after,
            valid_before,
            force_command: Some(&command),
            source_address: lease.source_address.as_deref(),
            permit_pty: unit.terms.permit_pty,
            permit_port_forwarding: unit.terms.permit_port_forwarding,
        });
        require!(tbs.len() <= MAX_SIGNED_BYTES, "E_CERTIFICATE_TOO_LARGE");

        if let Some(open) = self.leases.get_mut(&id) {
            open.status = LeaseStatus::Cutting;
            open.valid_after = U64(valid_after);
            open.valid_before = U64(valid_before);
        }

        let args = json!({
            "request": {
                "path": ca_path(&unit.owner, &lease.unit),
                "payload_v2": {"Eddsa": hex::encode(&tbs)},
                "domain_id": self.sign_domain,
            }
        });
        Promise::new(self.mpc.clone())
            .function_call("sign".to_string(), args.to_string().into_bytes(), NearToken::from_yoctonear(1), GAS_SIGN)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SIGNED).on_signed(id, hex::encode(&tbs)))
    }

    /// Ends a lease that produced no key and returns what was held. The record is removed, because
    /// its storage fee goes back too: a failed claim must not leave state that nobody paid for. A
    /// payment this lease marked as used is freed, so it can be claimed again.
    fn close_refunded(&mut self, id: u64, status: LeaseStatus) -> Option<Lease> {
        let mut lease = self.leases.remove(&id)?;
        lease.status = status;
        let paid = lease.paid.clone();
        if let Some(unit) = self.units.get_mut(&lease.unit) {
            if unit.in_flight == Some(id) {
                unit.in_flight = None;
            }
        }
        let refund = |to: AccountId, yocto: u128| {
            if yocto > 0 {
                let _ = Promise::new(to).transfer(NearToken::from_yoctonear(yocto));
            }
        };
        match paid {
            Paid::Near { payer, rent, change } => {
                let held = rent.0 + change.0 + LEASE_STORAGE_FEE.as_yoctonear();
                refund(payer, held);
            }
            Paid::Foreign { payer, chain, tx, log_index, spent, .. } => {
                if spent {
                    self.spent.remove(&spent_key(chain, &tx, log_index));
                }
                refund(payer, LEASE_STORAGE_FEE.as_yoctonear());
            }
        }
        event("lease_closed", json!({"lease": id.to_string(), "status": status}));
        Some(lease)
    }
}

#[cfg(test)]
mod tests;
