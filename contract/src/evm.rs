//! Reading a payment on another chain without a bridge.
//!
//! The MPC network attests to a log it read from a foreign chain, but it returns only a hash. So the
//! contract rebuilds that hash from the log the caller supplied, and passes it to the MPC network as
//! `expected_payload_hash`. A caller who lies about any field gets no attestation.

use near_sdk::{env, near};

/// `keccak256("Transfer(address,address,uint256)")`
pub const TRANSFER_TOPIC: [u8; 32] = [
    0xdd, 0xf2, 0x52, 0xad, 0x1b, 0xe2, 0xc8, 0x9b, 0x69, 0xc2, 0xb0, 0x68, 0xfc, 0x37, 0x8d, 0xaa,
    0x95, 0x2b, 0xa7, 0xf1, 0x63, 0xc4, 0xa1, 0x16, 0x28, 0xf5, 0x5a, 0x4d, 0xf5, 0x23, 0xb3, 0xef,
];

/// EVM chains the MPC network can read today. `get_available_foreign_chains` lists these on both
/// testnet and mainnet.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvmChain {
    Abstract,
    Bnb,
    Base,
    Arbitrum,
    Polygon,
    HyperEvm,
    Avalanche,
}

impl EvmChain {
    /// Position in the MPC contract's `ForeignChainRpcRequest` enum, used by its Borsh encoding.
    fn borsh_index(self) -> u8 {
        match self {
            EvmChain::Abstract => 0,
            EvmChain::Bnb => 5,
            EvmChain::Base => 6,
            EvmChain::Arbitrum => 7,
            EvmChain::Polygon => 8,
            EvmChain::HyperEvm => 9,
            EvmChain::Avalanche => 13,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            EvmChain::Abstract => "Abstract",
            EvmChain::Bnb => "Bnb",
            EvmChain::Base => "Base",
            EvmChain::Arbitrum => "Arbitrum",
            EvmChain::Polygon => "Polygon",
            EvmChain::HyperEvm => "HyperEvm",
            EvmChain::Avalanche => "Avalanche",
        }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Finality {
    Latest,
    Safe,
    Finalized,
}

impl Finality {
    fn borsh_index(self) -> u8 {
        match self {
            Finality::Latest => 0,
            Finality::Safe => 1,
            Finality::Finalized => 2,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Finality::Latest => "Latest",
            Finality::Safe => "Safe",
            Finality::Finalized => "Finalized",
        }
    }
}

/// An EVM log, as `eth_getTransactionReceipt` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EvmLog {
    pub removed: bool,
    pub log_index: u64,
    pub transaction_index: u64,
    pub transaction_hash: String,
    pub block_hash: String,
    pub block_number: u64,
    pub address: String,
    pub data: String,
    pub topics: Vec<String>,
}

/// A refusal carries a stable code, so tests and callers can tell exactly why.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    BadLog,
    NotATransfer,
    WrongToken,
    WrongRecipient,
    AmountTooLarge,
    BadSignature,
    WrongPayer,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::BadLog => "E_BAD_LOG",
            Refusal::NotATransfer => "E_NOT_A_TRANSFER",
            Refusal::WrongToken => "E_WRONG_TOKEN",
            Refusal::WrongRecipient => "E_WRONG_RECIPIENT",
            Refusal::AmountTooLarge => "E_AMOUNT_TOO_LARGE",
            Refusal::BadSignature => "E_BAD_SIGNATURE",
            Refusal::WrongPayer => "E_WRONG_PAYER",
        }
    }
}

/// Strict lowercase `0x` hex. The MPC hash covers the literal string for `data`, and uppercase
/// would never match, so it is refused here rather than timing out later.
fn strict_hex(s: &str, bytes: usize) -> Result<Vec<u8>, Refusal> {
    let body = s.strip_prefix("0x").ok_or(Refusal::BadLog)?;
    if body.len() != bytes * 2 || body.bytes().any(|c| c.is_ascii_uppercase()) {
        return Err(Refusal::BadLog);
    }
    hex::decode(body).map_err(|_| Refusal::BadLog)
}

fn hex32(s: &str) -> Result<[u8; 32], Refusal> {
    strict_hex(s, 32)?.try_into().map_err(|_| Refusal::BadLog)
}

fn hex20(s: &str) -> Result<[u8; 20], Refusal> {
    strict_hex(s, 20)?.try_into().map_err(|_| Refusal::BadLog)
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Borsh encoding of `ForeignTxSignPayload::V1` for a single `Log` extractor on an EVM chain.
pub fn signed_payload(chain: EvmChain, finality: Finality, log: &EvmLog) -> Result<Vec<u8>, Refusal> {
    let tx = hex32(&log.transaction_hash)?;
    let block = hex32(&log.block_hash)?;
    let address = hex20(&log.address)?;

    let mut out = Vec::with_capacity(320);
    out.push(0); // ForeignTxSignPayload::V1
    out.push(chain.borsh_index()); // ForeignChainRpcRequest variant
    out.extend_from_slice(&tx); // EvmRpcRequest.tx_id
    put_u32(&mut out, 1); // extractors: one
    out.push(1); // EvmExtractor::Log (explicit discriminant 1)
    put_u64(&mut out, log.log_index);
    out.push(finality.borsh_index());
    put_u32(&mut out, 1); // values: one
    out.push(1); // ExtractedValue::EvmExtractedValue
    out.push(1); // EvmExtractedValue::Log
    out.push(u8::from(log.removed));
    put_u64(&mut out, log.log_index);
    put_u64(&mut out, log.transaction_index);
    out.extend_from_slice(&tx);
    out.extend_from_slice(&block);
    put_u64(&mut out, log.block_number);
    out.extend_from_slice(&address);
    put_u32(&mut out, log.data.len() as u32);
    out.extend_from_slice(log.data.as_bytes());
    put_u32(&mut out, log.topics.len() as u32);
    for topic in &log.topics {
        out.extend_from_slice(&hex32(topic)?);
    }
    Ok(out)
}

/// The hash the MPC network must sign for this exact log.
pub fn payload_hash(chain: EvmChain, finality: Finality, log: &EvmLog) -> Result<[u8; 32], Refusal> {
    Ok(env::sha256_array(signed_payload(chain, finality, log)?))
}

/// A transfer of `token` to `pay_to`, decoded from a log.
#[derive(Debug, PartialEq, Eq)]
pub struct Transfer {
    pub from: [u8; 20],
    pub amount: u128,
}

pub fn decode_transfer(log: &EvmLog, token: &[u8; 20], pay_to: &[u8; 20]) -> Result<Transfer, Refusal> {
    if log.removed || log.topics.len() != 3 {
        return Err(Refusal::NotATransfer);
    }
    if hex32(&log.topics[0])? != TRANSFER_TOPIC {
        return Err(Refusal::NotATransfer);
    }
    if hex20(&log.address)? != *token {
        return Err(Refusal::WrongToken);
    }
    let address_in_topic = |topic: &str| -> Result<[u8; 20], Refusal> {
        let word = hex32(topic)?;
        if word[..12].iter().any(|b| *b != 0) {
            return Err(Refusal::BadLog);
        }
        let mut address = [0u8; 20];
        address.copy_from_slice(&word[12..]);
        Ok(address)
    };
    let from = address_in_topic(&log.topics[1])?;
    if address_in_topic(&log.topics[2])? != *pay_to {
        return Err(Refusal::WrongRecipient);
    }
    let word = hex32(&log.data)?;
    if word[..16].iter().any(|b| *b != 0) {
        return Err(Refusal::AmountTooLarge);
    }
    let mut low = [0u8; 16];
    low.copy_from_slice(&word[16..]);
    Ok(Transfer { from, amount: u128::from_be_bytes(low) })
}

/// The message the payer signs. Without it, anyone watching the chain could claim someone else's
/// payment for their own SSH key.
pub fn claim_message(contract: &str, unit: &str, ssh_key: &[u8; 32], chain: EvmChain, tx: &str, log_index: u64) -> String {
    format!(
        "Sublet lease claim\ncontract: {contract}\nunit: {unit}\nssh key: {}\npayment: {} {tx} #{log_index}",
        hex::encode(ssh_key),
        chain.name(),
    )
}

/// EIP-191 `personal_sign` recovery. Returns the signer's address.
pub fn recover_signer(message: &str, signature: &[u8]) -> Result<[u8; 20], Refusal> {
    if signature.len() != 65 {
        return Err(Refusal::BadSignature);
    }
    let v = match signature[64] {
        0 | 27 => 0u8,
        1 | 28 => 1u8,
        _ => return Err(Refusal::BadSignature),
    };
    let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", message.len()).into_bytes();
    prefixed.extend_from_slice(message.as_bytes());
    let hash = env::keccak256_array(prefixed);
    let mut rs = [0u8; 64];
    rs.copy_from_slice(&signature[..64]);
    let public = env::ecrecover(&hash, &rs, v, true).ok_or(Refusal::BadSignature)?;
    let digest = env::keccak256_array(public);
    let mut address = [0u8; 20];
    address.copy_from_slice(&digest[12..]);
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real Base Sepolia USDC transfer, attested by the live testnet MPC network.
    /// NEAR testnet tx 73AWUGYVFdznBxcxMfbkUkPNW4peV55dZNppAPvKWWMf returned this hash.
    fn real_log() -> EvmLog {
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

    fn addr(s: &str) -> [u8; 20] {
        hex20(s).unwrap()
    }

    const USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
    const PAYEE: &str = "0x8d642988e3e7b6db15b6058461d5563835b04bf6";

    #[test]
    fn reproduces_the_hash_the_live_mpc_network_signed() {
        let hash = payload_hash(EvmChain::Base, Finality::Latest, &real_log()).unwrap();
        assert_eq!(
            hex::encode(hash),
            "33378266322d1f0c6cd6c5655d065e8365904d618f276ca0d62e21c9577965db"
        );
    }

    #[test]
    fn any_changed_field_changes_the_hash() {
        let original = payload_hash(EvmChain::Base, Finality::Latest, &real_log()).unwrap();
        let mut more_money = real_log();
        more_money.data = "0x00000000000000000000000000000000000000000000000000000000ffffffff".into();
        assert_ne!(payload_hash(EvmChain::Base, Finality::Latest, &more_money).unwrap(), original);
        assert_ne!(payload_hash(EvmChain::Arbitrum, Finality::Latest, &real_log()).unwrap(), original);
        assert_ne!(payload_hash(EvmChain::Base, Finality::Safe, &real_log()).unwrap(), original);
    }

    #[test]
    fn decodes_a_real_transfer() {
        let t = decode_transfer(&real_log(), &addr(USDC), &addr(PAYEE)).unwrap();
        assert_eq!(t.amount, 0xec9ae);
        assert_eq!(t.from, addr("0xd067719ee4c514b5735d1ac0ffb46fecf2a9ada4"));
    }

    #[test]
    fn refuses_the_wrong_token() {
        let other = addr("0x1111111111111111111111111111111111111111");
        assert_eq!(decode_transfer(&real_log(), &other, &addr(PAYEE)), Err(Refusal::WrongToken));
    }

    #[test]
    fn refuses_the_wrong_recipient() {
        let other = addr("0x2222222222222222222222222222222222222222");
        assert_eq!(decode_transfer(&real_log(), &addr(USDC), &other), Err(Refusal::WrongRecipient));
    }

    #[test]
    fn refuses_logs_that_are_not_transfers() {
        let mut log = real_log();
        log.topics[0] = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925".into();
        assert_eq!(decode_transfer(&log, &addr(USDC), &addr(PAYEE)), Err(Refusal::NotATransfer));

        let mut removed = real_log();
        removed.removed = true;
        assert_eq!(decode_transfer(&removed, &addr(USDC), &addr(PAYEE)), Err(Refusal::NotATransfer));
    }

    #[test]
    fn refuses_uppercase_hex_that_could_never_match_the_hash() {
        let mut log = real_log();
        log.data = log.data.to_uppercase().replace("0X", "0x");
        log.data = "0x00000000000000000000000000000000000000000000000000000000000EC9AE".into();
        assert_eq!(decode_transfer(&log, &addr(USDC), &addr(PAYEE)), Err(Refusal::BadLog));
    }

    #[test]
    fn refuses_amounts_above_u128() {
        let mut log = real_log();
        log.data = "0x0000000000000000000000000000000100000000000000000000000000000000".into();
        assert_eq!(decode_transfer(&log, &addr(USDC), &addr(PAYEE)), Err(Refusal::AmountTooLarge));
    }
}
