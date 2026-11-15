import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", repo, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Make sure both commits are present locally, fetching from origin if needed. */
export async function ensureCommits(repo: string, shas: string[], fetch = true): Promise<void> {
  const missing: string[] = [];
  for (const sha of shas) if (!(await hasCommit(repo, sha))) missing.push(sha);
  if (missing.length && fetch) {
    try {
      await git(repo, ["fetch", "--quiet", "origin", ...missing]);
    } catch {
      // fall through to the check below for a clear error
    }
  }
  for (const sha of missing) {
    if (!(await hasCommit(repo, sha))) {
      throw new Error(`commit ${sha} not found in ${repo} (fetch it first)`);
    }
  }
}

/** Diff of what the PR adds: merge-base(base, head)..head, like GitHub's PR view. */
export async function diffForChange(repo: string, base: string, head: string): Promise<string> {
  let from = base;
  try {
    from = (await git(repo, ["merge-base", base, head])).trim() || base;
  } catch {
    // unrelated histories: fall back to a straight diff
  }
  return git(repo, ["diff", "--no-color", "--no-ext-diff", from, head]);
}
