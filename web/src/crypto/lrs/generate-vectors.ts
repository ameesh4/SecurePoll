/**
 * Generates the committed cross-language test vectors in `test-vectors/vectors.json`.
 *
 * Run once (and re-run only when the scheme intentionally changes):
 *   bun run src/crypto/lrs/generate-vectors.ts
 *
 * The output is the artifact handed to the Rust verifier team: each vector carries the
 * ring, the vote fields, the encoded message, the serialized signature, and whether it must
 * verify — plus one H_p and one H_s intermediate so a mismatch can be localized to a
 * specific hash rather than "the signature just doesn't verify."
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeMessage,
  generateKeyPair,
  serializeSignature,
  sign,
  toBase64Url,
  SIGNATURE_VERSION,
  type KeyPair,
} from "./index";
import { hashToScalar, keyImageBase } from "./hash";
import { pointToBytes, scalarToBytes } from "./curve";

interface Vector {
  name: string;
  description: string;
  electionId: string;
  ringId: string;
  candidateId: string;
  ring: string[]; // base64url public keys, in order
  signerIndex: number; // for reference only; NOT part of what a verifier learns
  message: string; // base64url of the canonical signed message
  signature: string; // base64url of the serialized signature
  expected: boolean; // must verify()?
}

function buildPositive(name: string, description: string, n: number, signerIndex: number, ids: { e: string; r: string; c: string }): Vector {
  const keys: KeyPair[] = Array.from({ length: n }, () => generateKeyPair());
  const ring = keys.map((k) => k.publicKey);
  const message = encodeMessage({ electionId: ids.e, ringId: ids.r, candidateId: ids.c });
  const sig = sign({ message, ring, signerIndex, privateKey: keys[signerIndex].privateKey, electionId: ids.e });
  return {
    name,
    description,
    electionId: ids.e,
    ringId: ids.r,
    candidateId: ids.c,
    ring: ring.map(toBase64Url),
    signerIndex,
    message: toBase64Url(message),
    signature: toBase64Url(serializeSignature(sig)),
    expected: true,
  };
}

const vectors: Vector[] = [
  buildPositive("size2-idx0", "smallest valid ring, signer at index 0", 2, 0, { e: "election-2026", r: "ring-A", c: "cand-1" }),
  buildPositive("size3-idx2", "ring of 3, signer at last index", 3, 2, { e: "election-2026", r: "ring-B", c: "cand-2" }),
  buildPositive("size10-idx5", "default ring size, signer in the middle", 10, 5, { e: "election-2026", r: "ring-C", c: "cand-3" }),
];

// One negative: take the size-10 vector and flip a byte of the message so it must NOT verify.
const neg = { ...vectors[2], name: "size10-tampered-message", description: "flipping one message byte must fail verification", expected: false };
const negMsg = new Uint8Array(atobBytes(neg.message));
negMsg[0] ^= 0x01;
neg.message = toBase64Url(negMsg);
vectors.push(neg);

// Hash intermediates over a fixed, non-secret input, for cross-language spot-checks.
const sampleKey = generateKeyPair().publicKey;
const hpIntermediate = {
  input_publicKey: toBase64Url(sampleKey),
  input_electionId: "election-2026",
  output_point: toBase64Url(pointToBytes(keyImageBase(sampleKey, "election-2026"))),
};
const hsInputBytes = new TextEncoder().encode("SECUREPOLL test H_s input");
const hsIntermediate = {
  input_utf8: "SECUREPOLL test H_s input",
  output_scalar: toBase64Url(scalarToBytes(hashToScalar(hsInputBytes))),
};

const doc = {
  version: SIGNATURE_VERSION,
  group: "ristretto255",
  encoding: "base64url (no padding)",
  note: "See WIRE_FORMAT.md. Scalars are 32-byte little-endian < q; points are 32-byte canonical compressed ristretto255.",
  hp: hpIntermediate,
  hs: hsIntermediate,
  vectors,
};

function atobBytes(b64url: string): number[] {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  return Array.from(bin, (ch) => ch.charCodeAt(0));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, "test-vectors", "vectors.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${vectors.length} vectors to ${outPath}`);
