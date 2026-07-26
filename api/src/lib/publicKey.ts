import { ristretto255 } from "@noble/curves/ed25519.js";

export const PUBLIC_KEY_BYTE_LENGTH = 32;

/**
 * A voter's public key is a compressed ristretto255 point, base64url encoded.
 *
 * This is validated at the door rather than at ring-formation time on purpose. An
 * unparseable key that reaches a ring is not a bad row, it is a ring that cannot be
 * verified against — and by then the ring may already be published and frozen. Rejecting a
 * malformed key costs one registration; discovering it later costs an election.
 */
export function isValidVoterPublicKey(encoded: string): boolean {
  return describeVoterPublicKey(encoded) === null;
}

/** Returns null when the key is usable, or a human-readable reason when it is not. */
export function describeVoterPublicKey(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return "Public key must be base64url encoded";
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    return "Public key must be base64url encoded";
  }

  if (bytes.length !== PUBLIC_KEY_BYTE_LENGTH) {
    return `Public key must decode to ${PUBLIC_KEY_BYTE_LENGTH} bytes, got ${bytes.length}`;
  }

  let point: InstanceType<typeof ristretto255.Point>;
  try {
    // Rejects non-canonical encodings as well as bytes that are not a point at all.
    point = ristretto255.Point.fromBytes(Uint8Array.from(bytes));
  } catch {
    return "Public key is not a valid ristretto255 point";
  }

  // The identity has a known discrete log of zero, so its holder could not produce a
  // signature and its presence would weaken every ring it appeared in.
  if (point.equals(ristretto255.Point.ZERO)) {
    return "Public key must not be the identity element";
  }

  return null;
}
