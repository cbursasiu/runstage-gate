import type { CheckResult, GateConclusion, RunRecord } from "@runstage-gate/core";

const REPO_RE = /^(?!\.+\/)[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{1,64}$/;

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function runDurationMs(run: RunRecord): number | null {
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.completedAt);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  if ((run.checks ?? []).length > 0) return (run.checks ?? []).reduce((sum, c) => sum + (c.durationMs || 0), 0);
  return null;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function githubRepo(repo: string): string | undefined {
  return REPO_RE.test(repo) ? repo : undefined;
}

function githubCommitUrl(repo: string, sha: string): string | undefined {
  const r = githubRepo(repo);
  return r && SHA_RE.test(sha) ? `https://github.com/${r}/commit/${sha}` : undefined;
}

function githubPrUrl(repo: string, pr: number): string | undefined {
  const r = githubRepo(repo);
  return r && Number.isInteger(pr) && pr > 0 ? `https://github.com/${r}/pull/${pr}` : undefined;
}

function githubCompareUrl(repo: string, base: string, head: string): string | undefined {
  const r = githubRepo(repo);
  return r && SHA_RE.test(base) && SHA_RE.test(head)
    ? `https://github.com/${r}/compare/${base}...${head}`
    : undefined;
}

function githubFilesUrl(repo: string, pr: number): string | undefined {
  const prUrl = githubPrUrl(repo, pr);
  return prUrl ? `${prUrl}/files` : undefined;
}

function href(url: string): string {
  return escapeHtml(url);
}

function link(url: string | undefined, label: string, extraClass?: string): string {
  const cls = extraClass ? ` class="${extraClass}"` : "";
  if (!url) return `<span${cls}>${escapeHtml(label)}</span>`;
  return `<a${cls} href="${href(url)}">${escapeHtml(label)}</a>`;
}

function badge(verdict: string): string {
  const kind = verdict === "success" || verdict === "failure" ? verdict : "unknown";
  return `<span class="badge ${kind}">${escapeHtml(verdict)}</span>`;
}

function statusBadge(status: string): string {
  const known = new Set(["passed", "failed", "skipped", "error"]);
  const kind = known.has(status) ? status : "unknown";
  return `<span class="badge ${kind}">${escapeHtml(status)}</span>`;
}

const css = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  color: #1f2328;
  background: #f6f8fa;
}
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
header {
  background: #fff;
  border-bottom: 1px solid #d0d7de;
  padding: 16px 24px;
}
header h1 { margin: 0; font-size: 18px; }
header h1 a { color: inherit; }
header p { margin: 4px 0 0; color: #656d76; }
main { max-width: 1080px; margin: 0 auto; padding: 24px; }
.filters {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
  margin: 0 0 16px; padding: 12px 16px;
  background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
}
.filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #656d76; }
.filters input, .filters select {
  font: inherit; padding: 6px 8px; min-width: 180px;
  border: 1px solid #d0d7de; border-radius: 6px; background: #fff;
}
.filters button, .filters a.btn {
  font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #d0d7de;
  background: #f6f8fa; color: #1f2328; cursor: pointer; text-decoration: none;
}
.filters button:hover, .filters a.btn:hover { background: #eef1f4; text-decoration: none; }
table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #d0d7de; vertical-align: top; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.02em; color: #656d76; background: #f6f8fa; }
tr:last-child td { border-bottom: 0; }
.mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.muted { color: #656d76; }
.empty { padding: 32px; text-align: center; color: #656d76; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; }
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 12px; font-weight: 600; line-height: 1.6;
}
.badge.success, .badge.passed { background: #dafbe1; color: #0a7d32; }
.badge.failure, .badge.failed { background: #ffebe9; color: #b42318; }
.badge.skipped { background: #eaeef2; color: #656d76; }
.badge.error, .badge.unknown { background: #fff1e5; color: #bc4c00; }
.meta { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; margin: 0 0 20px; }
.meta dt { color: #656d76; }
.meta dd { margin: 0; }
section { margin: 0 0 24px; }
section h2 { font-size: 15px; margin: 0 0 8px; }
pre.output, pre.diff {
  margin: 0; padding: 12px; overflow: auto; max-height: 28em;
  background: #161b22; color: #e6edf3; border-radius: 8px; white-space: pre-wrap; word-break: break-word;
}
.check-out { margin: 0 0 16px; }
.check-out h3 { font-size: 13px; margin: 0 0 6px; }
.links { display: flex; flex-wrap: wrap; gap: 12px; }
.back { margin: 0 0 16px; }
`.trim();

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <h1><a href="/">RunStage Gate</a></h1>
    <p>Run history</p>
  </header>
  <main>
${body}
  </main>
</body>
</html>
`;
}

export type ListFilters = { repo?: string; verdict?: string };

export function renderListPage(runs: RunRecord[], filters: ListFilters = {}): string {
  const repoValue = escapeHtml(filters.repo ?? "");
  const verdict = filters.verdict === "success" || filters.verdict === "failure" ? filters.verdict : "";
  const rows = runs
    .map((run) => {
      const prLabel = run.prNumber != null ? `#${run.prNumber}` : "—";
      const sha = shortSha(run.headSha);
      return `<tr>
        <td class="muted">${escapeHtml(formatTime(run.completedAt || run.createdAt))}</td>
        <td>${escapeHtml(run.repoFullName)}</td>
        <td>${link(run.prNumber != null ? githubPrUrl(run.repoFullName, run.prNumber) : undefined, prLabel)}</td>
        <td class="mono">${link(githubCommitUrl(run.repoFullName, run.headSha), sha)}</td>
        <td>${badge(run.conclusion)}</td>
        <td>${link(`/runs/${encodeURIComponent(run.id)}`, run.title || "(no title)")}</td>
        <td class="mono">${escapeHtml(run.runnerId ?? "—")}</td>
        <td>${escapeHtml(formatDuration(runDurationMs(run)))}</td>
      </tr>`;
    })
    .join("\n");

  const table = runs.length
    ? `<table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Repo</th>
            <th>PR</th>
            <th>Commit</th>
            <th>Verdict</th>
            <th>Title</th>
            <th>Runner</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>`
    : `<p class="empty">No runs yet.</p>`;

  const body = `    <form class="filters" method="get" action="/">
      <label>Repo
        <input type="text" name="repo" value="${repoValue}" placeholder="owner/name" autocomplete="off">
      </label>
      <label>Verdict
        <select name="verdict">
          <option value=""${verdict === "" ? " selected" : ""}>All</option>
          <option value="success"${verdict === "success" ? " selected" : ""}>success</option>
          <option value="failure"${verdict === "failure" ? " selected" : ""}>failure</option>
        </select>
      </label>
      <button type="submit">Filter</button>
      <a class="btn" href="/">Clear</a>
    </form>
${table}`;

  return layout("Run history · RunStage Gate", body);
}

function checkRow(check: CheckResult): string {
  return `<tr>
    <td class="mono">${escapeHtml(check.name)}</td>
    <td>${escapeHtml(check.kind)}</td>
    <td>${check.required ? "yes" : "no"}</td>
    <td>${statusBadge(check.status)}</td>
    <td>${escapeHtml(formatDuration(check.durationMs))}</td>
    <td>${escapeHtml(check.reason || "—")}</td>
  </tr>`;
}

function failingOutputs(run: RunRecord): string {
  const failing = (run.checks ?? []).filter((c) => c.status === "failed" || c.status === "error");
  if (failing.length === 0) return `<p class="muted">No failing checks.</p>`;
  return failing
    .map((c) => {
      const out = c.output?.length ? c.output : "(no output)";
      return `<div class="check-out">
        <h3>${escapeHtml(c.name)} <span class="muted">(${escapeHtml(c.status)})</span></h3>
        <pre class="output">${escapeHtml(out)}</pre>
      </div>`;
    })
    .join("\n");
}

export function renderDetailPage(run: RunRecord): string {
  const prLabel = run.prNumber != null ? `#${run.prNumber}` : "—";
  const compare = githubCompareUrl(run.repoFullName, run.baseSha, run.headSha);
  const files = run.prNumber != null ? githubFilesUrl(run.repoFullName, run.prNumber) : undefined;
  const checks = (run.checks ?? []).length
    ? `<table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Required</th>
            <th>Result</th>
            <th>Duration</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
${(run.checks ?? []).map(checkRow).join("\n")}
        </tbody>
      </table>`
    : `<p class="muted">No checks recorded.</p>`;

  const diffSection = run.diff
    ? `<section>
      <h2>Diff</h2>
      <pre class="diff">${escapeHtml(run.diff)}</pre>
    </section>`
    : "";

  const title = `${run.conclusion} · ${run.repoFullName}${run.prNumber != null ? `#${run.prNumber}` : ""}`;
  const body = `    <p class="back">${link("/", "← All runs")} · ${link(`/api/runs/${encodeURIComponent(run.id)}`, "JSON")}</p>
    <section>
      <h2>${escapeHtml(run.title || "Run")} ${badge(run.conclusion)}</h2>
      <dl class="meta">
        <dt>Repo</dt><dd>${escapeHtml(run.repoFullName)}</dd>
        <dt>PR</dt><dd>${link(run.prNumber != null ? githubPrUrl(run.repoFullName, run.prNumber) : undefined, prLabel)}</dd>
        <dt>Head</dt><dd class="mono">${link(githubCommitUrl(run.repoFullName, run.headSha), run.headSha)}</dd>
        <dt>Base</dt><dd class="mono">${link(githubCommitUrl(run.repoFullName, run.baseSha), run.baseSha)}</dd>
        <dt>Verdict</dt><dd>${badge(run.conclusion)}</dd>
        <dt>Runner</dt><dd class="mono">${escapeHtml(run.runnerId ?? "—")}</dd>
        ${run.approvedBy ? `<dt>Approved by</dt><dd>${escapeHtml(run.approvedBy)}</dd>` : ""}
        <dt>Created</dt><dd>${escapeHtml(formatTime(run.createdAt))}</dd>
        <dt>Completed</dt><dd>${escapeHtml(formatTime(run.completedAt))}</dd>
        <dt>Duration</dt><dd>${escapeHtml(formatDuration(runDurationMs(run)))}</dd>
      </dl>
    </section>
    <section>
      <h2>Checks</h2>
${checks}
    </section>
    <section>
      <h2>Failing output</h2>
${failingOutputs(run)}
    </section>
    <section>
      <h2>PR diff</h2>
      <p class="links">
        ${link(compare, "Compare on GitHub")}
        ${files ? ` · ${link(files, "PR files")}` : ""}
      </p>
    </section>
${diffSection}`;

  return layout(title, body);
}

export function renderNotFoundPage(): string {
  return layout(
    "Run not found · RunStage Gate",
    `    <p class="back">${link("/", "← All runs")}</p>
    <p class="empty">Run not found.</p>`,
  );
}

export function wantsHtml(acceptHeader: string | undefined): boolean {
  const accept = acceptHeader ?? "";
  const htmlQ = qValue(accept, "text/html");
  const jsonQ = qValue(accept, "application/json");
  // Browsers list text/html explicitly; API clients and curl send */* or application/json.
  return htmlQ > 0 && htmlQ >= jsonQ;
}

/** q-value of an explicitly listed media type (0 when absent or unparseable). */
function qValue(accept: string, type: string): number {
  for (const part of accept.split(",")) {
    const [media, ...params] = part.trim().split(";");
    if (media?.trim().toLowerCase() !== type) continue;
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    if (!q) return 1;
    const n = Number(q.slice(2));
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
  }
  return 0;
}
