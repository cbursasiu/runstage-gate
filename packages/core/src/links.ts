import type { ChangeRef } from "./types.ts";

const GITHUB_REPO_RE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/**
 * Web link to the provider check behind a gate run, built only from data the App already has.
 *
 * - GitHub: `https://github.com/<owner>/<repo>/runs/<check_run_id>`, which is the `html_url`
 *   GitHub returns for a check run.
 * - GitLab: commit statuses have no page of their own, so this links to the merge request
 *   (`<project web url>/-/merge_requests/<iid>`), derived from the project's HTTP clone URL.
 *
 * Returns undefined when the inputs don't look right; callers fall back to another link.
 */
export function providerCheckUrl(change: ChangeRef, externalCheckId: string | undefined): string | undefined {
  if (change.provider === "github") {
    if (!GITHUB_REPO_RE.test(change.repoFullName) || !externalCheckId || !/^\d{1,20}$/.test(externalCheckId)) return undefined;
    return `https://github.com/${change.repoFullName}/runs/${externalCheckId}`;
  }
  if (change.provider === "gitlab") {
    const web = gitlabWebUrl(change.cloneUrl);
    if (!web) return undefined;
    return change.prNumber != null && Number.isInteger(change.prNumber) && change.prNumber > 0
      ? `${web}/-/merge_requests/${change.prNumber}`
      : web;
  }
  return undefined;
}

function gitlabWebUrl(cloneUrl: string | undefined): string | undefined {
  if (!cloneUrl) return undefined;
  let u: URL;
  try {
    u = new URL(cloneUrl);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path || path === "/") return undefined;
  return `${u.protocol}//${u.host}${path}`;
}
