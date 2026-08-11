import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeSignature, fromBase64Url, verify } from "./index";
import { hashToScalar, keyImageBase } from "./hash";
import { pointToBytes, scalarToBytes } from "./curve";

interface VectorDoc {
  hp: { input_publicKey: string; input_electionId: string; output_point: string };
  hs: { input_utf8: string; output_scalar: string };
  vectors: Array<{
    name: string;
    electionId: string;
    ring: string[];
    message: string;
    signature: string;
    expected: boolean;
  }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(
  readFileSync(join(__dirname, "test-vectors", "vectors.json"), "utf8"),
) as VectorDoc;

describe("committed test vectors (Rust verifier contract)", () => {
  for (const v of doc.vectors) {
    it(`vector ${v.name} → verify === ${v.expected}`, () => {
      const ring = v.ring.map(fromBase64Url);
      const message = fromBase64Url(v.message);
      const signature = deserializeSignature(fromBase64Url(v.signature));
      expect(verify({ message, ring, signature, electionId: v.electionId })).toBe(v.expected);
    });
  }

  it("H_p intermediate matches", () => {
    const point = keyImageBase(fromBase64Url(doc.hp.input_publicKey), doc.hp.input_electionId);
    expect(Array.from(pointToBytes(point))).toEqual(Array.from(fromBase64Url(doc.hp.output_point)));
  });

  it("H_s intermediate matches", () => {
    const scalar = scalarToBytes(hashToScalar(new TextEncoder().encode(doc.hs.input_utf8)));
    expect(Array.from(scalar)).toEqual(Array.from(fromBase64Url(doc.hs.output_scalar)));
  });
});
