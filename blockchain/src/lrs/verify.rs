//! LSAG verification — the whole of a node's ballot authorization check.
//!
//! Counterpart of `web/src/crypto/lrs/verify.ts`; algorithm and byte layouts in
//! `web/src/crypto/lrs/WIRE_FORMAT.md`.
//!
//! There is no separate "is this key image from this ring" step, and cryptographically there
//! cannot be one from a bare `(keyImage, ring)` pair. The `R_i = s_i·H_p(P_i) + c_i·I` terms
//! weave the key image into the same challenge chain as the ring, so if the chain closes then
//! `I` was produced by a holder of one of the ring's private keys. That is also why a
//! substituted key image fails verification rather than merely appearing unlinked.
//!
//! Any malformed input returns `false`. A verifier's job is to reject, not to panic on
//! adversarial bytes — the rest of this node is looser about that than it should be, and the
//! looseness must not spread here.

use curve25519_dalek::constants::RISTRETTO_BASEPOINT_TABLE;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::traits::Identity;

use super::hash::{challenge, key_image_base};
use super::serialize::RingSignature;

/// Verifies a ring signature against a ring, a message, and an election.
///
/// `ring` is the ordered public keys from the node's election manifest — never from the
/// submission. `message` must have been rebuilt locally by `encode_message`.
pub fn verify(
    message: &[u8],
    ring: &[[u8; 32]],
    signature: &RingSignature,
    election_id: &str,
) -> bool {
    let n = ring.len();

    // --- structural checks, before any curve arithmetic ---
    if n < 2 || signature.s.len() != n {
        return false;
    }
    if signature.key_image == RistrettoPoint::identity() {
        return false;
    }

    // Decode ring members. A non-canonical or identity member makes the ring unusable; the
    // manifest importer should already have refused it, so reaching here means a mismatch
    // between what this node loaded and what it is being asked to verify against.
    let mut points = Vec::with_capacity(n);
    for key in ring {
        match CompressedRistretto(*key).decompress() {
            Some(point) if point != RistrettoPoint::identity() => points.push(point),
            _ => return false,
        }
    }

    // Per-member key-image bases H_p(P_i ‖ electionId). This is where election scoping enters
    // verification: the same signature checked against a different electionId produces
    // different bases and cannot close.
    let bases: Vec<RistrettoPoint> = ring
        .iter()
        .map(|key| key_image_base(key, election_id))
        .collect();

    // --- re-walk the ring ---
    //
    // Start from the provided c_0 and go once around. The verifier does not know, and never
    // learns, which index the signer closed the loop at: the final iteration reproduces c_0 for
    // any signer position, which is exactly the anonymity property.
    let mut c = signature.c0;
    for i in 0..n {
        let li = RISTRETTO_BASEPOINT_TABLE * &signature.s[i] + points[i] * c;
        let ri = bases[i] * signature.s[i] + signature.key_image * c;

        // The identity here means a malformed signature rather than a valid one — negligible
        // by accident, so treat it as an attacker.
        if li == RistrettoPoint::identity() || ri == RistrettoPoint::identity() {
            return false;
        }

        c = challenge(message, ring, &li, &ri);
    }

    // Accept iff the loop closed. Fixed-shape comparison on canonical bytes.
    bytes_equal(c.as_bytes(), signature.c0.as_bytes())
}

/// Two signatures are linked iff their key images are equal — same signer, same election,
/// regardless of which ring each was signed against.
///
/// This predicate is all the library provides toward double-vote prevention. The seen-set that
/// answers "has this key image appeared before" belongs to the ledger, and must be consulted
/// only AFTER `verify` succeeds: the chain is what binds the key image to the ring, so checking
/// the set first would let a substituted key image be recorded as merely unseen.
pub fn are_linked(a: &RingSignature, b: &RingSignature) -> bool {
    bytes_equal(&a.key_image_bytes, &b.key_image_bytes)
}

/// A canonical string key for a key image, for use as a seen-set key.
pub fn key_image_key(signature: &RingSignature) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature.key_image_bytes)
}

fn bytes_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lrs::serialize::{deserialize_signature, encode_message};
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const VECTORS: &str =
        include_str!("../../../web/src/crypto/lrs/test-vectors/vectors.json");

    fn b64(value: &serde_json::Value) -> Vec<u8> {
        URL_SAFE_NO_PAD
            .decode(value.as_str().expect("string").as_bytes())
            .expect("valid base64url")
    }

    fn ring_of(value: &serde_json::Value) -> Vec<[u8; 32]> {
        value
            .as_array()
            .expect("ring array")
            .iter()
            .map(|entry| {
                let bytes = b64(entry);
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                key
            })
            .collect()
    }

    /// The cross-language contract: every committed vector must produce the recorded verdict.
    #[test]
    fn every_committed_vector_agrees() {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
        let vectors = doc["vectors"].as_array().expect("vectors array");
        assert!(!vectors.is_empty(), "no vectors to check");

        for vector in vectors {
            let name = vector["name"].as_str().unwrap_or("<unnamed>");
            let election_id = vector["electionId"].as_str().expect("electionId");
            let ring_id = vector["ringId"].as_str().expect("ringId");
            let candidate_id = vector["candidateId"].as_str().expect("candidateId");
            let ring = ring_of(&vector["ring"]);
            let expected = vector["expected"].as_bool().expect("expected");

            // Verify against the committed message, because that is the input the vector
            // specifies. Negative vectors deliberately supply a message that is NOT the
            // canonical encoding — `size10-tampered-message` flips a byte of the domain tag —
            // so this must not be replaced by a locally rebuilt one.
            let committed_message = b64(&vector["message"]);

            // For vectors that are meant to pass, the committed message must equal what
            // encode_message produces. That is the real cross-check on the message encoding,
            // and it has to be scoped to the passing vectors to stay meaningful.
            let rebuilt = encode_message(election_id, ring_id, candidate_id);
            if expected {
                assert_eq!(
                    committed_message, rebuilt,
                    "{}: encode_message disagrees with the committed message",
                    name
                );
            }

            let signature_bytes = b64(&vector["signature"]);
            let actual = match deserialize_signature(&signature_bytes) {
                Ok(signature) => verify(&committed_message, &ring, &signature, election_id),
                // A vector whose bytes do not even parse is a legitimate `false`.
                Err(_) => false,
            };

            assert_eq!(actual, expected, "vector {} disagrees", name);
        }
    }

    /// Tampering with any input must break the chain. Derived from a known-good vector so the
    /// baseline is guaranteed to verify first.
    #[test]
    fn tampering_breaks_verification() {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
        let vector = doc["vectors"]
            .as_array()
            .expect("vectors")
            .iter()
            .find(|v| v["expected"].as_bool() == Some(true))
            .expect("at least one passing vector");

        let election_id = vector["electionId"].as_str().unwrap();
        let ring_id = vector["ringId"].as_str().unwrap();
        let candidate_id = vector["candidateId"].as_str().unwrap();
        let ring = ring_of(&vector["ring"]);
        let message = encode_message(election_id, ring_id, candidate_id);
        let signature = deserialize_signature(&b64(&vector["signature"])).expect("parses");

        assert!(
            verify(&message, &ring, &signature, election_id),
            "baseline must verify"
        );

        // Wrong election: different key-image bases, chain cannot close.
        assert!(!verify(&message, &ring, &signature, "some-other-election"));

        // Different candidate: different message.
        let other_message = encode_message(election_id, ring_id, "different-candidate");
        assert!(!verify(&other_message, &ring, &signature, election_id));

        // Different ring id: also a different message, so a signature cannot be replayed into
        // another group even if the key set happened to match.
        let other_ring_message = encode_message(election_id, "other-ring", candidate_id);
        assert!(!verify(&other_ring_message, &ring, &signature, election_id));

        // Reordered ring: every challenge hashes the ring in order.
        if ring.len() >= 2 {
            let mut swapped = ring.clone();
            swapped.swap(0, 1);
            assert!(!verify(&message, &swapped, &signature, election_id));
        }

        // Tampered response scalar.
        let mut bad_s = signature.clone();
        bad_s.s[0] += curve25519_dalek::scalar::Scalar::ONE;
        assert!(!verify(&message, &ring, &bad_s, election_id));

        // Tampered c0.
        let mut bad_c0 = signature.clone();
        bad_c0.c0 += curve25519_dalek::scalar::Scalar::ONE;
        assert!(!verify(&message, &ring, &bad_c0, election_id));

        // Substituted key image: must fail verification outright, not merely look unlinked.
        // This is what makes verify-then-dedup safe.
        let mut bad_image = signature.clone();
        bad_image.key_image = bad_image.key_image * curve25519_dalek::scalar::Scalar::from(2u8);
        bad_image.key_image_bytes = bad_image.key_image.compress().to_bytes();
        assert!(!verify(&message, &ring, &bad_image, election_id));

        // Truncated ring: s length no longer matches.
        let short_ring = &ring[..ring.len() - 1];
        assert!(!verify(&message, short_ring, &signature, election_id));
    }

    #[test]
    fn linkability_compares_key_images() {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
        let vectors = doc["vectors"].as_array().expect("vectors");
        let first = deserialize_signature(&b64(&vectors[0]["signature"])).expect("parses");

        assert!(are_linked(&first, &first));
        assert_eq!(key_image_key(&first), key_image_key(&first));

        // A different signer's key image must not link.
        let other = vectors
            .iter()
            .skip(1)
            .filter_map(|v| deserialize_signature(&b64(&v["signature"])).ok())
            .find(|sig| sig.key_image_bytes != first.key_image_bytes);
        if let Some(other) = other {
            assert!(!are_linked(&first, &other));
        }
    }
}
