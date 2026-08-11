/**
 * The group layer. This is the ONLY file in the library that imports `@noble/curves`.
 *
 * Everything above it (sign, verify, keygen) works in terms of `bigint` scalars and
 * `CurvePoint` objects and never touches curve internals or byte layouts directly. Keeping
 * the primitive quarantined here means the algorithm files read like the paper, and there
 * is exactly one place to audit for "is the field arithmetic being used correctly."
 *
 * Group: ristretto255 — a prime-order group, so there are no cofactor or small-subgroup
 * pitfalls to defend against (this is why the project prefers it over raw ed25519).
 */
import { ristretto255 } from "@noble/curves/ed25519.js";
import {
  bytesToNumberLE,
  numberToBytesLE,
} from "@noble/curves/utils.js";

const RPoint = ristretto255.Point;

/** A ristretto255 group element. Opaque to the rest of the library. */
export type CurvePoint = InstanceType<typeof RPoint>;

/** The prime group order q. Scalars live in [0, q-1]. */
export const Q: bigint = RPoint.Fn.ORDER;

/** Base point G. */
export const G: CurvePoint = RPoint.BASE;

/** Identity element (the zero point). */
export const IDENTITY: CurvePoint = RPoint.ZERO;

export const SCALAR_BYTES = 32;
export const POINT_BYTES = 32;

/** Reduce a bigint into [0, q-1]. */
export function modQ(n: bigint): bigint {
  const r = n % Q;
  return r < 0n ? r + Q : r;
}

/**
 * A uniformly random non-zero scalar in [1, q-1].
 *
 * Reducing 64 random bytes rather than 32 keeps the result statistically uniform over the
 * range; reducing exactly 32 bytes would skew towards small values. A zero scalar is
 * rejected because it has no valid use here (a zero private key's public key is the
 * identity; a zero nonce would leak the secret). This mirrors the pattern the temporary
 * `web/src/crypto/keys.ts` used, now living in one place.
 */
export function randomScalar(): bigint {
  const wide = crypto.getRandomValues(new Uint8Array(64));
  const scalar = modQ(bytesToNumberLE(wide));
  return scalar === 0n ? 1n : scalar;
}

/** Encode a scalar as 32 canonical little-endian bytes. Caller must pass a value < q. */
export function scalarToBytes(s: bigint): Uint8Array {
  return numberToBytesLE(modQ(s), SCALAR_BYTES);
}

/**
 * Decode 32 little-endian bytes into a scalar, rejecting non-canonical encodings (values
 * ≥ q). Rejecting non-canonical scalars removes signature malleability — otherwise
 * `s` and `s + q` would both decode to the same value.
 */
export function bytesToScalar(bytes: Uint8Array): bigint {
  if (bytes.length !== SCALAR_BYTES) {
    throw new Error(`scalar must be ${SCALAR_BYTES} bytes, got ${bytes.length}`);
  }
  const n = bytesToNumberLE(bytes);
  if (n >= Q) {
    throw new Error("scalar is not canonical (>= group order)");
  }
  return n;
}

/** Encode a point as its 32-byte canonical compressed form. */
export function pointToBytes(p: CurvePoint): Uint8Array {
  return p.toBytes();
}

/**
 * Decode 32 bytes into a ristretto255 point. `Point.fromBytes` rejects both non-canonical
 * encodings and byte strings that are not points at all — the same check the server uses
 * in `api/src/lib/publicKey.ts`.
 */
export function bytesToPoint(bytes: Uint8Array): CurvePoint {
  if (bytes.length !== POINT_BYTES) {
    throw new Error(`point must be ${POINT_BYTES} bytes, got ${bytes.length}`);
  }
  return RPoint.fromBytes(bytes);
}

/** P = s·G. */
export function mulG(s: bigint): CurvePoint {
  return G.multiply(modQ(s));
}

/** Q = s·P. Handles s = 0 (→ identity), which noble's `multiply` rejects. */
export function mul(p: CurvePoint, s: bigint): CurvePoint {
  const r = modQ(s);
  return r === 0n ? IDENTITY : p.multiply(r);
}

/** A + B. */
export function add(a: CurvePoint, b: CurvePoint): CurvePoint {
  return a.add(b);
}

export function isIdentity(p: CurvePoint): boolean {
  return p.equals(IDENTITY);
}

export function pointsEqual(a: CurvePoint, b: CurvePoint): boolean {
  return a.equals(b);
}

/**
 * Parse and validate a ring member's public key: must be a canonical, non-identity point.
 * The identity has a known discrete log of zero, so its holder could not sign and its
 * presence would weaken every ring it appeared in.
 */
export function decodeRingMember(bytes: Uint8Array): CurvePoint {
  const p = bytesToPoint(bytes);
  if (isIdentity(p)) {
    throw new Error("ring member must not be the identity element");
  }
  return p;
}
