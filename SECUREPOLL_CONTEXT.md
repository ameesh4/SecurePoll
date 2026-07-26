# Secure Poll — Agent Context (LRS + Admin Panel scope)

> **Read this fully before writing code.** This file is the single source of truth for
> the slice of the project you are working on. If something here conflicts with what you
> infer from other files in the repo, ask before proceeding.

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
- The voter-facing portal UI (registration/voting screens). The LRS library must be
  *usable* by it, but do not build it.

When the design requires talking to the blockchain, **stub it behind an interface**
(see §7). Never implement the far side.

---

## 3. Stack and conventions

- **Language:** TypeScript everywhere in this scope. `strict: true`. No `any` without a
  comment justifying it.
- **Backend:** Node.js + Express (or Fastify — confirm with me if not already chosen).
- **Frontend:** React + TypeScript. Plain CSS or CSS modules; no heavy UI framework
  unless already present in the repo.
- **DB:** Assume Postgres via Prisma unless the repo says otherwise.
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
- One token per voter per election, single-use, with expiry (default: election close).
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
