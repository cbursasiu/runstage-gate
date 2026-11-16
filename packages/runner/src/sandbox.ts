import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Isolation for untrusted PR code, at zero cost: macOS `sandbox-exec` (built in, no install).
 *
 * Mode (runner env RUNSTAGE_SANDBOX, never from gate.yml, so a PR cannot turn it off):
 *   auto      (default) sandbox when sandbox-exec exists; otherwise run unsandboxed and say so
 *             loudly in the log and in every check result.
 *   required  sandbox or fail: a check that cannot be sandboxed errors instead of running.
 *   off       no sandbox (a warning is still logged and shown on the check).
 * Network (RUNSTAGE_SANDBOX_NETWORK): none (default; no DNS either), loopback (127.0.0.1/::1
 * only, e.g. tests that start local servers), all (no network restriction).
 *
 * The profile denies every file write except the job's temp dir (worktree, HOME, TMPDIR) and the
 * worktree's own git admin dir, and denies reads of well-known credential stores in the real
 * HOME. It does NOT hide the rest of the filesystem from reads, does not limit CPU/memory, and
 * sandbox-exec is deprecated by Apple (still shipped and working). See docs/security.md.
 */
export type SandboxMode = "auto" | "required" | "off";
export type SandboxNetwork = "none" | "loopback" | "all";

export interface SandboxSettings {
  mode: SandboxMode;
  network: SandboxNetwork;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxSettings {
  const mode = (env.RUNSTAGE_SANDBOX ?? "auto").trim().toLowerCase();
  const network = (env.RUNSTAGE_SANDBOX_NETWORK ?? "none").trim().toLowerCase();
  if (!["auto", "required", "off"].includes(mode)) throw new Error(`RUNSTAGE_SANDBOX must be auto, required or off (got "${mode}")`);
  if (!["none", "loopback", "all"].includes(network)) {
    throw new Error(`RUNSTAGE_SANDBOX_NETWORK must be none, loopback or all (got "${network}")`);
  }
  return { mode: mode as SandboxMode, network: network as SandboxNetwork };
}

export function sandboxAvailable(platform: NodeJS.Platform = process.platform, exists = existsSync): boolean {
  return platform === "darwin" && exists(SANDBOX_EXEC);
}

/** Credential stores under the real HOME that sandboxed checks may not read. */
export const PROTECTED_HOME_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".claude",
  ".codex",
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
  "Library/Cookies",
];

function q(path: string): string {
  return JSON.stringify(path); // SBPL strings use the same escaping as JSON for our paths
}

/**
 * The SBPL profile. `writable` must be real paths (no symlinks: /var -> /private/var on macOS).
 * `protectedReads` are denied for both read and write.
 */
export function sandboxProfile(o: { writable: string[]; network: SandboxNetwork; protectedReads?: string[] }): string {
  const lines = ["(version 1)", "(allow default)"];
  if (o.network !== "all") {
    lines.push("(deny network*)");
    if (o.network === "loopback") {
      lines.push(
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        '(allow network-bind (local ip "localhost:*"))',
      );
    }
  }
  lines.push(
    "(deny file-write*)",
    `(allow file-write* ${[
      ...o.writable.map((p) => `(subpath ${q(p)})`),
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/tty")',
      '(literal "/dev/dtracehelper")',
      '(subpath "/dev/fd")',
    ].join(" ")})`,
  );
  const reads = o.protectedReads ?? PROTECTED_HOME_PATHS.map((p) => join(homedir(), p));
  if (reads.length) lines.push(`(deny file-read* file-write* ${reads.map((p) => `(subpath ${q(p)})`).join(" ")})`);
  return lines.join("\n") + "\n";
}

/** Command + args that run `bash -c <command>` inside the sandbox profile. */
export function sandboxedBash(command: string, profile: string): { cmd: string; args: string[] } {
  return { cmd: SANDBOX_EXEC, args: ["-p", profile, "/bin/bash", "-c", command] };
}
