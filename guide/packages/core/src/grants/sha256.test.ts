import { describe, it, expect } from "vitest";
import { sha256Hex } from "./sha256.js";

/**
 * Published FIPS 180-4 / NIST CAVP vectors, plus UTF-8 ground truth taken from
 * Node's own crypto. These are the only reason to trust a hand-rolled hash, so
 * they are pinned rather than snapshotted.
 *
 * Non-ASCII inputs are written as escapes so the assertions cannot drift with
 * the file's encoding.
 */
describe("sha256Hex", () => {
  it("matches the NIST vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // 56 bytes: exercises the two-block padding path.
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // 112 bytes: exercises a clean multi-block message.
    expect(
      sha256Hex(
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  });

  it("hashes one million repetitions of 'a'", () => {
    expect(sha256Hex("a".repeat(1_000_000))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("hashes UTF-8 by its bytes, not its code units", () => {
    // "\u00e9"
    expect(sha256Hex("\u00e9")).toBe(
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
    // "h\u00e9llo w\u00f6rld"
    expect(sha256Hex("h\u00e9llo w\u00f6rld")).toBe(
      "a1003f7d04a4115711d0b48a2eaf1359ce565d2d2a6fd65098dfcffadeeef59f",
    );
    // Three-byte sequences.
    expect(sha256Hex("\u65e5\u672c\u8a9e")).toBe(
      "77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
    );
    // A surrogate pair must hash as its four UTF-8 bytes, not two code units.
    expect(sha256Hex("\ud83d\udd25")).toBe(
      "ed8d830565bfcc5cb5b15e7deef7b6d07645d06597c8d17c7bdd49ad6f0e310a",
    );
  });

  it("always returns 64 lowercase hex characters", () => {
    for (const input of ["", "a", "x".repeat(63), "y".repeat(64), "z".repeat(65)]) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
