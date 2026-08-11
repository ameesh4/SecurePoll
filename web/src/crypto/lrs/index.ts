/**
 * SecurePoll LRS — Linkable Spontaneous Anonymous Group signatures (LSAG) over
 * ristretto255, with a CryptoNote-style, election-scoped key image.
 *
 * Scheme, parameters, and wire format are specified in SECUREPOLL_CONTEXT.md §5 and
 * ./WIRE_FORMAT.md. This library is the academic core of the project: it runs in the
 * browser, the private key never leaves it, and its output is re-verified by the Rust
 * blockchain nodes.
 *
 * The public surface below matches §5.4 exactly; `encodeMessage`, `keyImageKey`, and the
 * base64url helpers are documented additions used at the application boundary.
 */
export type { Scalar, Point, KeyPair, RingSignature } from "./types";

export { generateKeyPair, derivePublicKey, deriveKeyImage } from "./keygen";
export { sign, type SignParams } from "./sign";
export { verify, type VerifyParams } from "./verify";
export { areLinked, keyImageKey } from "./link";
export {
  serializeSignature,
  deserializeSignature,
  encodeMessage,
  type VoteMessage,
  toBase64Url,
  fromBase64Url,
  SIGNATURE_VERSION,
} from "./serialize";
