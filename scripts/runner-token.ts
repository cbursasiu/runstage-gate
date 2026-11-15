/**
 * Manage per-runner tokens for the RunStage Gate App.
 *
 *   npm run -s runner-token -- mint   --id <runner-id> [--repo owner/name ...] [--file <runners.json>]
 *   npm run -s runner-token -- revoke --id <runner-id> [--file <runners.json>]
 *   npm run -s runner-token -- list   [--file <runners.json>]
 *
 * `mint` creates or rotates the runner's token and prints it ONCE on stdout. Only its SHA-256
 * hash is written to the file (default $RUNSTAGE_RUNNERS_FILE or .runstage-gate-data/runners.json).
 * The App re-reads the file when it changes, so no restart is needed.
 */
import { parseArgs } from "node:util";
import { mintRunnerToken, readRunnersFile, revokeRunner } from "../apps/github-app/src/runners.ts";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { id: { type: "string" }, repo: { type: "string", multiple: true }, file: { type: "string" } },
});
const file = values.file ?? process.env.RUNSTAGE_RUNNERS_FILE ?? ".runstage-gate-data/runners.json";
const cmd = positionals[0];

try {
  if (cmd === "mint" && values.id) {
    const token = mintRunnerToken(file, values.id, values.repo ?? []);
    process.stderr.write(`Minted token for runner "${values.id}" in ${file}. It is shown once; store it on the runner as RUNSTAGE_RUNNER_TOKEN.\n`);
    process.stdout.write(`${token}\n`);
  } else if (cmd === "revoke" && values.id) {
    if (!revokeRunner(file, values.id)) throw new Error(`no runner "${values.id}" in ${file}`);
    process.stderr.write(`Revoked runner "${values.id}".\n`);
  } else if (cmd === "list") {
    for (const r of readRunnersFile(file).runners) {
      process.stdout.write(`${r.id}\t${r.repos?.join(",") || "(all repos)"}\t${r.createdAt ?? ""}\n`);
    }
  } else {
    process.stderr.write("usage: runner-token mint --id <id> [--repo owner/name ...] | revoke --id <id> | list   [--file <path>]\n");
    process.exitCode = 2;
  }
} catch (err) {
  process.stderr.write(`runner-token: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
