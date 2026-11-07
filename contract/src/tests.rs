//! Contract tests. Cross-contract replies are fed in as promise results, using the same JSON the
//! live MPC network returns. Each refusal is asserted by its stable code.

use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, test_vm_config, PromiseResult, RuntimeFeesConfig};

const CA: [u8; 32] = [7u8; 32];
const SSH_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH tenant";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &str, deposit: NearToken) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("sublet.testnet"))
        .signer_account_id(account(predecessor))
        .predecessor_account_id(account(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(1_800_000_000 * 1_000_000_000);
    builder
}

fn act_as(predecessor: &str, deposit: NearToken) {
    testing_env!(context(predecessor, deposit).build());
}

fn callback(result: PromiseResult) {
    let builder = context("sublet.testnet", NearToken::from_yoctonear(0));
    testing_env!(
        builder.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn terms() -> Terms {
    Terms {
        title: "Sunny 8-core".into(),
        blurb: "No daemon required.".into(),
        host: "203.0.113.7".into(),
        port: 22,
        principal: "tenant".into(),
        command: None,
        permit_pty: true,
        permit_port_forwarding: false,
        tick_secs: 300,
        max_ticks: 12,
        near_per_tick: U128(NearToken::from_millinear(100).as_yoctonear()),
        foreign: vec![],
        allowlist: None,
        needs_approval: false,
    }
}

fn base_rent() -> ForeignRent {
    ForeignRent {
        chain: EvmChain::Base,
        token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e".into(),
        pay_to: "0x8d642988e3e7b6db15b6058461d5563835b04bf6".into(),
        amount_per_tick: U128(100_000),
        finality: Finality::Latest,
    }
}

fn contract() -> Sublet {
    act_as("deployer.testnet", NearToken::from_yoctonear(0));
    Sublet::new(account("v1.signer-prod.testnet"), 1, 3)
}

fn listed(terms: Terms) -> Sublet {
    let mut c = contract();
    act_as("owner.testnet", UNIT_STORAGE_FEE);
    let _ = c.list_unit("box-1".into(), terms);
    let line = serde_json::to_vec(&format!("ed25519:{}", near_sdk::bs58::encode(CA).into_string())).unwrap();
    callback(PromiseResult::Successful(line));
    c.on_ca_key("box-1".into(), UNIT_STORAGE_FEE);
    c
}

fn deposit(rent_millinear: u128) -> NearToken {
    NearToken::from_yoctonear(rent_millinear * 10u128.pow(21) + LEASE_STORAGE_FEE.as_yoctonear())
}

#[test]
#[should_panic(expected = "E_BAD_UNIT_ID")]
fn unit_ids_are_restricted() {
    let mut c = contract();
    act_as("owner.testnet", UNIT_STORAGE_FEE);
    let _ = c.list_unit("Bad Id!".into(), terms());
}

#[test]
#[should_panic(expected = "E_NEEDS_STORAGE_FEE")]
fn listing_needs_a_storage_fee() {
    let mut c = contract();
    act_as("owner.testnet", NearToken::from_yoctonear(0));
    let _ = c.list_unit("box-1".into(), terms());
}

#[test]
#[should_panic(expected = "E_UNIT_EXISTS")]
fn a_second_owner_cannot_take_a_listed_id() {
    let mut c = listed(terms());
    act_as("mallory.testnet", UNIT_STORAGE_FEE);
    let _ = c.list_unit("box-1".into(), terms());
}

#[test]
fn ca_paths_differ_by_owner_so_a_reused_id_cannot_inherit_a_server() {
    assert_ne!(ca_path(&account("a.testnet"), "box"), ca_path(&account("b.testnet"), "box"));
}

#[test]
fn listing_stores_a_usable_trust_line() {
    let c = listed(terms());
    let view = c.get_unit("box-1".into()).unwrap();
    let line = view.ca_public_key.unwrap();
    assert!(line.starts_with("ssh-ed25519 "));
    assert_eq!(ssh::parse_public_key(&line), Some(CA));
}

#[test]
fn a_failed_key_derivation_removes_the_unit() {
    let mut c = contract();
    act_as("owner.testnet", UNIT_STORAGE_FEE);
    let _ = c.list_unit("box-1".into(), terms());
    callback(PromiseResult::Failed);
    assert_eq!(c.on_ca_key("box-1".into(), UNIT_STORAGE_FEE), None);
    assert!(c.get_unit("box-1".into()).is_none());
}

#[test]
#[should_panic(expected = "E_CA_NOT_READY")]
fn a_unit_cannot_be_rented_before_its_key_exists() {
    let mut c = contract();
    act_as("owner.testnet", UNIT_STORAGE_FEE);
    let _ = c.list_unit("box-1".into(), terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
}

#[test]
#[should_panic(expected = "E_NOT_OWNER")]
fn only_the_owner_can_change_terms() {
    let mut c = listed(terms());
    act_as("mallory.testnet", NearToken::from_yoctonear(0));
    c.update_terms("box-1".into(), terms());
}

#[test]
#[should_panic(expected = "E_NOT_OWNER")]
fn only_the_owner_can_pause() {
    let mut c = listed(terms());
    act_as("mallory.testnet", NearToken::from_yoctonear(0));
    c.set_paused("box-1".into(), true);
}

#[test]
#[should_panic(expected = "E_PAUSED")]
fn a_paused_unit_refuses_tenants() {
    let mut c = listed(terms());
    act_as("owner.testnet", NearToken::from_yoctonear(0));
    c.set_paused("box-1".into(), true);
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
}

#[test]
#[should_panic(expected = "E_UNDERPAID")]
fn short_rent_is_refused() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(99));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
}

#[test]
#[should_panic(expected = "E_BAD_TICKS")]
fn too_many_ticks_are_refused() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100_000));
    let _ = c.rent("box-1".into(), 13, Some(SSH_KEY.into()), None);
}

#[test]
#[should_panic(expected = "E_NOT_ALLOWED")]
fn the_allowlist_is_enforced() {
    let mut t = terms();
    t.allowlist = Some(vec![account("friend.testnet")]);
    let mut c = listed(t);
    act_as("stranger.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
}

#[test]
#[should_panic(expected = "E_BAD_SSH_KEY")]
fn a_malformed_ssh_key_is_refused() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some("ssh-rsa AAAA".into()), None);
}

#[test]
#[should_panic(expected = "E_BAD_SOURCE_ADDRESS")]
fn a_shell_metacharacter_in_source_address_is_refused() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), Some("1.2.3.4;reboot".into()));
}

#[test]
fn renting_opens_a_lease_held_until_the_key_exists() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(200));
    let _ = c.rent("box-1".into(), 2, Some(SSH_KEY.into()), None);
    let lease = c.get_lease(U64(1)).unwrap();
    assert_eq!(lease.status, LeaseStatus::Cutting);
    assert_eq!(lease.valid_before.0 - 1_800_000_000, 600);
    assert_eq!(lease.tenant, "tenant.testnet");
}

#[test]
fn the_signer_key_is_used_when_no_ssh_key_is_given() {
    let mut c = listed(terms());
    let mut builder = context("tenant.testnet", deposit(100));
    let pk: PublicKey = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap();
    builder.signer_account_pk(pk.clone());
    testing_env!(builder.build());
    let _ = c.rent("box-1".into(), 1, None, None);
    let lease = c.get_lease(U64(1)).unwrap();
    assert_eq!(lease.subject, hex::encode(&pk.as_bytes()[1..]));
}

#[test]
fn a_failed_signature_refunds_and_issues_nothing() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    callback(PromiseResult::Failed);
    let lease = c.on_signed(1, "00".into()).unwrap();
    assert_eq!(lease.status, LeaseStatus::Failed);
    assert!(lease.certificate.is_none());
    assert_eq!(c.get_unit("box-1".into()).unwrap().leases.0, 0);
}

#[test]
fn a_signature_that_does_not_verify_is_never_turned_into_a_certificate() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    let forged = serde_json::to_vec(&json!({"scheme": "Ed25519", "signature": vec![0u8; 64]})).unwrap();
    callback(PromiseResult::Successful(forged));
    let lease = c.on_signed(1, "abcd".into()).unwrap();
    assert_eq!(lease.status, LeaseStatus::Failed);
    assert!(lease.certificate.is_none());
}

#[test]
fn malformed_mpc_output_cannot_panic_the_callback() {
    let mut c = listed(terms());
    act_as("tenant.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    callback(PromiseResult::Successful(b"not json".to_vec()));
    let lease = c.on_signed(1, "zz-not-hex".into()).unwrap();
    assert_eq!(lease.status, LeaseStatus::Failed);
}

fn approval_terms() -> Terms {
    let mut t = terms();
    t.needs_approval = true;
    t
}

#[test]
fn an_approval_unit_waits_for_the_owner() {
    let mut c = listed(approval_terms());
    act_as("agent.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    assert_eq!(c.get_lease(U64(1)).unwrap().status, LeaseStatus::AwaitingApproval);
    act_as("owner.testnet", NearToken::from_yoctonear(0));
    let _ = c.approve(U64(1));
    assert_eq!(c.get_lease(U64(1)).unwrap().status, LeaseStatus::Cutting);
}

#[test]
#[should_panic(expected = "E_NOT_OWNER")]
fn a_tenant_cannot_approve_their_own_request() {
    let mut c = listed(approval_terms());
    act_as("agent.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    let _ = c.approve(U64(1));
}

#[test]
fn the_owner_can_reject_and_the_tenant_is_refunded() {
    let mut c = listed(approval_terms());
    act_as("agent.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    act_as("owner.testnet", NearToken::from_yoctonear(0));
    c.reject(U64(1));
    assert_eq!(c.get_lease(U64(1)).unwrap().status, LeaseStatus::Rejected);
}

#[test]
fn a_tenant_can_withdraw_an_unanswered_request() {
    let mut c = listed(approval_terms());
    act_as("agent.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    c.cancel(U64(1));
    assert_eq!(c.get_lease(U64(1)).unwrap().status, LeaseStatus::Cancelled);
}

#[test]
#[should_panic(expected = "E_NOT_TENANT")]
fn a_stranger_cannot_cancel_a_request() {
    let mut c = listed(approval_terms());
    act_as("agent.testnet", deposit(100));
    let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    act_as("mallory.testnet", NearToken::from_yoctonear(0));
    c.cancel(U64(1));
}

#[test]
#[should_panic(expected = "E_APPROVAL_NEEDS_NEAR_RENT")]
fn approval_cannot_be_combined_with_foreign_rent() {
    let mut t = approval_terms();
    t.foreign = vec![base_rent()];
    let _ = listed(t);
}

fn real_payment_log() -> EvmLog {
    EvmLog {
        removed: false,
        log_index: 12,
        transaction_index: 3,
        transaction_hash: "0xe5842537faace016fbbc809e33b9103a0bc53d1cd232e7a4388799603b012865".into(),
        block_hash: "0xfaea7cf4499e584ca948e7771f88d4ee7a25d48b3fc38b265e116ad263fd82a1".into(),
        block_number: 0x35156f0,
        address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e".into(),
        data: "0x00000000000000000000000000000000000000000000000000000000000ec9ae".into(),
        topics: vec![
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef".into(),
            "0x000000000000000000000000d067719ee4c514b5735d1ac0ffb46fecf2a9ada4".into(),
            "0x0000000000000000000000008d642988e3e7b6db15b6058461d5563835b04bf6".into(),
        ],
    }
}

fn foreign_terms() -> Terms {
    let mut t = terms();
    t.foreign = vec![base_rent()];
    t
}

#[test]
#[should_panic(expected = "E_CHAIN_NOT_ACCEPTED")]
fn a_chain_the_owner_did_not_list_is_refused() {
    let mut c = listed(foreign_terms());
    act_as("relayer.testnet", LEASE_STORAGE_FEE);
    let _ = c.rent_foreign("box-1".into(), EvmChain::Polygon, real_payment_log(), SSH_KEY.into(), "00".repeat(65), None);
}

#[test]
#[should_panic(expected = "E_WRONG_TOKEN")]
fn payment_in_another_token_is_refused() {
    let mut t = terms();
    let mut rent = base_rent();
    rent.token = "0x1111111111111111111111111111111111111111".into();
    t.foreign = vec![rent];
    let mut c = listed(t);
    act_as("relayer.testnet", LEASE_STORAGE_FEE);
    let _ = c.rent_foreign("box-1".into(), EvmChain::Base, real_payment_log(), SSH_KEY.into(), "00".repeat(65), None);
}

#[test]
#[should_panic(expected = "E_WRONG_RECIPIENT")]
fn payment_to_someone_else_is_refused() {
    let mut t = terms();
    let mut rent = base_rent();
    rent.pay_to = "0x2222222222222222222222222222222222222222".into();
    t.foreign = vec![rent];
    let mut c = listed(t);
    act_as("relayer.testnet", LEASE_STORAGE_FEE);
    let _ = c.rent_foreign("box-1".into(), EvmChain::Base, real_payment_log(), SSH_KEY.into(), "00".repeat(65), None);
}

#[test]
#[should_panic(expected = "E_UNDERPAID")]
fn a_foreign_payment_below_one_tick_is_refused() {
    let mut t = terms();
    let mut rent = base_rent();
    rent.amount_per_tick = U128(10_000_000);
    t.foreign = vec![rent];
    let mut c = listed(t);
    act_as("relayer.testnet", LEASE_STORAGE_FEE);
    let _ = c.rent_foreign("box-1".into(), EvmChain::Base, real_payment_log(), SSH_KEY.into(), "00".repeat(65), None);
}

#[test]
#[should_panic(expected = "E_BAD_SIGNATURE")]
fn a_garbage_payer_signature_is_refused() {
    let mut c = listed(foreign_terms());
    act_as("relayer.testnet", LEASE_STORAGE_FEE);
    let _ = c.rent_foreign("box-1".into(), EvmChain::Base, real_payment_log(), SSH_KEY.into(), "nope".into(), None);
}

#[test]
#[should_panic(expected = "E_NEEDS_STORAGE_FEE")]
fn a_foreign_claim_needs_a_storage_fee() {
    let mut c = listed(foreign_terms());
    act_as("relayer.testnet", NearToken::from_yoctonear(0));
    let _ = c.rent_foreign("box-1".into(), EvmChain::Base, real_payment_log(), SSH_KEY.into(), "00".repeat(65), None);
}

#[test]
fn claim_message_binds_contract_unit_key_and_payment() {
    let log = real_payment_log();
    let key = ssh::parse_public_key(SSH_KEY).unwrap();
    let m = evm::claim_message("sublet.testnet", "box-1", &key, EvmChain::Base, &log.transaction_hash, log.log_index);
    assert!(m.contains("sublet.testnet"));
    assert!(m.contains("box-1"));
    assert!(m.contains(&hex::encode(key)));
    assert!(m.contains(&log.transaction_hash));
    assert!(m.contains("#12"));
}

#[test]
fn a_spent_key_is_per_chain_tx_and_log() {
    assert_ne!(spent_key(EvmChain::Base, "0xa", 1), spent_key(EvmChain::Base, "0xa", 2));
    assert_ne!(spent_key(EvmChain::Base, "0xa", 1), spent_key(EvmChain::Arbitrum, "0xa", 1));
}

#[test]
fn recent_leases_are_newest_first() {
    let mut c = listed(terms());
    for _ in 0..3 {
        act_as("tenant.testnet", deposit(100));
        let _ = c.rent("box-1".into(), 1, Some(SSH_KEY.into()), None);
    }
    let ids: Vec<u64> = c.recent_leases(Some(2)).iter().map(|l| l.id.0).collect();
    assert_eq!(ids, vec![3, 2]);
}
