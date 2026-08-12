/**
 * Public types for the LRS (Linkable Spontaneous Anonymous Group signature) library.
 *
 * These are the exact shapes from SECUREPOLL_CONTEXT.md §5.4 — the cross-team contract.
 * A `Scalar` and a `Point` are both raw 32-byte `Uint8Array`s so that this library has no
 * opinion about string encodings: base64url lives at the application boundary, not here.
 */

/** A 32-byte, little-endian, canonical scalar in [0, q-1]. */
export type Scalar = Uint8Array;

/** A 32-byte compressed (canonical) ristretto255 point. */
export type Point = Uint8Array;

export interface KeyPair {
  /** Secret scalar x. Never leaves the voter's device. */
  privateKey: Scalar;
  /** Public point P = x·G. */
  publicKey: Point;
}

export interface RingSignature {
  /** The challenge at ring index 0. Always index 0, never the signer's index. */
  c0: Scalar;
  /** One response scalar per ring member, in ring order. `s.length` is the ring size. */
  s: Scalar[];
  /** Key image I = x·H_p(P ‖ electionId). Stable per signer per election. */
  keyImage: Point;
}
