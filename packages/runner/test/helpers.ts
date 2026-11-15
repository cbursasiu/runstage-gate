import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;

export interface TempRepo {
  dir: string;
  base: string;
  commit(files: Record<string, string>, message: string): string;
}

/** A temp git repo whose base commit has .runstage/gate.yml and the example check. */
export function makeTempRepo(gateYml?: string): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "rsg-test-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(dir, ".runstage/checks"), { recursive: true });
  copyFileSync(join(ROOT, "examples/checks/no-todo-in-diff.sh"), join(dir, ".runstage/checks/no-todo-in-diff.sh"));
  writeFileSync(
    join(dir, ".runstage/gate.yml"),
    gateYml ??
      "version: 1\nchecks:\n  - name: no-todo-in-diff\n    type: script\n    run: bash .runstage/checks/no-todo-in-diff.sh\n",
  );
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  return {
    dir,
    base,
    commit(files, message) {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
      g("add", "-A");
      g("commit", "-q", "-m", message);
      return g("rev-parse", "HEAD");
    },
  };
}
