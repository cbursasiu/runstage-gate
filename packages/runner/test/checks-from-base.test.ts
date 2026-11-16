import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gatePathsIn, poll, runGate } from "../src/index.ts";
import { makeTempRepo, signedJobResponse } from "./helpers.ts";

const SCRIPT = ".runstage/checks/no-todo-in-diff.sh";
const TODO_CHANGE = "export const x = 1;\n// TODO: skip validation for now\n";

describe("check scripts are loaded from the base commit", () => {
  it("judges a PR that neuters the check script with the base version and blocks it", async () => {
    const repo = makeTempRepo();
    const head = repo.commit(
      { [SCRIPT]: "#!/usr/bin/env bash\necho 'No new TODO/FIXME lines.'\nexit 0\n", "app.js": TODO_CHANGE },
      "make the check always pass and add a TODO",
    );
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.conclusion).toBe("failure");
    expect(result.checks[0]).toMatchObject({ name: "no-todo-in-diff", status: "failed", exitCode: 1 });
    expect(result.checks[0]!.output).toContain("app.js:2: // TODO: skip validation for now");
  });

  it("still runs the base script when the PR deletes it", async () => {
    const repo = makeTempRepo();
    const head = repo.commit({ [SCRIPT]: null, "app.js": TODO_CHANGE }, "delete the check and add a TODO");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.conclusion).toBe("failure");
    expect(result.checks[0]).toMatchObject({ status: "failed", exitCode: 1 });
  });

  it("ignores files the PR adds under .runstage/ (e.g. a planted helper the base script would source)", async () => {
    const yml = "version: 1\nchecks:\n  - {name: guard, type: script, run: 'ls .runstage/checks; test \"$(ls .runstage/checks)\" = no-todo-in-diff.sh'}\n";
    const repo = makeTempRepo(yml);
    const head = repo.commit({ ".runstage/checks/override.sh": "exit 0\n" }, "plant a file");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks[0]).toMatchObject({ status: "passed" });
  });

  it("keeps the executable bit and supports direct ./ invocation", async () => {
    const yml = "version: 1\nchecks:\n  - {name: exec, type: script, run: './.runstage/checks/ok.sh'}\n";
    const repo = makeTempRepo(yml);
    const base = repo.commit({ ".runstage/checks/ok.sh": "#!/usr/bin/env bash\necho base-version\nexit 1\n" }, "add exec check", [
      ".runstage/checks/ok.sh",
    ]);
    const head = repo.commit({ ".runstage/checks/ok.sh": "#!/usr/bin/env bash\necho head-version\nexit 0\n" }, "pr edits it");
    const result = await runGate({ repo: repo.dir, base, head });
    expect(result.checks[0]).toMatchObject({ status: "failed", exitCode: 1, reason: "exit 1: base-version" });
  });

  it("errors clearly when a referenced script is missing on the base, and never falls back to the head copy", async () => {
    const yml = "version: 1\nchecks:\n  - {name: new-check, type: script, run: 'bash .runstage/checks/new.sh'}\n";
    const repo = makeTempRepo(yml);
    const head = repo.commit({ ".runstage/checks/new.sh": "echo head-version\nexit 0\n" }, "pr adds the script");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.conclusion).toBe("failure");
    const check = result.checks[0]!;
    expect(check.status).toBe("error");
    expect(check.reason).toContain(".runstage/checks/new.sh");
    expect(check.reason).toContain("not on the base commit");
    expect(check.output).not.toContain("head-version");
  });

  it("does not run checks that only the PR's gate.yml adds", async () => {
    const repo = makeTempRepo();
    const head = repo.commit(
      {
        ".runstage/gate.yml":
          "version: 1\nchecks:\n  - {name: pr-only, type: script, run: 'echo pr-only ran'}\n",
      },
      "replace the gate",
    );
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks.map((c) => c.name)).toEqual(["no-todo-in-diff"]);
  });

  it("still lets checks read the PR head's code and cleans up its worktree", async () => {
    const yml = "version: 1\nchecks:\n  - {name: head-code, type: script, run: 'grep -q \"x = 42\" app.js'}\n";
    const repo = makeTempRepo(yml);
    const head = repo.commit({ "app.js": "export const x = 42;\n" }, "change app");
    const result = await runGate({ repo: repo.dir, base: repo.base, head });
    expect(result.checks[0]).toMatchObject({ status: "passed" });
    const wt = execFileSync("git", ["-C", repo.dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n");
    expect(wt).toHaveLength(1);
  });
});

describe("gatePathsIn", () => {
  it("finds .runstage paths in check commands", () => {
    expect(gatePathsIn("bash .runstage/checks/a.sh")).toEqual([".runstage/checks/a.sh"]);
    expect(gatePathsIn("./.runstage/checks/a.sh --x && node '.runstage/lib/b.js'")).toEqual([
      ".runstage/checks/a.sh",
      ".runstage/lib/b.js",
    ]);
    expect(gatePathsIn("npm test --silent")).toEqual([]);
    expect(gatePathsIn("bash scripts/x.runstage/y.sh")).toEqual([]);
  });
});

describe("gate config must come from the base commit", () => {
  const noGateRepo = () => {
    const repo = makeTempRepo();
    // Base commit without .runstage/gate.yml; the user's working tree still has a gate.yml.
    const base = repo.commit({ ".runstage/gate.yml": null }, "remove gate from base");
    writeFileSync(join(repo.dir, ".runstage/gate.yml"), "version: 1\nchecks:\n  - {name: wt, type: script, run: 'echo from working tree'}\n");
    const head = repo.commit({ "app.js": "export const x = 5;\n" }, "change");
    writeFileSync(join(repo.dir, ".runstage/gate.yml"), "version: 1\nchecks:\n  - {name: wt, type: script, run: 'echo from working tree'}\n");
    return { repo, base, head };
  };

  it("errors clearly by default instead of using the checkout's working tree", async () => {
    const { repo, base, head } = noGateRepo();
    await expect(runGate({ repo: repo.dir, base, head })).rejects.toThrow(/\.runstage\/gate\.yml not found on the base commit/);
  });

  it("local runs can opt in to the working-tree config", async () => {
    const { repo, base, head } = noGateRepo();
    const logs: string[] = [];
    const result = await runGate({ repo: repo.dir, base, head, allowWorkingTreeConfig: true, log: (l) => logs.push(l) });
    expect(result.checks.map((c) => c.name)).toEqual(["wt"]);
    expect(logs.join("\n")).toContain("using the working tree");
  });

  it("poll mode fails the job as a runner error with the reason", async () => {
    const { repo, base, head } = noGateRepo();
    const job = {
      id: "j1", externalCheckId: "1", status: "claimed", createdAt: new Date().toISOString(),
      change: { provider: "github", repoFullName: "acme/x", headSha: head, baseSha: base, prNumber: 1 },
    };
    const posted: Array<{ conclusion: string; title: string; summary: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/jobs/next")) return signedJobResponse(job, "t");
      if (url.endsWith("/result")) posted.push(JSON.parse(String(init!.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await poll({ server: "http://x", token: "t", repos: repo.dir, once: true, fetchImpl, log: () => {} });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ conclusion: "failure", title: "Runner error" });
    expect(posted[0]!.summary).toContain(".runstage/gate.yml not found on the base commit");
  });
});
