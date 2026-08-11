/**
 * The two hash functions the scheme needs, plus the challenge transcript.
 *
 * This is the ONLY file that imports the hashing primitives (`ristretto255_hasher` and
 * SHA-512). Both functions are domain-separated with fixed ASCII prefixes and every
 * variable-length input is length-prefixed, so no two distinct logical inputs can ever
 * collide by concatenating to the same byte string. The Rust verifier must reproduce
 * these byte-for-byte — see WIRE_FORMAT.md.
 */
import { ristretto255_hasher } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, concatBytes } from "@noble/curves/utils.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { modQ, type CurvePoint, pointToBytes } from "./curve";

const ASCII = new TextEncoder();

// Domain-separation tags. Bump the version if any hash construction changes — a Rust
// verifier keyed to v1 must never silently accept a v2 signature.
const DST_HP = "SECUREPOLL/v1/H_p";
const PREFIX_HS = ASCII.encode("SECUREPOLL/v1/H_s");
const PREFIX_CHAL = ASCII.encode("SECUREPOLL/v1/chal");

/** 4-byte little-endian length tag. */
export function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`u32le out of range: ${n}`);
  }
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}

/** length ‖ bytes — the atom that makes concatenations unambiguous. */
function lenPrefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(u32le(bytes.length), bytes);
}

/**
 * H_p — hash to a ristretto255 point via RFC 9380 (XMD:SHA-512 → Elligator).
 *
 * CRITICAL: this is a real hash-to-curve, NOT "hash then multiply by G". If H_p(P) were
 * h·G for a known scalar h, then the key image I = x·H_p(P) = x·h·G = h·(x·G) = h·P would
 * be computable by anyone from the public key alone — the key image would be forgeable and
 * the whole double-vote defence would collapse.
 */
export function hashToPoint(bytes: Uint8Array): CurvePoint {
  return ristretto255_hasher.hashToCurve(bytes, { DST: DST_HP }) as CurvePoint;
}

/**
 * The per-signer key-image base: H_p(P ‖ electionId).
 *
 * Election-scoping is what gives "one vote per voter per election" without linking a
 * voter's ballots across different elections (SECUREPOLL_CONTEXT.md §5.1).
 */
export function keyImageBase(publicKey: Uint8Array, electionId: string): CurvePoint {
  const eid = ASCII.encode(electionId);
  return hashToPoint(concatBytes(lenPrefixed(publicKey), lenPrefixed(eid)));
}

/**
 * H_s — hash to a scalar. Plain SHA-512 over the domain-separated input, interpreted as a
 * little-endian integer and reduced mod q. This is deliberately the simplest possible
 * construction (§5.2): it maps one-to-one onto dalek's `Scalar::from_bytes_mod_order_wide`
 * on the Rust side, so cross-language agreement needs no RFC-9380 expander.
 */
export function hashToScalar(bytes: Uint8Array): bigint {
  const digest = sha512(concatBytes(PREFIX_HS, bytes));
  return modQ(bytesToNumberLE(digest));
}

/**
 * The challenge c = H_s over the full transcript. Binds the message, the entire ring (in
 * contract order), and the current (L_i, R_i) pair. Because the message is variable length
 * it is length-prefixed; the ring is length-prefixed by member count so that its boundary
 * with the following fields is unambiguous too.
 *
 * @param message   the canonical signed message (see serialize.encodeMessage)
 * @param ringBytes the ring's public keys, already encoded, in ring order
 * @param li        the L_i point for this step
 * @param ri        the R_i point for this step
 */
export function challenge(
  message: Uint8Array,
  ringBytes: readonly Uint8Array[],
  li: CurvePoint,
  ri: CurvePoint,
): bigint {
  const parts: Uint8Array[] = [
    PREFIX_CHAL,
    lenPrefixed(message),
    u32le(ringBytes.length),
    ...ringBytes,
    pointToBytes(li),
    pointToBytes(ri),
  ];
  return hashToScalar(concatBytes(...parts));
}
