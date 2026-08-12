use wincode::{SchemaRead, SchemaWrite};

use crate::block::block::Block;

/// A verified ballot waiting to be mined.
///
/// Only ballots that already passed LRS verification become tasks — the endpoint verifies before
/// queueing, and `Block::validate` verifies again on arrival.
#[derive(SchemaWrite, SchemaRead, Clone)]
pub struct MiningTask {
    pub candidate: String,
    pub ring_id: String,
    pub key_image: Vec<u8>,
    pub signature: Vec<u8>,
}

pub fn mine_block(mining_task: &MiningTask, last_block: Option<&Block>, last_idx: usize) -> Block {
    let block = Block::new(
        if last_block.is_none() {
            0
        } else {
            last_idx + 1
        },
        mining_task.candidate.clone(),
        last_block
            .as_ref()
            .map(|b| b.hash.clone())
            .unwrap_or_else(|| vec![]),
        mining_task.ring_id.clone(),
        mining_task.key_image.clone(),
        mining_task.signature.clone(),
    );
    block
}
