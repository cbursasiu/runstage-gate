import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATE_CONFIG_PATH,
  evaluateGate,
  parseGateConfig,
  type AgentCheck,
  type CheckDefinition,
  type CheckResult,
  type GateConfig,
  type GateResult,
  type ScriptCheck,
} from "@runstage-gate/core";
import { diffForChange, ensureCommits, git, pathExistsAt } from "./git.ts";

export interface RunOptions {
  repo: string;
  base: string;
  head: string;
  /** Use this config instead of reading .runstage/gate.yml at the base commit. Scripts still come from base. */
  configPath?: string;
  /** Runner-side switch: agent checks only run when both this and `agents.enabled` are true. */
  allowAgents?: boolean;
  /** Try `git fetch origin <sha>` for missing commits. */
  fetch?: boolean;
  log?: (line: string) => void;
}

const OUTPUT_LIMIT = 8_000;

/**
 * Everything under this directory is the gate's own code (config, check scripts, helpers).
 * In the check worktree it is always replaced with the BASE commit's copy, so a PR cannot
 * rewrite, delete or add to the checks that judge it.
 */
export const GATE_DIR = ".runstage";

/**
 * Load the gate config. By default it is read from the *base* commit, so a PR
 * cannot weaken its own gate. Falls back to the working tree when absent there.
 */
export async function loadConfig(opts: RunOptions): Promise<GateConfig> {
  if (opts.configPath) return parseGateConfig(await readFile(opts.configPath, "utf8"));
  try {
    return parseGateConfig(await git(opts.repo, ["show", `${opts.base}:${GATE_CONFIG_PATH}`]));
  } catch (err) {
    if ((err as Error).name === "GateConfigError") throw err;
  }
  return parseGateConfig(await readFile(join(opts.repo, GATE_CONFIG_PATH), "utf8"));
}

export async function runGate(opts: RunOptions): Promise<GateResult> {
  const log = opts.log ?? (() => {});
  await ensureCommits(opts.repo, [opts.base, opts.head], opts.fetch ?? false);
  const config = await loadConfig(opts);
  const diff = await diffForChange(opts.repo, opts.base, opts.head);

  // Checks run against a clean worktree of the head commit, never the user's checkout.
  const work = await mkdtemp(join(tmpdir(), "runstage-gate-"));
  const tree = join(work, "tree");
  const diffFile = join(work, "change.diff");
  await writeFile(diffFile, diff);
  await git(opts.repo, ["worktree", "add", "--detach", "--quiet", tree, opts.head]);
  try {
    await pinGateDirToBase(opts.repo, tree, opts.base);
    const results: CheckResult[] = [];
    for (const check of config.checks) {
      log(`▶ ${check.name} (${check.type})`);
      const r = await runCheck(check, config, { ...opts, tree, diffFile, diff });
      log(`  ${r.status}: ${r.reason}`);
      if ((r.status === "failed" || r.status === "error") && r.output.trim()) {
        log(r.output.trim().split("\n").map((l) => `    | ${l}`).join("\n"));
      }
      results.push(r);
    }
    return evaluateGate(results);
  } finally {
    await git(opts.repo, ["worktree", "remove", "--force", tree]).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

interface CheckContext extends RunOptions {
  tree: string;
  diffFile: string;
  diff: string;
}

async function runCheck(check: CheckDefinition, config: GateConfig, ctx: CheckContext): Promise<CheckResult> {
  const env = {
    ...process.env,
    RUNSTAGE_BASE: ctx.base,
    RUNSTAGE_HEAD: ctx.head,
    RUNSTAGE_REPO: ctx.tree,
    RUNSTAGE_DIFF_FILE: ctx.diffFile,
    RUNSTAGE_CHECK: check.name,
  };
  if (check.type === "script") return runScript(check, ctx, env);
  return runAgent(check, config, ctx, env);
}

/**
 * Replace `.runstage/` in the head worktree with the base commit's version: the PR's copy is
 * removed entirely (edits, deletions and new files alike), then the base tree is checked out
 * with its modes and symlinks. If the base has no `.runstage/`, the directory is simply absent.
 * The rest of the worktree stays at the PR head, so checks still inspect the PR's code.
 */
async function pinGateDirToBase(repo: string, tree: string, base: string): Promise<void> {
  await rm(join(tree, GATE_DIR), { recursive: true, force: true });
  if (await pathExistsAt(repo, base, GATE_DIR)) {
    await git(tree, ["checkout", "--quiet", base, "--", GATE_DIR]);
  }
}

/** `.runstage/...` paths named in a check command (e.g. `bash .runstage/checks/x.sh`). */
export function gatePathsIn(command: string): string[] {
  const re = /(?:^|[\s'"=:;&|(<>])(?:\.\/)?(\.runstage\/[^\s'";&|()<>$`*?]+)/g;
  const paths = new Set<string>();
  for (const m of command.matchAll(re)) paths.add(m[1]!.replace(/\/+$/, ""));
  return [...paths];
}

async function runScript(check: ScriptCheck, ctx: CheckContext, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  for (const path of gatePathsIn(check.run)) {
    if (!(await pathExistsAt(ctx.repo, ctx.base, path))) {
      return {
        name: check.name, kind: "script", required: check.required, status: "error", exitCode: null, durationMs: 0, output: "",
        reason:
          `${path} is not on the base commit ${ctx.base.slice(0, 12)}. Check scripts are loaded from the base, ` +
          "never from the PR head; merge the script to the base branch first.",
      };
    }
  }
  const r = await exec("bash", ["-c", check.run], { cwd: ctx.tree, env, timeoutMs: check.timeout_seconds * 1000 });
  return toResult(check.name, "script", check.required, r);
}

const AGENT_COMMANDS: Record<Exclude<AgentCheck["agent"], "custom">, string> = {
  "claude-code": "claude -p",
  codex: "codex exec -",
};

async function runAgent(check: AgentCheck, config: GateConfig, ctx: CheckContext, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const skip = (reason: string): CheckResult => ({
    name: check.name, kind: "agent", required: check.required, status: "skipped", reason, exitCode: null, durationMs: 0, output: "",
  });
  if (!config.agents.enabled) return skip("agent checks disabled in gate.yml (agents.enabled: false)");
  if (!ctx.allowAgents) return skip("agent checks not allowed on this runner (pass --allow-agents)");
  const command = check.command ?? AGENT_COMMANDS[check.agent as Exclude<AgentCheck["agent"], "custom">];
  const bin = command.split(/\s+/)[0]!;
  const which = await exec("bash", ["-c", `command -v ${JSON.stringify(bin)}`], { cwd: ctx.tree, env, timeoutMs: 5000 });
  if (which.code !== 0) return skip(`${bin} is not installed on this runner`);

  const input =
    `${check.prompt}\n\nEnd your answer with a line "VERDICT: PASS" or "VERDICT: FAIL: <reason>".\n\n` +
    `--- PR diff ---\n${ctx.diff}`;
  const r = await exec("bash", ["-c", command], { cwd: ctx.tree, env, input, timeoutMs: check.timeout_seconds * 1000 });
  const verdict = /VERDICT:\s*(PASS|FAIL)(?::\s*(.*))?/i.exec(r.output.split("\n").reverse().find((l) => /VERDICT:/i.test(l)) ?? "");
  if (r.code === 0 && verdict?.[1]?.toUpperCase() === "FAIL") {
    return { ...toResult(check.name, "agent", check.required, r), status: "failed", reason: `agent verdict: ${verdict[2]?.trim() || "FAIL"}` };
  }
  return toResult(check.name, "agent", check.required, r);
}

interface ExecResult {
  code: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  spawnError?: string;
}

function exec(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const append = (b: Buffer) => {
      output += b.toString();
      if (output.length > OUTPUT_LIMIT * 2) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, o.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output, durationMs: Date.now() - started, timedOut, spawnError: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: output.slice(-OUTPUT_LIMIT), durationMs: Date.now() - started, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}

function toResult(name: string, kind: CheckResult["kind"], required: boolean, r: ExecResult): CheckResult {
  const lastLine = r.output.trim().split("\n").filter(Boolean).pop() ?? "";
  let status: CheckResult["status"];
  let reason: string;
  if (r.spawnError) {
    status = "error";
    reason = `could not start: ${r.spawnError}`;
  } else if (r.timedOut) {
    status = "error";
    reason = "timed out";
  } else if (r.code === 0) {
    status = "passed";
    reason = lastLine || "exit 0";
  } else {
    status = "failed";
    reason = `exit ${r.code}${lastLine ? `: ${lastLine}` : ""}`;
  }
  return { name, kind, required, status, reason: reason.slice(0, 300), exitCode: r.code, durationMs: r.durationMs, output: r.output };
}
