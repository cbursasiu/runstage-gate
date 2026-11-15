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
- **Subscribe to events**: **Check suite**, **Pull request**
- **Where can this App be installed**: Only on this account

After creating it:

1. Note the **App ID**.
2. **Generate a private key**. Save the `.pem` file outside the repo
   (e.g. `~/.config/runstage-gate/dev-app.pem`). `*.pem` is gitignored anyway.
3. **Install App** on the test repository.

## 3. Configure and start the App server

```bash
cp .env.example .env
# fill in GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET,
# and a RUNSTAGE_RUNNER_TOKEN (openssl rand -hex 32)

set -a; source .env; set +a
npm run dev:history &       # optional: hosted history stub on :3100
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

The runner reads `gate.yml` from the PR's **base** commit, so this must be on the default
branch before you open a test PR.

## 5. Run the runner

On the machine that has a checkout of the test repo (macOS or Linux):

```bash
export RUNSTAGE_RUNNER_TOKEN=<same token as the App>
npm run gate -- poll --server http://localhost:3000 --repo /path/to/test-repo
# or: packages/runner/bin/runstage-gate.js poll --server http://localhost:3000 --repo /path/to/test-repo
```

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

## Troubleshooting

- **401 bad signature**: the webhook secret in `.env` does not match the App settings.
- **No check appears**: the App is not installed on the repo, or the Checks permission was
  added after install (accept the updated permissions on the installation page).
- **Check stuck on "Waiting for a runner"**: no runner is polling, or the token differs. The
  in-memory queue is lost if the App restarts; push again or use **Re-run all checks**
  (single-check `check_run.rerequested` is not handled yet).
- **`commit ... not found`**: the runner's checkout cannot fetch the PR head (e.g. a fork).
  Fetch it manually: `git fetch origin pull/<n>/head`.
