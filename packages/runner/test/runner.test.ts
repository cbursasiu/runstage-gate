import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runGate } from "../src/index.ts";
import { makeTempRepo } from "./helpers.ts";

describe("runner with the example no-todo-in-diff check", () => {
  it("passes a change without TODO/FIXME", async () => {
    const repo = makeTempRepo();
    const head = repo.commit({ "app.js": "export const x = 2;\n" }, "clean change");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.conclusion).toBe("success");
    expect(result.checks[0]).toMatchObject({ name: "no-todo-in-diff", status: "passed", exitCode: 0 });
    expect(result.checks[0]!.reason).toBe("No new TODO/FIXME lines.");
  });

  it("fails a change that adds TODO and FIXME and says where", async () => {
    const repo = makeTempRepo();
    const head = repo.commit(
      { "app.js": "export const x = 1;\n// TODO: handle errors\nexport const y = 2; // FIXME later\n" },
      "add todo",
    );
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.conclusion).toBe("failure");
    const check = result.checks[0]!;
    expect(check.status).toBe("failed");
    expect(check.output).toContain("app.js:2: // TODO: handle errors");
    expect(check.output).toContain("app.js:3: export const y = 2; // FIXME later");
    expect(check.reason).toContain("Found 2 new TODO/FIXME line(s)");
    expect(result.summary).toContain("Gate blocked");
  });

  it("ignores TODOs that already existed on the base", async () => {
    const repo = makeTempRepo();
    const base = repo.commit({ "old.js": "// TODO: pre-existing\n" }, "old todo");
    const head = repo.commit({ "app.js": "export const x = 3;\n" }, "unrelated");
    const result = await runGate({ repo: repo.dir, base, head });
    expect(result.conclusion).toBe("success");
  });

  it("does not touch the user's checkout", async () => {
    const repo = makeTempRepo();
    const head = repo.commit({ "app.js": "// TODO\n" }, "todo");
    execFileSync("git", ["-C", repo.dir, "checkout", "-q", repo.base]);
    await runGate({ repo: repo.dir, base: repo.base, head });
    const wt = execFileSync("git", ["-C", repo.dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n");
    expect(wt).toHaveLength(1);
    expect(execFileSync("git", ["-C", repo.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(repo.base);
  });

  it("skips agent checks unless enabled in config and allowed on the runner", async () => {
    const yml = [
      "version: 1",
      "agents: {enabled: true}",
      "checks:",
      "  - {name: ok, type: script, run: 'echo fine'}",
      "  - {name: review, type: agent, agent: custom, command: 'cat >/dev/null; echo VERDICT: FAIL: looks risky', prompt: review}",
    ].join("\n");
    const repo = makeTempRepo(yml);
    const head = repo.commit({ "app.js": "export const x = 9;\n" }, "change");
    const off = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(off.checks[1]).toMatchObject({ status: "skipped" });
    expect(off.checks[1]!.reason).toContain("--allow-agents");

    const on = await runGate({ repo: repo.dir, base: repo.base, head, allowAgents: true });
    expect(on.checks[1]).toMatchObject({ status: "failed", reason: "agent verdict: looks risky" });
    expect(on.conclusion).toBe("success"); // agent checks are optional by default
  });

  it("reports timeouts as errors", async () => {
    const repo = makeTempRepo("version: 1\nchecks:\n  - {name: slow, type: script, run: 'sleep 5', timeout_seconds: 1}\n");
    const head = repo.commit({ "app.js": "export const x = 4;\n" }, "change");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks[0]).toMatchObject({ status: "error", reason: "timed out" });
    expect(result.conclusion).toBe("failure");
  });
});
