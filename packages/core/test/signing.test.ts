import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceCache, jobSigningKeyFromHash, jobSigningKeyFromToken, signJob, verifyJobSignature } from "../src/index.ts";

const TOKEN = "rsg_test-token-for-signing-0123456789";
const key = jobSigningKeyFromToken(TOKEN);
const body = JSON.stringify({ id: "job-1", change: { headSha: "a".repeat(40) } });
const NOW = 1_800_000_000_000;

describe("job signing", () => {
  it("derives the same key from the token (runner) and from its stored SHA-256 (App)", () => {
    const hash = createHash("sha256").update(TOKEN).digest("hex");
    expect(jobSigningKeyFromHash(hash).equals(key)).toBe(true);
    expect(jobSigningKeyFromToken("another-token").equals(key)).toBe(false);
  });

  it("verifies a fresh signature", () => {
    expect(verifyJobSignature(body, signJob(body, key, { now: NOW }), key, { now: NOW + 1000 })).toEqual({ ok: true });
  });

  it("rejects a missing, malformed, tampered or wrong-key signature", () => {
    const sig = signJob(body, key, { now: NOW });
    expect(verifyJobSignature(body, undefined, key, { now: NOW })).toEqual({ ok: false, reason: "missing" });
    expect(verifyJobSignature(body, "garbage", key, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyJobSignature(body, sig.replace(/v1=.*/, "v1=zz"), key, { now: NOW })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyJobSignature(body.replace("job-1", "job-2"), sig, key, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyJobSignature(body, sig, jobSigningKeyFromToken("other-token-xyz"), { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    // Changing the timestamp or nonce breaks the MAC too.
    expect(verifyJobSignature(body, sig.replace(`t=${NOW}`, `t=${NOW + 1}`), key, { now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects expired and far-future signatures", () => {
    const old = signJob(body, key, { now: NOW - 6 * 60_000 });
    expect(verifyJobSignature(body, old, key, { now: NOW })).toEqual({ ok: false, reason: "expired" });
    const future = signJob(body, key, { now: NOW + 6 * 60_000 });
    expect(verifyJobSignature(body, future, key, { now: NOW })).toEqual({ ok: false, reason: "expired" });
    expect(verifyJobSignature(body, old, key, { now: NOW, maxAgeMs: 10 * 60_000 })).toEqual({ ok: true });
  });

  it("rejects a replayed nonce within the window", () => {
    const nonces = new NonceCache();
    const sig = signJob(body, key, { now: NOW, nonce: "nonce-123456" });
    expect(verifyJobSignature(body, sig, key, { now: NOW, nonces })).toEqual({ ok: true });
    expect(verifyJobSignature(body, sig, key, { now: NOW + 1, nonces })).toEqual({ ok: false, reason: "replayed" });
    // A new nonce is fine; expired entries are pruned.
    expect(verifyJobSignature(body, signJob(body, key, { now: NOW }), key, { now: NOW, nonces })).toEqual({ ok: true });
    nonces.use("x".repeat(10), NOW + 10 * 60_000, NOW + 10 * 60_000);
    expect(nonces.size).toBe(1);
  });
});
