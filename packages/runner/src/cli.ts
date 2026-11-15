import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runGate } from "./execute.ts";
import { poll } from "./poll.ts";

const HELP = `runstage-gate - run your RunStage Gate checks on this machine

Usage:
  runstage-gate run  --repo <path> --base <sha> --head <sha> [--config <file>] [--allow-agents] [--json]
  runstage-gate poll --server <url> --repo <path> [--token <t>] [--allow-agents] [--once] [--interval <sec>]

run   Local dry run: evaluates the gate for base..head and prints the verdict.
      Exit code 0 = pass, 1 = blocked, 2 = usage/config error.
poll  Fetches jobs from the RunStage Gate server, runs them and posts results.
      The token (this runner's own, from \`npm run -s runner-token -- mint\`)
      defaults to $RUNSTAGE_RUNNER_TOKEN.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: {
        repo: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        config: { type: "string" },
        server: { type: "string" },
        token: { type: "string" },
        interval: { type: "string" },
        "allow-agents": { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      strict: true,
    });

    if (cmd === "run") {
      if (!values.repo || !values.base || !values.head) throw new UsageError("run needs --repo, --base and --head");
      const result = await runGate({
        repo: resolve(values.repo),
        base: values.base,
        head: values.head,
        configPath: values.config ? resolve(values.config) : undefined,
        allowAgents: values["allow-agents"],
        log: values.json ? undefined : (l) => console.log(l),
      });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`\n${result.conclusion === "success" ? "PASS" : "BLOCKED"}: ${result.title}`);
      return result.conclusion === "success" ? 0 : 1;
    }

    if (cmd === "poll") {
      const token = values.token ?? process.env.RUNSTAGE_RUNNER_TOKEN;
      if (!values.server || !values.repo) throw new UsageError("poll needs --server and --repo");
      if (!token) throw new UsageError("poll needs --token or RUNSTAGE_RUNNER_TOKEN");
      const n = await poll({
        server: values.server,
        token,
        repos: resolve(values.repo),
        allowAgents: values["allow-agents"],
        once: values.once,
        intervalMs: values.interval ? Number(values.interval) * 1000 : undefined,
      });
      if (values.once) console.log(n ? "processed 1 job" : "no jobs queued");
      return 0;
    }
    throw new UsageError(`unknown command "${cmd}"`);
  } catch (err) {
    console.error(`runstage-gate: ${(err as Error).message}`);
    if (err instanceof UsageError) console.error(`\n${HELP}`);
    return 2;
  }
}

class UsageError extends Error {}

// Allow `tsx packages/runner/src/cli.ts ...`
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
