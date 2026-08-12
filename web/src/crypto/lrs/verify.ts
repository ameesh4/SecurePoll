/**
 * LSAG verification (SECUREPOLL_CONTEXT.md §5.3).
 *
 * Verification is also the answer to "prove this key image came from the ring": the
 * R_i = s_i·H_p(P_i) + c_i·I terms weave the key image I into the same challenge chain as
 * the ring L. If the chain closes (recomputed c_0 equals the provided c_0), then I was
 * produced by a holder of one of the ring's private keys — there is no separate membership
 * check, and cryptographically there cannot be one from a bare (keyImage, ring) pair.
 *
 * Any malformed input (wrong length, non-canonical scalar/point, identity key image)
 * returns `false` rather than throwing: a verifier's job is to reject, not to crash on
 * adversarial bytes.
 */
import type { Point, RingSignature } from "./types";
import {
  add,
  bytesToScalar,
  decodeRingMember,
  isIdentity,
  mul,
  mulG,
  scalarToBytes,
  type CurvePoint,
} from "./curve";
import { challenge, keyImageBase } from "./hash";

export interface VerifyParams {
  message: Uint8Array;
  ring: Point[];
  signature: RingSignature;
  electionId: string;
}

export function verify(params: VerifyParams): boolean {
  const { message, ring, signature, electionId } = params;
  const n = ring.length;

  try {
    // --- structural checks ---
    if (n < 2) return false;
    if (signature.s.length !== n) return false;

    // Key image must be a canonical, non-identity point. An identity key image is the
    // classic degenerate forgery and must be rejected before any arithmetic.
    const image = decodeRingMember(signature.keyImage);
    if (isIdentity(image)) return false;

    // Decode ring members (rejects non-canonical / identity) and response scalars
    // (bytesToScalar rejects any s_i ≥ q, killing malleability).
    const P: CurvePoint[] = ring.map((bytes) => decodeRingMember(bytes));
    const H: CurvePoint[] = ring.map((bytes) => keyImageBase(bytes, electionId));
    const s: bigint[] = signature.s.map((si) => bytesToScalar(si));
    const c0 = bytesToScalar(signature.c0);

    // --- re-walk the ring ---
    let c = c0;
    for (let i = 0; i < n; i++) {
      const li = add(mulG(s[i]!), mul(P[i]!, c)); // L_i = s_i·G + c_i·P_i
      const ri = add(mul(H[i]!, s[i]!), mul(image, c)); // R_i = s_i·H_p(P_i) + c_i·I
      c = challenge(message, ring, li, ri); // c_{i+1}
    }

    // Accept iff the chain closed back to the provided c_0. Compare via canonical bytes so
    // the check is a fixed-shape equality on 32-byte arrays.
    return bytesEqual(scalarToBytes(c), scalarToBytes(c0));
  } catch {
    // Any decode failure (bad length, non-canonical point/scalar) is a rejection.
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
