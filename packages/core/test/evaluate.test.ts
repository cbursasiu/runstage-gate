import { describe, expect, it } from "vitest";
import { evaluateGate, type CheckResult } from "../src/index.ts";

const r = (name: string, status: CheckResult["status"], required = true, reason: string = status): CheckResult => ({
  name, kind: "script", required, status, reason, exitCode: status === "passed" ? 0 : 1, durationMs: 1, output: status === "failed" ? "boom" : "",
});

describe("evaluateGate", () => {
  it("passes when every required check passes", () => {
    const g = evaluateGate([r("a", "passed"), r("b", "passed")]);
    expect(g.conclusion).toBe("success");
    expect(g.title).toBe("2/2 checks passed");
  });

  it("fails when a required check fails or errors and names it", () => {
    const g = evaluateGate([r("a", "passed"), r("b", "failed"), r("c", "error")]);
    expect(g.conclusion).toBe("failure");
    expect(g.title).toBe("2 required checks failed: b, c");
    expect(g.summary).toContain("Gate blocked");
    expect(g.summary).toContain("<details><summary>b output</summary>");
  });

  it("does not block on optional failures or skipped checks", () => {
    const g = evaluateGate([r("a", "passed"), r("ai", "failed", false), r("ai2", "skipped", false)]);
    expect(g.conclusion).toBe("success");
    expect(g.title).toContain("1 optional failed");
  });

  it("fails when nothing actually ran", () => {
    expect(evaluateGate([r("ai", "skipped", false)]).conclusion).toBe("failure");
  });

  it("escapes pipes in reasons for the markdown table", () => {
    expect(evaluateGate([r("a", "passed", true, "x | y")]).summary).toContain("x \\| y");
  });
});
