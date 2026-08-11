use wincode::{SchemaRead, SchemaWrite};

use crate::{
    block::{block::Block, miner::MiningTask},
    peer::peer::Peer,
};

#[derive(SchemaWrite, SchemaRead)]
pub enum NetworkMessageReq {
    // During Init request Peer is constructed using public IP so that the root server can communicate back
    // Peer, NodeId
    InitReq((Peer, String)),
    PushPeersReq(Vec<(Peer, String)>),
    // Chain, Sender Node Id, Vec<NodeId> This message also sent to these no need to send to them
    PushChainReq((Vec<Block>, String, Vec<String>)),
    DistributeMiningTask(MiningTask),
}

#[derive(SchemaWrite, SchemaRead)]
pub enum NetworkMessageRes {
    // Vec<Peer, NodeId>. Candidates are NOT propagated: every node imports its own election
    // manifest from disk (ELECTION_MANIFEST.md), so a peer cannot redefine this node's
    // electorate or candidate set.
    InitRes(Vec<(Peer, String)>),
    PushPeersRes,
    PushChainRes,
}
