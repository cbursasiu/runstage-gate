# Gate config

RunStage Gate reads `.runstage/gate.yml` from the pull request's **base** commit and runs
the checks listed there against a clean worktree of the **head** commit. The whole
`.runstage/` directory in that worktree is replaced with the base commit's copy, so a PR
cannot weaken or rewrite the scripts that judge it.

The YAML is parsed and validated by [`packages/core/src/config.ts`](../packages/core/src/config.ts)
(zod). The same rules are published as a JSON Schema at
[`schema/gate.schema.json`](../schema/gate.schema.json). Point an editor at the schema with
either a `yaml-language-server` comment or a `$schema` key (the parser accepts `$schema`
and then strips it):

```yaml
# yaml-language-server: $schema=../schema/gate.schema.json
# or:  $schema: ../schema/gate.schema.json
version: 1
checks:
  - name: tests
    type: script
    run: bash .runstage/checks/with-npm.sh test
```

Tests in `packages/core/test/config.test.ts` load this repository's `.runstage/gate.yml`
and `examples/gate.yml` and check them against both the parser and the schema.

## Checks this repository runs

Four candidates were considered: **tests**, **lint**, **secret scan**, and a
**diff-size / untested-changes** policy. The gate keeps three:

| Check | Command | Timeout | Why it is in the gate |
|---|---|---|---|
| `secret-scan` | `bash .runstage/checks/secret-scan.sh` | 60s | This repo handles App private keys, webhook secrets and runner tokens. gitleaks scans the PR's commits (`base..head`). `--redact=100` is required so secret values never appear in logs or check output. It does not need `node_modules`, so it runs first. |
| `lint` | `bash .runstage/checks/with-npm.sh run lint` | 600s | ESLint with a modest typescript-eslint recommended config catches issues the test suite does not. |
| `tests` | `bash .runstage/checks/with-npm.sh test` | 600s | The strongest merge signal: the full Vitest suite must pass on the PR head. |

`with-npm.sh` runs `npm ci` in a clean head worktree when `node_modules` is missing, then
the requested npm command. Checks share the worktree and run in order, so lint and tests
do not each pay for a full install. Timeouts are 600s because `npm ci` plus the check can
need around 300s on a cold cache, and 300s is tight.

### Why untested-changes and diff-size are not enabled here

- **Untested-changes** (fail when source files change but no test file does) is a useful
  heuristic, but it false-positives on refactors, type-only edits and lint fixes, and
  false-negatives when someone adds an empty test file. The `tests` check already proves
  the suite runs; that is the signal this repo relies on.
- **Diff-size** is a process limit, not a quality or security check, and PR sizes here vary.

A portable implementation of the untested-changes heuristic is in
[`examples/checks/untested-changes.sh`](../examples/checks/untested-changes.sh). To opt in,
copy it into `.runstage/checks/` and add a check (see the commented example in
[`examples/gate.yml`](../examples/gate.yml)).

The previous example check, `no-todo-in-diff`, remains under `examples/checks/` for the
demo and runner tests. It is no longer part of this repository's gate.

## Field reference

Top-level keys (the object is strict: unknown keys are rejected):

| Field | Required | Default | Notes |
|---|---|---|---|
| `version` | yes | | Must be `1`. |
| `$schema` | no | | Editor hint. Stripped after parse. |
| `agents.enabled` | no | `false` | Agent checks are skipped unless this is true **and** the runner is started with `--allow-agents`. |
| `checks` | yes | | At least one check. Names must be unique. |
| `ai_detection` | no | off | See [ai-detection.md](ai-detection.md). |

Every check has `name` (letters, digits, `.`, `-` or `_`), `type` (`script` or `agent`),
`required` and `timeout_seconds` (integer, 1–3600, default 300).

**Script checks** need `run`, a command executed with `bash -c` from the worktree root.
They are required by default. Keep scripts that define the gate under `.runstage/` so they
come from the base commit. Commands outside `.runstage/` (for example `npm test`) run the
PR's own code by design.

**Agent checks** need `agent` (`claude-code`, `codex`, or `custom` with `command`) and a
`prompt`. The prompt plus the PR diff go to the agent on stdin; it must end with
`VERDICT: PASS` or `VERDICT: FAIL: <reason>`. Agent checks default to optional.

`ai_detection.policy.require_checks` must name checks that exist in `checks` (parser only;
the JSON Schema cannot express that cross-reference).

## How a check runs

The runner:

1. Reads `.runstage/gate.yml` from the base commit (jobs from the App never fall back to
   the working tree; a local `runstage-gate run` may, with a warning).
2. Creates a temporary worktree of the head commit and pins `.runstage/` to the base copy.
3. Sets `RUNSTAGE_BASE`, `RUNSTAGE_HEAD`, `RUNSTAGE_DIFF_FILE`, `RUNSTAGE_REPO`,
   `RUNSTAGE_CHECK`, and when AI detection is on, `RUNSTAGE_AI_GENERATED` and
   `RUNSTAGE_AI_SIGNALS`.
4. Runs each check in that worktree with a timeout. Exit 0 passes; the last output line
   becomes the reason shown on the check run.

Implications for authors:

- The worktree has no `node_modules`. Node checks must install dependencies (use
  `with-npm.sh`) and budget time for `npm ci`.
- `secret-scan.sh` requires `gitleaks` on the runner machine (Homebrew: `brew install gitleaks`).
  It scans `base..head` with `--redact=100` and must not print secret values. Do not `cat`
  the diff or log raw findings from your own scripts.
- Use `RUNSTAGE_DIFF_FILE` or `git diff "$RUNSTAGE_BASE" "$RUNSTAGE_HEAD"` rather than
  `git status`, because `.runstage/` in the worktree differs from the head commit.

## Examples

This repository's config is [`.runstage/gate.yml`](../.runstage/gate.yml). A copy-paste
starting point, including the optional `ai-review` agent check and a commented
`untested-changes` check, is [`examples/gate.yml`](../examples/gate.yml).

```yaml
version: 1
agents:
  enabled: false
checks:
  - name: secret-scan
    type: script
    run: bash .runstage/checks/secret-scan.sh
    timeout_seconds: 60
  - name: lint
    type: script
    run: bash .runstage/checks/with-npm.sh run lint
    timeout_seconds: 600
  - name: tests
    type: script
    run: bash .runstage/checks/with-npm.sh test
    timeout_seconds: 600
  - name: ai-review
    type: agent
    agent: claude-code
    prompt: Review this diff for security problems and leaked secrets.
    required: false
```
