import { describe, expect, it } from "vitest";
import {
  areLinked,
  deriveKeyImage,
  encodeMessage,
  generateKeyPair,
  keyImageKey,
  serializeSignature,
  sign,
  verify,
  type KeyPair,
  type Point,
  type RingSignature,
} from "./index";
import { IDENTITY, pointToBytes } from "./curve";

const EID = "election-2026";

function ringOf(keys: KeyPair[]): Point[] {
  return keys.map((k) => k.publicKey);
}

function msg(candidateId = "cand-1", ringId = "ring-1", electionId = EID): Uint8Array {
  return encodeMessage({ electionId, ringId, candidateId });
}

function signWith(keys: KeyPair[], signerIndex: number, electionId = EID): RingSignature {
  return sign({
    message: msg("cand-1", "ring-1", electionId),
    ring: ringOf(keys),
    signerIndex,
    privateKey: keys[signerIndex].privateKey,
    electionId,
  });
}

describe("sign → verify round-trip", () => {
  for (const n of [2, 3, 10, 50]) {
    it(`ring size ${n}, every signer index`, () => {
      const keys = Array.from({ length: n }, () => generateKeyPair());
      const ring = ringOf(keys);
      const message = msg();
      for (let pi = 0; pi < n; pi++) {
        const sig = sign({ message, ring, signerIndex: pi, privateKey: keys[pi].privateKey, electionId: EID });
        expect(verify({ message, ring, signature: sig, electionId: EID })).toBe(true);
      }
    });
  }
});

describe("verify rejects tampering", () => {
  const keys = Array.from({ length: 6 }, () => generateKeyPair());
  const ring = ringOf(keys);
  const signerIndex = 2;
  const message = msg();
  const base = () =>
    sign({ message, ring, signerIndex, privateKey: keys[signerIndex].privateKey, electionId: EID });

  it("flipped message bit", () => {
    const sig = base();
    const tampered = message.slice();
    tampered[0] ^= 1;
    expect(verify({ message: tampered, ring, signature: sig, electionId: EID })).toBe(false);
  });

  it("swapped ring order", () => {
    const sig = base();
    const swapped = ring.slice();
    // swap two non-signer members; signer's key stays at its index but order differs
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(verify({ message, ring: swapped, signature: sig, electionId: EID })).toBe(false);
  });

  it("ring member substituted", () => {
    const sig = base();
    const substituted = ring.slice();
    substituted[0] = generateKeyPair().publicKey; // replace a non-signer
    expect(verify({ message, ring: substituted, signature: sig, electionId: EID })).toBe(false);
  });

  it("tampered s_i", () => {
    const sig = base();
    const s = sig.s.map((x) => x.slice());
    s[3][0] ^= 1;
    expect(verify({ message, ring, signature: { ...sig, s }, electionId: EID })).toBe(false);
  });

  it("tampered c0", () => {
    const sig = base();
    const c0 = sig.c0.slice();
    c0[0] ^= 1;
    expect(verify({ message, ring, signature: { ...sig, c0 }, electionId: EID })).toBe(false);
  });

  it("identity key image", () => {
    const sig = base();
    const keyImage = pointToBytes(IDENTITY);
    expect(verify({ message, ring, signature: { ...sig, keyImage }, electionId: EID })).toBe(false);
  });

  it("wrong electionId", () => {
    const sig = base();
    expect(verify({ message, ring, signature: sig, electionId: "other-election" })).toBe(false);
  });
});

describe("linkability", () => {
  it("same key + same election, different rings → linked", () => {
    const signer = generateKeyPair();
    const ringA = [signer, generateKeyPair(), generateKeyPair()];
    const ringB = [generateKeyPair(), signer, generateKeyPair(), generateKeyPair()];
    const sigA = signWith(ringA, 0);
    const sigB = signWith(ringB, 1);
    expect(areLinked(sigA, sigB)).toBe(true);
  });

  it("same key, different elections → not linked", () => {
    const signer = generateKeyPair();
    const ring = [signer, generateKeyPair(), generateKeyPair()];
    const sigA = signWith(ring, 0, "election-A");
    const sigB = signWith(ring, 0, "election-B");
    expect(areLinked(sigA, sigB)).toBe(false);
  });

  it("different keys, same ring → not linked", () => {
    const keys = Array.from({ length: 4 }, () => generateKeyPair());
    const sigA = signWith(keys, 0);
    const sigB = signWith(keys, 1);
    expect(areLinked(sigA, sigB)).toBe(false);
  });

  it("deriveKeyImage matches the signature's key image", () => {
    const keys = Array.from({ length: 3 }, () => generateKeyPair());
    const sig = signWith(keys, 1);
    const derived = deriveKeyImage(keys[1].privateKey, EID);
    expect(Array.from(sig.keyImage)).toEqual(Array.from(derived));
  });
});

describe("anonymity — signatures carry no positional tell", () => {
  it("same ring/message/eid at every signer index → identical output length", () => {
    const n = 8;
    const keys = Array.from({ length: n }, () => generateKeyPair());
    const ring = ringOf(keys);
    const message = msg();
    const lengths = new Set<number>();
    for (let pi = 0; pi < n; pi++) {
      const sig = sign({ message, ring, signerIndex: pi, privateKey: keys[pi].privateKey, electionId: EID });
      lengths.add(serializeSignature(sig).length);
      // every position produces a valid signature
      expect(verify({ message, ring, signature: sig, electionId: EID })).toBe(true);
    }
    expect(lengths.size).toBe(1);
    expect([...lengths][0]).toBe(69 + 32 * n);
  });

  // The length check above proves the shape does not leak. This proves the *values* do
  // not either — the other half of §5.5's "no positional tells".
  //
  // Why it holds: s_π = (α − c_π·x) mod q with α drawn uniformly, so the signer's response
  // is uniform over [0, q) exactly like the n−1 decoys drawn at random. Nothing structural
  // marks the position either: c_0 sits at index 0 whoever signed.
  it("an adversary cannot guess the signer index better than chance", () => {
    const n = 10;
    const TRIALS = 120;
    const keys = Array.from({ length: n }, () => generateKeyPair());
    const ring = ringOf(keys);
    const message = msg();

    const hits = { smallestS: 0, largestS: 0, fewestBits: 0, alwaysZero: 0 };
    const bitsSigner: number[] = [];
    const bitsDecoy: number[] = [];

    for (let t = 0; t < TRIALS; t++) {
      const pi = t % n; // every index equally often, so the baseline is exactly 1/n
      const sig = sign({
        message,
        ring,
        signerIndex: pi,
        privateKey: keys[pi].privateKey,
        electionId: EID,
      });
      const s = sig.s.map(leToBigInt);

      let argMin = 0;
      let argMax = 0;
      let argFewest = 0;
      for (let i = 1; i < n; i++) {
        if (s[i] < s[argMin]) argMin = i;
        if (s[i] > s[argMax]) argMax = i;
        if (bitLength(s[i]) < bitLength(s[argFewest])) argFewest = i;
      }
      if (argMin === pi) hits.smallestS++;
      if (argMax === pi) hits.largestS++;
      if (argFewest === pi) hits.fewestBits++;
      if (pi === 0) hits.alwaysZero++; // control: must land at the 1/n baseline

      bitsSigner.push(bitLength(s[pi]));
      for (let i = 0; i < n; i++) if (i !== pi) bitsDecoy.push(bitLength(s[i]));
    }

    // Baseline is 1/10. Allow up to 2x before calling it a leak; a real positional tell
    // would push a heuristic toward 100%, not 20%.
    const ceiling = TRIALS * 0.2;
    expect(hits.smallestS).toBeLessThan(ceiling);
    expect(hits.largestS).toBeLessThan(ceiling);
    expect(hits.fewestBits).toBeLessThan(ceiling);
    expect(hits.alwaysZero).toBe(TRIALS / n); // sanity: the experiment is calibrated

    // The signer's scalar must be distributionally indistinguishable from the decoys.
    expect(Math.abs(mean(bitsSigner) - mean(bitsDecoy))).toBeLessThan(0.5);
  });

  it("re-signing produces fresh scalars but the same key image", () => {
    const keys = Array.from({ length: 4 }, () => generateKeyPair());
    const a = signWith(keys, 2);
    const b = signWith(keys, 2);
    expect(Array.from(a.c0)).not.toEqual(Array.from(b.c0));
    for (let i = 0; i < a.s.length; i++) {
      expect(Array.from(a.s[i])).not.toEqual(Array.from(b.s[i]));
    }
    // The key image is a stable pseudonym — the deliberate price of linkability.
    expect(areLinked(a, b)).toBe(true);
  });
});

// The double-vote gate, as a node must run it: verify FIRST, then check the key image
// against the per-election seen-set. Reversing those two steps would let an attacker dodge
// linking by submitting a substituted key image.
describe("double-vote gate", () => {
  function gate(
    seen: Set<string>,
    message: Uint8Array,
    ring: Point[],
    signature: RingSignature,
    electionId: string,
  ): "invalid" | "double" | "accepted" {
    if (!verify({ message, ring, signature, electionId })) return "invalid";
    const key = keyImageKey(signature);
    if (seen.has(key)) return "double";
    seen.add(key);
    return "accepted";
  }

  it("accepts one ballot per voter and rejects the second", () => {
    const n = 5;
    const keys = Array.from({ length: n }, () => generateKeyPair());
    const ring = ringOf(keys);
    const seen = new Set<string>();

    for (let i = 0; i < n; i++) {
      expect(gate(seen, msg(), ring, signWith(keys, i), EID)).toBe("accepted");
    }
    expect(seen.size).toBe(n);

    // Same voter, fresh signature, different candidate — still caught.
    const second = sign({
      message: msg("cand-2"),
      ring,
      signerIndex: 0,
      privateKey: keys[0].privateKey,
      electionId: EID,
    });
    expect(gate(seen, msg("cand-2"), ring, second, EID)).toBe("double");
    expect(seen.size).toBe(n);
  });

  it("catches a voter who moves to a different ring", () => {
    const signer = generateKeyPair();
    const ringA = [signer, ...Array.from({ length: 4 }, () => generateKeyPair())];
    const ringB = [...Array.from({ length: 3 }, () => generateKeyPair()), signer];
    const seen = new Set<string>();

    expect(gate(seen, msg(), ringOf(ringA), signWith(ringA, 0), EID)).toBe("accepted");
    // Different ring, different anonymity set, same private key: the election-scoped key
    // image is unchanged, so the repeat is still caught. This is exactly what the per-ring
    // key image of textbook LSAG cannot do.
    expect(gate(seen, msg(), ringOf(ringB), signWith(ringB, 3), EID)).toBe("double");
  });

  it("rejects a substituted key image as invalid, before dedup can see it", () => {
    const keys = Array.from({ length: 4 }, () => generateKeyPair());
    const ring = ringOf(keys);
    const seen = new Set<string>();

    const sig = signWith(keys, 1);
    const forged: RingSignature = { ...sig, keyImage: signWith(keys, 2).keyImage };
    // Not "double" and not silently unlinked — invalid. The chain binds I to the ring.
    expect(gate(seen, msg(), ring, forged, EID)).toBe("invalid");
    expect(seen.size).toBe(0);
  });

  it("does not carry a key image across elections", () => {
    const keys = Array.from({ length: 4 }, () => generateKeyPair());
    const ring = ringOf(keys);
    const seen = new Set<string>();

    expect(gate(seen, msg("cand-1", "ring-1", "election-A"), ring, signWith(keys, 0, "election-A"), "election-A")).toBe("accepted");
    // A separate election is a separate seen-set in practice, but even sharing one, the
    // key image differs — so voting in election B is not mistaken for a double vote.
    expect(gate(seen, msg("cand-1", "ring-1", "election-B"), ring, signWith(keys, 0, "election-B"), "election-B")).toBe("accepted");
  });
});

function leToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function bitLength(v: bigint): number {
  return v === 0n ? 0 : v.toString(2).length;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
