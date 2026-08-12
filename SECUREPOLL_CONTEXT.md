# Secure Poll — Agent Context (LRS + Admin Panel scope)

> **Read this fully before writing code.**
>
> This file is the source of truth for **intent**: scope, the security invariants (§4), the
> LRS scheme and wire format (§5), and the lifecycle rules (§6.1). Those are cross-team
> contracts — if a request would break one, say so and propose the fix rather than silently
> implementing either version (§8).
>
> For **implementation state**, the code is the source of truth and `COMPLETED.md` is the
> status snapshot. Much of the system is already built; the API sketch in §6.3 and the data
> model in §6.4 are original design intent that the code has since moved past, and are
> annotated accordingly. Where this document describes what *should* be true and the code
> disagrees, that is a bug or a decision to raise — not licence to edit §4 or §5 to match.

---

## 1. What the overall system is

Secure Poll is an online voting system for a Bachelor's final-year project
(Gandaki College of Engineering and Science, Pokhara University). Three components:

| Component | Role | Owner |
|---|---|---|
| **Verification Server** | Voter registration, admin-driven identity vetting, election/candidate management, ring (LRS group) formation, token issuance | **You / this scope** |
| **Voter client** | Generates keypair locally, fetches ring, signs vote with LRS, submits | Partially in scope (crypto only) |
| **Blockchain nodes** (Rust) | Verify signature, store vote, gossip blocks, consensus | **OUT OF SCOPE** |

The security goal: **no single party can both identify a voter and see how they voted.**
The verification server knows *who is eligible* and *who requested a ballot*. The
blockchain knows *what was voted*. Linkable Ring Signatures are what keep those two
facts from being joinable.

---

## 2. Your scope

### IN SCOPE
1. **The LRS (Linkable Ring Signature) library** — a standalone, dependency-light
   TypeScript package implementing keygen, sign, verify, and link-detection.
2. **The Admin panel** — backend API + React frontend for:
   - admin authentication
   - voter registration review (approve / reject)
   - election CRUD and lifecycle state machine
   - candidate CRUD
   - ring (LRS group) formation and publication
   - token generation and email dispatch
   - monitoring / audit views

### OUT OF SCOPE — do not write, scaffold, or "helpfully add" these
- Rust blockchain nodes, block structs, hashing, PoW, gossip, peer discovery, consensus,
  longest-chain rules, mempool.
- Anything under a `blockchain/` or `node/` directory.
- ~~The voter-facing portal UI (registration/voting screens).~~ **Now in scope and built.**
  Registration, status, key replacement, and ballot casting (`web/src/pages/VotePage.tsx`, route
  `/ballot`) all exist. The path is fixed by the ballot-access email, which sends
  `${VOTER_APP_BASE_URL}/ballot?access=<token>`.

When the design requires talking to the blockchain, **stub it behind an interface**
(see §7). Never implement the far side.

---

## 3. Stack and conventions

- **Language:** TypeScript everywhere in this scope. `strict: true`. No `any` without a
  comment justifying it.
- **Backend:** Node.js + Express (or Fastify — confirm with me if not already chosen).
- **Frontend:** React + TypeScript. Plain CSS or CSS modules; no heavy UI framework
  unless already present in the repo.
- **DB:** Postgres via **Drizzle ORM** (`api/src/db/`). Migrations under
  `api/src/db/migrations/`. Local Postgres via `local-db-compose.yml`.
- **Runtime/tooling:** **Bun** in dev for both packages; `api` builds with `tsc`, `web` with
  Vite 8. Frontend is React 19 + react-router v7 + Tailwind v4 (CSS-first `@theme`).
- **Crypto:** `@noble/curves` (ristretto255) and `@noble/hashes`. **Do not roll your own
  field arithmetic and do not pull in an unaudited ring-signature package.** The point of
  the project is that we implement the LRS scheme ourselves on top of a vetted curve
  primitive.
- **Tests:** Vitest. The LRS library needs real tests (see §5.5) — this is the academic
  core of the project and will be defended in a viva.
- Small, reviewable commits. Explain cryptographic choices in code comments with a
  reference to the paper or spec.

---

## 4. Non-negotiable security invariants

These are correctness requirements, not suggestions. Flag it loudly if a request would
break one.

1. **The voter's private key never leaves the voter's device.** The server receives only
   the public key. No endpoint may accept a private key, seed, or mnemonic.
2. **Signing happens client-side.** The LRS library must run in a browser. No Node-only
   APIs in the signing path.
3. **The ring must be frozen before voting opens.** Adding a member to a ring after votes
   exist against it breaks verification and can break linkability guarantees.
4. **The verification server must never see a ballot.** No vote payload, plaintext or
   otherwise, touches the server or its DB.
5. **The token must not be submitted with the vote.** See §4.1 — this is a design defect
   in the original proposal and you must implement the corrected flow.
6. **Rings must be ≥ a configured minimum size** (default 10). A ring of size 1 is a
   signature with the voter's name on it. Enforce this at ring-formation time and refuse
   to publish undersized rings.
7. **Audit-log every admin action** that changes eligibility, ring membership, or election
   state. Append-only table, admin id + timestamp + before/after.
8. **The ring is resolved by the verifier, never supplied by the submitter.** Any verifier —
   a blockchain node, or this library's `verify` — loads the ring from the key set the
   verification server published for that `ringId`. It never takes the ring from the vote
   package. A voter who supplies their own ring supplies a ring of one, and a ring of one is
   a signature with their name on it. This is what makes it safe to keep the public keys out
   of the signature (§5.6), and it is the enforcement point that gives invariant 6 its teeth
   at verification time rather than only at ring-formation time.

### 4.1 Correction to the proposal's flow — read this

The proposal (§UC2, Figure 5) says the voter submits `vote + LRS signature + token` to the
blockchain node. **This destroys the anonymity the ring signature provides.** The
verification server knows `token → voter identity`. The blockchain stores `token → vote`.
Anyone with access to both — or one operator who runs both — can de-anonymize every ballot.

**Corrected flow to implement:**

- The token is a **bearer credential used only against the verification server**, to
  authenticate the "fetch my ring's public keys" request. It is consumed there.
- The vote package submitted to the blockchain is **`{ electionId, ringId, vote, signature, keyImage }`** — **no token, no voter id.**
- Authorization to vote *is* the ring signature: it proves the signer holds a private key
  matching one of the public keys in a ring the server publicly published for that election.
- Double-vote prevention *is* the key image, not the token.

If you need to state this in the final report, the one-liner is: *the token authenticates
ballot retrieval, the ring signature authorizes ballot casting, and the two are never
observed together.*

### 4.2 Known exposure: timing correlation

The separation in §4.1 is about *data*, and it holds. It does not cover *timing*, and that gap is
real: the verification server records when a token was redeemed, the ledger records when a ballot
arrived, and a voter who collects their group and votes thirty seconds later is identifiable by
correlating the two — regardless of how large the anonymity group is. A 1-in-10 group can be
narrowed towards 1 this way.

Accepted and undefended for now, deliberately. State it as a limitation rather than letting it be
discovered. Mitigations, if it is ever taken on: a client-side random delay before submission,
batched or mixed submission, or decoupling collection from casting so the two happen in separate
sessions.

---

## 5. The LRS library

### 5.1 Scheme

Implement **LSAG** (Liu, Wei, Wong 2004, *Linkable Spontaneous Anonymous Group Signature
for Ad Hoc Groups*), with the CryptoNote-style **per-key key image** rather than the
per-ring key image from the original paper.

**Why the deviation — document this, it's a defensible design decision:** in the original
LSAG the key image is `I = x · H_p(L)` where `L` is the whole ring. Linkability is then
scoped to a single fixed ring: the same voter signing under a *different* ring produces an
unlinkable signature and could vote twice. The CryptoNote form `I = x · H_p(P)` binds the
key image to the signer's own public key, so it is stable regardless of ring composition.

**This is measured, not argued.** A Python LSAG prototype (see §5.7) implements the original
per-ring form faithfully, and a test harness reproduced the attack: one voter's key placed in
two different rings yielded two unrelated key images, both verifying — two countable ballots,
nothing linking them. Under the per-ring form, double-vote prevention rests on the
*administrative* invariant "exactly one ring per voter per election" (§6.2C) rather than on
cryptography; one duplicate registration or one ring re-form defeats it. The deviation this
section specifies moves that guarantee into the maths. Use this in the report and the viva —
it turns a design preference into a demonstrated necessity.

**Election scoping:** use `I = x · H_p(P ‖ electionId)`. This gives exactly the property we
want — one vote per voter *per election*, with no cross-election linkage of a voter's
ballots.

### 5.2 Parameters

- Group: **ristretto255** (prime order, no cofactor pitfalls, no small-subgroup checks
  needed — this is why we prefer it over raw ed25519).
- `q` = group order, `G` = base point.
- `H_s` (hash-to-scalar): SHA-512 → reduce mod q.
- `H_p` (hash-to-point): ristretto255 `hashToCurve` / Elligator via `@noble/curves`.
  **Do not** implement hash-to-point as "hash then multiply by G" — that is a real,
  common, project-killing bug: it makes the key image forgeable.
- Domain-separate every hash with a fixed ASCII prefix (`"SECUREPOLL/v1/sign"` etc.).

### 5.3 Algorithms

**KeyGen()**
```
x  ← random scalar in [1, q-1]
P  = x · G
return { privateKey: x, publicKey: P }
```

**Sign(message m, ring L = [P_1..P_n], signer index π, private key x)**
```
I     = x · H_p(P_π ‖ electionId)
α     ← random scalar
s_i   ← random scalar, for all i ≠ π

c_{π+1} = H_s(m ‖ L ‖ α·G ‖ α·H_p(P_π ‖ eid))

for i = π+1, π+2, …, π-1  (mod n):
    L_i     = s_i·G + c_i·P_i
    R_i     = s_i·H_p(P_i ‖ eid) + c_i·I
    c_{i+1} = H_s(m ‖ L ‖ L_i ‖ R_i)

s_π = α − c_π · x   (mod q)

return { c_1, s: [s_1..s_n], keyImage: I }
```

**Verify(message m, ring L, signature)**
```
reject if I is identity
for i = 1..n:
    L_i     = s_i·G + c_i·P_i
    R_i     = s_i·H_p(P_i ‖ eid) + c_i·I
    c_{i+1} = H_s(m ‖ L ‖ L_i ‖ R_i)
accept iff recomputed c_1 == provided c_1
```

**Link(sigA, sigB)** → `sigA.keyImage == sigB.keyImage`

### 5.4 Public API surface

```ts
export type Scalar = Uint8Array;   // 32 bytes, canonical
export type Point  = Uint8Array;   // 32 bytes, compressed ristretto

export interface KeyPair { privateKey: Scalar; publicKey: Point }
export interface RingSignature { c0: Scalar; s: Scalar[]; keyImage: Point }

export function generateKeyPair(): KeyPair;
export function deriveKeyImage(privateKey: Scalar, electionId: string): Point;

export function sign(params: {
  message: Uint8Array;
  ring: Point[];
  signerIndex: number;
  privateKey: Scalar;
  electionId: string;
}): RingSignature;

export function verify(params: {
  message: Uint8Array;
  ring: Point[];
  signature: RingSignature;
  electionId: string;
}): boolean;

export function areLinked(a: RingSignature, b: RingSignature): boolean;

// canonical byte encodings — the Rust node must be able to reproduce these
export function serializeSignature(sig: RingSignature): Uint8Array;
export function deserializeSignature(bytes: Uint8Array): RingSignature;
```

**Serialization is a cross-language contract.** The Rust nodes re-verify these signatures.
Define the wire format explicitly (fixed-width, little-endian scalars, length-prefixed `s`
array), write it down in `lrs/WIRE_FORMAT.md`, and add test vectors as JSON so the Rust
side can be checked against them.

The message being signed must be the canonical serialization of
`{ electionId, ringId, candidateId }` — never a free-form string. Otherwise a signature is
replayable into another election.

### 5.5 Required tests

- Sign → verify round-trip for ring sizes 2, 3, 10, 50, at every signer index.
- Verify **fails** on: flipped message bit, swapped ring order, ring member substituted,
  tampered `s_i`, tampered `c_0`, identity key image, wrong `electionId`.
- Two signatures by the same key over the same election → `areLinked === true`,
  including when the two rings differ.
- Two signatures by the same key over *different* elections → `areLinked === false`.
- Different keys, same ring → `areLinked === false`.
- Determinism of serialization; round-trip serialize/deserialize.
- Committed test vectors for the Rust verifier.
- Anonymity smoke test: signature bytes must not vary in any way correlated with
  `signerIndex` (same-length output, no positional tells).

**Status: all of the above are implemented and passing** — 34 tests across
`web/src/crypto/lrs/lrs.test.ts`, `serialize.test.ts` and `vectors.test.ts`. Run with:

```
cd web && bunx vitest run src/crypto
```

Two notes on the anonymity item, because "no positional tells" is easy to under-test.
Asserting equal output length only proves the *shape* does not leak; the *values* need their
own check. `lrs.test.ts` covers both: length invariance across every signer index, plus an
adversary experiment — 120 trials, each index equally often, three heuristics (`smallestS`,
`largestS`, `fewestBits`) guessing the signer from `s`, each required to stay under 2× the
1/n baseline, with an `alwaysZero` control asserted at exactly `TRIALS/n` so the experiment is
provably calibrated, and a check that the signer's scalar bit-length distribution matches the
decoys'. **Say this precisely in the viva:** the tests establish no structural or statistical
leak. Unconditional anonymity rests on the hardness of computing `x·H_p(P)` from `x·G` — a CDH
assumption. That is argued, not measured. Do not claim the tests prove anonymity.

### 5.6 What is actually in a signature — and what is not

A signature is the triple `(c_0, s[], I)` and nothing else. It maps 1:1 onto `RingSignature`
in §5.4 (`c0`, `s`, `keyImage`).

| Field | Shape | What it is |
|---|---|---|
| `c_0` | one scalar | The entry point to the challenge chain. It gives the verifier somewhere to start, and something to compare against once it has gone all the way around. |
| `s` | `n` scalars | One response per ring position. `n − 1` of them were random draws; one was solved with the private key. Nothing in the values distinguishes them — the signer's entry looks exactly like the random ones. |
| `I` | one point | The key image. The linkability tag. |

**Public keys are not part of the signature.** The ring `L` is a separate verifier input, and
the verifier needs all `n` of them to check the chain. `s[]` is positionally indexed against
`L`, so `L` must be presented in the exact order used at signing.

**Why every entry of `s` must travel.** Each position's step consumes its own `s_i`; drop
`s_3` and the verifier cannot compute `c_4`, the chain breaks, and nothing past index 3 is
checkable. The missing entry cannot be re-derived — it was a random draw. The random entries
are not wasted bytes, they are the disguise: a signature carrying only the signer's real `s`
is a plain Schnorr signature under a single public key, which names the signer outright.

**Size.** `n + 1` scalars plus one point — linear in ring size. The wire format is
`69 + 32·n` bytes (see `WIRE_FORMAT.md`), so 389 bytes at the default `ringSize = 10`. This is
inherent to LSAG, not an implementation shortcoming; say so when justifying the default, since
ring size trades anonymity-set size against ballot size directly.

**Verification loop shape.** Carry a single accumulator `c`, seeded from the provided `c_0` and
reassigned each iteration. After `n` iterations the last value produced *is* the recomputed
`c_0`; compare against the argument. §5.3 writes it as `c_{i+1}` for clarity, but the
implementation keeps one variable.

**The ballot never carries the ring.** What the voter submits is exactly §4.1:
`{ electionId, ringId, vote, signature: (c0, s[]), keyImage: I }`. `ringId` is how the node
finds the key set published before voting opened. See §4 invariant 8.

Two footguns that make a valid signature verify as `false` with no other symptom — check these
first before suspecting the maths:

- the ring is in a different order at verify than at sign (`L` bytes differ, so every hash
  differs);
- the message bytes are not byte-identical (the other reason §5.4 insists the message is a
  canonical serialization of `{ electionId, ringId, candidateId }` and never a free-form
  string).

### 5.7 Implementation status

**The library lives at `web/src/crypto/lrs/`** — `curve.ts`, `hash.ts`, `keygen.ts`, `sign.ts`,
`verify.ts`, `link.ts`, `serialize.ts`, `types.ts`, `index.ts`, plus `WIRE_FORMAT.md`,
`generate-vectors.ts` and `test-vectors/vectors.json`. It implements the §5.1 scheme as
specified: the key image is per-key and election-scoped via `keyImageBase(publicKey,
electionId)`, `H_p` is a real RFC 9380 hash-to-curve (`ristretto255_hasher.hashToCurve`), every
hash is domain-separated (`SECUREPOLL/v1/H_p`, `/H_s`, `/chal`) with length-prefixed
variable-length inputs, and `bytesToScalar` rejects any `s_i ≥ q` so signatures are not
malleable. `verify` returns `false` on any malformed input rather than throwing.

**Both security gates are verified** (`lrs.test.ts`):

- *Anonymity gate* — length invariance plus the adversary experiment described in §5.5.
- *Double-vote gate* — one ballot per voter accepted and the second rejected; a voter who
  **moves to a different ring** still caught (the case textbook LSAG cannot handle); no false
  positive across elections.

**The gate's step order is load-bearing.** A node must **verify before deduplicating**. A
ballot with a substituted key image must come back *invalid*, not merely *unlinked* — the
challenge chain binds `I` to the ring, so verification is what catches it. Reverse the two
steps and the gate is trivially bypassable by submitting a random key image. `lrs.test.ts`
asserts this ordering; the same ordering has to hold in the node's real acceptance path.

`link.ts` deliberately provides only the `areLinked` predicate and `keyImageKey` (a canonical
`Set`/`Map` key). **The seen-set itself is the blockchain's, never this server's** — storing
`keyImage → voterId` here would undo the whole scheme (§6.4).

**Python prototype (historical).** `/Volumes/external/test/main.py` plus `test_lrs.py` — a
faithful *textbook* LSAG implementation on secp256k1 via `ecdsa`, with 57 passing checks. It
was the reference the TypeScript port was reasoned from, and its audit produced the measured
evidence cited in §5.1. It is **not** the deliverable and its three recorded gaps (per-ring key
image, no election scoping, free-form signed message) are all resolved in the TypeScript
library. Do not port code from it; the curve, language, and key-image form all differ.

---

## 6. Admin panel

### 6.1 Election lifecycle state machine

```
DRAFT ──▶ REGISTRATION_OPEN ──▶ RINGS_FROZEN ──▶ VOTING_OPEN ──▶ VOTING_CLOSED ──▶ TALLIED
   │              │
   └──▶ CANCELLED ◀┘
```

Allowed operations per state — enforce server-side, not just in the UI:

| Operation | DRAFT | REG_OPEN | RINGS_FROZEN | VOTING_OPEN | CLOSED |
|---|:--:|:--:|:--:|:--:|:--:|
| Edit election metadata | ✅ | ✅ | ❌ | ❌ | ❌ |
| Add/remove candidates | ✅ | ✅ | ❌ | ❌ | ❌ |
| Approve/reject voters | ❌ | ✅ | ❌ | ❌ | ❌ |
| Form / re-form rings | ❌ | ❌ | ✅ (before publish) | ❌ | ❌ |
| Publish rings to chain | ❌ | ❌ | ✅ | ❌ | ❌ |
| Issue tokens | ❌ | ❌ | ✅ | ✅ | ❌ |
| Open voting | ❌ | ❌ | ✅ (rings published) | — | — |
| View tally | ❌ | ❌ | ❌ | ❌ | ✅ |

Guards to implement: cannot enter `VOTING_OPEN` unless ≥2 candidates exist, all rings are
published, and every approved voter belongs to exactly one ring.

### 6.2 Admin flows

**A. Voter verification queue**
Registrations arrive as `{ fullName, nationalId, email, publicKey }`. Admin sees a paginated
queue, opens a record, and approves or rejects with a reason. Manual vetting is deliberate —
it's the project's stated auth model (see the gap-analysis table: "Admin Manual Vetting +
Token"). Reject reasons are stored and surfaced to the voter by email.
Duplicate detection: warn on duplicate `nationalId`, duplicate `email`, or a `publicKey`
already registered.

**B. Election & candidate management**
Standard CRUD. Candidates: name, party/affiliation, photo URL, ballot position. Candidate
ids are what get signed, so they must be immutable once rings freeze.

**C. Ring formation**
Given the approved voters for an election, partition them into rings.
- Shuffle with a CSPRNG, then chunk into groups of `ringSize` (default 10, configurable).
- Handle the remainder: if the last chunk is below the minimum, distribute its members into
  existing rings rather than publishing a small ring.
- Every approved voter belongs to **exactly one** ring. Assert this before allowing publish.
- Rings are immutable after publish. Enforce with a DB constraint or a `publishedAt` guard.
- Show the admin a preview: ring count, sizes, unassigned voters, warnings.

**D. Token issuance and email**
- Token = 32 bytes CSPRNG, base64url. Store **only a SHA-256 hash** of it, never the token.
- One token per voter per election, with expiry (default: election close).
- **Retrieval is idempotent until expiry**, not strictly single-use. A voter whose tab dies between
  collecting their ring and casting would otherwise be locked out pending a resend. Re-reading a
  ring discloses nothing — it is published to the ledger anyway, and without the private key it
  cannot be signed against; the credential gates *learning which group you are in*, not casting.
  `redeemedAt` is stamped on first retrieval only, so turnout keeps counting voters.
- Email delivery via a `Mailer` interface with a console/dev implementation and a real SMTP
  implementation. Include a resend action with rate limiting.
- Dispatch is a queued/batched job with per-recipient status (`PENDING/SENT/FAILED/BOUNCED`)
  visible in the UI. Do not block an HTTP request on sending hundreds of emails.

**E. Monitoring**
Turnout (tokens redeemed / tokens issued — note this reveals *who voted*, not *how*, which
is normal and acceptable in public elections), rejected-package counts pulled from the chain
adapter, audit log viewer with filters.

### 6.3 Backend API sketch

```
POST   /api/admin/auth/login
POST   /api/admin/auth/logout

GET    /api/admin/elections
POST   /api/admin/elections
GET    /api/admin/elections/:id
PATCH  /api/admin/elections/:id
POST   /api/admin/elections/:id/transition        { to: "VOTING_OPEN" }

GET    /api/admin/elections/:id/candidates
POST   /api/admin/elections/:id/candidates
PATCH  /api/admin/candidates/:id
DELETE /api/admin/candidates/:id

GET    /api/admin/elections/:id/registrations?status=PENDING
POST   /api/admin/registrations/:id/approve
POST   /api/admin/registrations/:id/reject        { reason }

POST   /api/admin/elections/:id/rings/preview     { ringSize }
POST   /api/admin/elections/:id/rings/form        { ringSize }
GET    /api/admin/elections/:id/rings
POST   /api/admin/elections/:id/rings/publish

POST   /api/admin/elections/:id/tokens/issue
POST   /api/admin/tokens/:id/resend
GET    /api/admin/elections/:id/tokens

GET    /api/admin/elections/:id/audit
```

> **The sketch above is the original design intent and is now out of date.** The implemented
> API is mounted at **`/api/v1`** (`api/src/app.ts`), with public routes at the root and admin
> routes under `/admin`. Real shape, from `api/src/api/routes/`:
>
> ```
> GET    /api/v1/health
>
> POST   /api/v1/register                      { fullName, nationalId, email, publicKey }
> GET    /api/v1/register/:id                  voter's own status page
> POST   /api/v1/register/:id/key              key replacement (public half only)
> POST   /api/v1/ring                          { token } -> ring + candidates; consumes token
>
> /api/v1/admin/auth        login, logout, me
> /api/v1/admin/admins      operator management (super-admin)
> /api/v1/admin/registrations  queue, :id/approve, :id/reject, bulk/approve, bulk/reject,
>                              key-rotations, key-rotations/:id/review
> /api/v1/admin/elections   CRUD, :id/transition, :id/candidates(+reorder), :id/rings
>                              (preview|form|publish), :id/ballot-access(issue|dispatch|retry),
>                              :id/voters(+available), :id/eligibility(+bulk),
>                              :id/monitoring, :id/audit, dashboard, audit
> /api/v1/admin/candidates  :id patch/delete
> /api/v1/admin/ballot-access  :id/resend, :id/recipient
> ```
>
> Every public endpoint is rate-limited (`api/src/api/middleware/rateLimit.ts`); `/ring`
> hardest, since it is the one unauthenticated route carrying a bearer credential. Note the
> naming drift: the code says **"anonymity group"** and **"ballot access"** where this document
> says "ring" and "token". Same concepts.

Public / voter-facing endpoints on the verification server (build these — the voter portal
UI is out of scope, but its server side is not):

```
POST   /api/register                              { fullName, nationalId, email, publicKey }
POST   /api/ring                                  { token } → { ringId, publicKeys[], electionId, candidates[] }
```
`POST /api/ring` consumes the token. It returns the ring the token's owner belongs to. It
must **not** return the caller's index in the ring — the client already knows its own key.

### 6.4 Data model

```prisma
model Admin        { id, email, passwordHash, name, createdAt }
model Election     { id, title, description, status, registrationOpensAt,
                     votingOpensAt, votingClosesAt, ringSize, createdAt }
model Candidate    { id, electionId, name, affiliation, photoUrl, position }
model Voter        { id, fullName, nationalId, email, publicKey, createdAt }
model Registration { id, voterId, electionId, status, rejectionReason,
                     reviewedByAdminId, reviewedAt }
model Ring         { id, electionId, index, publishedAt, chainTxRef }
model RingMember   { id, ringId, voterId, positionInRing }   // @@unique([ringId, voterId])
model Token        { id, voterId, electionId, tokenHash, issuedAt, expiresAt,
                     redeemedAt, emailStatus }
model AuditLog     { id, adminId, action, entityType, entityId, before, after, createdAt }
```

> **Implemented as Drizzle schemas in `api/src/db/schema/`, not Prisma** — 11 tables:
> `admins, audit_log, elections, candidates, voters, registrations, election_eligibility,
> rings, ring_members, ballot_access_tokens, key_rotation_requests`. The sketch above is
> conceptually accurate but the live schema adds `election_eligibility` (the electoral roll)
> and `key_rotation_requests`, and carries integrity the sketch does not name: partial unique
> indexes (re-registration allowed after rejection; one pending token/rotation per voter),
> composite foreign keys on `ring_members`, and CHECK constraints (ring size ≥ 2, expiry after
> issue, key-actually-changed). Read the schema files rather than this sketch before writing a
> query.

Note what is **absent** and must stay absent: no `Vote` table, no ballot column, no
`voterId → keyImage` mapping. The server storing a key image against a voter id would
single-handedly undo the whole scheme.

---

## 7. Blockchain boundary

Everything the server needs from the chain goes through one interface. Implement only the
in-memory dev stub.

```ts
export interface ChainAdapter {
  publishRing(electionId: string, ringId: string, publicKeys: Point[]): Promise<{ txRef: string }>;
  publishElectionConfig(election: ElectionConfig): Promise<{ txRef: string }>;
  getTally(electionId: string): Promise<Record<string /*candidateId*/, number>>;
  getRejectedCount(electionId: string): Promise<number>;
  health(): Promise<{ nodes: number; height: number }>;
}
```

`InMemoryChainAdapter` for dev and tests. An HTTP implementation against the Rust nodes will
be written by a teammate — leave a clearly marked TODO stub, don't guess their routes.

---

## 8. How to work with me

- **Ask before adding dependencies.** Especially crypto ones.
- **Ask before changing the LRS scheme or the wire format** — those are cross-team contracts
  and go in the report.
- If a request of mine would violate §4, say so and propose the fix rather than silently
  implementing the safe version or the unsafe one.
- Prefer clear, explainable code over clever code. I have to defend this in a viva.
- Don't write the Rust side. Don't write the voter portal UI. If it feels like the natural
  next step, stop and tell me instead.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **LRS / LSAG** | Linkable Spontaneous Anonymous Group signature. Proves "one of these n people signed" without revealing which. |
| **Ring** | The set of public keys a signature is made on behalf of. Called "LRS group" in the proposal. |
| **Key image** | Deterministic value derived from the private key. Same signer → same key image → double vote detected. Reveals nothing about which key produced it. |
| **Token** | Single-use bearer credential emailed to an approved voter. Authenticates ring retrieval only. |
| **Verification server** | The backend in this scope. Handles identity; never handles ballots. |
