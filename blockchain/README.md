# bk-rs

A blockchain-based voting system in Rust. Votes are recorded as proof-of-work-mined blocks
gossiped across a peer-to-peer network of nodes, with one node exposing an HTTP API for casting
votes and reading results.

## How it works

- **Elections**: a node serves exactly one election, described by an **election manifest** it
  imports from disk at startup (`--election`, default `election.json`). The manifest carries the
  election id, the valid candidate ids, and the anonymity groups (ordered public keys) — see
  `ELECTION_MANIFEST.md`. Export it from the admin panel's Groups page. Each election runs its
  own separate network, so every node in a network must hold the same manifest. A node with no
  manifest, or an unreadable one, refuses to start.
- **Nodes** communicate over raw TCP using length-delimited, `wincode`-serialized messages
  (`src/net/network_message.rs`). Each node has a string **peer id** (`--node-id`, e.g. `node0`)
  used to identify it in every other node's peer table, separate from its `Peer` (IP + port). A
  node either starts as the **root** (no `--root-ip`/`--root-port` given) or joins an existing
  network by connecting to a root peer's IP/port/id.
- **Peer discovery**: a joining node sends a `PeerDiscoveryReq` (its own `Peer` + peer id) to the
  root peer and gets back the root's current peer table (`Vec<(Peer, id)>`), then gossips its own
  presence to the network with `PushPeersReq` (`App::push_peer_sync`).
- **Voting**: the root peer runs a [Rocket](https://rocket.rs/) HTTP server
  (`src/http_server/http.rs`) exposing `POST /ballot` plus tally reads. A ballot is verified
  against the manifest's anonymity group before anything else happens; only then does it become a
  `MiningTask`, mined locally and fanned out (`DistributeMiningTask`) to a subset of known peers
  (`fan_out = ceil(known_peers * 0.4)`). Tasks arriving from a peer are re-verified — a peer is
  untrusted input.
- **Mining**: a block is valid once its SHA-256 hash has a configured number of leading zero bits
  (`DIFFICULTY` in `src/block/block.rs`). Blocks link to the previous block's hash and record the
  chosen `candidateId`, the `ringId`, the **key image**, and the ring signature — no voter
  identity. `Block::validate` re-verifies the signature, so a block arriving by gossip is checked
  rather than trusted. Each key image can be counted only once: repeats already seen or already
  queued are dropped (`App::add_mining_task`, `MiningPool::add_task`). Mining runs one block at a time per node
  (`App::mining_lock`), racing against blocks mined elsewhere; a node that loses the race requeues
  its task against the new chain tip (`ValidateChainRes::AttemptedLateAdd`).
- **Chain sync and gossip flood prevention**: nodes validate and adopt the longest/newer valid
  chain seen from peers (`App::sync_chain`), rebuilding an in-memory vote cache
  (`src/http_server/vote_cache.rs`) for O(1) vote lookups and tallying instead of rescanning the
  chain. Each node's `Chain::hash()` (an MD5 digest of the serialized chain, distinct from each
  block's own SHA-256 PoW hash) is tracked per known peer in `KnownPeers::id_map`. When a chain
  update is accepted, it's only re-pushed to peers whose tracked hash doesn't already match — plus
  whichever peer ids the sender already forwarded to (`PushChainReq`'s `already_sent` list),
  passed along and merged at each hop. This "already sent" set stops the same chain from being
  re-gossiped endlessly around the peer graph.

## Project layout

```
src/
  main.rs                       CLI arg parsing (clap), node startup, TCP listener loop
  app.rs                        shared node state (App): peers, chain, mining, gossip/sync logic
  block/
    block.rs                    Block + Candidate definitions, PoW hashing/validation
    chain.rs                    Chain (Vec<Block>) validation, extension, and hashing
    miner.rs                    MiningTask, block mining entry point
    mining_pool.rs               per-node queue of pending mining tasks, deduped by voter_id
  peer/
    peer.rs                     Peer struct (ip/port)
    known_peers.rs               peer id -> (Peer, last known chain hash) table
  net/
    network_message.rs           wire message enums (req/res)
    utils.rs                     TCP send/receive helpers, chain-to-file dump
  http_server/
    http.rs                      Rocket HTTP API (root peer only)
    vote_cache.rs                 voter_id -> vote map and tallies, rebuilt on chain sync
  election.rs                   election manifest import: id, candidate ids, anonymity groups
  lrs/
    hash.rs                     H_p (RFC 9380 hash-to-ristretto255), H_s, challenge transcript
    serialize.rs                signature/message decoding and its rejection rules
    verify.rs                   LSAG verification, linkability, key-image keys
election.json                   the election manifest this node serves (see ELECTION_MANIFEST.md)
launch_nodes.py                 spins up N local nodes (1 root + N-1 peers, or all peers with --no-root)
tally.py                        verifies cast votes and compares tallies against the chain (orphaned, see below)
```

## Cross-origin requests (CORS)

Ballots are submitted by the voter's **browser**, directly to a node. A ballot carries
`Content-Type: application/json`, which makes it a non-simple cross-origin request, so the browser
sends an `OPTIONS` preflight first and refuses to send the ballot at all unless that preflight is
answered. `src/http_server/cors.rs` supplies both halves — a fairing for the headers and a
catch-all `OPTIONS` route, because Rocket needs a route to dispatch the preflight to.

The ballot has to reach the node directly: routing it through the verification server would be
easier and is forbidden, because that server must never see a ballot.

`Access-Control-Allow-Origin` is `*`, which is not a hole. **CORS is a browser mechanic, not this
endpoint's security boundary.** The ballot endpoint accepts no cookies, no `Authorization` header
and no credentials, so it cannot be induced to act with someone else's authority — the CSRF shape
same-origin policy exists to prevent. A malicious page POSTing here achieves exactly what `curl`
already could. Authorization is the ring signature: anyone may *offer* a ballot, but only a holder
of a private key in a published group can offer one that verifies, and only once per election.

Verify it with:

```bash
curl -i -X OPTIONS http://127.0.0.1:8000/ballot \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

## Breaking change: block layout

`Block` no longer carries `voter_id`; it carries `ring_id`, `key_image` and `signature`. This
changes the `wincode` layout, so:

- existing `chain_*.bin` dumps are meaningless against the new format;
- **every node in a network must be rebuilt and restarted together** — a node running the old
  layout cannot deserialize a `PushChainReq` from a new one.

## Building

Requires a Rust toolchain (edition 2024).

```bash
cargo build --release
```

## Running a network directly with `cargo run` / the built binary

`src/main.rs` takes these flags (defaults shown are what the Rust binary itself falls back to):

| Flag | Default | Description |
|------|---------|-------------|
| `--node-id` | `node_0` | Identifier for this node |
| `--root-ip` | *(none)* | IP of the root node to join; omit to run as root |
| `--root-port` | *(none)* | Port of the root node to join; omit to run as root |
| `--root-id` | `node_0` | Identifier of the root node to join |
| `--public-ip` | `0.0.0.0` | Public IP address for this node |
| `--election` | `election.json` | Path to the election manifest (see `ELECTION_MANIFEST.md`) |

A node only attempts to join an existing network when `--root-ip` and `--root-port` are both
given; otherwise it starts as root and launches the Rocket HTTP server on port 8000. There's no
flag to choose the P2P port: every node binds `0.0.0.0:0` and lets the OS assign a free port,
which it reports on startup (and which is what other nodes should be pointed at via `--root-port`)
- this avoids port collisions when running multiple nodes on one machine.

Start a root node:

```bash
cargo run -- --node-id node0
```

The node prints the TCP address it bound for peer traffic, e.g. `IP: 127.0.0.1, Port: 54321`.
Start additional peers pointing at that address:

```bash
cargo run -- --node-id node1 --root-ip 127.0.0.1 --root-port 54321 --root-id node0
```

Or with the compiled release binary:

```bash
./target/release/bk-rs --node-id node1 --root-ip 127.0.0.1 --root-port 54321 --root-id node0
```

## Running a network with the Python helper

`launch_nodes.py` wraps the above, wiring the root id/IP/port through automatically:

```bash
python3 launch_nodes.py 5
```

`launch_nodes.py` options:

| Flag | Description |
|------|-------------|
| `n` (positional) | Total number of nodes to launch (including root, unless `--no-root` is set) |
| `--node-prefix` | Node name prefix, e.g. `node` for `node0`, `node1`, ... (default: `node`) |
| `--connect-ip` | IP peers use to reach the root node (default: `0.0.0.0`); with `--no-root`, this is the external root's IP |
| `-p`, `--public-ip` | Public IP passed to every launched node (default: `0.0.0.0`, matching the Rust default) |
| `-b`, `--binary` | Run the compiled `target/release/bk-rs` binary instead of `cargo run` (requires `cargo build --release` first) |
| `-nr`, `--no-root` | Don't launch a local root node; instead connect all `n` launched nodes to an already-running external root (requires `--root-port` and `--root-id`, with `--connect-ip` set to the external root's IP) |
| `--root-port` | Port of the external root node to connect to (required with `--no-root`) |
| `--root-id` | Identifier of the external root node to connect to (default: `node_0`, used with `--no-root`) |

## Casting votes for a demo

`vote.py` is gone — it POSTed to `/add_vote/<voter_id>/<vote>`, which was removed when casting
started requiring a real LSAG signature, and it never worked again after that. Casting now needs
a real ring signature over a real published group, which only the TypeScript library in
`web/src/crypto/lrs` implements, so its replacement lives where that library can be imported
directly instead of reimplemented: **`api/src/scripts/vote.ts`**, run with `bun run vote` from
`api/`.

It drives the same path a voter's browser does: redeem a ballot-access token against the
verification server, sign the canonical message with the LRS library, POST the signed ballot
straight to a node. It only works for voters seeded with `bun run db:seed-registrations` (the
only ones this server ever holds a private key for) and only outside `NODE_ENV=production` (the
only setting where a token's plaintext is saved to disk at all — see
`api/src/lib/demoTokenStore.ts`). See `api/src/scripts/vote.ts` for the full flow and usage.

With a root node running its HTTP server (default `0.0.0.0:8000`, matching the Rust node's
`--public-ip` default and Rocket's fixed port):

```bash
cd api && bun run vote --election <electionId> --root-ip 0.0.0.0 --root-port 8000
```

`tally.py` is still here but now doubly orphaned: it already didn't work against the current
`/votes/tally` response shape, and it also read `votes_record.jsonl`, a file only `vote.py` ever
wrote. Reading `GET /votes/tally` directly (`curl http://<root-ip>:<root-port>/votes/tally`) is
the simplest way to check a demo's result today.

### HTTP API (root peer)

| Method | Path              | Description |
|--------|-------------------|-------------|
| GET    | `/election`       | Which election this node serves, and the size of its electorate |
| POST   | `/ballot`         | Cast a signed ballot (JSON, see below) |
| GET    | `/votes/total`    | `{ electionId, total }` |
| GET    | `/votes/tally`    | `{ electionId, tally: { candidateId: count } }` |
| GET    | `/votes/rejected` | `{ electionId, rejected }` — a count only |

**Every read echoes `electionId`.** A node serves exactly one election, so its address already
selects the election — but an address can be wrong. Returning the election id in the *same*
response as the figure lets a caller confirm it is reading what it asked for;
`HttpChainAdapter` in the admin panel refuses any answer whose `electionId` does not match, so
an election pointed at the wrong network fails loudly instead of displaying another election's
result as its own. A separate "which election are you?" call would leave a window in which the
answer and the data could describe different things.

```json
POST /ballot
{ "electionId": "…", "ringId": "…", "candidateId": "…", "signature": "<base64url>" }
```

Replies with one of `OK`, `WRONG_ELECTION`, `INVALID_CANDIDATE`, `UNKNOWN_RING`,
`MALFORMED_SIGNATURE`, `INVALID_SIGNATURE`, `DOUBLE_VOTE`.

**No voter identity is submitted, and there is no endpoint that reveals how anyone voted.**
Authorization is the ring signature: it proves the signer holds a private key in the group named
by `ringId`, without revealing which. One-vote-per-voter is the key image, not an identity. The
ring itself is never taken from the request — it is resolved from this node's election manifest,
because a submitter who supplies the ring supplies a ring of one.

The check order inside the endpoint is load-bearing: **verify the signature, then check the key
image.** Reversed, a substituted key image would read as merely unseen rather than invalid.
