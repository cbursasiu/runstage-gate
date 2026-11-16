import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Access control for the history service.
 *
 * - No tokens configured: open (local dev only). main.ts logs a warning.
 * - RUNSTAGE_HISTORY_TOKEN (write token): required for POST /runs. Also grants read access.
 * - RUNSTAGE_HISTORY_READ_TOKEN (read token, optional): grants read access only.
 * When any token is configured, reads (UI and JSON API) fail closed without credentials.
 *
 * Credentials: `Authorization: Bearer <token>` for API clients, or a browser session cookie set
 * by POST /login (HttpOnly, SameSite=Strict). The cookie holds an expiry and an HMAC keyed by the
 * configured tokens, never a token itself, so rotating a token signs every browser out.
 */
export interface HistoryAuthOptions {
  writeToken?: string;
  readToken?: string;
  /** Add `Secure` to the session cookie. Turn on when served over HTTPS. */
  cookieSecure?: boolean;
  /** Browser session lifetime. Default 12 hours. */
  sessionTtlMs?: number;
  /** Failed logins allowed per client address per window before 429. Default 10 per 5 minutes. */
  maxLoginFailures?: number;
  loginWindowMs?: number;
  now?: () => number;
}

export const SESSION_COOKIE = "rsg_history_session";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/** Constant-time string comparison (hashes first so lengths never leak through timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export class HistoryAuth {
  private readonly writeToken?: string;
  private readonly readToken?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  readonly cookieSecure: boolean;

  constructor(opts: HistoryAuthOptions = {}) {
    this.writeToken = opts.writeToken || undefined;
    this.readToken = opts.readToken || undefined;
    this.ttlMs = opts.sessionTtlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.cookieSecure = opts.cookieSecure ?? false;
    this.maxFailures = opts.maxLoginFailures ?? 10;
    this.windowMs = opts.loginWindowMs ?? 5 * 60 * 1000;
  }

  /** True when no token is configured, so every request is allowed (local dev). */
  get open(): boolean {
    return !this.writeToken && !this.readToken;
  }

  get writesEnabled(): boolean {
    return this.open || !!this.writeToken;
  }

  /** A token that may be used to sign in or read via bearer (read or write token). */
  isReadToken(token: string | undefined): boolean {
    if (!token) return false;
    let ok = false;
    // Evaluate both comparisons so timing does not reveal which token matched.
    if (this.readToken && safeEqual(token, this.readToken)) ok = true;
    if (this.writeToken && safeEqual(token, this.writeToken)) ok = true;
    return ok;
  }

  canRead(req: IncomingMessage): boolean {
    if (this.open) return true;
    if (this.isReadToken(bearer(req))) return true;
    return this.verifySession(cookies(req)[SESSION_COOKIE]);
  }

  /** Whether the request is authenticated by a browser session (used to show "Sign out"). */
  hasSession(req: IncomingMessage): boolean {
    return !this.open && this.verifySession(cookies(req)[SESSION_COOKIE]);
  }

  canWrite(req: IncomingMessage): boolean {
    if (this.open) return true;
    if (!this.writeToken) return false;
    const got = bearer(req);
    return !!got && safeEqual(got, this.writeToken);
  }

  issueSession(): string {
    const exp = this.now() + this.ttlMs;
    return `v1.${exp}.${this.sign(`v1.${exp}`)}`;
  }

  verifySession(value: string | undefined): boolean {
    if (!value || this.open) return false;
    const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!m) return false;
    const exp = Number(m[1]);
    if (!Number.isFinite(exp) || exp <= this.now()) return false;
    return safeEqual(m[2]!, this.sign(`v1.${m[1]}`));
  }

  sessionCookie(value: string): string {
    const maxAge = Math.floor(this.ttlMs / 1000);
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.cookieSecure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.cookieSecure ? "; Secure" : ""}`;
  }

  /** Returns false when this client has too many recent failed logins. */
  loginAllowed(client: string): boolean {
    const f = this.failures.get(client);
    if (!f || f.resetAt <= this.now()) return true;
    return f.count < this.maxFailures;
  }

  recordLoginFailure(client: string): void {
    const now = this.now();
    const f = this.failures.get(client);
    if (!f || f.resetAt <= now) this.failures.set(client, { count: 1, resetAt: now + this.windowMs });
    else f.count += 1;
    if (this.failures.size > 10_000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }

  clearLoginFailures(client: string): void {
    this.failures.delete(client);
  }

  private sign(payload: string): string {
    const key = createHash("sha256")
      .update(`runstage-history-session\0${this.readToken ?? ""}\0${this.writeToken ?? ""}`, "utf8")
      .digest();
    return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
  }
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return /^Bearer\s+(\S+)\s*$/i.exec(h ?? "")?.[1];
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/** Only same-origin absolute paths are allowed as a post-login redirect target. */
export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 2048) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return "/";
  if (next.startsWith("/login") || next.startsWith("/logout")) return "/";
  return next;
}
