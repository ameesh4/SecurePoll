/**
 * Link detection (SECUREPOLL_CONTEXT.md §5.3).
 *
 * Two signatures are linked iff they carry the same key image. Because the key image is
 * I = x·H_p(P ‖ electionId), this is true exactly when the same private key signed for the
 * same election — even if the two signatures were made against different rings. Signing for
 * a *different* election yields a different key image, so a voter's ballots are not linkable
 * across elections.
 *
 * NOTE on scope: this predicate is all the library provides toward double-vote prevention.
 * The actual "has this key image been seen before?" registry is the blockchain's job and
 * must never live on the verification server (§6) — storing keyImage→voterId there would
 * single-handedly undo the anonymity of the whole scheme. `keyImageKey` exists to make that
 * off-chain/on-chain seen-set easy to build with a plain Set/Map.
 */
import type { RingSignature } from "./types";
import { toBase64Url } from "./serialize";

/** True iff both signatures were produced by the same key for the same election. */
export function areLinked(a: RingSignature, b: RingSignature): boolean {
  const x = a.keyImage;
  const y = b.keyImage;
  if (x.length !== y.length) return false;
  // Constant-time-ish comparison; key images are public, but a fixed-shape compare avoids
  // handing out early-exit timing as a matter of habit.
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * A stable, canonical string key for a signature's key image — suitable as a Set/Map key
 * when building a per-election seen-set to reject repeats.
 */
export function keyImageKey(sig: RingSignature): string {
  return toBase64Url(sig.keyImage);
}
