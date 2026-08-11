/**
 * Canonical byte encodings — the cross-language contract with the Rust verifier.
 *
 * Every layout here is fixed-width and deterministic (no maps, no optional fields), so the
 * same signature always serializes to the same bytes and a Rust node can reproduce and
 * re-verify it. The wire format is specified in full in WIRE_FORMAT.md; this file is its
 * executable copy. Do not change either without changing the version byte AND the DSTs in
 * hash.ts — a v1 verifier must never silently accept a v2 signature.
 */
import type { RingSignature } from "./types";
import {
  bytesToScalar,
  POINT_BYTES,
  SCALAR_BYTES,
  bytesToPoint,
  isIdentity,
} from "./curve";
import { u32le } from "./hash";

const ASCII = new TextEncoder();

/** Wire format version. Increment on any breaking change to layout or hashing. */
export const SIGNATURE_VERSION = 0x01;

// Fixed offsets within a serialized signature (see WIRE_FORMAT.md).
const OFF_VERSION = 0;
const OFF_N = 1; // u32le
const OFF_C0 = 5; // 32-byte scalar
const OFF_KEY_IMAGE = 37; // 32-byte point
const OFF_S = 69; // first s scalar; then 32*n bytes
const HEADER_BYTES = OFF_S;

function readU32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Serialize: version ‖ u32le(n) ‖ c0 ‖ keyImage ‖ s[0..n-1].
 * Total length = 69 + 32·n bytes.
 */
export function serializeSignature(sig: RingSignature): Uint8Array {
  const n = sig.s.length;
  if (n < 2) throw new Error(`ring size must be >= 2, got ${n}`);
  if (sig.c0.length !== SCALAR_BYTES) throw new Error("c0 must be 32 bytes");
  if (sig.keyImage.length !== POINT_BYTES) throw new Error("keyImage must be 32 bytes");

  const out = new Uint8Array(HEADER_BYTES + SCALAR_BYTES * n);
  out[OFF_VERSION] = SIGNATURE_VERSION;
  out.set(u32le(n), OFF_N);
  out.set(sig.c0, OFF_C0);
  out.set(sig.keyImage, OFF_KEY_IMAGE);
  for (let i = 0; i < n; i++) {
    const si = sig.s[i];
    if (si.length !== SCALAR_BYTES) throw new Error(`s[${i}] must be 32 bytes`);
    out.set(si, OFF_S + i * SCALAR_BYTES);
  }
  return out;
}

/**
 * Deserialize and validate. Rejects: wrong version, mismatched length, non-canonical
 * scalars (≥ q), non-canonical or identity points. A signature that survives this is
 * structurally sound — though still subject to `verify` for cryptographic validity.
 */
export function deserializeSignature(bytes: Uint8Array): RingSignature {
  if (bytes.length < HEADER_BYTES) {
    throw new Error("signature buffer too short");
  }
  if (bytes[OFF_VERSION] !== SIGNATURE_VERSION) {
    throw new Error(`unsupported signature version ${bytes[OFF_VERSION]}`);
  }
  const n = readU32le(bytes, OFF_N);
  if (n < 2) throw new Error(`ring size must be >= 2, got ${n}`);
  const expectedLength = HEADER_BYTES + SCALAR_BYTES * n;
  if (bytes.length !== expectedLength) {
    throw new Error(`expected ${expectedLength} bytes for n=${n}, got ${bytes.length}`);
  }

  const c0Bytes = bytes.slice(OFF_C0, OFF_C0 + SCALAR_BYTES);
  bytesToScalar(c0Bytes); // canonical-scalar check (throws if >= q)

  const keyImage = bytes.slice(OFF_KEY_IMAGE, OFF_KEY_IMAGE + POINT_BYTES);
  const imagePoint = bytesToPoint(keyImage); // canonical-point check (throws if invalid)
  if (isIdentity(imagePoint)) throw new Error("keyImage must not be the identity element");

  const s: Uint8Array[] = new Array<Uint8Array>(n);
  for (let i = 0; i < n; i++) {
    const si = bytes.slice(OFF_S + i * SCALAR_BYTES, OFF_S + (i + 1) * SCALAR_BYTES);
    bytesToScalar(si); // canonical-scalar check
    s[i] = si;
  }

  return { c0: c0Bytes, s, keyImage };
}

export interface VoteMessage {
  electionId: string;
  ringId: string;
  candidateId: string;
}

/**
 * The canonical message that gets signed: a length-prefixed, domain-separated encoding of
 * {electionId, ringId, candidateId}. It is NEVER a free-form string — binding electionId
 * and ringId here is what stops a signature being replayed into another election or ring.
 *
 * Layout: "SECUREPOLL/v1/vote" ‖ lp(electionId) ‖ lp(ringId) ‖ lp(candidateId),
 * where lp(x) = u32le(len utf8(x)) ‖ utf8(x).
 */
export function encodeMessage(vote: VoteMessage): Uint8Array {
  const parts: Uint8Array[] = [ASCII.encode("SECUREPOLL/v1/vote")];
  for (const field of [vote.electionId, vote.ringId, vote.candidateId]) {
    const encoded = ASCII.encode(field);
    parts.push(u32le(encoded.length), encoded);
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** base64url (no padding) — the encoding the app and DB use for scalars and points. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of toBase64Url. */
export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
