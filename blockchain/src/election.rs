//! Election manifest loading.
//!
//! One election, one blockchain network, one manifest. This module is how a node learns which
//! election it serves: its id, its valid candidate ids, and its anonymity groups (rings) as
//! ordered public keys.
//!
//! The format is specified in `ELECTION_MANIFEST.md`. The admin panel exports it; every node
//! imports it from disk at startup. Nothing arrives over the network — a peer cannot tell this
//! node what the electorate is.
//!
//! Loading is strict and fails the process. A node that cannot parse its electorate cannot
//! verify ballots against it, and discovering that at startup costs a restart while discovering
//! it after votes are cast costs the election.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use curve25519_dalek::ristretto::{CompressedRistretto, RistrettoPoint};
use curve25519_dalek::traits::Identity;
use serde::Deserialize;

/// Public keys are 32-byte compressed ristretto255 points.
pub const PUBLIC_KEY_BYTES: usize = 32;

const SUPPORTED_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    version: u32,
    #[serde(rename = "electionId")]
    election_id: String,
    title: String,
    #[serde(rename = "votingOpensAt")]
    voting_opens_at: Option<String>,
    #[serde(rename = "votingClosesAt")]
    voting_closes_at: Option<String>,
    #[serde(rename = "ringSize")]
    ring_size: Option<u32>,
    candidates: Vec<RawCandidate>,
    rings: Vec<RawRing>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
// Only candidate_id is used by the node; the rest are accepted (and required to be absent-or-
// valid by deny_unknown_fields) so the manifest stays human-readable.
#[allow(dead_code)]
struct RawCandidate {
    #[serde(rename = "candidateId")]
    candidate_id: String,
    name: Option<String>,
    affiliation: Option<String>,
    #[serde(rename = "ballotPosition")]
    ballot_position: Option<i32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRing {
    #[serde(rename = "ringId")]
    ring_id: String,
    index: u32,
    #[serde(rename = "publicKeys")]
    public_keys: Vec<String>,
}

/// A ring: the ordered set of public keys a ballot is signed on behalf of.
#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct Ring {
    pub ring_id: String,
    pub index: u32,
    /// Ordered exactly as exported. Order is part of the signature contract — see
    /// ELECTION_MANIFEST.md. Never sort or deduplicate this.
    pub public_keys: Vec<[u8; PUBLIC_KEY_BYTES]>,
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct ElectionManifest {
    pub election_id: String,
    pub title: String,
    pub voting_opens_at: Option<String>,
    pub voting_closes_at: Option<String>,
    pub ring_size: Option<u32>,
    /// The node's valid-vote set. A ballot naming anything outside this is rejected.
    candidate_ids: HashSet<String>,
    rings: HashMap<String, Ring>,
}

// Some accessors below exist for the ballot verifier in task 2 and have no caller yet. They
// are part of this module's contract, not dead weight, so the warning is silenced explicitly
// rather than the methods being deferred.
#[allow(dead_code)]
impl ElectionManifest {
    pub fn load(path: &Path) -> Result<Self, String> {
        let contents = fs::read_to_string(path).map_err(|err| {
            format!(
                "could not read election manifest at {}: {}. Export one from the admin panel \
                 (GET /api/v1/admin/elections/:id/chain-manifest) and place it here.",
                path.display(),
                err
            )
        })?;
        Self::from_json(&contents)
    }

    pub fn from_json(contents: &str) -> Result<Self, String> {
        let raw: RawManifest = serde_json::from_str(contents)
            .map_err(|err| format!("election manifest is not valid JSON: {}", err))?;

        if raw.version != SUPPORTED_VERSION {
            // Refuse rather than guess: a later version may change the signature contract.
            return Err(format!(
                "unsupported election manifest version {} (this node understands version {})",
                raw.version, SUPPORTED_VERSION
            ));
        }
        if raw.election_id.trim().is_empty() {
            return Err("election manifest has an empty electionId".to_string());
        }
        if raw.candidates.is_empty() {
            return Err("election manifest lists no candidates".to_string());
        }
        if raw.rings.is_empty() {
            return Err("election manifest lists no anonymity groups".to_string());
        }

        let mut candidate_ids = HashSet::new();
        for candidate in &raw.candidates {
            if candidate.candidate_id.trim().is_empty() {
                return Err("election manifest has a candidate with an empty candidateId".into());
            }
            if !candidate_ids.insert(candidate.candidate_id.clone()) {
                return Err(format!(
                    "election manifest lists candidateId {} more than once",
                    candidate.candidate_id
                ));
            }
        }

        let mut rings = HashMap::new();
        for raw_ring in &raw.rings {
            if raw_ring.ring_id.trim().is_empty() {
                return Err("election manifest has a group with an empty ringId".to_string());
            }
            if raw_ring.public_keys.is_empty() {
                return Err(format!(
                    "anonymity group {} lists no public keys",
                    raw_ring.ring_id
                ));
            }

            let mut public_keys = Vec::with_capacity(raw_ring.public_keys.len());
            for (position, encoded) in raw_ring.public_keys.iter().enumerate() {
                public_keys.push(decode_public_key(encoded).map_err(|reason| {
                    format!(
                        "anonymity group {} position {}: {}",
                        raw_ring.ring_id, position, reason
                    )
                })?);
            }

            // A repeated key inside one group shrinks the real anonymity set below the group's
            // apparent size, so the group is not the thing it claims to be.
            let distinct: HashSet<&[u8; PUBLIC_KEY_BYTES]> = public_keys.iter().collect();
            if distinct.len() != public_keys.len() {
                return Err(format!(
                    "anonymity group {} contains a duplicate public key",
                    raw_ring.ring_id
                ));
            }

            let ring = Ring {
                ring_id: raw_ring.ring_id.clone(),
                index: raw_ring.index,
                public_keys,
            };
            if rings.insert(raw_ring.ring_id.clone(), ring).is_some() {
                return Err(format!(
                    "election manifest lists ringId {} more than once",
                    raw_ring.ring_id
                ));
            }
        }

        Ok(Self {
            election_id: raw.election_id,
            title: raw.title,
            voting_opens_at: raw.voting_opens_at,
            voting_closes_at: raw.voting_closes_at,
            ring_size: raw.ring_size,
            candidate_ids,
            rings,
        })
    }

    /// True if this node serves the named election. Checked before a ballot is looked at.
    pub fn is_election(&self, election_id: &str) -> bool {
        self.election_id == election_id
    }

    pub fn is_valid_candidate(&self, candidate_id: &str) -> bool {
        self.candidate_ids.contains(candidate_id)
    }

    /// The ring a ballot names, resolved from *this node's* manifest. A ring is never taken
    /// from a submission — see ELECTION_MANIFEST.md, "Why the ring travels in the manifest".
    pub fn ring(&self, ring_id: &str) -> Option<&Ring> {
        self.rings.get(ring_id)
    }

    pub fn candidate_count(&self) -> usize {
        self.candidate_ids.len()
    }

    pub fn ring_count(&self) -> usize {
        self.rings.len()
    }

    pub fn voter_count(&self) -> usize {
        self.rings.values().map(|ring| ring.public_keys.len()).sum()
    }

    /// Candidate ids as a sorted list — for logging and for the legacy vote path, which
    /// validates against this set instead of the old free-form candidate strings.
    pub fn candidate_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.candidate_ids.iter().cloned().collect();
        ids.sort();
        ids
    }
}

/// Decodes and fully validates one ring member's public key.
///
/// Every check here is a startup failure rather than a runtime surprise. A key that is not a
/// canonical, non-identity ristretto255 point cannot participate in verification: the challenge
/// chain multiplies each `P_i` by a scalar, so a member that will not decompress makes every
/// signature against that ring unverifiable — and by the time a ballot arrives, the ring is
/// published and frozen. Rejecting the manifest costs a restart; discovering it mid-election
/// costs the election.
///
/// The identity element is rejected separately because it decodes perfectly well: a ring member
/// whose "public key" is the identity has no private key behind it and silently shrinks the real
/// anonymity set by one.
fn decode_public_key(encoded: &str) -> Result<[u8; PUBLIC_KEY_BYTES], String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|err| format!("public key is not valid base64url (no padding): {}", err))?;
    if bytes.len() != PUBLIC_KEY_BYTES {
        return Err(format!(
            "public key must decode to {} bytes, got {}",
            PUBLIC_KEY_BYTES,
            bytes.len()
        ));
    }
    let mut key = [0u8; PUBLIC_KEY_BYTES];
    key.copy_from_slice(&bytes);

    // Rejects non-canonical encodings as well as bytes that are not a point at all. This is the
    // same check `api/src/lib/publicKey.ts` applies when a voter first registers, so a key that
    // reached a ring should already have passed it once — belt and braces at the last moment it
    // can still be caught cheaply.
    let point: RistrettoPoint = CompressedRistretto(key)
        .decompress()
        .ok_or_else(|| "public key is not a canonical ristretto255 point".to_string())?;
    if point == RistrettoPoint::identity() {
        return Err("public key is the identity element".to_string());
    }

    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "9hmjC7LPC-5dZ_vsfQ1S9tOO0jJs2WOD7dhNWvNjbWo";
    const KEY_B: &str = "vunFsyc-VnPCUh-4JlWOPYtCKGR5aq5j_OrStVFx3lE";

    fn manifest_json(rings: &str) -> String {
        format!(
            r#"{{
              "version": 1,
              "electionId": "election-1",
              "title": "Test",
              "votingOpensAt": null,
              "votingClosesAt": null,
              "ringSize": 2,
              "candidates": [{{ "candidateId": "cand-1" }}, {{ "candidateId": "cand-2" }}],
              "rings": {}
            }}"#,
            rings
        )
    }

    fn one_ring() -> String {
        format!(
            r#"[{{ "ringId": "ring-1", "index": 0, "publicKeys": ["{}", "{}"] }}]"#,
            KEY_A, KEY_B
        )
    }

    #[test]
    fn loads_a_valid_manifest() {
        let m = ElectionManifest::from_json(&manifest_json(&one_ring())).unwrap();
        assert!(m.is_election("election-1"));
        assert!(!m.is_election("election-2"));
        assert!(m.is_valid_candidate("cand-1"));
        assert!(!m.is_valid_candidate("cand-3"));
        assert_eq!(m.candidate_count(), 2);
        assert_eq!(m.ring_count(), 1);
        assert_eq!(m.voter_count(), 2);
    }

    #[test]
    fn preserves_public_key_order() {
        // Order is part of the signature contract; a sort here would break every ballot.
        let m = ElectionManifest::from_json(&manifest_json(&one_ring())).unwrap();
        let ring = m.ring("ring-1").unwrap();
        assert_eq!(ring.public_keys[0], decode_public_key(KEY_A).unwrap());
        assert_eq!(ring.public_keys[1], decode_public_key(KEY_B).unwrap());
    }

    #[test]
    fn unknown_ring_is_not_resolvable() {
        let m = ElectionManifest::from_json(&manifest_json(&one_ring())).unwrap();
        assert!(m.ring("ring-nope").is_none());
    }

    #[test]
    fn rejects_unsupported_version() {
        let json = manifest_json(&one_ring()).replace("\"version\": 1", "\"version\": 2");
        assert!(ElectionManifest::from_json(&json).unwrap_err().contains("version"));
    }

    #[test]
    fn rejects_short_public_key() {
        let rings = r#"[{ "ringId": "ring-1", "index": 0, "publicKeys": ["AAAA", "AAAB"] }]"#;
        assert!(
            ElectionManifest::from_json(&manifest_json(rings))
                .unwrap_err()
                .contains("32 bytes")
        );
    }

    #[test]
    fn rejects_non_base64url_public_key() {
        let rings = format!(
            r#"[{{ "ringId": "ring-1", "index": 0, "publicKeys": ["not base64!!", "{}"] }}]"#,
            KEY_B
        );
        assert!(
            ElectionManifest::from_json(&manifest_json(&rings))
                .unwrap_err()
                .contains("base64url")
        );
    }

    #[test]
    fn rejects_a_non_canonical_public_key() {
        // 32 bytes of 0xFF is well-formed base64url of the right length but is not a valid
        // ristretto255 encoding.
        let bad = URL_SAFE_NO_PAD.encode([0xFFu8; PUBLIC_KEY_BYTES]);
        let rings = format!(
            r#"[{{ "ringId": "ring-1", "index": 0, "publicKeys": ["{}", "{}"] }}]"#,
            bad, KEY_B
        );
        let err = ElectionManifest::from_json(&manifest_json(&rings)).unwrap_err();
        assert!(err.contains("canonical ristretto255 point"), "got: {}", err);
    }

    #[test]
    fn rejects_the_identity_as_a_public_key() {
        // All-zero is the canonical encoding of the identity: it decodes fine, but no private key
        // stands behind it, so it is a ring member that cannot have signed.
        let identity = URL_SAFE_NO_PAD.encode([0u8; PUBLIC_KEY_BYTES]);
        let rings = format!(
            r#"[{{ "ringId": "ring-1", "index": 0, "publicKeys": ["{}", "{}"] }}]"#,
            identity, KEY_B
        );
        let err = ElectionManifest::from_json(&manifest_json(&rings)).unwrap_err();
        assert!(err.contains("identity element"), "got: {}", err);
    }

    #[test]
    fn rejects_duplicate_key_within_a_ring() {
        let rings = format!(
            r#"[{{ "ringId": "ring-1", "index": 0, "publicKeys": ["{}", "{}"] }}]"#,
            KEY_A, KEY_A
        );
        assert!(
            ElectionManifest::from_json(&manifest_json(&rings))
                .unwrap_err()
                .contains("duplicate")
        );
    }

    #[test]
    fn rejects_duplicate_ring_id() {
        let rings = format!(
            r#"[
              {{ "ringId": "ring-1", "index": 0, "publicKeys": ["{}", "{}"] }},
              {{ "ringId": "ring-1", "index": 1, "publicKeys": ["{}", "{}"] }}
            ]"#,
            KEY_A, KEY_B, KEY_B, KEY_A
        );
        assert!(
            ElectionManifest::from_json(&manifest_json(&rings))
                .unwrap_err()
                .contains("more than once")
        );
    }

    #[test]
    fn rejects_empty_rings_and_candidates() {
        assert!(
            ElectionManifest::from_json(&manifest_json("[]"))
                .unwrap_err()
                .contains("no anonymity groups")
        );
        let no_candidates = manifest_json(&one_ring())
            .replace(r#"[{ "candidateId": "cand-1" }, { "candidateId": "cand-2" }]"#, "[]");
        assert!(
            ElectionManifest::from_json(&no_candidates)
                .unwrap_err()
                .contains("no candidates")
        );
    }
}
