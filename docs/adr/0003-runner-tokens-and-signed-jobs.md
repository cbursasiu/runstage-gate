# ADR 0003: Per-runner tokens and signed jobs

- Status: accepted
- Date: 2026-11-15

## Context

The first slice authenticated runners with a single shared bearer token and held jobs in
memory. A restart of the App dropped queued work, and any holder of the shared token could
claim jobs. Runners also pull job payloads (repository, SHAs, what to check out) over
local HTTP, so a tampered or replayed job is a real risk once the App is reachable.

## Decision

- Each runner has its own token. The App stores only SHA-256 hashes (for example in
  `runners.json`), compared in constant time. A token can be scoped to repositories.
  This shipped in [pull request #2](https://github.com/cbursasiu/runstage-gate/pull/2)
  (`a84cfbc`, 15 November 2026) together with a durable file-backed job queue, claim
  leases and heartbeats.
- Jobs the App issues to a runner are signed. The accepted design, implemented on
  `feat/security-hardening` (tip `b8c7b81`, not yet merged), is an HMAC-SHA256 signature
  over the job body with a timestamp (five-minute window) and a one-time nonce. The
  signing key is derived from the runner token, so there is no second secret to distribute.
  Unsigned, mis-signed, stale or replayed jobs are refused.
- Related hardening on the same branch (scrubbed check environments, macOS sandboxing,
  and redaction of secrets in logs and check output) follows from the same decision to
  treat pull-request code as untrusted on the runner host. Those pieces travel with the
  branch and are also not on `main` yet.

## Consequences

- Operators must mint a token per runner and set `RUNSTAGE_RUNNER_TOKEN` on that runner.
  Rotating the token also rotates the job-signing key, once signing is merged.
- The hash file on the App host is equivalent to a signing-key store and must stay out
  of git (it already lives in a gitignored data directory).
- Until `feat/security-hardening` is merged, `main` has per-runner tokens and the durable
  queue, but not job signatures, the sandbox, or log redaction.
