//! A small OpenSSH certificate encoder that runs inside a smart contract.
//!
//! The contract, not a server, decides every field of the certificate. These functions produce the
//! exact bytes the MPC network signs, in the field order of OpenSSH's `PROTOCOL.certkeys`.
//! OpenSSH checks the result with no NEAR software present on the server.

use base64::{engine::general_purpose::STANDARD, Engine};

pub const CERT_TYPE: &str = "ssh-ed25519-cert-v01@openssh.com";
const KEY_TYPE: &str = "ssh-ed25519";
const SSH_CERT_TYPE_USER: u32 = 1;

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_str(out: &mut Vec<u8>, v: &[u8]) {
    put_u32(out, v.len() as u32);
    out.extend_from_slice(v);
}

/// `string "ssh-ed25519" || string <32 byte key>`, the wire form of an Ed25519 public key.
pub fn key_blob(key: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(51);
    put_str(&mut out, KEY_TYPE.as_bytes());
    put_str(&mut out, key);
    out
}

/// What the contract has decided this certificate may do.
pub struct CertSpec<'a> {
    pub nonce: &'a [u8; 32],
    pub subject: &'a [u8; 32],
    pub ca: &'a [u8; 32],
    pub serial: u64,
    pub key_id: &'a str,
    pub principal: &'a str,
    pub valid_after: u64,
    pub valid_before: u64,
    pub force_command: Option<&'a str>,
    pub source_address: Option<&'a str>,
    pub permit_pty: bool,
    pub permit_port_forwarding: bool,
}

/// Critical options: `string name || string (string value)`, sorted by name.
fn critical_options(spec: &CertSpec) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some(cmd) = spec.force_command {
        put_str(&mut out, b"force-command");
        let mut inner = Vec::with_capacity(cmd.len() + 4);
        put_str(&mut inner, cmd.as_bytes());
        put_str(&mut out, &inner);
    }
    if let Some(addr) = spec.source_address {
        put_str(&mut out, b"source-address");
        let mut inner = Vec::with_capacity(addr.len() + 4);
        put_str(&mut inner, addr.as_bytes());
        put_str(&mut out, &inner);
    }
    out
}

/// Extensions are flags with empty values, sorted by name.
fn extensions(spec: &CertSpec) -> Vec<u8> {
    let mut out = Vec::new();
    if spec.permit_port_forwarding {
        put_str(&mut out, b"permit-port-forwarding");
        put_str(&mut out, b"");
    }
    if spec.permit_pty {
        put_str(&mut out, b"permit-pty");
        put_str(&mut out, b"");
    }
    out
}

/// The bytes the MPC network signs: the whole certificate except the final signature field.
pub fn to_be_signed(spec: &CertSpec) -> Vec<u8> {
    let mut principals = Vec::with_capacity(spec.principal.len() + 4);
    put_str(&mut principals, spec.principal.as_bytes());

    let mut out = Vec::with_capacity(512);
    put_str(&mut out, CERT_TYPE.as_bytes());
    put_str(&mut out, spec.nonce);
    put_str(&mut out, spec.subject);
    put_u64(&mut out, spec.serial);
    put_u32(&mut out, SSH_CERT_TYPE_USER);
    put_str(&mut out, spec.key_id.as_bytes());
    put_str(&mut out, &principals);
    put_u64(&mut out, spec.valid_after);
    put_u64(&mut out, spec.valid_before);
    put_str(&mut out, &critical_options(spec));
    put_str(&mut out, &extensions(spec));
    put_str(&mut out, b""); // reserved
    put_str(&mut out, &key_blob(spec.ca));
    out
}

/// Appends the Ed25519 signature, giving a complete certificate blob.
pub fn assemble(tbs: &[u8], signature: &[u8; 64]) -> Vec<u8> {
    let mut sig = Vec::with_capacity(83);
    put_str(&mut sig, KEY_TYPE.as_bytes());
    put_str(&mut sig, signature);
    let mut out = Vec::with_capacity(tbs.len() + sig.len() + 4);
    out.extend_from_slice(tbs);
    put_str(&mut out, &sig);
    out
}

/// A `<type> <base64> <comment>` line, the format of an `id_ed25519-cert.pub` file.
pub fn cert_line(cert: &[u8], comment: &str) -> String {
    format!("{CERT_TYPE} {} {comment}", STANDARD.encode(cert))
}

/// A `ssh-ed25519 <base64> <comment>` line, the format of a `TrustedUserCAKeys` file.
pub fn public_key_line(key: &[u8; 32], comment: &str) -> String {
    format!("{KEY_TYPE} {} {comment}", STANDARD.encode(key_blob(key)))
}

/// Accepts an OpenSSH line (`ssh-ed25519 AAAA... comment`) or bare base64 of the key blob.
pub fn parse_public_key(input: &str) -> Option<[u8; 32]> {
    let mut parts = input.split_whitespace();
    let first = parts.next()?;
    let b64 = if first == KEY_TYPE { parts.next()? } else { first };
    let blob = STANDARD.decode(b64).ok()?;
    let prefix = {
        let mut p = Vec::with_capacity(19);
        put_str(&mut p, KEY_TYPE.as_bytes());
        put_u32(&mut p, 32);
        p
    };
    if blob.len() != prefix.len() + 32 || !blob.starts_with(&prefix) {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&blob[prefix.len()..]);
    Some(key)
}

/// Bytes valid inside a shell single-quoted string once `'` is escaped.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// OpenSSH checks a certificate's expiry only when a session starts, so a session opened one second
/// before expiry would otherwise run forever. The contract therefore writes an eviction into the
/// signed `force-command`. Because the command is signed, a tenant cannot edit it before it runs.
///
/// It works with any POSIX shell and installs nothing:
/// - A login records the certificate's end time in a stamp file, if later than the one there. A
///   renewal is therefore just a login with a newer certificate, and running sessions continue.
/// - A background watcher sleeps until the stamp's time, then runs `kill -9 -1`, which ends every
///   process this Unix user owns, including anything started with `nohup` or `setsid`.
///
/// The watcher runs as the tenant, so a hostile tenant could kill it and keep an open session
/// alive. They still cannot open a new one. See docs/THREAT-MODEL.md.
pub fn session_command(valid_before: u64, owner_command: Option<&str>) -> String {
    let inner = match owner_command {
        Some(cmd) => shell_single_quote(cmd),
        None => "\"${SSH_ORIGINAL_COMMAND:-exec ${SHELL:-/bin/sh} -l}\"".to_string(),
    };
    format!(
        "e={valid_before};f=$HOME/.sublet-until;s=$(cat \"$f\" 2>/dev/null);\
         [ \"$e\" -gt \"${{s:-0}}\" ]&&echo \"$e\">\"$f\";export SUBLET_UNTIL=$e;\
         (while t=$(($(cat \"$f\")-$(date +%s)));[ \"$t\" -gt 0 ];do sleep \"$t\";done;kill -9 -1)\
         </dev/null >/dev/null 2>&1 &\
         exec sh -c {inner}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec<'a>(nonce: &'a [u8; 32], subject: &'a [u8; 32], ca: &'a [u8; 32]) -> CertSpec<'a> {
        CertSpec {
            nonce,
            subject,
            ca,
            serial: 7,
            key_id: "sublet:box:7:alice.testnet",
            principal: "tenant",
            valid_after: 1_000,
            valid_before: 1_300,
            force_command: Some("whoami"),
            source_address: Some("10.0.0.0/8"),
            permit_pty: true,
            permit_port_forwarding: false,
        }
    }

    #[test]
    fn public_key_round_trips_through_openssh_line() {
        let key = [9u8; 32];
        let line = public_key_line(&key, "sublet");
        assert!(line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI"));
        assert_eq!(parse_public_key(&line), Some(key));
    }

    #[test]
    fn parse_public_key_rejects_other_key_types_and_bad_lengths() {
        assert_eq!(parse_public_key(""), None);
        assert_eq!(parse_public_key("ssh-rsa AAAAB3NzaC1yc2E="), None);
        assert_eq!(parse_public_key("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"), None);
        assert_eq!(parse_public_key("not base64!!"), None);
    }

    #[test]
    fn certificate_fields_are_in_protocol_order() {
        let (nonce, subject, ca) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let tbs = to_be_signed(&spec(&nonce, &subject, &ca));
        assert_eq!(&tbs[..4], &(CERT_TYPE.len() as u32).to_be_bytes());
        assert_eq!(&tbs[4..4 + CERT_TYPE.len()], CERT_TYPE.as_bytes());
        let after_type = 4 + CERT_TYPE.len();
        assert_eq!(&tbs[after_type + 4..after_type + 36], &nonce);
        assert_eq!(&tbs[after_type + 40..after_type + 72], &subject);
        assert_eq!(&tbs[tbs.len() - 32..], &ca);
    }

    #[test]
    fn critical_options_sort_force_command_before_source_address() {
        let (n, s, c) = ([0u8; 32], [0u8; 32], [0u8; 32]);
        let spec = spec(&n, &s, &c);
        let opts = critical_options(&spec);
        let find = |needle: &[u8]| opts.windows(needle.len()).position(|w| w == needle);
        assert!(find(b"force-command").unwrap() < find(b"source-address").unwrap());
    }

    #[test]
    fn session_command_uses_the_absolute_end_time_and_evicts_the_whole_user() {
        let cmd = session_command(1_794_055_300, None);
        assert!(cmd.starts_with("e=1794055300;"));
        assert!(cmd.contains("kill -9 -1"));
        assert!(cmd.contains("SSH_ORIGINAL_COMMAND"));
    }

    #[test]
    fn owner_command_cannot_break_out_of_quoting() {
        let cmd = session_command(1, Some("echo 'hi'; rm -rf /"));
        assert!(cmd.contains(r"'echo '\''hi'\''; rm -rf /'"));
        assert!(!cmd.contains("SSH_ORIGINAL_COMMAND"));
    }
}
