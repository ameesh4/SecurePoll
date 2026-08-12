import { describe, expect, it } from "vitest";
import { generateVoterKeyPair, parseKeyFile } from "./keys";
import { derivePublicKey, fromBase64Url, toBase64Url } from "./lrs";

/**
 * The key file is the only durable copy of a voter's private key, and reading it back is the step
 * that stands between "wrong file" and a signature that silently fails to verify. These tests are
 * about the failure messages being right, not just the happy path.
 */

/** Rebuilds the exact text `downloadKeyFile` writes, without touching the DOM. */
function keyFileText(privateKey: string, publicKey: string): string {
  return [
    "SecurePoll voting key — keep this file private.",
    "",
    "Anyone holding this private key can cast your vote. It is not stored on the",
    "election server and cannot be recovered if you lose it.",
    "",
    `fingerprint:  AAAA·BBBB·CCCC`,
    `private_key:  ${privateKey}`,
    `public_key:   ${publicKey}`,
    "",
  ].join("\n");
}

describe("parseKeyFile", () => {
  it("round-trips a freshly generated key", () => {
    const generated = generateVoterKeyPair();
    const parsed = parseKeyFile(keyFileText(generated.privateKey, generated.publicKey));
    expect(parsed.privateKey).toBe(generated.privateKey);
    expect(parsed.publicKey).toBe(generated.publicKey);
  });

  it("derives the public key rather than trusting the file", () => {
    // A file with no public_key line is still usable: the public half is recomputed.
    const generated = generateVoterKeyPair();
    const parsed = parseKeyFile(`private_key: ${generated.privateKey}`);
    expect(parsed.publicKey).toBe(generated.publicKey);
  });

  it("rejects a file whose halves disagree", () => {
    // The case this check exists for: an edited or corrupted file that would otherwise produce a
    // signature nothing can verify, with no clue as to why.
    const mine = generateVoterKeyPair();
    const someoneElse = generateVoterKeyPair();
    expect(() => parseKeyFile(keyFileText(mine.privateKey, someoneElse.publicKey))).toThrow(
      /halves do not match/,
    );
  });

  it("rejects a file with no private key", () => {
    expect(() => parseKeyFile("fingerprint: AAAA·BBBB·CCCC")).toThrow(
      /does not look like a SecurePoll voting key/,
    );
  });

  it("rejects a malformed private key", () => {
    expect(() => parseKeyFile("private_key: not base64!!")).toThrow(/not a valid voting key/);
  });

  it("rejects a private key of the wrong length", () => {
    expect(() => parseKeyFile(`private_key: ${toBase64Url(new Uint8Array(16))}`)).toThrow(
      /not a valid voting key/,
    );
  });

  it("rejects a zero private key", () => {
    // In range, but its public key is the identity — it could never sign anything that verifies.
    expect(() => parseKeyFile(`private_key: ${toBase64Url(new Uint8Array(32))}`)).toThrow(
      /not a valid voting key/,
    );
  });

  it("tolerates CRLF line endings and extra whitespace", () => {
    // Voters will open this file in Notepad and email it to themselves.
    const generated = generateVoterKeyPair();
    const text = `private_key:   ${generated.privateKey}  \r\npublic_key:  ${generated.publicKey}\r\n`;
    expect(parseKeyFile(text).publicKey).toBe(generated.publicKey);
  });
});

describe("derivePublicKey", () => {
  it("agrees with the keypair generator", () => {
    const generated = generateVoterKeyPair();
    const derived = toBase64Url(derivePublicKey(fromBase64Url(generated.privateKey)));
    expect(derived).toBe(generated.publicKey);
  });
});
