# SecurePoll LRS — Wire Format (v1)

This document is the cross-language contract between the TypeScript signer (this library)
and the Rust blockchain verifier. Both sides MUST agree on every byte described here. The
canonical, executable copy of these layouts lives in `serialize.ts` and `hash.ts`; this
file explains them and is the reference the Rust team implements against.

If anything here changes, bump **both** the signature `version` byte (`serialize.ts`,
`SIGNATURE_VERSION`) and the domain-separation tags (`hash.ts`, the `SECUREPOLL/v1/...`
prefixes). A v1 verifier must never silently accept a v2 signature.

## Group and encodings

- **Group:** ristretto255 (prime order `q`, base point `G`).
- **Scalar:** 32 bytes, **little-endian**, canonical (value `< q`). Matches noble
  `numberToBytesLE`/`bytesToNumberLE` and dalek `Scalar::to_bytes` /
  `Scalar::from_canonical_bytes`. Non-canonical scalars (≥ q) MUST be rejected on decode.
- **Point:** 32 bytes, the RFC 9496 canonical compressed ristretto255 encoding. Matches
  noble `Point.toBytes`/`Point.fromBytes` and dalek `CompressedRistretto`. Non-canonical
  encodings and the identity element MUST be rejected where noted.

## Hash functions

Both are domain-separated and length-prefix every variable-length input. `lp(x)` below
means `u32le(len(x)) ‖ x`, where `u32le` is a 4-byte little-endian unsigned length.

### H_p — hash to point (key-image base)

```
H_p(bytes) = ristretto255_hash_to_curve(bytes, DST = "SECUREPOLL/v1/H_p")
```

This is **RFC 9380** `hash_to_ristretto255`: `expand_message_xmd` with SHA-512 producing 64
uniform bytes, then the ristretto255 Elligator map. It is **NOT** "hash then multiply by G"
(that would make the key image forgeable), and it is **NOT** dalek's
`RistrettoPoint::from_uniform_bytes` / `hash_from_bytes` (which map a *raw* 64-byte hash
without the RFC 9380 XMD expansion).

> **Rust interop note.** Use a crate implementing RFC 9380 `hash_to_ristretto255` with the
> DST above (e.g. the `hash_to_curve`/`voprf` ecosystem), not `from_uniform_bytes`. Confirm
> against the committed `test-vectors/*.json` H_p intermediate before building on it.

The key-image base for a signer is:

```
keyImageBase(P, electionId) = H_p( lp(P) ‖ lp(utf8(electionId)) )
```

### H_s — hash to scalar (challenges)

```
H_s(bytes) = bytesToNumberLE( SHA-512( "SECUREPOLL/v1/H_s" ‖ bytes ) ) mod q
```

SHA-512 → interpret the 64 bytes little-endian → reduce mod q. This maps one-to-one onto
dalek `Scalar::from_bytes_mod_order_wide(sha512(prefix ‖ bytes))`.

### Challenge transcript

Each challenge in the ring is `H_s` over this transcript:

```
challenge(m, ring, L_i, R_i) =
  H_s(
    "SECUREPOLL/v1/chal"
    ‖ lp(m)                      // canonical signed message (below)
    ‖ u32le(n) ‖ P_0 ‖ … ‖ P_{n-1}   // ring public keys, in published order
    ‖ L_i                        // 32-byte point
    ‖ R_i                        // 32-byte point
  )
```

`n` is the ring size; the `P_i` are 32-byte points in the exact published ring order.
Reordering the ring changes every challenge — ring order is part of the contract.

## Canonical signed message

The `message` fed to `sign`/`verify` is NOT free-form. It is:

```
encodeMessage(electionId, ringId, candidateId) =
  "SECUREPOLL/v1/vote" ‖ lp(utf8(electionId)) ‖ lp(utf8(ringId)) ‖ lp(utf8(candidateId))
```

Binding `electionId` and `ringId` here prevents replay of a signature into another election
or ring.

## Signature serialization

`serializeSignature(sig)` → fixed layout, total length `69 + 32·n`:

| offset | size   | field      | notes                                   |
|-------:|-------:|------------|-----------------------------------------|
| 0      | 1      | `version`  | `0x01`                                   |
| 1      | 4      | `n`        | u32le; ring size = length of `s`         |
| 5      | 32     | `c0`       | scalar (challenge at ring index 0)       |
| 37     | 32     | `keyImage` | point; MUST NOT be identity              |
| 69     | 32·n   | `s[0..n-1]`| scalars, in ring order                   |

`c0` is always the challenge at **index 0**, never the signer's index — this is what makes
the signature positionally indistinguishable (the anonymity property).

`deserializeSignature` MUST reject: a wrong version byte; a total length `≠ 69 + 32·n`; any
scalar `≥ q`; a non-canonical `keyImage`; and an identity `keyImage`.

## Verification (summary)

Given `(m, ring, {c0, s, keyImage}, electionId)`:

1. Reject if `keyImage` is non-canonical or identity, if `s.length ≠ n`, or if any ring
   member / scalar is non-canonical.
2. `c ← c0`; for `i = 0 … n-1`:
   `L_i = s_i·G + c·P_i`, `R_i = s_i·H_p(P_i‖eid) + c·keyImage`, `c ← challenge(m, ring, L_i, R_i)`.
3. Accept iff the final `c == c0`.

## Linkability

Two signatures are linked iff their `keyImage` bytes are equal. The key image is
`x·H_p(P‖electionId)`, so equality means "same signer, same election" — independent of ring
composition, and never across elections.

## Test vectors

`test-vectors/*.json` carry base64url ring keys, `electionId`/`ringId`/`candidateId`, the
encoded message, the serialized signature, and `expected` (true/false), plus at least one
`H_p` and one `H_s` intermediate. The Rust verifier should load these and confirm it agrees
before trusting its own implementation of the hashes above.
