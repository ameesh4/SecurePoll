# SecurePoll — Election Manifest (v1)

The manifest is how an election's parameters travel from the admin panel to the blockchain
nodes. The admin panel **exports** it; every node **imports** it from disk at startup.

One election, one blockchain network, one manifest. A node serves exactly the election named in
its manifest and refuses ballots for any other.

This file is the contract between:

- the exporter — `exportChainManifest` in `api/src/services/ring.service.ts`, served by
  `GET /api/v1/admin/elections/:id/chain-manifest`;
- the importer — `ElectionManifest::load` in `blockchain/src/election.rs`.

Related contract: `web/src/crypto/lrs/WIRE_FORMAT.md` defines the ballot signature format that
verifies *against* the rings listed here.

## Format

```json
{
  "version": 1,
  "electionId": "3f2b8c14-5d6e-4a7b-8c9d-0e1f2a3b4c5d",
  "title": "Student Union Election 2026",
  "votingOpensAt": "2026-09-01T09:00:00.000Z",
  "votingClosesAt": "2026-09-01T17:00:00.000Z",
  "ringSize": 10,
  "candidates": [
    {
      "candidateId": "b21a4f77-9c3e-4d18-a2b5-6f8e0c1d2e3f",
      "name": "A. Candidate",
      "affiliation": "Independent",
      "ballotPosition": 1
    }
  ],
  "rings": [
    {
      "ringId": "c40d1e88-2f5a-4b6c-9d0e-1a2b3c4d5e6f",
      "index": 0,
      "publicKeys": [
        "9hmjC7LPC-5dZ_vsfQ1S9tOO0jJs2WOD7dhNWvNjbWo",
        "vunFsyc-VnPCUh-4JlWOPYtCKGR5aq5j_OrStVFx3lE"
      ]
    }
  ]
}
```

## Field rules

| Field | Rule |
|---|---|
| `version` | Must be `1`. A node MUST refuse a version it does not know rather than guess. |
| `electionId` | The election's UUID. Every ballot's signature commits to this value, so a node checks it before anything else. |
| `candidates[].candidateId` | Candidate UUIDs. **These are the node's valid-vote set** — a ballot naming anything else is rejected. They replace the free-form `A`–`F` strings the node used before. |
| `candidates` | One flat, ordered list. There is no office or seat grouping: a voter has one key image per election, so exactly one ballot with one `candidateId` can be accepted. One election is one contest. |
| `rings[].ringId` | Ring UUID. A ballot names the ring it was signed against; the node resolves the keys from here. |
| `rings[].publicKeys` | 32-byte compressed ristretto255 points, base64url, **no padding**. |
| `ringSize` | The election's target ring size. Informational for the node; the real sizes are whatever `publicKeys` says. |

### Ring order is cryptographic, not cosmetic

`publicKeys` is in `ring_members.positionInRing` order and **must not be sorted, deduplicated,
or otherwise reordered** at any point between the database and the node.

Every challenge in an LSAG signature hashes the whole ring in sequence
(`WIRE_FORMAT.md`, "Challenge transcript"). Reorder the keys and every signature against that
ring stops verifying — with no error message that points at the cause. The exporter passes the
order through untouched; the importer preserves array order; the verifier uses it as given.

### Why the ring travels in the manifest rather than in the ballot

A node looks up the ring by `ringId` **in its own manifest**. It never accepts a ring supplied
by whoever submitted the ballot. A submitter who provides the ring provides a ring of one, and a
ring of one is a signature with the voter's name on it. See §4 invariant 8 of
`SECUREPOLL_CONTEXT.md`.

## Export rules

- Refused before the election reaches `RINGS_FROZEN`. A manifest exported while groups are
  still forming would seed nodes with a partial electorate.
- The export is audit-logged: it discloses the full electorate's public keys.
- The exporter computes a digest — `sha256` over the exact serialized bytes — and stores it as
  each ring's `chainTxRef`, so the database records *what* was published and the value is
  reproducible from the file by anyone holding it.

## Import rules

A node loads the manifest before it opens any socket, and **fails to start** rather than
running half-configured, if:

- the file is missing, unreadable, or not valid JSON;
- `version` is not `1`;
- `electionId` is empty, or there are no candidates, or no rings;
- any `publicKeys` entry is not valid base64url decoding to exactly 32 bytes;
- any `publicKeys` entry is not a **canonical ristretto255 point**, or is the **identity
  element**;
- a `ringId` appears twice, or a `candidateId` appears twice;
- the same public key appears twice within one group.

A node that cannot parse its electorate cannot verify ballots against it. Discovering that at
startup costs a restart; discovering it after votes are cast costs the election.

Why the point validation matters, and why it happens here rather than later: the challenge chain
multiplies every ring member `P_i` by a scalar, so a member that will not decompress makes *every*
signature against that group unverifiable. By the time a ballot arrives the group is published and
frozen, so there is no repair — the election is the thing that breaks. The identity element is
rejected separately because it decodes perfectly well: no private key stands behind it, so it is a
member that cannot have signed and silently shrinks the real anonymity set by one.

This mirrors the check `api/src/lib/publicKey.ts` applies when a voter first registers. A key that
reached a group should already have passed it once; this is the last point at which it can still be
caught cheaply.

## What is deliberately absent

- **No authenticity check.** The manifest is not signed and nothing pins the chain to it. A
  node imports whatever manifest is on its disk, and two nodes given different manifests will
  disagree silently. Accepted for now; revisit before any real use.
- **No voter identities.** Public keys only. Which key belongs to which voter is knowledge the
  admin panel holds and the ledger must never receive.
