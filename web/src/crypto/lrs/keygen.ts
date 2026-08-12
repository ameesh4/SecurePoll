/**
 * Key generation and key-image derivation (SECUREPOLL_CONTEXT.md §5.3).
 */
import type { KeyPair, Point, Scalar } from "./types";
import {
  bytesToScalar,
  mul,
  mulG,
  pointToBytes,
  randomScalar,
  scalarToBytes,
} from "./curve";
import { keyImageBase } from "./hash";

/**
 * KeyGen: x ← random scalar in [1, q-1]; P = x·G.
 *
 * Runs entirely in the browser. The private key is returned to the caller and must never
 * be transmitted — the whole anonymity argument rests on the server never holding it.
 */
export function generateKeyPair(): KeyPair {
  const x = randomScalar();
  return {
    privateKey: scalarToBytes(x),
    publicKey: pointToBytes(mulG(x)),
  };
}

/**
 * P = x·G — the public half of a private key.
 *
 * Exposed because a voter loading their saved key file needs to find *their own* position in a
 * published ring, and the server deliberately refuses to tell them which one it is. Deriving the
 * public key locally and matching it against the ring is how the client answers that itself.
 */
export function derivePublicKey(privateKey: Scalar): Point {
  return pointToBytes(mulG(bytesToScalar(privateKey)));
}

/**
 * The key image I = x·H_p(P ‖ electionId), where P = x·G is recomputed from the secret.
 *
 * The same signer produces the same key image for a given election regardless of which
 * ring they sign in (that is the point of the CryptoNote per-key form), which is what lets
 * the ledger detect a double vote. It reveals nothing about which public key produced it.
 */
export function deriveKeyImage(privateKey: Scalar, electionId: string): Point {
  const x = bytesToScalar(privateKey);
  const publicKey = pointToBytes(mulG(x));
  const image = mul(keyImageBase(publicKey, electionId), x);
  return pointToBytes(image);
}
