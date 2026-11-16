import { describe, expect, it } from "vitest";
import { runGate } from "../src/index.ts";
import { makeTempRepo } from "./helpers.ts";

const TRAILER = "Co-authored-by: Claude <noreply@anthropic.com>";

function repoWith(ai: string, checks = "  - {name: env, type: script, run: 'echo \"ai=$RUNSTAGE_AI_GENERATED signals=$RUNSTAGE_AI_SIGNALS\"'}\n") {
  return makeTempRepo(`version: 1\nchecks:\n${checks}${ai}`);
}

describe("AI-generated detection in the runner", () => {
  it("exposes RUNSTAGE_AI_GENERATED=0 when detection is off", async () => {
    const repo = repoWith("");
    const head = repo.commit({ "app.js": "export const x = 2;\n" }, `change\n\n${TRAILER}`);
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks[0]!.reason).toBe("ai=0 signals=");
    expect(result.ai).toBeUndefined();
  });

  it("detects commit trailers and PR metadata, exposes them to checks and the summary", async () => {
    const repo = repoWith("ai_detection: {enabled: true}\n");
    const head = repo.commit({ "app.js": "export const x = 2;\n" }, `change\n\n${TRAILER}`);
    const result = await runGate({
      repo: repo.dir, base: repo.base, head,
      change: { pr: { headRef: "cursor/fix", labels: ["ai-generated"] } },
    });
    expect(result.ai?.generated).toBe(true);
    expect(result.ai?.signals).toEqual([
      'branch "cursor/fix" starts with "cursor/"',
      'PR label "ai-generated"',
      `commit trailer "${TRAILER}"`,
    ]);
    expect(result.checks[0]!.output).toContain("ai=1 signals=branch");
    expect(result.summary).toContain("**AI-generated**: yes");
    expect(result.conclusion).toBe("success");
  });

  it("reports no signals for a human change", async () => {
    const repo = repoWith("ai_detection: {enabled: true}\n");
    const head = repo.commit({ "app.js": "export const x = 3;\n" }, "plain change");
    const result = await runGate({ repo: repo.dir, base: repo.base, head, change: { pr: { headRef: "feature/x" } } });
    expect(result.ai).toEqual({ generated: false, signals: [] });
    expect(result.checks[0]!.reason).toBe("ai=0 signals=");
  });

  it("policy.require_checks makes optional checks required, and a skipped one becomes an error", async () => {
    const checks =
      "  - {name: extra, type: script, required: false, run: 'exit 1'}\n" +
      "  - {name: review, type: agent, agent: custom, command: 'cat', prompt: 'p'}\n";
    const ai = "ai_detection:\n  enabled: true\n  policy: {require_checks: [extra, review]}\n";
    const repo = makeTempRepo(`version: 1\nchecks:\n${checks}${ai}`);
    const human = repo.commit({ "app.js": "export const x = 4;\n" }, "human change");
    const r1 = await runGate({ repo: repo.dir, base: repo.base, head: human });
    expect(r1.conclusion).toBe("success"); // only an optional check failed
    expect(r1.checks.map((c) => [c.name, c.required, c.status])).toEqual([
      ["extra", false, "failed"],
      ["review", false, "skipped"],
    ]);

    const aiHead = repo.commit({ "app.js": "export const x = 5;\n" }, `ai change\n\n${TRAILER}`);
    const r2 = await runGate({ repo: repo.dir, base: human, head: aiHead });
    expect(r2.conclusion).toBe("failure");
    expect(r2.checks.map((c) => [c.name, c.required, c.status])).toEqual([
      ["extra", true, "failed"],
      ["review", true, "error"],
    ]);
    expect(r2.checks[1]!.reason).toMatch(/^required for AI-generated changes but skipped: agent checks disabled/);
  });

  it("policy.require_approval blocks AI-generated changes with an ai-approval policy result", async () => {
    const repo = makeTempRepo(
      "version: 1\nchecks:\n  - {name: ok, type: script, run: 'true'}\nai_detection:\n  enabled: true\n  policy: {require_approval: true}\n",
    );
    const human = repo.commit({ "app.js": "export const x = 6;\n" }, "human");
    expect((await runGate({ repo: repo.dir, base: repo.base, head: human })).conclusion).toBe("success");
    const aiHead = repo.commit({ "app.js": "export const x = 7;\n" }, `ai\n\n${TRAILER}`);
    const r = await runGate({ repo: repo.dir, base: human, head: aiHead });
    expect(r.conclusion).toBe("failure");
    expect(r.title).toBe("1 required check failed: ai-approval");
    expect(r.checks.at(-1)).toMatchObject({ name: "ai-approval", kind: "policy", status: "failed", required: true });
  });
});
