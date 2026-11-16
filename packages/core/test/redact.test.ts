import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, redactSecrets, secretValuesFromEnv, type GateResult } from "../src/index.ts";

// Built at runtime so this file contains no literal token-shaped strings for secret scanners.
const fake = (prefix: string, n = 36) => prefix + "A1b2C3d4E5".repeat(Math.ceil(n / 10)).slice(0, n);

describe("redaction", () => {
  it("redacts well-known token formats", () => {
    const samples = [
      fake("ghp_"),
      fake("ghs_"),
      fake("github_pat_", 40),
      fake("glpat-", 24),
      fake("rsg_", 43),
      fake("xoxb-", 30),
      "AKIA" + "ABCDEFGHIJKLMNOP",
      fake("npm_", 36),
      fake("sk-ant-", 40),
      "eyJ" + "hbGciOiJIUzI1" + ".eyJ" + "zdWIiOiIxMjM0" + "." + "c2lnbmF0dXJlLXZhbHVl",
    ];
    for (const s of samples) {
      const out = redactSecrets(`value: ${s} end`);
      expect(out, s.slice(0, 6)).not.toContain(s);
      expect(out).toContain(REDACTED);
    }
  });

  it("redacts PEM private keys, auth headers, URL credentials and key=value secrets", () => {
    const pem = ["-----BEGIN", "RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA", "PRIVATE KEY-----"].join(" ");
    expect(redactSecrets(`key:\n${pem}\nafter`)).toBe(`key:\n${REDACTED}\nafter`);
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop1234")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactSecrets("git clone https://user:hunter2hunter2@example.com/x.git")).toBe(`git clone https://${REDACTED}@example.com/x.git`);
    expect(redactSecrets("MY_API_KEY=supersecretvalue1 next")).toBe(`MY_API_KEY=${REDACTED} next`);
    expect(redactSecrets('password: "correct-horse-battery"')).toBe(`password: "${REDACTED}"`);
  });

  it("leaves ordinary output alone (shas, short values, prose)", () => {
    const text = "commit 1111111111111111111111111111111111111111 passed 12 tests; token: short";
    expect(redactSecrets(text)).toBe(text);
  });

  it("replaces known secret values wherever they appear", () => {
    const secret = "my-very-specific-runner-value-42";
    const r = new Redactor([secret, undefined, "short"]);
    expect(r.redact(`a ${secret} b ${secret}`)).toBe(`a ${REDACTED} b ${REDACTED}`);
    expect(r.redact("short stays")).toBe("short stays");
  });

  it("collects secret-looking env values only", () => {
    const vals = secretValuesFromEnv({ RUNSTAGE_RUNNER_TOKEN: "x".repeat(20), GITHUB_WEBHOOK_SECRET: "y".repeat(20), PATH: "/usr/bin:/bin", TOKEN_SHORT: "abc" });
    expect(vals.sort()).toEqual(["x".repeat(20), "y".repeat(20)]);
  });

  it("redacts every free-text field of a gate result and deep objects", () => {
    const secret = "known-secret-value-123456";
    const r = new Redactor([secret]);
    const result: GateResult = {
      conclusion: "failure",
      title: `failed ${secret}`,
      summary: `out: ${fake("ghp_")}`,
      checks: [{ name: "t", kind: "script", required: true, status: "failed", reason: secret, exitCode: 1, durationMs: 1, output: `env ${secret}` }],
      ai: { generated: true, signals: [secret] },
    };
    const out = JSON.stringify(r.redactResult(result));
    expect(out).not.toContain(secret);
    expect(out).not.toContain(fake("ghp_"));
    expect(r.redactResult(result).checks[0]!.name).toBe("t");
    expect(r.redactDeep({ a: [secret, 1, { b: secret }], n: null })).toEqual({ a: [REDACTED, 1, { b: REDACTED }], n: null });
  });

  it("wraps a logger", () => {
    const lines: string[] = [];
    new Redactor(["logged-secret-value-99"]).wrapLog((l) => lines.push(l))("x logged-secret-value-99 y");
    expect(lines).toEqual([`x ${REDACTED} y`]);
  });
});
