# Testing RunStage Gate against real GitHub

This walks through running the first slice against a real repository. You need Node 20+,
git, a GitHub account and a repo where you can change branch protection.

Nothing here deploys anything. The App server runs on your machine and webhooks reach it
through smee.io.

## 0. Try it without GitHub first

```bash
npm install
npm run typecheck && npm test
npm run demo
```

The demo sends a signed fake webhook to the App, the real `runstage-gate` CLI picks up the
job, runs the example check against a temp git repo, and the result goes to a mocked GitHub
client and the history stub.

## 1. Start a smee.io channel

1. Open <https://smee.io> and click **Start a new channel**. Copy the URL
   (`https://smee.io/<random>`).
2. Forward it to the local App server:

   ```bash
   npx smee-client --url https://smee.io/<random> --target http://localhost:3000/webhooks
   ```

## 2. Register a GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**
(or the same under an organization's settings).

- **Name**: anything unique, e.g. `RunStage Gate (dev, <you>)`
- **Homepage URL**: any URL
- **Webhook URL**: your smee.io channel URL
- **Webhook secret**: generate one (`openssl rand -hex 32`) and keep it for `.env`
- **Repository permissions**:
  - **Checks**: Read and write
  - **Contents**: Read-only
  - **Pull requests**: Read-only
  - (Metadata: Read-only is added automatically)
- **Subscribe to events**: **Check suite**, **Check run**, **Pull request**
  (**Check run** powers the **Re-run** and **Approve override** buttons on the RunStage Gate check)
  - Optional, for the `/runstage approve` comment: **Issues: Read-only** permission plus the
    **Issue comment** event (see [approvals.md](approvals.md))
- **Where can this App be installed**: Only on this account

After creating it:

1. Note the **App ID**.
2. **Generate a private key**. Save the `.pem` file outside the repo
   (e.g. `~/.config/runstage-gate/dev-app.pem`). `*.pem` is gitignored anyway.
3. **Install App** on the test repository.

## 3. Configure and start the App server

```bash
cp .env.example .env
# fill in GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET

# Register a runner. Prints its token ONCE; only the SHA-256 hash goes into the runners file.
npm run -s runner-token -- mint --id my-laptop --repo <owner>/<test-repo>
# (--repo is optional and repeatable; without it the runner may claim jobs for any repo.)

set -a; source .env; set +a
npm run dev:history &       # optional: history service on :3100 (UI at http://localhost:3100/)
npm run dev:app             # App server on :3000
```

## 4. Add the gate to the test repository

In the test repo:

```bash
mkdir -p .runstage/checks
cp /path/to/runstage-gate/examples/gate.yml .runstage/gate.yml
cp /path/to/runstage-gate/examples/checks/no-todo-in-diff.sh .runstage/checks/
# trim checks you don't want (e.g. unit-tests if the repo has no npm test)
git add .runstage && git commit -m "Add RunStage Gate" && git push
```

The runner reads `gate.yml` **and every file under `.runstage/`** (check scripts and
anything they source) from the PR's **base** commit, so this must be on the default branch
before you open a test PR. Changes a PR makes under `.runstage/` don't affect its own run: to
change a check, merge that change first. If `gate.yml` names a `.runstage/...` script that is
not on the base, that check ends with an error instead of running the PR's copy. Checks still
run from the root of a worktree of the PR head, so they see the PR's code; use
`RUNSTAGE_DIFF_FILE` or `git diff "$RUNSTAGE_BASE" "$RUNSTAGE_HEAD"` rather than
`git status`, because `.runstage/` in that worktree differs from the head commit.

## 5. Run the runner

On the machine that has a checkout of the test repo (macOS or Linux):

```bash
export RUNSTAGE_RUNNER_TOKEN=<the token printed by runner-token mint for this runner>
npm run gate -- poll --server http://localhost:3000 --repo /path/to/test-repo
# or: packages/runner/bin/runstage-gate.js poll --server http://localhost:3000 --repo /path/to/test-repo
```

Each runner has its own token. The App identifies the runner from the token (not from any
header), records which runner claimed each job, and refuses a result or heartbeat from a
different runner (`403`). While checks run, the runner sends a heartbeat every 60 s. If a
runner crashes or goes offline, its claim expires after `RUNSTAGE_JOB_LEASE_SECONDS`
(default 900) and the job goes back to the queue for another runner. Rotate a token by
minting again with the same `--id`, and revoke it with `npm run -s runner-token -- revoke
--id my-laptop`. The App re-reads the runners file when it changes, so neither needs a restart.

Jobs live in `RUNSTAGE_QUEUE_FILE` (default `.runstage-gate-data/queue.json`, gitignored), so
queued and claimed jobs survive an App restart. Duplicate webhooks (same delivery id, or the
same commit and check run) don't create duplicate jobs.

If GitHub rejects the final check-run update after a runner posts its result (outage, 5xx), the
result is kept, the update is retried three times within ~5 s, and then every
`RUNSTAGE_REPORT_RETRY_SECONDS` (default 60) in the background until it succeeds (up to 50
attempts), so a check is not left "in progress". The job records `reportPending`,
`reportAttempts` and `reportError` in the queue file.

### Migrating from the shared `RUNSTAGE_RUNNER_TOKEN`

1. On the App machine, mint one token per runner: `npm run -s runner-token -- mint --id <id>`.
2. On each runner, set `RUNSTAGE_RUNNER_TOKEN` to that runner's new token.
3. Restart the App. The App requires the runners file and refuses to start without it; the
   old shared-token fallback (runner `legacy-shared`) has been removed.

The runner fetches missing PR commits with `git fetch origin <sha>`. Add `--allow-agents`
only if you want agent checks to run (they also need `agents.enabled: true` in gate.yml and
the agent CLI installed and signed in).

Local dry run without the App:

```bash
npm run gate -- run --repo /path/to/test-repo --base origin/main --head HEAD
```

## 6. Open a PR

Push a branch that adds a line with `TODO` and open a PR. You should see:

1. The App logs `webhook pull_request` / `check_suite` and `queued job ...`.
2. The PR shows **RunStage Gate** as in progress.
3. The runner logs the check and posts the result.
4. The check turns red with a summary listing the TODO lines. Remove the TODO, push, and it
   turns green.

## 7. Make it block merges

Repo → **Settings → Branches** (or **Rules → Rulesets**) → protect the default branch:

- Enable **Require status checks to pass before merging**.
- Search for and add **RunStage Gate** (it only appears after it has run once on the repo).
- Optionally enable **Require branches to be up to date before merging**.

Now a failing RunStage Gate blocks the merge button.

## Viewing run history

The history service keeps a local JSON file (`HISTORY_DATA_FILE`) of finished gate runs.
Open <http://localhost:3100/> for a list of runs (filter by repo or verdict). Each run
has a detail page with per-check results, failing output, and links to the GitHub PR
and compare view. `GET /runs` and `GET /runs/:id` remain JSON (`GET /api/runs` is an
alias). <http://localhost:3100/fleet> is the fleet dashboard (one row per repo); see
[dashboard.md](dashboard.md).

### History access tokens

| Variable | Grants | Notes |
| --- | --- | --- |
| `RUNSTAGE_HISTORY_TOKEN` | write (`POST /runs`) and read | The App sends it as `Authorization: Bearer`. |
| `RUNSTAGE_HISTORY_READ_TOKEN` | read only | Optional. For people or tools that only view history. |

- **No token set**: everything is open (local dev only); the service logs a warning at startup.
- **Any token set**: reads fail closed. API clients send `Authorization: Bearer <token>` and get
  `401` without it. Browsers are redirected to `/login`, where you paste either token; that sets
  an `HttpOnly; SameSite=Strict` session cookie (12 h, signed with the tokens, never containing
  them). Rotating a token signs every browser out. **Sign out** is in the page header.
- **Only the read token set**: `POST /runs` returns `403` (read-only mode).
- Ten failed sign-ins from one address within five minutes get `429` for the rest of the window.
- Over HTTPS, set `HISTORY_COOKIE_SECURE=1`.

Generate tokens without printing them, for example:

```bash
mkdir -p ~/.config/runstage-gate && chmod 700 ~/.config/runstage-gate
(umask 077; openssl rand -hex 32 > ~/.config/runstage-gate/history-token)
(umask 077; openssl rand -hex 32 > ~/.config/runstage-gate/history-read-token)
# then in .env:
#   RUNSTAGE_HISTORY_TOKEN=<contents of history-token>
#   RUNSTAGE_HISTORY_READ_TOKEN=<contents of history-read-token>
curl -H "Authorization: Bearer $(cat ~/.config/runstage-gate/history-read-token)" http://localhost:3100/runs
```

HTML pages are served with a strict Content-Security-Policy (no scripts, inline CSS only),
and every value from a run is HTML-escaped. `POST /runs` bodies are validated (bad shapes get
400, bodies over 2 MiB get 413) and any client-supplied `id` is ignored. A run's diff is only
shown when the poster includes a `diff` field; the App does not send one today, so the detail
page links to the GitHub compare and PR files views instead.

## Compiled build (no tsx at runtime)

`npm run dev:*`, `npm test`, `npm run demo` and `npm run typecheck` run the TypeScript sources
directly. To run compiled JavaScript instead:

```bash
npm run build                 # tsc -b: packages/*/dist and apps/*/dist (gitignored)
set -a; source .env; set +a
npm run start:history &       # node --conditions=runstage-dist apps/history/dist/main.js
npm run start:app             # node --conditions=runstage-dist apps/github-app/dist/main.js
npm run gate:dist -- poll --server http://localhost:3000 --repo <path>   # compiled runner
```

Each workspace package exports `dist/index.js` under the `runstage-dist` condition and its
TypeScript source otherwise, so dev tools never pick up a stale `dist/`. The start scripts and
the runner bin (`packages/runner/bin/runstage-gate.js`) pass `--conditions=runstage-dist`
for you. `npm run clean` removes the build output. CI runs `npm run build` on every push.

## Troubleshooting

- **401 bad signature**: the webhook secret in `.env` does not match the App settings.
- **No check appears**: the App is not installed on the repo, or the Checks permission was
  added after install (accept the updated permissions on the installation page).
- **Check stuck on "Waiting for a runner"**: no runner is polling, the runner's token isn't
  in the runners file (`npm run -s runner-token -- list`), or the runner's `--repo` scope
  doesn't include this repo. Restarting the App doesn't stop `gate poll`: it logs
  `server unreachable ... retrying in Ns` and resumes when the App is back. A job claimed by a runner that died is re-queued when its lease
  expires. Click **Re-run** on the check (or **Re-run all checks**) to queue a fresh run;
  for single-check re-runs the App must be subscribed to **Check run** events.
- **Check says `.runstage/gate.yml not found on the base commit`**: the PR's base branch has
  no gate config. The App's jobs only use the base commit's config, so merge
  `.runstage/gate.yml` into the base branch first. (Local `npm run gate -- run` falls back to
  your working tree with a warning.)
- **`401 bad runner token`**: the token was rotated or revoked, or it's an old shared token
  that was never minted into the runners file.
- **App exits with `no runners registered`**: create the runners file with
  `npm run -s runner-token -- mint --id <runner-id>`.
- **`... symlinks that resolve outside .runstage/`**: a link under the base commit's
  `.runstage/` points outside it (e.g. into `src/`), where the PR could change the target.
  Replace it with a real file. The job fails as a runner error.
- **`.runstage/... is not on the base commit`**: the check's script only exists in the PR.
  Scripts are loaded from the base, so merge the script (or the gate change) first.
- **`commit ... not found`**: the runner's checkout cannot fetch the PR head (e.g. a fork).
  Fetch it manually: `git fetch origin pull/<n>/head`.
