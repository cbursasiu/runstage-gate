import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runGate } from "../src/index.ts";
import { makeTempRepo } from "./helpers.ts";

function commitSymlink(dir: string, link: string, target: string, message: string): string {
  symlinkSync(target, join(dir, link));
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message]);
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

describe(".runstage symlinks must stay inside .runstage", () => {
  it("refuses a base symlink that points at PR-controlled code outside .runstage", async () => {
    const yml = "version: 1\nchecks:\n  - {name: linked, type: script, run: 'bash .runstage/checks/linked.sh'}\n";
    const repo = makeTempRepo(yml);
    repo.commit({ "src/check.sh": "echo base-version\nexit 1\n" }, "add outside script");
    const base = commitSymlink(repo.dir, ".runstage/checks/linked.sh", "../../src/check.sh", "link check outside");
    const head = repo.commit({ "src/check.sh": "echo head-version\nexit 0\n" }, "pr rewrites the target");
    await expect(runGate({ repo: repo.dir, base, head })).rejects.toThrow(/resolve outside \.runstage\/: \.runstage\/checks\/linked\.sh/);
    const wt = execFileSync("git", ["-C", repo.dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n");
    expect(wt).toHaveLength(1);
  });

  it("refuses absolute and dangling links that escape", async () => {
    const repo = makeTempRepo();
    commitSymlink(repo.dir, ".runstage/checks/abs.sh", "/bin/sh", "absolute link");
    const base = commitSymlink(repo.dir, ".runstage/checks/dangling.sh", "../../nowhere/x.sh", "dangling link");
    const head = repo.commit({ "app.js": "export const x = 9;\n" }, "change");
    await expect(runGate({ repo: repo.dir, base, head })).rejects.toThrow(/\.runstage\/checks\/abs\.sh, \.runstage\/checks\/dangling\.sh/);
  });

  it("allows symlinks that stay inside .runstage", async () => {
    const yml = "version: 1\nchecks:\n  - {name: linked, type: script, run: 'bash .runstage/checks/alias.sh'}\n";
    const repo = makeTempRepo(yml);
    repo.commit({ ".runstage/lib/real.sh": "echo inside\nexit 0\n" }, "add helper");
    const base = commitSymlink(repo.dir, ".runstage/checks/alias.sh", "../lib/real.sh", "inside link");
    const head = repo.commit({ "app.js": "export const x = 8;\n" }, "change");
    const result = await runGate({ repo: repo.dir, base, head });
    expect(result.checks[0]).toMatchObject({ status: "passed", reason: "inside" });
  });
});

describe("agent checks load helper files from the base commit", () => {
  const yml = (cmd: string) =>
    `version: 1\nagents: {enabled: true}\nchecks:\n  - {name: review, type: agent, agent: custom, required: true, prompt: 'review it', command: '${cmd}'}\n`;

  it("errors like script checks when the agent command's .runstage file is missing on base", async () => {
    const repo = makeTempRepo(yml("bash .runstage/agents/review.sh"));
    const head = repo.commit({ ".runstage/agents/review.sh": "echo head-version\necho 'VERDICT: PASS'\n" }, "pr adds agent script");
    const result = await runGate({ repo: repo.dir, base: repo.base, head, allowAgents: true });
    expect(result.conclusion).toBe("failure");
    expect(result.checks[0]).toMatchObject({ kind: "agent", status: "error" });
    expect(result.checks[0]!.reason).toContain(".runstage/agents/review.sh is not on the base commit");
    expect(result.checks[0]!.output).not.toContain("head-version");
  });

  it("runs the base copy of the agent helper (local bash, no paid CLI)", async () => {
    const repo = makeTempRepo(yml("bash .runstage/agents/review.sh"));
    const base = repo.commit({ ".runstage/agents/review.sh": "cat >/dev/null\necho base-version\necho 'VERDICT: FAIL: base says no'\n" }, "add agent script");
    const head = repo.commit({ ".runstage/agents/review.sh": "cat >/dev/null\necho 'VERDICT: PASS'\n", "app.js": "export const x = 4;\n" }, "pr edits it");
    const result = await runGate({ repo: repo.dir, base, head, allowAgents: true });
    expect(result.checks[0]).toMatchObject({ status: "failed", reason: "agent verdict: base says no" });
  });

  it("still skips (does not error) when agents are not allowed on this runner", async () => {
    const repo = makeTempRepo(yml("bash .runstage/agents/review.sh"));
    const head = repo.commit({ "app.js": "export const x = 5;\n" }, "change");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks[0]).toMatchObject({ status: "skipped" });
  });
});
