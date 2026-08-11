use std::collections::{HashMap, HashSet};

// Per-candidate tallies plus the set of key images already counted, so reads don't require
// scanning the chain. Rebuilt whenever the chain changes.
//
// Note what is absent: there is no map from any voter identifier to a vote. The key image set
// exists only to avoid double-counting; it is not a lookup from a person to their ballot, and
// there is deliberately no endpoint that would make it one.
pub struct VoteCache {
    counted_key_images: HashSet<Vec<u8>>,
    tally: HashMap<String, usize>,
}

impl VoteCache {
    pub fn new() -> Self {
        Self {
            counted_key_images: HashSet::new(),
            tally: HashMap::new(),
        }
    }

    pub fn record_vote(&mut self, key_image: Vec<u8>, candidate: &String) {
        if self.counted_key_images.insert(key_image) {
            *self.tally.entry(candidate.clone()).or_insert(0) += 1;
        }
    }

    pub fn tally(&self) -> HashMap<String, usize> {
        self.tally.clone()
    }

    pub fn total_votes(&self) -> usize {
        self.counted_key_images.len()
    }
}
