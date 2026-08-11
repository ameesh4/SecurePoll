import { describe, expect, it } from "vitest";
import {
  deserializeSignature,
  encodeMessage,
  generateKeyPair,
  serializeSignature,
  sign,
  verify,
  type Point,
  type RingSignature,
} from "./index";

const EID = "election-2026";

function sampleSignature(n = 5): { sig: RingSignature; ring: Point[]; message: Uint8Array } {
  const keys = Array.from({ length: n }, () => generateKeyPair());
  const ring = keys.map((k) => k.publicKey);
  const message = encodeMessage({ electionId: EID, ringId: "ring-1", candidateId: "cand-1" });
  const signerIndex = 2;
  const sig = sign({ message, ring, signerIndex, privateKey: keys[signerIndex].privateKey, electionId: EID });
  return { sig, ring, message };
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe("serialization", () => {
  it("is deterministic and has length 69 + 32·n", () => {
    const { sig } = sampleSignature(5);
    const a = serializeSignature(sig);
    const b = serializeSignature(sig);
    expect(bytesEq(a, b)).toBe(true);
    expect(a.length).toBe(69 + 32 * 5);
  });

  it("round-trips through deserialize and still verifies", () => {
    const { sig, ring, message } = sampleSignature(7);
    const bytes = serializeSignature(sig);
    const back = deserializeSignature(bytes);
    expect(bytesEq(back.c0, sig.c0)).toBe(true);
    expect(bytesEq(back.keyImage, sig.keyImage)).toBe(true);
    expect(back.s.length).toBe(sig.s.length);
    back.s.forEach((si, i) => expect(bytesEq(si, sig.s[i])).toBe(true));
    expect(verify({ message, ring, signature: back, electionId: EID })).toBe(true);
  });

  it("rejects a truncated buffer", () => {
    const { sig } = sampleSignature(4);
    const bytes = serializeSignature(sig);
    expect(() => deserializeSignature(bytes.slice(0, bytes.length - 1))).toThrow();
  });

  it("rejects an unsupported version byte", () => {
    const { sig } = sampleSignature(4);
    const bytes = serializeSignature(sig);
    bytes[0] = 0x02;
    expect(() => deserializeSignature(bytes)).toThrow(/version/);
  });

  it("rejects a non-canonical scalar (>= q)", () => {
    const { sig } = sampleSignature(4);
    const bytes = serializeSignature(sig);
    // Offset 5 is c0; set it to all-0xFF, which is >= q for ristretto255.
    for (let i = 5; i < 5 + 32; i++) bytes[i] = 0xff;
    expect(() => deserializeSignature(bytes)).toThrow();
  });

  it("rejects a non-canonical / invalid key-image point", () => {
    const { sig } = sampleSignature(4);
    const bytes = serializeSignature(sig);
    // Offset 37 is the key image; all-0xFF is not a valid ristretto encoding.
    for (let i = 37; i < 37 + 32; i++) bytes[i] = 0xff;
    expect(() => deserializeSignature(bytes)).toThrow();
  });
});
