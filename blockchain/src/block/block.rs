use crate::election::ElectionManifest;
use crate::lrs::serialize::deserialize_signature;
use crate::lrs::verify::verify;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use wincode::{SchemaRead, SchemaWrite};

const DIFFICULTY: usize = 20;
fn check_leading_zeroes(hash: &[u8], difficulty: usize) -> bool {
    let full_bytes = difficulty / 8;
    let remaining_bits = difficulty % 8;
    if hash.iter().take(full_bytes).any(|&b| b != 0) {
        return false;
    }
    if remaining_bits > 0 {
        if full_bytes >= hash.len() {
            return false;
        }
        let next_byte = hash[full_bytes];
        if next_byte >> (8 - remaining_bits) != 0 {
            return false;
        }
    }
    return true;
}

/// One recorded ballot.
///
/// There is deliberately no voter identity here. Authorization is the ring signature, and
/// one-vote-per-voter is the key image — see SECUREPOLL_CONTEXT.md §4.1. A `voter_id` field used
/// to live here and recorded identity against vote in plaintext, which is precisely what the
/// ring signature exists to prevent.
#[derive(SchemaWrite, SchemaRead, Clone, Debug)]
pub struct Block {
    pub idx: usize,
    /// The chosen `candidateId`. Named `data` for historical reasons.
    pub data: String,
    pub prev_hash: Vec<u8>,
    pub nonce: Option<u128>,
    pub hash: Vec<u8>,
    /// Which anonymity group the ballot was signed against. The keys themselves are NOT stored:
    /// they come from the node's election manifest, so a block cannot smuggle in its own ring.
    pub ring_id: String,
    /// The linkability tag, `I = x·H_p(P ‖ electionId)`. Two blocks carrying the same key image
    /// are the same voter voting twice.
    pub key_image: Vec<u8>,
    /// The serialized ring signature, `69 + 32·n` bytes (see WIRE_FORMAT.md).
    pub signature: Vec<u8>,
    // Milliseconds since UNIX_EPOCH when the block was mined
    pub timestamp: u128,
}

impl Block {
    pub fn validate(block: &Self, election: &ElectionManifest) -> bool {
        // The block needs to have a nonce
        if block.nonce.is_none() {
            return false;
        }
        // the block needs to have a hash
        if block.hash.is_empty() {
            return false;
        }


        // the block needs to have set number of leading zeroes
        if !check_leading_zeroes(block.hash.as_slice(), DIFFICULTY) {
            return false;
        }

        // `data` carries the chosen candidate id, which must be one this election offers.
        if !election.is_valid_candidate(&block.data) {
            return false;
        }

        // A block arriving by gossip is re-verified, not trusted. This is the same check the
        // ballot endpoint ran before mining: resolve the ring from THIS node's manifest, rebuild
        // the message locally, and confirm the signature closes.
        if !Self::verify_ballot(block, election) {
            return false;
        }

        let mut block_clone = block.clone();
        block_clone.hash = vec![];
        block_clone.nonce = None;
        // Check if the reported hash is correct
        // convert to bytes without hash and nonce
        let p = wincode::serialize(&block_clone);
        if p.is_err() {
            return false;
        }
        let mut hasher = Sha256::new();
        hasher.update(&p.unwrap());
        // update hasher with reported nonce
        hasher.update(block.nonce.unwrap().to_be_bytes());
        let h = hasher.finalize();
        // check if final hash matches reported hash
        return *h == block.hash;
    }

    /// Re-runs LRS verification for a block against the node's manifest.
    ///
    /// Kept separate from `validate` so the ballot endpoint and block validation cannot drift
    /// apart: both call this.
    pub fn verify_ballot(block: &Self, election: &ElectionManifest) -> bool {
        let Some(ring) = election.ring(&block.ring_id) else {
            // A ring this node does not know about. Either the block is forged or this node
            // holds a different manifest than its peers.
            return false;
        };
        let Ok(signature) = deserialize_signature(&block.signature) else {
            return false;
        };
        // The key image on the block must be the one inside the signature, or the dedup key and
        // the verified ballot would describe different things.
        if signature.key_image_bytes.as_slice() != block.key_image.as_slice() {
            return false;
        }

        let message = crate::lrs::serialize::encode_message(
            &election.election_id,
            &block.ring_id,
            &block.data,
        );
        verify(
            &message,
            &ring.public_keys,
            &signature,
            &election.election_id,
        )
    }

    pub fn new(
        idx: usize,
        data: String,
        prev_hash: Vec<u8>,
        ring_id: String,
        key_image: Vec<u8>,
        signature: Vec<u8>,
    ) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time is before UNIX_EPOCH")
            .as_millis();
        let mut block = Block {
            idx,
            data,
            prev_hash,
            nonce: None,
            hash: vec![],
            ring_id,
            key_image,
            signature,
            timestamp,
        };
        block.hash();
        return block;
    }
    pub fn hash(&mut self) {
        self.hash = vec![];
        self.nonce = None;
        // Convert to bytes without the hash and nonce
        let p = wincode::serialize(self).expect("Error while serializing block");
        let mut base_hasher = Sha256::new();
        base_hasher.update(&p);
        let v = (0u128..u128::MAX).into_par_iter().find_any(|v| {
            let mut hasher = base_hasher.clone();
            // append candidate nonce to hasher
            hasher.update(&v.to_be_bytes());
            let h = hasher.finalize();
            // check for leading zeroes
            return check_leading_zeroes(h.as_slice(), DIFFICULTY);
        });

        // update the block with hash and nonce
        let nonce = v.expect("No nonce found");
        self.nonce = Some(nonce);
        let mut final_hasher = base_hasher.clone();
        final_hasher.update(nonce.to_be_bytes());
        // p.extend(nonce.to_be_bytes().as_ref());
        self.hash = final_hasher.finalize().to_vec();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const VECTORS: &str = include_str!("../../../web/src/crypto/lrs/test-vectors/vectors.json");

    /// Builds a manifest around a committed test vector, so the gate is exercised against a real
    /// signature produced by the TypeScript signer rather than a hand-rolled fixture.
    fn manifest_and_block() -> (ElectionManifest, Block) {
        let doc: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
        let vector = doc["vectors"]
            .as_array()
            .expect("vectors")
            .iter()
            .find(|v| v["expected"].as_bool() == Some(true))
            .expect("a passing vector");

        let election_id = vector["electionId"].as_str().unwrap();
        let ring_id = vector["ringId"].as_str().unwrap();
        let candidate_id = vector["candidateId"].as_str().unwrap();
        let keys: Vec<String> = vector["ring"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| format!("\"{}\"", k.as_str().unwrap()))
            .collect();
        let signature = URL_SAFE_NO_PAD
            .decode(vector["signature"].as_str().unwrap().as_bytes())
            .expect("valid base64url");
        let key_image = signature[37..69].to_vec();

        let json = format!(
            r#"{{
              "version": 1,
              "electionId": "{eid}",
              "title": "Vector Election",
              "votingOpensAt": null,
              "votingClosesAt": null,
              "ringSize": {n},
              "candidates": [{{ "candidateId": "{cid}" }}, {{ "candidateId": "other-candidate" }}],
              "rings": [{{ "ringId": "{rid}", "index": 0, "publicKeys": [{keys}] }}]
            }}"#,
            eid = election_id,
            cid = candidate_id,
            rid = ring_id,
            n = keys.len(),
            keys = keys.join(",")
        );
        let manifest = ElectionManifest::from_json(&json).expect("manifest loads");

        let block = Block {
            idx: 0,
            data: candidate_id.to_string(),
            prev_hash: vec![],
            nonce: Some(1),
            hash: vec![1],
            ring_id: ring_id.to_string(),
            key_image,
            signature,
            timestamp: 0,
        };
        (manifest, block)
    }

    #[test]
    fn accepts_a_real_ballot() {
        let (manifest, block) = manifest_and_block();
        assert!(Block::verify_ballot(&block, &manifest));
    }

    #[test]
    fn rejects_a_candidate_swap() {
        // The candidate id is inside the signed message, so re-pointing the block at a different
        // candidate must break verification — this is what stops a node rewriting a ballot.
        let (manifest, mut block) = manifest_and_block();
        block.data = "other-candidate".to_string();
        assert!(!Block::verify_ballot(&block, &manifest));
    }

    #[test]
    fn rejects_an_unknown_ring() {
        let (manifest, mut block) = manifest_and_block();
        block.ring_id = "ring-that-does-not-exist".to_string();
        assert!(!Block::verify_ballot(&block, &manifest));
    }

    #[test]
    fn rejects_a_key_image_that_disagrees_with_the_signature() {
        // The block's dedup key and the verified ballot must describe the same thing, or the
        // seen-set would be policing a value the signature never committed to.
        let (manifest, mut block) = manifest_and_block();
        block.key_image[0] ^= 0x01;
        assert!(!Block::verify_ballot(&block, &manifest));
    }

    #[test]
    fn rejects_a_tampered_signature() {
        let (manifest, mut block) = manifest_and_block();
        let last = block.signature.len() - 1;
        block.signature[last] ^= 0x01;
        assert!(!Block::verify_ballot(&block, &manifest));
    }

    #[test]
    fn rejects_a_ballot_for_another_election() {
        let (_, block) = manifest_and_block();
        let doc: serde_json::Value = serde_json::from_str(VECTORS).expect("valid JSON");
        let vector = doc["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["expected"].as_bool() == Some(true))
            .unwrap();
        let keys: Vec<String> = vector["ring"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| format!("\"{}\"", k.as_str().unwrap()))
            .collect();
        // Same ring and same ballot, but the node serves a different election: the key-image
        // bases differ, so the chain cannot close.
        let json = format!(
            r#"{{
              "version": 1, "electionId": "a-different-election", "title": "X",
              "votingOpensAt": null, "votingClosesAt": null, "ringSize": {n},
              "candidates": [{{ "candidateId": "{cid}" }}],
              "rings": [{{ "ringId": "{rid}", "index": 0, "publicKeys": [{keys}] }}]
            }}"#,
            n = keys.len(),
            cid = block.data,
            rid = block.ring_id,
            keys = keys.join(",")
        );
        let other = ElectionManifest::from_json(&json).expect("manifest loads");
        assert!(!Block::verify_ballot(&block, &other));
    }
}
