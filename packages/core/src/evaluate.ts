import type { CheckResult, GateResult } from "./types.ts";

const ICON: Record<CheckResult["status"], string> = {
  passed: "✅",
  failed: "❌",
  error: "⚠️",
  skipped: "⏭️",
};

/**
 * Turn individual check results into one gate verdict.
 * Rules (v1):
 * - any required check that failed or errored -> failure
 * - optional failures are reported but do not block
 * - skipped checks never block
 * - zero checks actually executed -> failure (a gate that ran nothing should not pass)
 */
export function evaluateGate(checks: CheckResult[]): GateResult {
  const blocking = checks.filter((c) => c.required && (c.status === "failed" || c.status === "error"));
  const executed = checks.filter((c) => c.status !== "skipped");
  const optionalFailed = checks.filter((c) => !c.required && (c.status === "failed" || c.status === "error"));

  let conclusion: GateResult["conclusion"];
  let title: string;
  if (executed.length === 0) {
    conclusion = "failure";
    title = "No checks ran";
  } else if (blocking.length > 0) {
    conclusion = "failure";
    title = `${blocking.length} required check${blocking.length === 1 ? "" : "s"} failed: ${blocking.map((c) => c.name).join(", ")}`;
  } else {
    conclusion = "success";
    const passed = checks.filter((c) => c.status === "passed").length;
    title = `${passed}/${checks.length} checks passed` + (optionalFailed.length ? ` (${optionalFailed.length} optional failed)` : "");
  }

  const lines = [
    `**${conclusion === "success" ? "Gate passed" : "Gate blocked"}**: ${title}`,
    "",
    "| | Check | Kind | Required | Reason |",
    "|---|---|---|---|---|",
    ...checks.map(
      (c) => `| ${ICON[c.status]} | ${c.name} | ${c.kind} | ${c.required ? "yes" : "no"} | ${escapeCell(c.reason)} |`,
    ),
  ];
  for (const c of checks.filter((x) => x.status === "failed" || x.status === "error")) {
    if (c.output.trim()) {
      lines.push("", `<details><summary>${c.name} output</summary>`, "", "```", c.output.trim(), "```", "", "</details>");
    }
  }
  return { conclusion, title, summary: lines.join("\n"), checks };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
