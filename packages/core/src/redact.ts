import type { GateResult } from "./types.ts";

/**
 * Secret redaction for log lines and for check output that leaves the machine (GitHub check
 * run summaries, the history service). Two layers:
 *  1. Known values: secrets this process actually holds (runner token, webhook secret, env vars
 *     whose names look secret). Exact matches are always replaced.
 *  2. Patterns: well-known token formats (GitHub, GitLab, Slack, AWS, npm, OpenAI/Anthropic-style
 *     keys, RunStage runner tokens, JWTs, PEM private keys, Bearer/Basic auth, key=value pairs).
 * Redaction is best effort: it cannot recognise an arbitrary secret it has never seen in an
 * unknown format, so checks should still not print secrets.
 */
export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\brsg_[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, REDACTED],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${REDACTED}@`],
  [
    /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*)(\s*[=:]\s*)("?)([^\s"',;]{8,})\3/gi,
    `$1$2$3${REDACTED}$3`,
  ],
];

const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|WEBHOOK)/i;
const MIN_SECRET_LENGTH = 8;

/** Values of env vars whose names look secret (e.g. RUNSTAGE_RUNNER_TOKEN, GITHUB_WEBHOOK_SECRET). */
export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map(([, v]) => v as string);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly known: RegExp | undefined;
  constructor(secrets: Iterable<string | undefined> = []) {
    const vals = [...new Set([...secrets].filter((s): s is string => !!s && s.length >= MIN_SECRET_LENGTH))];
    // Longest first so a secret that contains another is replaced whole.
    vals.sort((a, b) => b.length - a.length);
    this.known = vals.length ? new RegExp(vals.map(escapeRegExp).join("|"), "g") : undefined;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = this.known ? text.replace(this.known, REDACTED) : text;
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    return out;
  }

  /** A copy of the result with every free-text field redacted. */
  redactResult(result: GateResult): GateResult {
    const r = (s: string) => this.redact(s);
    return {
      ...result,
      title: r(result.title),
      summary: r(result.summary),
      checks: (result.checks ?? []).map((c) => ({ ...c, reason: r(c.reason), output: r(c.output) })),
      ...(result.ai ? { ai: { ...result.ai, signals: result.ai.signals.map(r) } } : {}),
    };
  }

  /** A deep copy with every string value redacted (object keys are kept). */
  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])) as T;
    }
    return value;
  }

  /** Wrap a line logger so nothing it prints carries a known or recognisable secret. */
  wrapLog(log: (line: string) => void): (line: string) => void {
    return (line: string) => log(this.redact(line));
  }
}

/** Redact with patterns plus the given known secret values. */
export function redactSecrets(text: string, secrets: Iterable<string | undefined> = []): string {
  return new Redactor(secrets).redact(text);
}
