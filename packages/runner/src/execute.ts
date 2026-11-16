import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  GATE_CONFIG_PATH,
  evaluateGate,
  parseGateConfig,
  detectAiGenerated,
  type AgentCheck,
  type AiDetection,
  type ChangeRef,
  type CheckDefinition,
  type CheckResult,
  type GateConfig,
  type GateResult,
  type ScriptCheck,
} from "@runstage-gate/core";
import { commitMessages, diffForChange, ensureCommits, git, pathExistsAt } from "./git.ts";
import { scrubbedCheckEnv } from "./check-env.ts";
import {
  PROTECTED_HOME_PATHS,
  sandboxAvailable,
  sandboxProfile,
  sandboxSettingsFromEnv,
  sandboxedBash,
  type SandboxSettings,
} from "./sandbox.ts";
import { homedir } from "node:os";

export interface RunOptions {
  repo: string;
  base: string;
  head: string;
  /** Use this config instead of reading .runstage/gate.yml at the base commit. Scripts still come from base. */
  configPath?: string;
  /** Runner-side switch: agent checks only run when both this and `agents.enabled` are true. */
  allowAgents?: boolean;
  /**
   * Local `run` only: if the base commit has no .runstage/gate.yml, read it from the checkout's
   * working tree instead of failing. Never set for jobs from the App (poll mode).
   */
  allowWorkingTreeConfig?: boolean;
  /** PR metadata from the code host (branch, labels, body, author), for AI-generated detection. */
  change?: Pick<ChangeRef, "pr" | "author">;
  /** Try `git fetch origin <sha>` for missing commits. */
  fetch?: boolean;
  log?: (line: string) => void;
  /** Sandbox settings. Default: from the runner's env (RUNSTAGE_SANDBOX, RUNSTAGE_SANDBOX_NETWORK). */
  sandbox?: SandboxSettings;
  /** The runner's environment that check envs are filtered from. Default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** How checks of one gate run are isolated. */
interface Isolation {
  /** True when checks run under sandbox-exec. */
  sandboxed: boolean;
  settings: SandboxSettings;
  /** Set when mode is "required" but the sandbox is unavailable: every check errors with this. */
  refuse?: string;
  /** Why checks run unsandboxed (mode off, or auto on a host without sandbox-exec). */
  warning?: string;
  /** Real paths checks may write to. */
  writable: string[];
  home: string;
  tmp: string;
}

const OUTPUT_LIMIT = 8_000;

/**
 * Everything under this directory is the gate's own code (config, check scripts, helpers).
 * In the check worktree it is always replaced with the BASE commit's copy, so a PR cannot
 * rewrite, delete or add to the checks that judge it.
 */
export const GATE_DIR = ".runstage";

/**
 * Load the gate config from the *base* commit, so a PR cannot weaken its own gate. If the base
 * has none, that is an error, unless a local run opted in with `allowWorkingTreeConfig`.
 */
export async function loadConfig(opts: RunOptions): Promise<GateConfig> {
  if (opts.configPath) return parseGateConfig(await readFile(opts.configPath, "utf8"));
  let text: string | undefined;
  try {
    text = await git(opts.repo, ["show", `${opts.base}:${GATE_CONFIG_PATH}`]);
  } catch {
    text = undefined; // not on the base commit
  }
  if (text !== undefined) return parseGateConfig(text);
  if (!opts.allowWorkingTreeConfig) {
    throw new Error(
      `${GATE_CONFIG_PATH} not found on the base commit ${opts.base.slice(0, 12)}. RunStage Gate reads its config ` +
        "from the PR's base branch only; merge .runstage/gate.yml into the base branch first.",
    );
  }
  opts.log?.(`! ${GATE_CONFIG_PATH} is not on the base commit; using the working tree copy (local run only)`);
  return parseGateConfig(await readFile(join(opts.repo, GATE_CONFIG_PATH), "utf8"));
}

export async function runGate(opts: RunOptions): Promise<GateResult> {
  const log = opts.log ?? (() => {});
  await ensureCommits(opts.repo, [opts.base, opts.head], opts.fetch ?? false);
  const config = await loadConfig(opts);
  const diff = await diffForChange(opts.repo, opts.base, opts.head);
  const ai = config.ai_detection.enabled ? await detectForChange(config, opts) : undefined;
  if (ai) log(`AI-generated: ${ai.generated ? `yes (${ai.signals.join("; ")})` : "no"}`);
  const policyRequired = new Set(ai?.generated ? config.ai_detection.policy.require_checks : []);

  // Checks run against a clean worktree of the head commit, never the user's checkout.
  // realpath: on macOS tmpdir() is under /var, a symlink to /private/var; the sandbox needs real paths.
  const work = await realpath(await mkdtemp(join(tmpdir(), "runstage-gate-")));
  const tree = join(work, "tree");
  const diffFile = join(work, "change.diff");
  await writeFile(diffFile, diff);
  await git(opts.repo, ["worktree", "add", "--detach", "--quiet", tree, opts.head]);
  try {
    await pinGateDirToBase(opts.repo, tree, opts.base);
    const isolation = await prepareIsolation(opts, work, tree);
    if (isolation.refuse) log(`! ${isolation.refuse}`);
    else if (isolation.warning) log(`! WARNING: ${isolation.warning}`);
    else log(`sandbox: on (network: ${isolation.settings.network})`);
    const results: CheckResult[] = [];
    for (const configured of config.checks) {
      // AI policy: listed checks become required for AI-generated changes.
      const check = policyRequired.has(configured.name) ? { ...configured, required: true } : configured;
      log(`▶ ${check.name} (${check.type})`);
      let r = isolation.refuse
        ? errorResult(check, isolation.refuse)
        : await runCheck(check, config, { ...opts, tree, diffFile, diff, ai, isolation });
      if (policyRequired.has(check.name) && r.status === "skipped") {
        // A check the AI policy requires must actually run; skipping it would quietly weaken the gate.
        r = { ...r, status: "error", reason: `required for AI-generated changes but skipped: ${r.reason}` };
      }
      log(`  ${r.status}: ${r.reason}`);
      if ((r.status === "failed" || r.status === "error") && r.output.trim()) {
        log(r.output.trim().split("\n").map((l) => `    | ${l}`).join("\n"));
      }
      results.push(r);
    }
    if (ai?.generated && config.ai_detection.policy.require_approval) {
      results.push({
        name: "ai-approval", kind: "policy", required: true, status: "failed", exitCode: null, durationMs: 0, output: "",
        reason: "AI-generated change: needs approval (Approve override button or a /runstage approve comment)",
      });
    }
    const verdict = evaluateGate(results, { ai });
    return { ...verdict, summary: `${verdict.summary}\n\n${isolationNote(isolation)}` };
  } finally {
    await git(opts.repo, ["worktree", "remove", "--force", tree]).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
}

interface CheckContext extends RunOptions {
  tree: string;
  diffFile: string;
  diff: string;
  ai?: AiDetection;
  isolation: Isolation;
}

async function prepareIsolation(opts: RunOptions, work: string, tree: string): Promise<Isolation> {
  const settings = opts.sandbox ?? sandboxSettingsFromEnv(opts.env ?? process.env);
  const home = join(work, "home");
  const tmp = join(work, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  // The worktree's own admin dir (<repo>/.git/worktrees/<name>): git writes its index and HEAD
  // there. The shared .git (objects, refs, hooks, config) stays read-only.
  const adminDir = await realpath((await git(tree, ["rev-parse", "--absolute-git-dir"])).trim());
  const writable = [work, adminDir];
  const base = { settings, writable, home, tmp };
  if (settings.mode === "off") {
    return { ...base, sandboxed: false, warning: "checks run UNSANDBOXED (RUNSTAGE_SANDBOX=off): PR code has the runner user's file and network access" };
  }
  if (!sandboxAvailable()) {
    const why = `sandbox-exec is not available on this host (${process.platform})`;
    if (settings.mode === "required") return { ...base, sandboxed: false, refuse: `sandbox required (RUNSTAGE_SANDBOX=required) but ${why}; checks were not run` };
    return { ...base, sandboxed: false, warning: `checks run UNSANDBOXED: ${why}. Set RUNSTAGE_SANDBOX=required to refuse instead` };
  }
  return { ...base, sandboxed: true };
}

function isolationNote(i: Isolation): string {
  if (i.refuse) return `> ⚠️ **Sandbox**: ${i.refuse}.`;
  if (!i.sandboxed) return `> ⚠️ **Sandbox**: ${i.warning}.`;
  return `> 🔒 Checks ran in a macOS sandbox (writes limited to the job's temp worktree; network: ${i.settings.network}).`;
}

function errorResult(check: CheckDefinition, reason: string): CheckResult {
  return { name: check.name, kind: check.type, required: check.required, status: "error", exitCode: null, durationMs: 0, output: "", reason };
}

/** How to start `bash -c <command>` for a check: sandboxed or not, with which env. */
function launcher(command: string, ctx: CheckContext, gateEnv: Record<string, string>, kind: "script" | "agent") {
  const i = ctx.isolation;
  const source = ctx.env ?? process.env;
  let env = scrubbedCheckEnv(source, { home: i.home, tmp: i.tmp, gate: gateEnv });
  let writable = i.writable;
  let network = i.settings.network;
  let protectedReads = PROTECTED_HOME_PATHS.map((p) => join(homedir(), p));
  if (kind === "agent") {
    // Agent CLIs (claude, codex) need their own login state and API access: real HOME, network,
    // and the agent's config dirs; plus names the runner owner lists in RUNSTAGE_AGENT_ENV_PASSTHROUGH.
    env = { ...env, HOME: homedir() };
    for (const name of (source.RUNSTAGE_AGENT_ENV_PASSTHROUGH ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (source[name] !== undefined) env[name] = source[name];
    }
    const agentDirs = [".claude", ".claude.json", ".codex", ".config/claude"].map((p) => join(homedir(), p));
    writable = [...writable, ...agentDirs];
    network = "all";
    protectedReads = protectedReads.filter((p) => !agentDirs.includes(p));
  }
  if (!i.sandboxed) return { cmd: "bash", args: ["-c", command], env };
  const { cmd, args } = sandboxedBash(command, sandboxProfile({ writable, network, protectedReads }));
  return { cmd, args, env };
}

async function detectForChange(config: GateConfig, opts: RunOptions): Promise<AiDetection> {
  const pr = opts.change?.pr;
  return detectAiGenerated(config.ai_detection, {
    commitMessages: config.ai_detection.commit_trailers ? await commitMessages(opts.repo, opts.base, opts.head) : [],
    branch: pr?.headRef,
    labels: pr?.labels,
    title: pr?.title,
    body: pr?.body,
    author: opts.change?.author,
  });
}

async function runCheck(check: CheckDefinition, config: GateConfig, ctx: CheckContext): Promise<CheckResult> {
  // Only these gate variables plus an allowlist (check-env.ts) reach the check; never the runner's env.
  const env: Record<string, string> = {
    RUNSTAGE_BASE: ctx.base,
    RUNSTAGE_HEAD: ctx.head,
    RUNSTAGE_REPO: ctx.tree,
    RUNSTAGE_DIFF_FILE: ctx.diffFile,
    RUNSTAGE_CHECK: check.name,
    // "1" when ai_detection is enabled and found signals, else "0".
    RUNSTAGE_AI_GENERATED: ctx.ai?.generated ? "1" : "0",
    RUNSTAGE_AI_SIGNALS: ctx.ai?.signals.join("\n") ?? "",
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
    await assertGateDirContained(tree);
  }
}

/** Thrown when the base commit's `.runstage/` contains links that point outside it. */
export class GateDirEscapeError extends Error {
  constructor(readonly links: string[]) {
    super(
      `${GATE_DIR}/ on the base commit contains symlinks that resolve outside ${GATE_DIR}/: ${links.join(", ")}. ` +
        `Those targets come from the PR head, so the PR could rewrite the check. Replace the links with real files.`,
    );
    this.name = "GateDirEscapeError";
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Every symlink under `.runstage/` (after pinning it to base) must resolve inside `.runstage/`.
 * Otherwise a base link like `.runstage/checks/x.sh -> ../../src/x.sh` would run PR-controlled code.
 * `.runstage` itself must be a real directory.
 */
export async function assertGateDirContained(tree: string): Promise<void> {
  const gateDir = join(tree, GATE_DIR);
  const top = await lstat(gateDir);
  if (top.isSymbolicLink()) throw new GateDirEscapeError([GATE_DIR]);
  if (!top.isDirectory()) return;
  const root = await realpath(gateDir);
  const bad: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(p);
        } catch {
          // Dangling: resolve the link text against the link's real parent directory.
          target = resolve(await realpath(dirname(p)), await readlink(p));
        }
        if (!isInside(root, target)) bad.push(relative(tree, p));
      } else if (entry.isDirectory()) {
        await walk(p);
      }
    }
  };
  await walk(gateDir);
  if (bad.length) throw new GateDirEscapeError(bad.sort());
}

/** `.runstage/...` paths named in a check command (e.g. `bash .runstage/checks/x.sh`). */
export function gatePathsIn(command: string): string[] {
  const re = /(?:^|[\s'"=:;&|(<>])(?:\.\/)?(\.runstage\/[^\s'";&|()<>$`*?]+)/g;
  const paths = new Set<string>();
  for (const m of command.matchAll(re)) paths.add(m[1]!.replace(/\/+$/, ""));
  return [...paths];
}

/** Error result if a `.runstage/...` path named in `command` is not on the base commit. */
async function missingOnBase(
  command: string,
  check: { name: string; required: boolean },
  kind: CheckResult["kind"],
  ctx: CheckContext,
): Promise<CheckResult | undefined> {
  for (const path of gatePathsIn(command)) {
    if (!(await pathExistsAt(ctx.repo, ctx.base, path))) {
      return {
        name: check.name, kind, required: check.required, status: "error", exitCode: null, durationMs: 0, output: "",
        reason:
          `${path} is not on the base commit ${ctx.base.slice(0, 12)}. Check scripts are loaded from the base, ` +
          "never from the PR head; merge the script to the base branch first.",
      };
    }
  }
  return undefined;
}

async function runScript(check: ScriptCheck, ctx: CheckContext, gateEnv: Record<string, string>): Promise<CheckResult> {
  const missing = await missingOnBase(check.run, check, "script", ctx);
  if (missing) return missing;
  const l = launcher(check.run, ctx, gateEnv, "script");
  const r = await exec(l.cmd, l.args, { cwd: ctx.tree, env: l.env, timeoutMs: check.timeout_seconds * 1000 });
  return toResult(check.name, "script", check.required, r);
}

const AGENT_COMMANDS: Record<Exclude<AgentCheck["agent"], "custom">, string> = {
  "claude-code": "claude -p",
  codex: "codex exec -",
};

async function runAgent(check: AgentCheck, config: GateConfig, ctx: CheckContext, gateEnv: Record<string, string>): Promise<CheckResult> {
  const skip = (reason: string): CheckResult => ({
    name: check.name, kind: "agent", required: check.required, status: "skipped", reason, exitCode: null, durationMs: 0, output: "",
  });
  if (!config.agents.enabled) return skip("agent checks disabled in gate.yml (agents.enabled: false)");
  if (!ctx.allowAgents) return skip("agent checks not allowed on this runner (pass --allow-agents)");
  const command = check.command ?? AGENT_COMMANDS[check.agent as Exclude<AgentCheck["agent"], "custom">];
  // Same rule as script checks: helper files an agent command names must exist on the base.
  const missing = await missingOnBase(command, check, "agent", ctx);
  if (missing) return missing;
  const bin = command.split(/\s+/)[0]!;
  const w = launcher(`command -v ${JSON.stringify(bin)}`, ctx, gateEnv, "agent");
  const which = await exec(w.cmd, w.args, { cwd: ctx.tree, env: w.env, timeoutMs: 5000 });
  if (which.code !== 0) return skip(`${bin} is not installed on this runner`);

  const input =
    `${check.prompt}\n\nEnd your answer with a line "VERDICT: PASS" or "VERDICT: FAIL: <reason>".\n\n` +
    `--- PR diff ---\n${ctx.diff}`;
  const l = launcher(command, ctx, gateEnv, "agent");
  const r = await exec(l.cmd, l.args, { cwd: ctx.tree, env: l.env, input, timeoutMs: check.timeout_seconds * 1000 });
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
