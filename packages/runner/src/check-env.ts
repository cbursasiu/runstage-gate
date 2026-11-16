/**
 * The environment a check runs with. Checks run untrusted PR code, so they get an allowlist,
 * never the runner's own environment: no RUNSTAGE_RUNNER_TOKEN, GITHUB_*, cloud keys, SSH agent
 * sockets or anything else the runner process happens to hold.
 *
 * Passed through from the runner: PATH, LANG, LC_*, TERM, TZ, USER, LOGNAME, SHELL, plus any names
 * the runner owner lists in RUNSTAGE_CHECK_ENV_PASSTHROUGH (comma-separated; names that look like
 * secrets or RUNSTAGE_/GITHUB_ prefixes are refused). HOME and TMPDIR point into the job's temp dir.
 * The gate's own RUNSTAGE_BASE/HEAD/REPO/DIFF_FILE/CHECK/AI_* variables are then added.
 */
const ALWAYS = ["PATH", "LANG", "TERM", "TZ", "USER", "LOGNAME", "SHELL"];
const SECRETISH = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|SESSION|COOKIE)/i;
const FORBIDDEN_PREFIX = /^(RUNSTAGE_|GITHUB_|GH_|GITLAB_|GL_|ACTIONS_|RUNNER_|AWS_|AZURE_|GOOGLE_|GCP_|NPM_CONFIG_|SSH_)/i;

export function passthroughNames(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.RUNSTAGE_CHECK_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of extra) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || SECRETISH.test(name) || FORBIDDEN_PREFIX.test(name)) {
      throw new Error(`RUNSTAGE_CHECK_ENV_PASSTHROUGH: refusing to pass "${name}" to checks (looks like a secret or runner/CI variable)`);
    }
  }
  return [...ALWAYS, ...extra];
}

export function scrubbedCheckEnv(
  source: NodeJS.ProcessEnv,
  o: { home: string; tmp: string; gate: Record<string, string> },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthroughNames(source)) if (source[name] !== undefined) env[name] = source[name];
  for (const [k, v] of Object.entries(source)) if (/^LC_[A-Z]+$/.test(k) && v !== undefined) env[k] = v;
  env.PATH ??= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  env.LANG ??= "en_US.UTF-8";
  env.HOME = o.home;
  env.TMPDIR = o.tmp;
  env.CI = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return { ...env, ...o.gate };
}
