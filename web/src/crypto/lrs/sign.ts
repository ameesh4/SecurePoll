/**
 * LSAG signing (SECUREPOLL_CONTEXT.md §5.3).
 *
 * The scheme builds a ring of challenge/response values that only closes into a consistent
 * loop if the signer knows one private key in the ring. The signer starts the loop at a
 * random point just after their own index, walks all the way around fabricating consistent
 * (s_i, c_i) pairs for the other members, and finally uses their secret to "close the gap"
 * at their own index. A verifier re-walks the whole loop and checks it closes — without
 * ever learning where the gap was closed.
 */
import type { Point, RingSignature, Scalar } from "./types";
import {
  add,
  bytesToScalar,
  decodeRingMember,
  modQ,
  mul,
  mulG,
  pointToBytes,
  pointsEqual,
  randomScalar,
  scalarToBytes,
  type CurvePoint,
} from "./curve";
import { challenge, keyImageBase } from "./hash";

export interface SignParams {
  /** Canonical signed message — use serialize.encodeMessage, never a free-form string. */
  message: Uint8Array;
  /** The ring's public keys, in the exact published order. */
  ring: Point[];
  /** Index of the signer's own public key within `ring`. */
  signerIndex: number;
  /** The signer's private scalar. */
  privateKey: Scalar;
  /** The election this vote belongs to; scopes the key image. */
  electionId: string;
}

export function sign(params: SignParams): RingSignature {
  const { message, ring, signerIndex: pi, privateKey, electionId } = params;
  const n = ring.length;

  // --- validation ---
  if (n < 2) {
    // A ring of size 1 is a signature with the voter's name on it (§4 invariant 6).
    throw new Error(`ring must have at least 2 members, got ${n}`);
  }
  if (!Number.isInteger(pi) || pi < 0 || pi >= n) {
    throw new Error(`signerIndex ${pi} out of range for ring size ${n}`);
  }

  const x = bytesToScalar(privateKey);
  // Decode every ring member up front: rejects non-canonical points and the identity.
  const P: CurvePoint[] = ring.map((bytes, i) => {
    try {
      return decodeRingMember(bytes);
    } catch (e) {
      throw new Error(`ring member ${i} is invalid: ${(e as Error).message}`, { cause: e });
    }
  });

  // Defensive: the secret must actually correspond to the claimed index, otherwise the
  // signature would be silently unverifiable. Catching it here turns a confusing "verify
  // returns false" into an actionable error at signing time.
  if (!pointsEqual(mulG(x), P[pi])) {
    throw new Error("privateKey does not match ring[signerIndex]");
  }

  // Per-signer key-image bases H_p(P_i ‖ eid), reused in every step.
  const H: CurvePoint[] = ring.map((bytes) => keyImageBase(bytes, electionId));

  // Key image I = x·H_p(P_π ‖ eid).
  const image = mul(H[pi], x);

  // --- ring construction ---
  const alpha = randomScalar();
  const s: bigint[] = new Array<bigint>(n);
  for (let i = 0; i < n; i++) {
    if (i !== pi) s[i] = randomScalar();
  }

  const c: bigint[] = new Array<bigint>(n);
  // Seed the challenge chain at the position AFTER the signer. The R-side uses the
  // signer's key-image base (α·H_p(P_π)), mirroring R_i = s_i·H_p(P_i) + c_i·I.
  c[(pi + 1) % n] = challenge(message, ring, mulG(alpha), mul(H[pi], alpha));

  // Walk the ring once, wrapping around; the final step (k = n-1) produces c_π.
  for (let k = 1; k < n; k++) {
    const i = (pi + k) % n;
    const li = add(mulG(s[i]), mul(P[i], c[i])); // L_i = s_i·G + c_i·P_i
    const ri = add(mul(H[i], s[i]), mul(image, c[i])); // R_i = s_i·H_p(P_i) + c_i·I
    c[(i + 1) % n] = challenge(message, ring, li, ri);
  }

  // Close the loop with the secret: s_π = α − c_π·x  (mod q).
  s[pi] = modQ(alpha - modQ(c[pi] * x));

  return {
    c0: scalarToBytes(c[0]),
    s: s.map((si) => scalarToBytes(si)),
    keyImage: pointToBytes(image),
  };
}
