import type { CheckResult } from "@runstage-gate/core";
import type { NewRun } from "./store.ts";

const CHECK_STATUSES = new Set(["passed", "failed", "skipped", "error"]);
const CONCLUSIONS = new Set(["success", "failure"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function parseCheck(v: unknown, i: number): CheckResult | string {
  if (!isObj(v)) return `checks[${i}] must be an object`;
  if (typeof v.name !== "string" || !v.name) return `checks[${i}].name is required`;
  if (typeof v.status !== "string" || !CHECK_STATUSES.has(v.status)) return `checks[${i}].status is invalid`;
  return {
    name: v.name,
    kind: v.kind === "agent" || v.kind === "policy" ? v.kind : "script",
    required: v.required !== false,
    status: v.status as CheckResult["status"],
    reason: str(v.reason),
    exitCode: typeof v.exitCode === "number" && Number.isInteger(v.exitCode) ? v.exitCode : null,
    durationMs: Math.max(0, num(v.durationMs)),
    output: str(v.output),
  };
}

/**
 * Validates and normalises a POST /runs body into a NewRun. Unknown fields (including any
 * client-supplied `id`) are dropped so stored records always have the shape the UI expects.
 */
export function parseNewRun(body: unknown): { ok: true; run: NewRun } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.repoFullName !== "string" || !body.repoFullName) return { ok: false, error: "missing fields" };
  if (typeof body.headSha !== "string" || !body.headSha) return { ok: false, error: "missing fields" };
  if (typeof body.conclusion !== "string" || !CONCLUSIONS.has(body.conclusion)) return { ok: false, error: "missing fields" };
  if (body.prNumber != null && !(typeof body.prNumber === "number" && Number.isInteger(body.prNumber) && body.prNumber > 0)) {
    return { ok: false, error: "prNumber must be a positive integer or null" };
  }
  if (body.checks !== undefined && !Array.isArray(body.checks)) return { ok: false, error: "checks must be an array" };
  const checks: CheckResult[] = [];
  for (const [i, c] of ((body.checks as unknown[] | undefined) ?? []).entries()) {
    const parsed = parseCheck(c, i);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    checks.push(parsed);
  }
  const now = new Date().toISOString();
  const run: NewRun = {
    jobId: str(body.jobId),
    repoFullName: body.repoFullName,
    prNumber: (body.prNumber as number | null | undefined) ?? null,
    headSha: body.headSha,
    baseSha: str(body.baseSha),
    conclusion: body.conclusion as NewRun["conclusion"],
    title: str(body.title),
    summary: str(body.summary),
    checks,
    runnerId: strOrNull(body.runnerId),
    approvedBy: strOrNull(body.approvedBy),
    createdAt: str(body.createdAt, now),
    completedAt: str(body.completedAt, now),
  };
  if (typeof body.diff === "string" && body.diff.length > 0) run.diff = body.diff;
  if (typeof body.aiGenerated === "boolean") run.aiGenerated = body.aiGenerated;
  if (Array.isArray(body.aiSignals)) run.aiSignals = body.aiSignals.filter((x): x is string => typeof x === "string").slice(0, 50);
  if (body.provider === "github" || body.provider === "gitlab") run.provider = body.provider;
  if (typeof body.externalCheckId === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(body.externalCheckId)) {
    run.externalCheckId = body.externalCheckId;
  }
  const checkUrl = webUrl(body.checkUrl);
  if (checkUrl) run.checkUrl = checkUrl;
  return { ok: true, run };
}

/** Only absolute http(s) URLs of sane length are kept as links; anything else is dropped. */
export function webUrl(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length === 0 || v.length > 2048) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    if (u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
