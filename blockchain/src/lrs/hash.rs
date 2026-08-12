//! The two hash functions the LRS scheme needs, plus the challenge transcript.
//!
//! This is the Rust half of a cross-language contract. Every byte here must match
//! `web/src/crypto/lrs/hash.ts`, and the authority is `web/src/crypto/lrs/WIRE_FORMAT.md`.
//! The committed test vectors in `web/src/crypto/lrs/test-vectors/vectors.json` are what prove
//! the two sides agree — the tests at the bottom of this file load that exact file rather than
//! a copy, so the two implementations answer to one artifact.
//!
//! Both functions are domain-separated, and every variable-length input is length-prefixed, so
//! no two distinct logical inputs can concatenate to the same byte string.

use curve25519_dalek::ristretto::RistrettoPoint;
use curve25519_dalek::scalar::Scalar;
use sha2::{Digest, Sha512};

/// Domain-separation tags. Bump these together with the signature version byte if any hash
/// construction changes — a v1 verifier must never silently accept a v2 signature.
const DST_HP: &[u8] = b"SECUREPOLL/v1/H_p";
const PREFIX_HS: &[u8] = b"SECUREPOLL/v1/H_s";
const PREFIX_CHAL: &[u8] = b"SECUREPOLL/v1/chal";

/// 4-byte little-endian length tag.
pub fn u32le(n: usize) -> [u8; 4] {
    debug_assert!(n <= u32::MAX as usize, "length {} exceeds u32", n);
    (n as u32).to_le_bytes()
}

/// `lp(x)` — length ‖ bytes, the atom that makes concatenations unambiguous.
fn push_len_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32le(bytes.len()));
    out.extend_from_slice(bytes);
}

/// RFC 9380 §5.3.1 `expand_message_xmd` with SHA-512.
///
/// Hand-written rather than pulled from a crate: it is short, fully specified, and the
/// committed `hp` test vector is a precise oracle for it. The alternative was adding a
/// hash-to-curve crate whose ristretto255 support would still need validating against the same
/// vector.
fn expand_message_xmd(msg: &[u8], dst: &[u8], len_in_bytes: usize) -> Vec<u8> {
    const B_IN_BYTES: usize = 64; // SHA-512 output
    const S_IN_BYTES: usize = 128; // SHA-512 block size

    let ell = len_in_bytes.div_ceil(B_IN_BYTES);
    assert!(ell <= 255 && len_in_bytes <= 65535 && dst.len() <= 255);

    // DST_prime = DST ‖ I2OSP(len(DST), 1)
    let mut dst_prime = dst.to_vec();
    dst_prime.push(dst.len() as u8);

    // msg_prime = Z_pad ‖ msg ‖ I2OSP(len_in_bytes, 2) ‖ I2OSP(0, 1) ‖ DST_prime
    let mut msg_prime = vec![0u8; S_IN_BYTES];
    msg_prime.extend_from_slice(msg);
    msg_prime.extend_from_slice(&(len_in_bytes as u16).to_be_bytes());
    msg_prime.push(0u8);
    msg_prime.extend_from_slice(&dst_prime);

    let b_0 = Sha512::digest(&msg_prime);

    let mut hasher = Sha512::new();
    hasher.update(b_0);
    hasher.update([1u8]);
    hasher.update(&dst_prime);
    let b_1 = hasher.finalize();

    let mut uniform = b_1.to_vec();
    let mut prev = b_1;
    for i in 2..=ell {
        // b_i = H( (b_0 XOR b_{i-1}) ‖ I2OSP(i, 1) ‖ DST_prime )
        let mut xored = [0u8; B_IN_BYTES];
        for (j, byte) in xored.iter_mut().enumerate() {
            *byte = b_0[j] ^ prev[j];
        }
        let mut hasher = Sha512::new();
        hasher.update(xored);
        hasher.update([i as u8]);
        hasher.update(&dst_prime);
        prev = hasher.finalize();
        uniform.extend_from_slice(&prev);
    }

    uniform.truncate(len_in_bytes);
    uniform
}

/// `H_p` — hash to a ristretto255 point, RFC 9380 `hash_to_ristretto255`.
///
/// XMD-expand to 64 uniform bytes, then the ristretto255 one-way map (dalek's
/// `from_uniform_bytes`).
///
/// CRITICAL: this is a real hash-to-curve, NOT "hash then multiply by G", and NOT raw SHA-512
/// fed straight into `from_uniform_bytes` (which skips the XMD expansion and lands on a
/// different point). If `H_p(P)` were `h·G` for a discoverable `h`, then the key image
/// `I = x·H_p(P) = h·(x·G) = h·P` would be computable by anyone holding the public key: the key
/// image would be forgeable and the signer identifiable by testing each ring member against it.
pub fn hash_to_point(bytes: &[u8]) -> RistrettoPoint {
    let uniform = expand_message_xmd(bytes, DST_HP, 64);
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&uniform);
    RistrettoPoint::from_uniform_bytes(&wide)
}

/// The per-signer key-image base: `H_p(lp(P) ‖ lp(utf8(electionId)))`.
///
/// Election-scoping is what gives "one vote per voter per election" without linking a voter's
/// ballots across different elections.
pub fn key_image_base(public_key: &[u8], election_id: &str) -> RistrettoPoint {
    let mut input = Vec::with_capacity(public_key.len() + election_id.len() + 8);
    push_len_prefixed(&mut input, public_key);
    push_len_prefixed(&mut input, election_id.as_bytes());
    hash_to_point(&input)
}

/// `H_s` — hash to a scalar. SHA-512 over the domain-separated input, read little-endian and
/// reduced mod q. One-to-one with dalek's `Scalar::from_bytes_mod_order_wide`.
pub fn hash_to_scalar(bytes: &[u8]) -> Scalar {
    let mut hasher = Sha512::new();
    hasher.update(PREFIX_HS);
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut wide = [0u8; 64];
    wide.copy_from_slice(&digest);
    Scalar::from_bytes_mod_order_wide(&wide)
}

/// One challenge in the ring, over the full transcript.
///
/// Binds the message, the entire ring in published order, and this step's `(L_i, R_i)` pair.
/// Reordering the ring changes every challenge — ring order is part of the contract.
///
/// `ring` holds the already-encoded 32-byte public keys, in ring order.
pub fn challenge(
    message: &[u8],
    ring: &[[u8; 32]],
    li: &RistrettoPoint,
    ri: &RistrettoPoint,
) -> Scalar {
    let mut input = Vec::with_capacity(PREFIX_CHAL.len() + message.len() + 32 * ring.len() + 72);
    input.extend_from_slice(PREFIX_CHAL);
    push_len_prefixed(&mut input, message);
    input.extend_from_slice(&u32le(ring.len()));
    for key in ring {
        input.extend_from_slice(key);
    }
    input.extend_from_slice(li.compress().as_bytes());
    input.extend_from_slice(ri.compress().as_bytes());
    hash_to_scalar(&input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    /// The committed cross-language vectors, read from the TypeScript library's own file rather
    /// than a copy — a copy would go stale and the point is that both sides answer to one
    /// artifact.
    const VECTORS: &str =
        include_str!("../../../web/src/crypto/lrs/test-vectors/vectors.json");

    fn vectors() -> serde_json::Value {
        serde_json::from_str(VECTORS).expect("vectors.json is valid JSON")
    }

    fn b64(value: &serde_json::Value) -> Vec<u8> {
        URL_SAFE_NO_PAD
            .decode(value.as_str().expect("string").as_bytes())
            .expect("valid base64url")
    }

    /// THE de-risking test for the whole Rust verifier.
    ///
    /// If this passes, `expand_message_xmd(SHA-512) + from_uniform_bytes` really is RFC 9380
    /// `hash_to_ristretto255` as the TypeScript side computes it, and everything downstream can
    /// be built on it. If it fails, nothing else is worth writing until it does.
    #[test]
    fn h_p_matches_the_committed_vector() {
        let v = vectors();
        let hp = &v["hp"];
        let public_key = b64(&hp["input_publicKey"]);
        let election_id = hp["input_electionId"].as_str().expect("electionId");
        let expected = b64(&hp["output_point"]);

        let actual = key_image_base(&public_key, election_id);

        assert_eq!(
            actual.compress().as_bytes().as_slice(),
            expected.as_slice(),
            "H_p disagrees with the TypeScript signer. Do not build on this until it matches."
        );
    }

    #[test]
    fn h_s_matches_the_committed_vector() {
        let v = vectors();
        let hs = &v["hs"];
        let input = hs["input_utf8"].as_str().expect("input_utf8");
        let expected = b64(&hs["output_scalar"]);

        let actual = hash_to_scalar(input.as_bytes());

        assert_eq!(
            actual.to_bytes().as_slice(),
            expected.as_slice(),
            "H_s disagrees with the TypeScript signer"
        );
    }

    /// RFC 9380 K.1 sanity: XMD is deterministic and the DST changes the output.
    #[test]
    fn xmd_is_deterministic_and_dst_separated() {
        let a = expand_message_xmd(b"abc", b"DST-1", 64);
        let b = expand_message_xmd(b"abc", b"DST-1", 64);
        let c = expand_message_xmd(b"abc", b"DST-2", 64);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }

    /// Length prefixing must make concatenation unambiguous: ("ab","c") and ("a","bc") are
    /// different inputs and must not collide.
    #[test]
    fn length_prefixing_prevents_collisions() {
        let mut left = Vec::new();
        push_len_prefixed(&mut left, b"ab");
        push_len_prefixed(&mut left, b"c");
        let mut right = Vec::new();
        push_len_prefixed(&mut right, b"a");
        push_len_prefixed(&mut right, b"bc");
        assert_ne!(left, right);
    }

    #[test]
    fn key_image_base_is_election_scoped() {
        let key = [7u8; 32];
        assert_ne!(
            key_image_base(&key, "election-A").compress(),
            key_image_base(&key, "election-B").compress(),
        );
    }
}
