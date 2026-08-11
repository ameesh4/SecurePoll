use crate::{
    block::{
        block::Block,
        chain::{Chain, ValidateChainRes},
        miner::{MiningTask, mine_block},
        mining_pool::MiningPool,
    },
    election::ElectionManifest,
    http_server::vote_cache::VoteCache,
    net::{
        network_message::{NetworkMessageReq, NetworkMessageRes},
        utils::{
            open_stream, save_chain_to_file, send_packet_and_wait, send_packet_req, send_packet_res,
        },
    },
    peer::{
        known_peers::KnownPeers,
        peer::{Peer, peer_exists},
    },
};
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    println,
    sync::{Arc, Mutex},
};
use tokio::{io::AsyncReadExt, net::TcpStream, task::JoinSet};



pub struct App {
    self_as_peer: Peer,
    public_ip: IpAddr,
    known_peers: Arc<Mutex<KnownPeers>>,
    chain: Arc<Mutex<Chain>>,
    /// Key images already recorded in this election. THE double-vote gate: a key image is a
    /// deterministic function of the signer's private key, so a repeat means the same voter
    /// voting twice. Never a map to any identity — see VoteCache for the same note.
    seen_key_images: Arc<Mutex<HashSet<Vec<u8>>>>,
    /// Ballots refused, for the admin panel's rejected-submission count. A count only: which
    /// voter and what they voted are both unknowable here by construction.
    rejected_ballots: Arc<Mutex<usize>>,
    /// This node's election: id, valid candidate ids, and the anonymity groups. Loaded from
    /// disk at startup and never mutated, so a plain `Arc` suffices — the previous `ArcSwap`
    /// existed only because candidates used to arrive over the network from the root peer.
    pub election: Arc<ElectionManifest>,
    node_id: String,
    mining_pool: Arc<Mutex<MiningPool>>,
    // Held while a mining attempt is in progress so a node only ever mines one block at a time.
    // Must stay a tokio Mutex: it's held across the mining loop's .await points by design.
    mining_lock: Arc<tokio::sync::Mutex<()>>,
    votes_cache: Arc<Mutex<VoteCache>>,
}

impl App {
    pub fn init(
        public_ip: IpAddr,
        node_id: String,
        self_as_peer: Peer,
        known_peers: Arc<Mutex<KnownPeers>>,
        chain: Arc<Mutex<Chain>>,
        seen_key_images: Arc<Mutex<HashSet<Vec<u8>>>>,
        election: Arc<ElectionManifest>,
    ) -> Self {
        return Self {
            public_ip,
            self_as_peer,
            known_peers,
            chain,
            node_id,
            seen_key_images,
            rejected_ballots: Arc::new(Mutex::new(0)),
            mining_pool: Arc::new(Mutex::new(MiningPool::new())),
            mining_lock: Arc::new(tokio::sync::Mutex::new(())),
            votes_cache: Arc::new(Mutex::new(VoteCache::new())),
            election,
        };
    }

    /// Has this key image already been recorded? The double-vote gate — consulted only after
    /// `verify` has succeeded.
    pub async fn has_voted(&self, key_image: &[u8]) -> bool {
        self.seen_key_images.lock().unwrap().contains(key_image)
    }

    pub async fn get_rejected_ballots(&self) -> usize {
        *self.rejected_ballots.lock().unwrap()
    }

    pub fn note_rejected_ballot(&self) {
        *self.rejected_ballots.lock().unwrap() += 1;
    }

    pub async fn get_tally(&self) -> HashMap<String, usize> {
        self.votes_cache.lock().unwrap().tally()
    }

    pub async fn get_total_votes(&self) -> usize {
        self.votes_cache.lock().unwrap().total_votes()
    }

    pub async fn get_known_peers(&self) -> Vec<Peer> {
        let peers = self.known_peers.lock().unwrap();
        return peers.peers.clone();
    }

    /// Queues a ballot for mining.
    ///
    /// The ballot must already have passed LRS verification — the endpoint verifies before
    /// calling this, and `Block::validate` verifies again. A task that arrives over the wire from
    /// a peer is re-verified here for the same reason.
    pub async fn add_mining_task(&self, mining_task: MiningTask) {
        let image = hex::encode(&mining_task.key_image);
        println!(
            "BALLOT received: key_image={} ring={} candidate={}",
            image, mining_task.ring_id, mining_task.candidate
        );

        // A task from a peer is untrusted input: verify it against this node's own manifest
        // before it can occupy a mining slot.
        if !self.verify_task(&mining_task) {
            println!("BALLOT rejected: key_image={} failed verification", image);
            self.note_rejected_ballot();
            return;
        }

        if self
            .seen_key_images
            .lock()
            .unwrap()
            .contains(&mining_task.key_image)
        {
            println!("BALLOT rejected: key_image={} has already voted", image);
            self.note_rejected_ballot();
            return;
        }

        let queued = self
            .mining_pool
            .lock()
            .unwrap()
            .add_task(mining_task, &self.election);
        if !queued {
            println!("BALLOT ignored: key_image={} is already queued", image);
            return;
        }
        println!("BALLOT queued: key_image={}", image);

        self.drive_mining_pool().await;
    }

    /// Verifies a ballot the way the endpoint does: ring from this node's manifest, message
    /// rebuilt locally, signature checked. Shared so the two paths cannot drift.
    pub fn verify_task(&self, task: &MiningTask) -> bool {
        let Some(ring) = self.election.ring(&task.ring_id) else {
            return false;
        };
        let Ok(signature) = crate::lrs::serialize::deserialize_signature(&task.signature) else {
            return false;
        };
        if signature.key_image_bytes.as_slice() != task.key_image.as_slice() {
            return false;
        }
        if !self.election.is_valid_candidate(&task.candidate) {
            return false;
        }
        let message = crate::lrs::serialize::encode_message(
            &self.election.election_id,
            &task.ring_id,
            &task.candidate,
        );
        crate::lrs::verify::verify(
            &message,
            &ring.public_keys,
            &signature,
            &self.election.election_id,
        )
    }

    // Mines tasks from the mining pool one at a time. If another call is
    // already draining the pool, this returns immediately and lets that
    // call pick up the newly queued task instead.
    async fn drive_mining_pool(&self) {
        let mining_guard = match self.mining_lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                println!("MINING already in progress, task left in pool for that run to pick up");
                return;
            }
        };

        loop {
            let task = {
                let mut mining_pool_lock = self.mining_pool.lock().unwrap();
                mining_pool_lock.take_last()
            };
            let task = match task {
                Some(task) => task,
                None => {
                    println!("MINING POOL drained, nothing left to mine");
                    break;
                }
            };

            let already_seen = self
                .seen_key_images
                .lock()
                .unwrap()
                .contains(&task.key_image);
            if already_seen {
                println!(
                    "MINING skipped: key_image={} has already voted",
                    hex::encode(&task.key_image)
                );
                continue;
            }

            println!(
                "MINING started: key_image={} candidate={}",
                hex::encode(&task.key_image),
                task.candidate
            );

            let (last_block, len) = {
                let chain_lock = self.chain.lock().unwrap();
                (chain_lock.last().cloned(), chain_lock.len())
            };

            let block = tokio::task::spawn_blocking(move || {
                mine_block(
                    &task,
                    last_block.as_ref(),
                    if len > 0 { len - 1 } else { 0 },
                )
            })
            .await;

            if let Ok(block) = block {
                println!(
                    "MINING finished: key_image={} idx={} hash={}",
                    hex::encode(&block.key_image),
                    block.idx,
                    hex::encode(&block.hash)
                );
                let requeue_task = MiningTask {
                    candidate: block.data.clone(),
                    ring_id: block.ring_id.clone(),
                    key_image: block.key_image.clone(),
                    signature: block.signature.clone(),
                };
                if self.add_block_to_chain(block).await == ValidateChainRes::AttemptedLateAdd {
                    println!(
                        "BALLOT requeued: key_image={} lost the race for this chain slot",
                        hex::encode(&requeue_task.key_image)
                    );
                    self.mining_pool.lock().unwrap().requeue(requeue_task);
                }
            }
        }

        drop(mining_guard);
    }

    pub async fn root_peer_discovery(&self, root_peer: Peer, peer_id: &str) -> Result<(), String> {
        let peers = self.get_known_peers().await;
        if !peer_exists(&peers, &root_peer) {
            self.add_peer_serializable(root_peer, peer_id.to_string())
                .await;
        }
        let stream = open_stream(&root_peer).await;
        if let Ok(mut stream) = stream {
            let res = send_packet_and_wait(
                &mut stream,
                NetworkMessageReq::InitReq((
                    Peer {
                        ip: self.public_ip,
                        port: self.self_as_peer.port,
                    },
                    self.node_id.clone(),
                )),
            )
            .await;
            return match res {
                Ok(res) => match res {
                    NetworkMessageRes::InitRes(res) => {
                        for (peer, id) in res {
                            self.add_peer_serializable(peer, id).await;
                        }
                        return Ok(());
                    }
                    _ => Err("Peer discovery response invalid".to_string()),
                },
                Err(e) => Err(format!(
                    "Error while waiting for peer discovery response: {}",
                    e.to_string()
                )),
            };
        };
        return Err("Could not open stream to root peer".to_string());
    }

    pub async fn server_process(&self, stream: &mut TcpStream) {
        let mut buff = [0; 1024];
        let mut final_buff = Vec::new();
        stream.readable().await.unwrap();
        loop {
            let bytes_read = stream.read(&mut buff).await.unwrap();
            final_buff.extend_from_slice(&buff[..bytes_read]);
            if bytes_read < 1024 {
                break;
            }
            // set a max limit?
        }
        let buff = &final_buff;
        let req = wincode::deserialize::<NetworkMessageReq>(&buff);
        if let Ok(req) = req {
            match req {
                NetworkMessageReq::InitReq((peer_serializable, id)) => {
                    println!("Received peer discovery request");
                    let peer = peer_serializable;
                    let peer_added = {
                        let mut known_peers_lock = self.known_peers.lock().unwrap();
                        if peer != self.self_as_peer && !peer_exists(&known_peers_lock.peers, &peer)
                        {
                            known_peers_lock.add_peer(peer, id);
                            true
                        } else {
                            false
                        }
                    };
                    let mut entries = vec![];
                    {
                        let known_peers_lock = self.known_peers.lock().unwrap();
                        entries = known_peers_lock.as_entries();
                    }
                    let _r = send_packet_res(stream, NetworkMessageRes::InitRes(entries)).await;

                    self.push_peer_sync().await;
                    if peer_added {
                        self.save_chain().await;
                    }
                }
                NetworkMessageReq::PushChainReq((chain, sender_node_id, already_sent)) => {
                    println!("Received chain sync");
                    self.sync_chain(chain, sender_node_id, already_sent).await;
                }
                NetworkMessageReq::PushPeersReq(peers) => {
                    self.add_multiple_peer(&peers).await;
                }
                NetworkMessageReq::DistributeMiningTask(mining_task) => {
                    self.add_mining_task(mining_task).await;
                }
            }
        } else {
            println!("Failed to deserialize network message");
            return;
        }
    }

    pub async fn add_peer_serializable(&self, peer: Peer, id: String) {
        if peer == self.self_as_peer {
            return;
        }
        let added = {
            let mut known_peers_lock = self.known_peers.lock().unwrap();
            if !peer_exists(&known_peers_lock.peers, &peer) {
                known_peers_lock.add_peer(peer, id);
                true
            } else {
                false
            }
        };
        if added {
            self.push_peer_sync().await;
            self.save_chain().await;
        }
    }

    pub async fn sync_chain(
        &self,
        new_chain: Vec<Block>,
        sender_node_id: String,
        already_sent: Vec<String>,
    ) {
        let new_len = new_chain.len();
        let outcome = {
            let mut chain_lock = self.chain.lock().unwrap();
            let mut seen_key_images_lock = self.seen_key_images.lock().unwrap();
            let mut known_peers_lock = self.known_peers.lock().unwrap();
            let validation_result = Chain::validate(&new_chain, &chain_lock, &self.election);
            let current_len = chain_lock.len();
            match validation_result {
                Ok(()) => {
                    chain_lock.clear();
                    seen_key_images_lock.clear();
                    let mut votes_cache = VoteCache::new();
                    for node in &new_chain {
                        seen_key_images_lock.insert(node.key_image.clone());
                        votes_cache.record_vote(node.key_image.clone(), &node.data);
                    }
                    chain_lock.extend(new_chain);
                    let chain_hash = chain_lock.hash();
                    known_peers_lock.update_chain_hash(&sender_node_id, chain_hash.clone());
                    Ok((current_len, votes_cache, chain_hash))
                }
                Err(reason) => Err((current_len, reason)),
            }
        };
        match outcome {
            Ok((current_len, votes_cache, chain_hash)) => {
                *self.votes_cache.lock().unwrap() = votes_cache;
                println!(
                    "ACCEPTED chain from peer: {} blocks (previous: {} blocks)",
                    new_len, current_len
                );
                let mut peers_to_ignore = vec![];
                {
                    let known_peers_lock = self.known_peers.lock().unwrap();
                    let known_peers = known_peers_lock.as_entries_with_hash();
                    peers_to_ignore = known_peers
                        .iter()
                        .filter(|(_, _, hash)| *hash == chain_hash)
                        .map(|(_, id, _)| id.clone())
                        .collect();
                }
                {
                    let mut known_peers_lock = self.known_peers.lock().unwrap();
                    known_peers_lock.update_chain_hash_all(chain_hash);
                }
                peers_to_ignore.extend(already_sent);
                self.push_chain_sync(&peers_to_ignore).await;
                self.save_chain().await;
            }
            Err((current_len, reason)) => {
                println!(
                    "IGNORED chain from peer: {} blocks (current: {} blocks) - reason: {}",
                    new_len, current_len, reason
                );
            }
        }
    }

    async fn add_block_to_chain(&self, block: Block) -> ValidateChainRes {
        let (result, added_vote) = {
            let mut chain_lock = self.chain.lock().unwrap();
            let mut seen_key_images = self.seen_key_images.lock().unwrap();
            let result =
                Chain::validate_addition(&seen_key_images, &chain_lock, &block, &self.election);
            let mut added_vote = None;
            match result {
                ValidateChainRes::AddBlock => {
                    let key_image = block.key_image.clone();
                    let candidate = block.data.clone();
                    chain_lock.push(block);
                    seen_key_images.insert(key_image.clone());
                    added_vote = Some((key_image, candidate));
                }
                ValidateChainRes::AttemptedLateAdd => {}
                ValidateChainRes::IgnoreBlock => {
                    println!("IGNORING INVALID BLOCK")
                }
            }
            (result, added_vote)
        };
        if let Some((key_image, candidate)) = added_vote {
            self.votes_cache
                .lock()
                .unwrap()
                .record_vote(key_image, &candidate);
            // When new block is mined no peer has it so we can ignore this parameter
            self.push_chain_sync(&vec![]).await;
            self.save_chain().await;
        }
        result
    }

    // Peer, Id
    async fn add_multiple_peer(&self, peers: &[(Peer, String)]) {
        let grew = {
            let mut known_peers_lock = self.known_peers.lock().unwrap();
            let old_len = known_peers_lock.peers.len();
            for (peer, id) in peers {
                if *peer != self.self_as_peer && !peer_exists(&known_peers_lock.peers, &peer) {
                    known_peers_lock.add_peer(*peer, id.clone());
                }
            }
            known_peers_lock.peers.len() > old_len
        };
        if grew {
            self.push_peer_sync().await;
            self.save_chain().await;
        }
    }

    async fn push_peer_sync(&self) {
        let mut join_set = JoinSet::new();
        {
            let known_peers_lock = self.known_peers.lock().unwrap();
            let peer_entries = known_peers_lock.as_entries();
            let len = peer_entries.len();
            drop(known_peers_lock);
            let peer_entries = peer_entries.clone();
            for i in 0..len {
                let (peer, _id) = peer_entries[i].clone();
                let peer_entries = peer_entries.clone();
                join_set.spawn(async move {
                    let stream = open_stream(&peer).await;
                    if let Ok(mut stream) = stream {
                        let r = send_packet_req(
                            &mut stream,
                            NetworkMessageReq::PushPeersReq(peer_entries),
                        )
                        .await;
                        if let Ok(_) = r {
                            return Ok(peer);
                        } else {
                            return Err(peer);
                        }
                    }
                    return Err(peer);
                });
            }
        }
        println!("TASKS LEN, {}", join_set.len());

        let failed_peers = join_set
            .join_all()
            .await
            .iter()
            .filter(|r| r.is_err())
            .map(|r| r.unwrap_err())
            .collect::<Vec<Peer>>();

        let peer_removed = {
            let mut known_peers_lock = self.known_peers.lock().unwrap();
            let mut peer_removed = false;
            for peer in failed_peers {
                if known_peers_lock.remove_peer_with_peer(&peer) {
                    peer_removed = true;
                }
            }
            peer_removed
        };
        if peer_removed {
            self.save_chain().await;
        }
    }

    async fn push_chain_sync(&self, ignore_peers: &[String]) {
        println!("PUSHING CHAIN SYNC");
        let mut join_set = JoinSet::new();
        {
            let known_peers_lock = self.known_peers.lock().unwrap();
            let chain_lock = self.chain.lock().unwrap();
            let peers_list = known_peers_lock
                .as_entries()
                .iter()
                .filter(|(_, id)| !ignore_peers.contains(id))
                .map(|v| v.clone())
                .collect::<Vec<(Peer, String)>>();
            let chain: Vec<Block> = chain_lock.to_vec();
            let len = peers_list.len();
            let sent_ids = peers_list
                .clone()
                .into_iter()
                .map(|v| v.1)
                .collect::<Vec<String>>();
            let peers_list = peers_list
                .clone()
                .into_iter()
                .map(|v| v.0)
                .collect::<Vec<Peer>>();
            drop(known_peers_lock);
            drop(chain_lock);
            let node_id = self.node_id.clone();
            for i in 0..len {
                let peer = peers_list[i].clone();
                let chain = chain.clone();
                let node_id = node_id.clone();
                let sent_ids = sent_ids.clone();
                join_set.spawn(async move {
                    let stream = open_stream(&peer).await;
                    if let Ok(mut stream) = stream {
                        let r = send_packet_req(
                            &mut stream,
                            NetworkMessageReq::PushChainReq((chain, node_id, sent_ids.clone())),
                        )
                        .await;
                        if let Ok(_) = r {
                            return Ok(peer);
                        } else {
                            return Err(peer);
                        }
                    }
                    return Err(peer);
                });
            }
        }
        println!("TASKS LEN, {}", join_set.len());

        let failed_peers = join_set
            .join_all()
            .await
            .iter()
            .filter(|r| r.is_err())
            .map(|r| r.unwrap_err())
            .collect::<Vec<Peer>>();

        let peer_removed = {
            let mut known_peers_lock = self.known_peers.lock().unwrap();
            let mut peer_removed = false;
            for peer in failed_peers {
                if known_peers_lock.remove_peer_with_peer(&peer) {
                    peer_removed = true;
                }
            }
            peer_removed
        };
        if peer_removed {
            self.save_chain().await;
        }
    }

    pub async fn save_chain(&self) {
        let filename = format!("chain_{}.bin", self.node_id);
        let known_peers_lock = self.known_peers.lock().unwrap();
        let chain_lock = self.chain.lock().unwrap();
        let _ = save_chain_to_file(
            &chain_lock,
            &filename,
            self.self_as_peer.clone(),
            &known_peers_lock.peers,
        );
        let known_peer_addresses = known_peers_lock
            .peers
            .iter()
            .map(|peer| format!("{}:{}", peer.ip, peer.port))
            .collect::<Vec<String>>();
        drop(chain_lock);
        drop(known_peers_lock);

        let self_address = format!("{}:{}", self.self_as_peer.ip, self.self_as_peer.port);
        println!("Chain saved to {}", filename);
        println!("Self address: {}", self_address);
        if known_peer_addresses.is_empty() {
            println!("Known peers: none");
        } else {
            println!("Known peers: {}", known_peer_addresses.join(", "));
        }
    }
}
