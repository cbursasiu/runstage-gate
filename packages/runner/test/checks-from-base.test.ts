import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { gatePathsIn, runGate } from "../src/index.ts";
import { makeTempRepo } from "./helpers.ts";

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
