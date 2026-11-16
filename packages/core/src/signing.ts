import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed jobs: the App signs every job it hands to a runner, and the runner refuses to run a
 * job whose signature does not verify. The bearer token already proves the runner to the App;
 * the signature proves the App (and the exact job body) to the runner, so something else
 * listening on the server URL, or a proxy that rewrites responses, cannot feed it commands.
 *
 * Key: derived from the runner's own token, so there is no second secret to distribute.
 *   key = HMAC-SHA256(key = SHA-256(token), "runstage-gate/job-signing/v1")
 * The App only stores SHA-256(token) (runners.json), which is enough to derive the key; the
 * runner derives it from its plaintext token.
 *
 * Header: `x-runstage-job-signature: t=<unix ms>,n=<nonce>,v1=<hex HMAC>` over
 *   "v1\n<t>\n<n>\n<body>"
 * Replay protection: the runner rejects signatures older (or newer) than maxAgeMs and any nonce
 * it has already seen within that window.
 */
export const JOB_SIGNATURE_HEADER = "x-runstage-job-signature";
const KEY_CONTEXT = "runstage-gate/job-signing/v1";
export const DEFAULT_JOB_SIGNATURE_MAX_AGE_MS = 5 * 60_000;

/** Signing key from the stored SHA-256 (hex) of a runner token. */
export function jobSigningKeyFromHash(tokenSha256Hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(tokenSha256Hex)) throw new Error("token hash must be 64 hex chars");
  return createHmac("sha256", Buffer.from(tokenSha256Hex, "hex")).update(KEY_CONTEXT).digest();
}

/** Signing key from a runner's plaintext token (runner side). */
export function jobSigningKeyFromToken(token: string): Buffer {
  return jobSigningKeyFromHash(createHash("sha256").update(token, "utf8").digest("hex"));
}

function mac(key: Buffer, t: string, n: string, body: string): Buffer {
  return createHmac("sha256", key).update(`v1\n${t}\n${n}\n${body}`, "utf8").digest();
}

export function signJob(body: string, key: Buffer, o: { now?: number; nonce?: string } = {}): string {
  const t = String(o.now ?? Date.now());
  const n = o.nonce ?? randomBytes(16).toString("hex");
  return `t=${t},n=${n},v1=${mac(key, t, n, body).toString("hex")}`;
}

export type JobSignatureFailure = "missing" | "malformed" | "bad_signature" | "expired" | "replayed";
export type JobSignatureCheck = { ok: true } | { ok: false; reason: JobSignatureFailure };

/** Nonces seen within the validity window, so a captured response cannot be replayed. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  /** Returns false if the nonce was already used. */
  use(nonce: string, expiresAt: number, now: number): boolean {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
  get size(): number {
    return this.seen.size;
  }
}

export function verifyJobSignature(
  body: string,
  header: string | null | undefined,
  key: Buffer,
  o: { now?: number; maxAgeMs?: number; nonces?: NonceCache } = {},
): JobSignatureCheck {
  if (!header) return { ok: false, reason: "missing" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const { t, n, v1 } = parts;
  if (!t || !n || !v1 || !/^\d{1,16}$/.test(t) || !/^[A-Za-z0-9_-]{8,128}$/.test(n) || !/^[0-9a-f]{64}$/.test(v1)) {
    return { ok: false, reason: "malformed" };
  }
  const want = mac(key, t, n, body);
  const got = Buffer.from(v1, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad_signature" };
  const now = o.now ?? Date.now();
  const maxAge = o.maxAgeMs ?? DEFAULT_JOB_SIGNATURE_MAX_AGE_MS;
  const ts = Number(t);
  if (Math.abs(now - ts) > maxAge) return { ok: false, reason: "expired" };
  if (o.nonces && !o.nonces.use(n, ts + maxAge, now)) return { ok: false, reason: "replayed" };
  return { ok: true };
}
