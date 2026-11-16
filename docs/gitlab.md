# GitLab (commit statuses)

The App can gate GitLab merge requests as well as GitHub pull requests. On GitLab the verdict
is an **external commit status** named `RunStage Gate` on the MR's head commit
(`POST /projects/:id/statuses/:sha`). It shows as `running` while queued or running, then
`success` or `failed` with the gate title as the description. The same runners, queue, history,
`gate.yml` rules (config and scripts from the base) and AI detection apply.

This works on every GitLab tier. Approvals (the button and `/runstage approve`) are GitHub-only
for now.

## Setup

1. Create a **project access token** (or group token) with the `api` scope and at least the
   **Developer** role.
2. In the project, go to **Settings → Webhooks** and add a webhook:
   - URL: `https://<your smee or tunnel>/webhooks/gitlab` (the App's `POST /webhooks/gitlab`)
   - Secret token: a random string (`openssl rand -hex 32`)
   - Trigger: **Merge request events** only
3. Configure the App:

```bash
RUNSTAGE_GITLAB_URL=https://gitlab.com          # or your self-managed URL
RUNSTAGE_GITLAB_TOKEN=<project access token>
RUNSTAGE_GITLAB_WEBHOOK_SECRET=<webhook secret token>
RUNSTAGE_GITLAB_TARGET_URL=http://localhost:3100/   # optional link on the status
```

GitLab is off unless both the token and the secret are set. Setting only one of them stops the
App at startup. When GitLab is off, `POST /webhooks/gitlab` returns 404.

4. Point a runner at a local clone of the project. The job's repo name is the project path,
   e.g. `group/project`, and the runner maps it to the checkout like GitHub repos.
   Its `origin` must be the GitLab project so `git fetch origin <sha>` works.

## What triggers a run

| MR hook action | Runs the gate? |
| --- | --- |
| `open`, `reopen` | yes |
| `update` with new commits (`oldrev` present) | yes |
| `update` without new commits (title, labels, …) | no |
| `close`, `merge`, `approved`, … | no |
| MR from a fork (source project ≠ target project) | no (not supported yet) |

The webhook is authenticated by comparing `X-Gitlab-Token` in constant time. Redeliveries are
recognised by `X-Gitlab-Event-UUID`. The base sha is the target branch's head, looked up with
`GET /projects/:id/repository/branches/:branch`. Like GitHub, the runner diffs
`merge-base(base, head)..head`.

To make it block merges, enable **Settings → Merge requests → Pipelines must succeed**.
GitLab groups external commit statuses into the commit's pipeline, so a `failed` RunStage Gate
status fails it. Check this on your instance before you rely on it. This integration has only
been tested against mocks, never a live GitLab.
