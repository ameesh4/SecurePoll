# SecurePoll — session handoff

> **You are picking up work in progress.** This file is the transfer of context from the previous
> session: what exists, what is proven, what is deliberately unfinished, and — most importantly —
> *why* each non-obvious decision was made, so you do not undo one by accident.
>
> **Read in this order:** this file → `SECUREPOLL_CONTEXT.md` (intent, invariants, the LRS scheme)
> → `COMPLETED.md` (feature inventory) → `blockchain/ELECTION_MANIFEST.md` and
> `web/src/crypto/lrs/WIRE_FORMAT.md` (the two cross-language contracts).

---

## 1. The system in one paragraph

An online voting system for a Bachelor's final-year project, defended in a viva. Three layers:

| Layer | Path | Role |
|---|---|---|
| Verification server | `api/` | Express + Drizzle + Postgres. Knows *who is eligible*. Never sees a ballot. |
| Voter/admin web app | `web/` | React 19 + Vite. Admin panel, voter registration, and ballot casting. The LRS library lives here (`web/src/crypto/lrs/`). |
| Ledger | `blockchain/` | Rust, crate `bk-rs`. PoW chain with P2P gossip. Knows *what was voted*. Never sees an identity. |

The security goal: **no single party can both identify a voter and see how they voted.** Linkable
Ring Signatures (LSAG over ristretto255) are what keep those two facts from being joinable.

**One election = one ledger network = one manifest.** The admin panel exports an `election.json`;
every node imports it from disk at startup.

---

## 2. Current state — verified vs assumed

Run these; they should all pass. If one does not, that is your first job.

```bash
cd blockchain && cargo build && cargo test     # 30 tests, 0 warnings
cd api && bunx tsc --noEmit                    # clean
cd web && bunx tsc -b && bunx vitest run src/crypto   # 43 tests
cd web && bunx eslint src --max-warnings 0     # clean
```

**Proven by tests:**

- LSAG sign/verify round-trip, TypeScript and Rust, agreeing on committed test vectors.
- Both security gates: anonymity (no positional tell above the 1-in-10 baseline over 120 trials,
  with a calibration control) and double-vote (cross-ring repeat caught; substituted key image
  rejected as *invalid*, not merely unlinked).
- Manifest import rejects malformed input, non-canonical points, and the identity element.
- Key-file parsing, including the derived-vs-stated public key mismatch case.
- CORS preflight verified live: `204` with the `Access-Control-*` headers.

**NOT proven — the biggest open risk:**

> **No valid ballot has ever completed the round trip.** Every end-to-end check so far proves
> *rejection*. `Block::verify_ballot` accepts a real TypeScript-signed ballot in a unit test, but
> nothing has ever driven a valid ballot through `POST /ballot` → mined block → tally. The accept
> path is unexercised. This is what a viva will ask to see.

Also unverified: the entire API has **zero tests** — lifecycle guards, ring formation, token
redemption, the one-ring-per-voter invariant. And no page has been rendered in a browser this
session; correctness rests on typecheck, lint and build.

---

## 3. Decisions and why — do not silently reverse these

Each of these was deliberate. If you think one is wrong, raise it; do not just change it.

### Cryptographic

**Per-key, election-scoped key image: `I = x·H_p(P ‖ electionId)`.** Not textbook LSAG's
per-ring `I = x·H_p(L)`. This is *measured*, not argued: a Python prototype implementing textbook
LSAG was audited, and placing one voter's key in two different rings produced two unrelated key
images, both verifying — two countable ballots. Under the per-ring form, double-vote prevention
rests on an administrative invariant; under this form it is cryptographic. Good viva material.

**`H_p` is `expand_message_xmd(SHA-512, DST, 64)` then `from_uniform_bytes`.** That pairing *is*
RFC 9380 `hash_to_ristretto255`, confirmed against the committed `hp` vector on first attempt.
`WIRE_FORMAT.md` warns against `from_uniform_bytes` — that warning is about feeding it a *raw*
SHA-512 digest without the XMD expansion, not about the function itself. If `H_p` were ever
"hash then multiply by G", the key image would be forgeable and anonymity would collapse.

**Verify before dedup.** The ballot gate must check the signature *then* the key image. Reversed,
an attacker dodges linkability by substituting a key image and the seen-set reports it as merely
unseen. The challenge chain is what binds `I` to the ring.

**The ring comes from the manifest, never the request.** A submitter who supplies the ring
supplies a ring of one. §4 invariant 8.

**The message is rebuilt node-side, never accepted.** Otherwise an attacker keeps a valid
signature while the block records a different candidate.

**Ring order is cryptographic.** Every challenge hashes the whole ring in sequence. Sorting or
deduplicating `publicKeys` anywhere between the database and the node breaks every signature,
silently.

**`c0` is the challenge at index 0, never the signer's index.** Publishing the signer's own
position would leak it. This is what makes the signature positionally indistinguishable.

**Scalars must be canonical (`< q`).** Without the check, `s_i` and `s_i + q` both verify and one
ballot has unboundedly many encodings. Never use a hash of signature bytes as a ballot id —
key-image dedup is the only sound uniqueness check.

### Architectural

**One election per ledger network.** `chainFor(election)` replaced a module-level singleton;
elections carry `chainRootIp` / `chainRootPort`.

**Manifest reaches nodes by file only.** No HTTP push, no admin→node confirmation. Consequence:
`publishRings` has no remote ack, so `chainTxRef` stores a local `sha256:` digest of the exported
bytes instead.

**Chain health was removed entirely**, not made per-election — a single "is the chain up" reading
has no subject once every election has its own network. This also removed the pre-publish
ledger-reachability guard, so publishing no longer requires any node to be up.

**The office system was removed.** A voter has one key image per election, so exactly one ballot
with one `candidateId` can ever be accepted — several seats in one election could never be voted;
the second would return `DOUBLE_VOTE`. One election is one contest. This also restored alignment
with §6.2B, which never had an office field.

**Ring retrieval is idempotent until expiry**, not strictly single-use. `redeemedAt` is stamped on
first retrieval only, so turnout still counts voters. Safe because re-reading a ring discloses
nothing — it is published to the ledger anyway.

**CORS `Access-Control-Allow-Origin: *` on the node is not a hole.** The ballot endpoint takes no
cookies, no auth header, no credentials, so it cannot be induced to act with someone else's
authority. A malicious page achieves exactly what `curl` already could. Authorization is the ring
signature. Proxying ballots through the verification server would be easier and is **forbidden** —
that server must never see a ballot (§4 invariant 4).

---

## 4. Traps that cost time — read before editing

- **`Block`'s wincode layout changed** (`voter_id` → `ring_id` + `key_image` + `signature`).
  Existing `chain_*.bin` files are meaningless and **every node in a network must be rebuilt and
  restarted together**; an old node cannot deserialize a new `PushChainReq`.
- **`RawCandidate` uses `deny_unknown_fields`.** Manifests exported before the office removal no
  longer load. Re-export rather than debugging the parse error.
- **The ballot page path is fixed.** `ballotAccess.service.ts:67` emails
  `${VOTER_APP_BASE_URL}/ballot?access=<token>`. Changing the route breaks every token already sent.
- **A zero private key passes `bytesToScalar`** (0 < q) but yields the identity and can never sign.
  `parseKeyFile` rejects it explicitly.
- **Test vectors include a deliberately malformed message.** `size10-tampered-message` flips a byte
  of the domain tag, so its committed message is *not* the canonical encoding. Do not assert
  `encode_message(...) == vector.message` for negative vectors — that mistake was already made once.
- **`drizzle-kit generate` needs `--hints`** when an index is replaced, or it cannot tell rename
  from create.

---

## 5. What is left, in priority order

1. **Drive one real ballot end to end.** Needs the pending database reset (see §6). Then: register
   voters *keeping their key files*, approve, form and publish groups, export manifest, start a
   node against it, open voting, issue a token, open `/ballot?access=…`, load the key, cast.
   Confirm the node logs `BALLOT queued`, mines, and the tally shows the vote.
2. **Double vote, live** — same key again, expect `DOUBLE_VOTE` and no tally change.
   **Wrong key file** — a key from another group, expect the "not in your group" state with no
   request reaching the node.
3. **API tests.** Zero exist. Highest value: the lifecycle guards, the one-ring-per-voter
   invariant, and concurrent `/ring` redemption.
4. **More negative test vectors.** Currently 4 vectors, 1 negative. Extend
   `web/src/crypto/lrs/generate-vectors.ts` with identity key image, non-canonical scalar, wrong
   `electionId`, reordered ring, tampered `c_0`, bad version byte, truncated buffer. Rust picks
   them up automatically via `include_str!`.
5. **`vote.py` / `tally.py` are broken** — they call the removed `/add_vote`. Left untouched on the
   user's explicit instruction. Replacing them needs a Bun script driving the real TS signer, since
   casting now requires a genuine LSAG signature.

---

## 6. Environment — a reset is pending

The office-removal migration is **generated but not applied**. The user authorised a full database
reset ("we can nuke the database no problem").

```bash
cd api
bunx drizzle-kit migrate          # against a freshly dropped/recreated database
bun run db:seed-admin             # first operator
```

Every previously exported manifest and every issued ballot-access token is void. When rebuilding:
create the election **with `chainRootIp` / `chainRootPort` set**, or the ballot page has nowhere to
send anything. And **keep every downloaded key file** — without a private key that sits in a
published group, no ballot can be cast and item 1 above cannot run.

Migrations added this session: `..._charming_serpent_society` (chain root columns),
`..._wooden_felicia_hardy` (office removal).

---

## 7. Honest limitations — state these, do not let them be discovered

- **Timing correlation.** §4.1 separates token from signature in *data*, not in *time*. The server
  records when a token was redeemed; the ledger records when a ballot arrived. Correlating the two
  narrows a 1-in-10 group towards 1. Documented in §4.2, deliberately unmitigated.
- **No receipt-freeness.** The voter holds their key and the key image is deterministic, so a voter
  *can* prove how they voted to a third party. Vote-buying and coercion are live. Inherent to the
  scheme; name it as a non-goal.
- **Manual vetting is the entire identity guarantee.** No document check, no registry lookup. Sybil
  resistance is `nationalId` uniqueness plus a reviewer's judgment.
- **Consensus bugs, out of scope by decision:** block 0 is never validated (`chain.rs:50` loops
  from index 1, so its PoW is unchecked and its dedup key never enters the seen set); equal-height
  ties are broken on an attacker-controlled, unbounded timestamp; TCP framing uses `write()` not
  `write_all()` with no length prefix and receivers loop until `n < 1024`, so large `PushChainReq`
  payloads can truncate or stall.
- **Manifest authenticity.** Not signed, nothing pins the chain to it. A node imports whatever is
  on its disk; two nodes given different manifests diverge silently.
- **`HttpChainAdapter` cannot confirm** the node at a given address serves the expected election
  for `publishRing`/`publishElectionConfig` (both unimplemented); the *read* methods do check, via
  the `electionId` echoed in each response.
- **20-bit PoW difficulty** — about a million hashes. A demo parameter; one laptop can rewrite the
  chain.

---

## 8. Also on disk

- `/Volumes/external/test/` — the original **Python LSAG prototype** (`main.py`, `test_lrs.py`,
  57 checks). Historical: it implements *textbook* LSAG on secp256k1 and produced the measured
  evidence cited in §5.1 of the context doc. **Do not port code from it** — different curve,
  language, and key-image form.
- `~/.claude/plans/create-two-tasks-that-iridescent-map.md` — the approved plan this session
  executed.
- `~/Desktop/context/SECUREPOLL_CONTEXT.md` — an older forked copy of the context doc carrying the
  full Python audit. The repo copy is authoritative.

## 9. Working agreements from the user

- Ask before adding dependencies, especially crypto ones (§8 of the context doc).
- The LRS scheme and wire format are cross-team contracts — propose, do not silently change.
- Prefer clear, explainable code: it has to be defended in a viva.
- Do not write the voter portal beyond what exists, and do not touch `vote.py`.
