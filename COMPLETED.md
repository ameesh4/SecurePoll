# SecurePoll — Completed Work

> Status snapshot of what is **built and wired end-to-end** in the verification-server
> slice of SecurePoll (the admin panel + voter-facing server side).
>
> **Out of scope** for this repo entirely: the Rust blockchain nodes (block storage,
> consensus, gossip, tally) and the voter-facing portal UI.

---

## At a glance

| Area | State |
|---|---|
| Backend API (Express + Drizzle + Postgres) | ✅ Fully wired: route → controller → service → repository → DB |
| Admin panel (React 19 + Vite + Tailwind v4) | ✅ Every route maps to a real, non-stub page |
| Election lifecycle state machine | ✅ Server-enforced, not just UI-hidden |
| Registration & voter vetting | ✅ Complete (single + bulk, duplicate detection) |
| Elections / candidates CRUD | ✅ Complete, lifecycle-gated |
| Anonymity-group (ring) formation & publish | ✅ Complete (group formation only) |
| Ballot-access tokens (issue → dispatch → redeem) | ✅ Complete |
| Key rotation / replacement | ✅ Complete |
| Audit logging | ✅ Append-only, broad coverage |
| Mailer (SMTP + console) | ✅ Complete with templates |
| Blockchain boundary — in-memory adapter | ✅ Working dev/test stub |
| Blockchain boundary — HTTP adapter | ⛔ Deliberate stub (`TODO(blockchain-team)`) |

The **only genuinely unimplemented** piece on the server is the real ledger integration
(`HttpChainAdapter`); the in-memory adapter stands in for it in dev and tests.

---

## Backend (`api/`)

Stack: Express 5 + TypeScript, Drizzle ORM over Postgres (`pg`), Zod validation, JWT
(HS256) + bcryptjs, nodemailer. Runs on Bun in dev, builds with `tsc`. Entry
`api/src/index.ts` → `api/src/app.ts`; all routes under `/api/v1`.

### Authentication & authorization
- Admin login with bcrypt verification and **constant-cost fake-verify** for unknown/
  inactive accounts to equalize timing. `api/src/services/adminAuth.service.ts`.
- JWT claims are `{sub, email}` only — **role is never in the token**. Issuer/audience
  pinned, TTL configurable. `api/src/lib/jwt.ts`.
- `requireAdmin` **re-loads the admin row from the DB every request** and rejects
  inactive accounts, so deactivation takes effect immediately despite stateless JWTs.
  `api/src/api/middleware/auth.ts`.
- Two-role model (`REVIEWER` / `SUPER_ADMIN`); `requireSuperAdmin` gates operator
  management, and services re-check role at the operation as belt-and-braces.
- First admin created via interactive CLI seed (`api/src/scripts/seedAdmin.ts`) — no
  public signup by design.

### Election lifecycle (`api/src/services/lifecycle.ts`)
- States: `DRAFT → REGISTRATION_OPEN → RINGS_FROZEN → VOTING_OPEN → VOTING_CLOSED →
  TALLIED`, plus `CANCELLED`. No reverse paths (notably no reopening registration after
  groups form).
- Per-operation gating (`editMetadata`, `manageCandidates`, `reviewVoters`, `formRings`,
  `publishRings`, `issueTokens`, `viewTally`) enforced server-side; `availableOperations()`
  is returned to the client so screen and server can't disagree.
- Irreversible transitions require super-admin and are re-checked under a row lock inside
  the transaction. **Guards** (`api/src/services/guards.service.ts`) block illegal
  transitions with structured pass/fail reasons — e.g. can't open voting unless the
  election is contested, all rings formed/published/assigned, and (for publish) the ledger
  is reachable.

### Registration & voter vetting (`registration.service.ts`, `review.service.ts`)
- `POST /register`: normalizes input, checks conflicts against live registrations **and**
  existing voters in a transaction, backed by partial unique indexes for race safety;
  returns only *which field* collided (no record leak). Public key validated at the door
  (ristretto255) via `api/src/lib/publicKey.ts`.
- Voter status page (`GET /register/:id`): reference code, dates, group size, computed
  key-replacement eligibility — reveals no national ID / email / key.
- Approve / reject (single **and** bulk) with emailed reasons; approval mints the `voters`
  row, links it, optionally grants eligibility, and audits.
- Duplicate detection surfaces named warnings (national ID / email / public key) to the
  reviewer; the queue flags colliding pending records.
- Electoral-roll management: bulk enrol/remove, refusing removal of anyone already locked
  into a published ring.

### Elections & candidates (`election.service.ts`, `candidate.service.ts`)
- Election CRUD with voting-window validation and configurable `ringSize` (default 10,
  CHECK ≥ 2). Detail view returns counts, allowed operations, transitions, guard results,
  unassigned count.
- Candidate CRUD as one flat ordered ballot, with reordering (collision-safe two-pass
  scheme), photo/affiliation/ballot-position, all gated to pre-freeze states and audited.
  There is no office/seat grouping: a voter has one key image per election, so exactly one
  ballot with one `candidateId` can ever be accepted. One election is one contest.

### Anonymity-group (ring) formation (`api/src/services/ring.service.ts`)
> Group *formation* only — building and publishing the anonymity groups, not signing or
> verifying ballots.
- Unbiased Fisher–Yates shuffle over `crypto.randomInt` (CSPRNG, explicitly not
  `Math.random`).
- Partition into groups of `target`/`target+1` — **never a short group** (leftovers dealt
  one-each into existing groups); minimum-size enforced.
- SHA-256 shuffle fingerprint for human cross-reference; preview (read-only), form
  (refuses re-form once any ring is published, snapshots each member's public key), publish
  guard-preview, and publish.
- **Publish writes to the ledger outside the DB transaction**, marking each ring published
  immediately after its own chain write, so partial runs are truthful and re-runnable.

### Ballot-access tokens (`api/src/services/ballotAccess.service.ts`)
- 32-byte CSPRNG token, **only a SHA-256 hash stored** (plaintext exists in exactly one
  email). One token per eligible voter, expiry defaults to voting close.
- Issue (super-admin, lifecycle-gated) → background batched dispatch (fresh token minted per
  send) → per-recipient status (`PENDING/SENT/FAILED/BOUNCED`), retry-failed, resend
  (per-recipient rate-limited), change-recipient.
- `POST /ring` redeems a token: locks by hash, constant-time compare, single opaque error
  for invalid/spent/expired, requires `VOTING_OPEN`, marks redeemed in-transaction
  on first retrieval, returns the ring's **ordered** public keys + candidates — **no voter index,
  no ballot**. Retrieval is idempotent until expiry so a lost tab is not a lockout; `redeemedAt`
  is stamped once, so turnout still counts voters rather than page loads.

### Key rotation (`api/src/services/keyRotation.service.ts`)
- Pending registration → key corrected in place; approved voter → files a review request
  (one pending per voter). Reviewer approves (swaps `voters.publicKey`; published rings keep
  their snapshot) or rejects with reason. Public half only — no endpoint ever accepts a
  private key.

### Audit logging (`api/src/db/schema/auditLog.ts`)
- Append-only (insert + read only). Covers registration, election, candidate, eligibility,
  ring, token, key-rotation, and admin-account actions, each with actor, action,
  entity, election scope, and before/after JSON snapshots. Global and per-election read
  endpoints.

### Mailer (`api/src/lib/mailer/`)
- `Mailer` interface with `SmtpMailer` (nodemailer) and `ConsoleMailer` (dev/test).
  Full HTML+text templates for registration approved/rejected, ballot access, and
  key-replacement requested/approved/rejected. Send failures are logged, not fatal.

### Blockchain boundary (`api/src/lib/chain/`)
- `ChainAdapter` interface deliberately has **no** `submitVote`/`getBallot` — ballots never
  pass through this server.
- `InMemoryChainAdapter`: working dev/test stub (stores rings/configs, deterministic
  tally + health). The only active adapter.
- `HttpChainAdapter`: ⛔ **stub — every method throws `NOT_IMPLEMENTED`**
  (`TODO(blockchain-team)`). This is the one genuinely unbuilt server area.

### Database (`api/src/db/`)
- Drizzle + Postgres, **11 tables**: `admins, audit_log, elections, candidates, voters,
  registrations, election_eligibility, rings, ring_members, ballot_access_tokens,
  key_rotation_requests`. Two migrations applied.
- Strong schema-level integrity: partial unique indexes (allow re-registration after
  rejection; one-pending token/rotation per voter), composite foreign keys
  (`ring_members` → eligibility and → rings with restrict/cascade), and CHECK constraints
  (ring size ≥ 2, positive positions, expiry-after-issue, key-actually-changed, etc.).
- One real repository per domain; a shared `Executor` type lets every repo run inside a
  transaction.

### Config / tooling
- Zod-validated env that fails fast on startup (`api/src/config/env.ts`): DB URL, JWT
  secret (≥ 32 chars), bcrypt rounds, SMTP, `RING_MIN_SIZE`, token dispatch/resend limits,
  etc.
- Middleware: in-memory fixed-window rate limiting (per-IP or custom key; single-node —
  noted as needing Redis to scale out), Zod validate, centralized error / not-found
  handlers.

---

## Frontend (`web/`)

Stack: React 19 + react-router-dom v7, Vite 8, Tailwind CSS v4 (CSS-first `@theme`, flat
"Modernist" look), TypeScript, React Compiler. Entry `web/src/main.tsx` → `web/src/App.tsx`.
The app builds cleanly (`dist/` present) and **every route maps to a real, non-stub page**.

### Routing & auth shell
- Public: `/register`, `/status/:id`, `/status/:id/new-key`, `/admin/login` (`/` and `*`
  redirect to `/register`).
- Admin subtree under `/admin`, wrapped in `RequireAuth` + `AdminLayout` (`<Outlet>`):
  dashboard, registrations queue, elections list/new/detail, candidates, voters, groups,
  ballot-access, monitoring, key-replacements, audit, operators.
- `RequireAuth` handles loading / anonymous (redirect carrying `from`) / authenticated;
  `AdminLayout` renders the nav rail with **live count badges** (pending registrations, key
  rotations) and filters "Operators" to super-admins.

### Voter-facing pages
- **RegisterPage** — 3-step wizard: details form (per-field validation) → **client-side
  keypair generation** with mandatory key-file download and optional local save → review &
  submit. Private key never leaves the browser; only the public key is sent.
- **VoterStatusPage** — server-driven APPROVED / REJECTED / PENDING states plus an embedded
  key-replacement prompt; discloses no PII.
- **ReplaceKeyPage** — in-browser replacement keypair, immediate-apply vs officer-review
  paths, and "cannot replace" states (pending request, frozen elections).
- **LoginPage** — email/password sign-in with typed error handling and redirect-if-already-
  authenticated.

### Admin pages (all genuinely implemented — real loads, mutations, lifecycle gating)
- **Dashboard** — stat strip, "needs you today" attention list, elections table.
- **Verification queue** — split-pane filter/paginate/search list + detail panel; single
  and **bulk** approve/reject (shift-click ranges), duplicate-flag-aware bulk guards,
  emailed rejection reasons, server-derived automated checks.
- **Elections** list + **New Election** create form (DRAFT).
- **Election detail** — editable metadata (disabled once gated off), lifecycle rail,
  server-computed action rows with blocking reasons, pre-flight guard checks, recent-activity
  feed, and transitions gated through a typed-confirmation dialog.
- **Candidates** — one ordered ballot: add/edit/delete/reorder with below-minimum warnings.
- **Groups** — anonymity-group formation & publish: preview stats, per-group visual tiles,
  re-form with shuffle fingerprint, freeze-&-publish behind confirmation (super-admin).
- **Ballot access** — issue/dispatch/retry/resend ballot links, per-recipient delivery
  table + progress, filters; never shows ballot content.
- **Monitoring** — turnout %, ledger panel (nodes/height/rejected), and a tally panel that
  stays empty until voting closes.
- **Voters** — electoral-roll management (available pool vs on-roll), bulk add/remove,
  ring-locked voters non-removable.
- **Key replacements** — review queue showing old/new key fingerprints, approve/reject with
  emailed reason.
- **Audit** — append-only log with election/action filters and a before/after diff
  summarizer.
- **Operators** (super-admin) — create operators (one-time password shown once), toggle
  role, activate/deactivate with last-super-admin guards, change own password.

### Shared infrastructure
- Typed API client (`web/src/api/client.ts`): `{ data }` unwrap, `ApiError` with field
  errors, bearer-token injection from localStorage. ~40 typed endpoint functions
  (`endpoints.ts`) and ~52 shared types (`types.ts`).
- Auth context seeds session from stored token and validates it on mount.
- Reusable design-system primitives, segmented controls, confirmation dialog (focus trap +
  typed phrase), lifecycle rail, and data hooks (`useAsyncData` abortable loader,
  `useSelection` multi-select with range clicks).

---

## Known gaps / follow-ups (non-blocking)

- **`HttpChainAdapter` is a stub** — real ledger integration awaits the blockchain team's
  routes (`api/src/lib/chain/http.ts`).
- **`admin.logged_in` audit action** is defined but never recorded (login only updates
  `lastLoginAt`).
- **Rate limiting is in-memory / single-node** — needs a shared store (e.g. Redis) before
  running multiple API instances.
- Minor frontend tidy-ups: a legacy `registrations/:id` redirect route and an unused
  `StatusBadge` component; neither affects functionality.
