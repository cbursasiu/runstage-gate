#!/usr/bin/env -S node --conditions=runstage-dist
// Runs the compiled runner (dist/). Build it first with `npm run build` from the repo root.
// The `runstage-dist` export condition makes @runstage-gate/* packages resolve to their dist/
// output; without it they resolve to TypeScript sources (dev, tests, tsx).
import { existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  console.error("runstage-gate: compiled runner not found. Run `npm run build` in the repo root first.");
  process.exit(2);
}
if (!process.execArgv.some((a) => a === "--conditions=runstage-dist" || a === "-C=runstage-dist")) {
  // Started as `node bin/runstage-gate.js` without the condition: re-exec with it.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["--conditions=runstage-dist", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const { main } = await import(cli.href);
process.exitCode = await main(process.argv.slice(2));
