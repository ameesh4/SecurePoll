use std::{eprintln, sync::Arc};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rocket::State;
use rocket::config::Config;
use rocket::http::Status;
use rocket::serde::json::Json;
use serde::{Deserialize, Serialize};
use std::net::Ipv4Addr;

use crate::{
    app::App,
    block::miner::MiningTask,
    http_server::cors::cors_fairing,
    lrs::serialize::{deserialize_signature, encode_message},
    lrs::verify::verify,
    net::{
        network_message::NetworkMessageReq,
        utils::{open_stream, send_packet_req},
    },
};

// Starts a web server on 0.0.0.0:8000
pub async fn rocket_server(app_state: Arc<App>) {
    let config = Config {
        address: Ipv4Addr::UNSPECIFIED.into(),
        port: 8000,
        ..Config::default()
    };
    let r = rocket::custom(config)
        // Fairing mode: rocket_cors answers every preflight itself, so no OPTIONS route is
        // needed alongside it — see cors.rs.
        .mount(
            "/",
            rocket::routes![
                get_election,
                cast_ballot,
                get_total_votes,
                get_tally,
                get_rejected,
                get_vote,
                ],
            )
            .attach(cors_fairing())
        .manage(app_state)
        .launch()
        .await;
    if r.is_err() {
        eprintln!("Error launching server, {}", r.unwrap_err().to_string())
    }
}

/// A ballot as submitted by a voter's client.
///
/// Note what is absent: no voter id, no token, and no ring. Identity never reaches a node
/// (SECUREPOLL_CONTEXT.md §4.1), and the ring is resolved from this node's own election manifest
/// rather than taken from the request — a submitter who supplies the ring supplies a ring of one.
#[derive(Deserialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct BallotSubmission {
    election_id: String,
    ring_id: String,
    candidate_id: String,
    /// Serialized ring signature, base64url, `69 + 32·n` bytes decoded.
    signature: String,
}

/// Ballot outcomes. Distinct so the ledger can count refusals by cause, and deliberately free of
/// anything that identifies a voter.
const OK: &str = "OK";
const WRONG_ELECTION: &str = "WRONG_ELECTION";
const INVALID_CANDIDATE: &str = "INVALID_CANDIDATE";
const UNKNOWN_RING: &str = "UNKNOWN_RING";
const MALFORMED_SIGNATURE: &str = "MALFORMED_SIGNATURE";
const INVALID_SIGNATURE: &str = "INVALID_SIGNATURE";
const DOUBLE_VOTE: &str = "DOUBLE_VOTE";

/// Casts a ballot.
///
/// The order of checks below is load-bearing and must not be rearranged:
///
///   1-3. cheap manifest checks, so malformed traffic costs no curve arithmetic;
///   4.   verify the ring signature — this is the authorization, replacing any notion of
///        "who is this voter";
///   5.   ONLY THEN check the key image against the seen set.
///
/// Reversing 4 and 5 would let an attacker dodge linkability by submitting a substituted key
/// image: the seen-set would report it as merely unseen instead of the signature failing. It is
/// the challenge chain that binds the key image to the ring, so verification has to come first.
#[rocket::post("/ballot", data = "<ballot>")]
async fn cast_ballot(app_state: &State<Arc<App>>, ballot: Json<BallotSubmission>) -> String {
    let app_state = app_state.inner();
    let election = &app_state.election;
    let ballot = ballot.into_inner();

    // 1. Is this ballot even for the election this node serves?
    if !election.is_election(&ballot.election_id) {
        app_state.note_rejected_ballot();
        return WRONG_ELECTION.to_string();
    }

    // 2. Is the candidate one this election offers? Candidate ids are what the signature commits
    //    to, so an unknown one cannot have been legitimately signed.
    if !election.is_valid_candidate(&ballot.candidate_id) {
        app_state.note_rejected_ballot();
        return INVALID_CANDIDATE.to_string();
    }

    // 3. Resolve the anonymity group from OUR manifest.
    let Some(ring) = election.ring(&ballot.ring_id) else {
        app_state.note_rejected_ballot();
        return UNKNOWN_RING.to_string();
    };

    let Ok(signature_bytes) = URL_SAFE_NO_PAD.decode(ballot.signature.as_bytes()) else {
        app_state.note_rejected_ballot();
        return MALFORMED_SIGNATURE.to_string();
    };
    let signature = match deserialize_signature(&signature_bytes) {
        Ok(signature) => signature,
        Err(reason) => {
            eprintln!("BALLOT malformed: {}", reason);
            app_state.note_rejected_ballot();
            return MALFORMED_SIGNATURE.to_string();
        }
    };

    // 4. Rebuild the message locally and verify. Never accept a caller-supplied message: an
    //    attacker would keep a valid signature while the block recorded a different candidate.
    let message = encode_message(&ballot.election_id, &ballot.ring_id, &ballot.candidate_id);
    if !verify(&message, &ring.public_keys, &signature, &ballot.election_id) {
        app_state.note_rejected_ballot();
        return INVALID_SIGNATURE.to_string();
    }

    // 5. Now, and only now, the double-vote gate.
    if app_state.has_voted(&signature.key_image_bytes).await {
        app_state.note_rejected_ballot();
        return DOUBLE_VOTE.to_string();
    }

    let task = MiningTask {
        candidate: ballot.candidate_id,
        ring_id: ballot.ring_id,
        key_image: signature.key_image_bytes.to_vec(),
        signature: signature_bytes,
    };

    // Mine locally as well as fanning out. The previous implementation only distributed, so a
    // root node with no peers answered "OK" while silently discarding the vote.
    let known_peer_count = app_state.get_known_peers().await.len();
    if known_peer_count > 0 {
        let fan_out = ((known_peer_count as f64 * 0.4).ceil() as usize).max(1);
        for _ in 0..fan_out {
            distribute_vote_task(app_state.clone(), &task).await;
        }
    }
    app_state.add_mining_task(task).await;

    OK.to_string()
}

/// Every read carries the election this node serves.
///
/// A node serves exactly one election, named in the manifest it imported, so its address already
/// selects the election — but an address can be wrong. Returning `electionId` alongside the figure
/// lets a caller confirm it is reading the election it asked about, in the *same* response. A
/// separate "which election are you?" call would leave a window in which the answer and the tally
/// could describe different things.
#[derive(Serialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct ElectionSummary {
    election_id: String,
    title: String,
    candidates: usize,
    rings: usize,
    public_keys: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct TotalResponse {
    election_id: String,
    total: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct TallyResponse {
    election_id: String,
    /// Keyed by `candidateId`.
    tally: std::collections::HashMap<String, usize>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct RejectedResponse {
    election_id: String,
    rejected: usize,
}

/// What election this node serves, and how big its electorate is. Public keys only — nothing
/// here maps a key to a person.
#[rocket::get("/election")]
async fn get_election(app_state: &State<Arc<App>>) -> Json<ElectionSummary> {
    let election = &app_state.inner().election;
    Json(ElectionSummary {
        election_id: election.election_id.clone(),
        title: election.title.clone(),
        candidates: election.candidate_count(),
        rings: election.ring_count(),
        public_keys: election.voter_count(),
    })
}

#[rocket::get("/votes/total")]
async fn get_total_votes(app_state: &State<Arc<App>>) -> Json<TotalResponse> {
    let app_state = app_state.inner();
    Json(TotalResponse {
        election_id: app_state.election.election_id.clone(),
        total: app_state.get_total_votes().await,
    })
}

/// Per-candidate totals, keyed by `candidateId`.
#[rocket::get("/votes/tally")]
async fn get_tally(app_state: &State<Arc<App>>) -> Json<TallyResponse> {
    let app_state = app_state.inner();
    Json(TallyResponse {
        election_id: app_state.election.election_id.clone(),
        tally: app_state.get_tally().await,
    })
}

/// How many submissions this node refused. A count only — which voter and what they voted are
/// both unknowable here by construction, and this is not a way to find out.
#[rocket::get("/votes/rejected")]
async fn get_rejected(app_state: &State<Arc<App>>) -> Json<RejectedResponse> {
    let app_state = app_state.inner();
    Json(RejectedResponse {
        election_id: app_state.election.election_id.clone(),
        rejected: app_state.get_rejected_ballots().await,
    })
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde", rename_all = "camelCase")]
struct VoteLookupResponse {
    election_id: String,
    found: bool,
    candidate_id: Option<String>,
    block_index: Option<usize>,
    timestamp: Option<u128>,
    block_hash: Option<String>,
}

/// Looks up a single ballot by its key image, base64url-encoded (the same encoding the client
/// uses for the signature's `keyImage` field).
///
/// This is a voter's own verifiability receipt, not a lookup service over other people's votes:
/// see the note on `App::find_vote` for why presenting the key image is itself proof the caller
/// is the one who cast it.
#[rocket::get("/vote/<key_image>")]
async fn get_vote(
    app_state: &State<Arc<App>>,
    key_image: &str,
) -> Result<Json<VoteLookupResponse>, Status> {
    let app_state = app_state.inner();
    let Ok(key_image_bytes) = URL_SAFE_NO_PAD.decode(key_image.as_bytes()) else {
        return Err(Status::BadRequest);
    };

    let election_id = app_state.election.election_id.clone();
    let response = match app_state.find_vote(&key_image_bytes).await {
        Some(vote) => VoteLookupResponse {
            election_id,
            found: true,
            candidate_id: Some(vote.candidate_id),
            block_index: Some(vote.block_index),
            timestamp: Some(vote.timestamp),
            block_hash: Some(hex::encode(vote.block_hash)),
        },
        None => VoteLookupResponse {
            election_id,
            found: false,
            candidate_id: None,
            block_index: None,
            timestamp: None,
            block_hash: None,
        },
    };
    Ok(Json(response))
}

const DISTRIBUTE_MAX_ATTEMPTS: usize = 3;

async fn distribute_vote_task(app_state: Arc<App>, task: &MiningTask) {
    let known_peers = app_state.get_known_peers().await;
    if known_peers.len() == 0 {
        return;
    }

    for attempt in 1..=DISTRIBUTE_MAX_ATTEMPTS {
        let rand_peer = known_peers[rand::random_range(0..known_peers.len())];
        let stream = open_stream(&rand_peer).await;

        let mut stream = match stream {
            Ok(stream) => stream,
            Err(err) => {
                eprintln!(
                    "Attempt {}/{}: error opening stream to {}:{} - {}",
                    attempt,
                    DISTRIBUTE_MAX_ATTEMPTS,
                    rand_peer.ip,
                    rand_peer.port,
                    err.to_string()
                );
                continue;
            }
        };

        let r = send_packet_req(
            &mut stream,
            NetworkMessageReq::DistributeMiningTask(task.clone()),
        )
        .await;
        match r {
            Ok(_) => {
                println!(
                    "Sending distribute task to {} {}",
                    rand_peer.ip, rand_peer.port,
                );
                return;
            }
            Err(err) => {
                eprintln!(
                    "Attempt {}/{}: error sending ballot to {}:{} - {}",
                    attempt,
                    DISTRIBUTE_MAX_ATTEMPTS,
                    rand_peer.ip,
                    rand_peer.port,
                    err.to_string()
                );
            }
        }
    }

    eprintln!(
        "Failed to distribute ballot key_image={} after {} attempts",
        hex::encode(&task.key_image),
        DISTRIBUTE_MAX_ATTEMPTS
    );
}
