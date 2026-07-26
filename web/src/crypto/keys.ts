import { ristretto255 } from "@noble/curves/ed25519.js";
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils.js";

/**
 * TEMPORARY. This is a stopgap so the registration page can produce a real keypair before
 * the LRS library exists. Once `lrs` ships its `generateKeyPair()` (context doc §5.4) this
 * file should be deleted and the import swapped, so that key generation and signing share
 * one implementation rather than drifting apart.
 *
 * The scheme is fixed by that document: ristretto255, private key a scalar in [1, q-1],
 * public key P = x·G.
 */

const Point = ristretto255.Point;
const SCALAR_BYTES = 32;

export interface VoterKeyPair {
  /** 32-byte little-endian scalar, base64url. Never transmitted. */
  privateKey: string;
  /** 32-byte compressed ristretto255 point, base64url. Sent to the server. */
  publicKey: string;
}

function randomScalar(): bigint {
  const order = Point.Fn.ORDER;
  // Reducing 64 random bytes rather than 32 keeps the result statistically uniform over
  // [0, q-1]; reducing exactly 32 would skew towards small values.
  const wide = crypto.getRandomValues(new Uint8Array(64));
  const scalar = bytesToNumberLE(wide) % order;
  // A zero private key has public key = identity and can never produce a valid signature.
  return scalar === 0n ? 1n : scalar;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Runs entirely in the browser. The private key is returned to the caller and must never be
 * put in a request body — the whole anonymity argument rests on the server never holding it.
 */
export function generateVoterKeyPair(): VoterKeyPair {
  const scalar = randomScalar();
  const publicKey = Point.BASE.multiply(scalar).toBytes();
  return {
    privateKey: toBase64Url(numberToBytesLE(scalar, SCALAR_BYTES)),
    publicKey: toBase64Url(publicKey),
  };
}

/**
 * A short, readable name for a key, shown in groups of four.
 *
 * Presentation only — derived from the *public* half, so it discloses nothing secret, and nothing
 * accepts it as input. It exists so a voter and an election officer can confirm they mean the same
 * key without reading out 43 base64 characters.
 */
export function fingerprintOf(publicKey: string): string {
  const cleaned = publicKey.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return [cleaned.slice(0, 4), cleaned.slice(4, 8), cleaned.slice(8, 12)].join("·");
}

/**
 * Hands the voter their key as a file.
 *
 * This is the only durable copy that exists. Nothing is uploaded: the download is assembled in the
 * browser from a keypair the browser generated, and the server never sees the private half.
 */
export function downloadKeyFile(keyPair: VoterKeyPair, filename = "voting-key.securepoll"): void {
  const contents = [
    "SecurePoll voting key — keep this file private.",
    "",
    "Anyone holding this private key can cast your vote. It is not stored on the",
    "election server and cannot be recovered if you lose it.",
    "",
    `fingerprint:  ${fingerprintOf(keyPair.publicKey)}`,
    `private_key:  ${keyPair.privateKey}`,
    `public_key:   ${keyPair.publicKey}`,
    "",
  ].join("\n");

  const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
