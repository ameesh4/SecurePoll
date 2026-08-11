import argparse
import json
import os
import random
import sys
import uuid
import urllib.request
import time

# Candidate ids come from the election manifest, not a hardcoded A-F list: they are the ids a
# ballot's signature commits to, and a node validates against exactly this set.
# See ELECTION_MANIFEST.md.
DEFAULT_MANIFEST = "election.json"


def load_candidate_ids(manifest_path):
    if not os.path.exists(manifest_path):
        sys.exit(
            f"No election manifest at {manifest_path}. Export one from the admin panel "
            f"(Groups page -> Download manifest) or pass --election <path>."
        )
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    ids = [c["candidateId"] for c in manifest.get("candidates", [])]
    if not ids:
        sys.exit(f"{manifest_path} lists no candidates")
    return ids


def send_vote_request(host, candidate_ids):
    random_vote = random.choice(candidate_ids)
    rand_uuid = str(uuid.uuid4())
    url = f"http://{host}/add_vote/{rand_uuid}/{random_vote}"
    req = urllib.request.Request(url=url, method="POST")
    with urllib.request.urlopen(req) as response:
        response_text = response.read().decode("utf-8")
        print(f"SENT VOTER {rand_uuid} VOTE {random_vote}")
        print(response_text)
    return rand_uuid, random_vote


def main():
    parser = argparse.ArgumentParser(description="Attempt N votes")
    parser.add_argument("n", type=int, help="Total number of votes to launch")
    parser.add_argument(
        "--election",
        default=DEFAULT_MANIFEST,
        help=f"Path to the election manifest (default: {DEFAULT_MANIFEST})",
    )
    parser.add_argument(
        "--root-ip",
        default="0.0.0.0",
        help="IP address of the root node's HTTP server (default: 0.0.0.0, matching the "
        "--public-ip default in the Rust node)",
    )
    parser.add_argument(
        "--root-port",
        type=int,
        default=8000,
        help="Port of the root node's HTTP server (default: 8000, the Rocket server's fixed "
        "port; this is not the P2P port used between nodes, which the OS assigns automatically)",
    )
    parser.add_argument(
        "--out",
        default="votes_record.jsonl",
        help="File to write cast votes to (cleared at the start of each run), for later tallying with tally.py",
    )
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds between votes")

    args = parser.parse_args()

    host = f"{args.root_ip}:{args.root_port}"
    candidate_ids = load_candidate_ids(args.election)
    print(f"Voting across {len(candidate_ids)} candidate ids from {args.election}")

    with open(args.out, "w") as f:
        for _ in range(args.n):
            voter_id, vote = send_vote_request(host, candidate_ids)
            f.write(json.dumps({"voter_id": voter_id, "vote": vote}) + "\n")
            f.flush()
            time.sleep(args.delay)

    print(f"Recorded {args.n} votes to {args.out}")


main()
