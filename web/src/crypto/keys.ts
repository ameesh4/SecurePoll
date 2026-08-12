import { derivePublicKey, fromBase64Url, generateKeyPair, toBase64Url } from "./lrs";

/**
 * Voter-facing key helpers for the registration and key-replacement pages.
 *
 * Key generation itself now lives in the LRS library (`./lrs`, per SECUREPOLL_CONTEXT.md
 * §5.4): this module is a thin adapter that presents the library's raw-bytes `KeyPair` as
 * the base64url strings the pages display, download, and send to the server. There is now
 * exactly one implementation of scalar/point generation — the library's — so signing and
 * registration can never drift apart. The functions below are presentation/IO only and are
 * deliberately NOT part of the LRS cryptographic surface.
 */

export { toBase64Url };

export interface VoterKeyPair {
  /** 32-byte little-endian scalar, base64url. Never transmitted. */
  privateKey: string;
  /** 32-byte compressed ristretto255 point, base64url. Sent to the server. */
  publicKey: string;
}

/** Where RegisterPage and ReplaceKeyPage save a copy of the key, if the voter opts in. */
export const VOTING_KEY_STORAGE_KEY = "securepoll.voting-key";

/**
 * Reads back the key copy this browser may hold, if the voter opted in when registering or
 * replacing a key (`VOTING_KEY_STORAGE_KEY`).
 *
 * Re-derives the public half the same way `parseKeyFile` does, so a value that has been
 * tampered with or corrupted (rather than simply absent) is treated as no key at all instead of
 * being handed to the signer.
 */
export function loadStoredKeyPair(): VoterKeyPair | null {
  try {
    const raw = localStorage.getItem(VOTING_KEY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoterKeyPair>;
    if (typeof parsed.privateKey !== "string" || typeof parsed.publicKey !== "string") {
      return null;
    }
    const derived = toBase64Url(derivePublicKey(fromBase64Url(parsed.privateKey)));
    if (derived !== parsed.publicKey) return null;
    return { privateKey: parsed.privateKey, publicKey: parsed.publicKey };
  } catch {
    return null;
  }
}

/**
 * Runs entirely in the browser. The private key is returned to the caller and must never be
 * put in a request body — the whole anonymity argument rests on the server never holding it.
 */
export function generateVoterKeyPair(): VoterKeyPair {
  const { privateKey, publicKey } = generateKeyPair();
  return {
    privateKey: toBase64Url(privateKey),
    publicKey: toBase64Url(publicKey),
  };
}

/**
 * Reads back the key file `downloadKeyFile` wrote.
 *
 * Both halves are validated rather than trusted, and the second check is the one that matters:
 * the public key is **re-derived from the private key** and compared against the one written in
 * the file. Without that, a corrupted or hand-edited file would sail through here and fail much
 * later as a signature that simply does not verify — with nothing pointing at the key as the
 * cause. Failing at load turns a baffling rejection into a clear "this file is damaged".
 *
 * Throws with a message suitable for showing to a voter.
 */
export function parseKeyFile(contents: string): VoterKeyPair {
  const field = (label: string): string | null => {
    for (const line of contents.split(/\r?\n/)) {
      const [key, ...rest] = line.split(":");
      if (key?.trim() === label) return rest.join(":").trim();
    }
    return null;
  };

  const privateKey = field("private_key");
  if (!privateKey) {
    throw new Error(
      "That file does not look like a SecurePoll voting key — no private_key line was found.",
    );
  }

  let derived: string;
  try {
    // fromBase64Url rejects malformed encodings; bytesToScalar inside derivePublicKey rejects a
    // wrong length and any value at or above the group order.
    const bytes = fromBase64Url(privateKey);
    // Zero is in range but degenerate: its public key is the identity, which can never produce a
    // signature that verifies. Caught here so it reads as a damaged file rather than as a
    // mysterious "you are not in this group" later.
    if (bytes.every((byte) => byte === 0)) {
      throw new Error("zero private key");
    }
    derived = toBase64Url(derivePublicKey(bytes));
  } catch {
    throw new Error("The private key in that file is not a valid voting key.");
  }

  const stated = field("public_key");
  if (stated && stated !== derived) {
    throw new Error(
      "That key file is damaged: its two halves do not match. Use the file you downloaded when " +
        "you registered, without editing it.",
    );
  }

  return { privateKey, publicKey: derived };
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
