import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTempRepo } from "./helpers.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const BIN = join(ROOT, "packages/runner/bin/runstage-gate.js");
const MARKER = ["TO", "DO"].join(""); // built at runtime so this file passes the repo's own gate

describe("compiled build (npm run build)", () => {
  beforeAll(() => {
    execFileSync(join(ROOT, "node_modules/.bin/tsc"), ["-b", "tsconfig.build.json"], { cwd: ROOT, stdio: "pipe" });
  }, 60_000);

  it("emits dist/ for every workspace package", () => {
    for (const pkg of ["packages/core", "packages/runner", "apps/github-app", "apps/history"]) {
      expect(existsSync(join(ROOT, pkg, "dist/index.js")), pkg).toBe(true);
      expect(existsSync(join(ROOT, pkg, "dist/index.d.ts")), pkg).toBe(true);
    }
    expect(existsSync(join(ROOT, "apps/github-app/dist/main.js"))).toBe(true);
    expect(existsSync(join(ROOT, "apps/history/dist/main.js"))).toBe(true);
  });

  it("resolves @runstage-gate/* to dist/ under the runstage-dist condition and to src/ without it", () => {
    const script = `
      const names = ["core", "runner", "github-app", "history"];
      const out = {};
      for (const n of names) out[n] = import.meta.resolve("@runstage-gate/" + n);
      const h = await import("@runstage-gate/history");
      const c = await import("@runstage-gate/core");
      out.ok = typeof h.createHistoryServer === "function" && typeof c.parseGateConfig === "function";
      console.log(JSON.stringify(out));`;
    const run = (args: string[]) =>
      JSON.parse(execFileSync(process.execPath, [...args, "--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" })) as Record<string, string | boolean>;
    const dist = run(["--conditions=runstage-dist"]);
    expect(dist.ok).toBe(true);
    for (const n of ["core", "runner", "github-app", "history"]) expect(String(dist[n])).toMatch(/\/dist\/index\.js$/);
    const src = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", `console.log(JSON.stringify(import.meta.resolve("@runstage-gate/core")))`], { cwd: ROOT, encoding: "utf8" }),
    ) as string;
    expect(src).toMatch(/\/src\/index\.ts$/);
  });

  it("runs the gate end to end through the compiled runner bin", () => {
    const repo = makeTempRepo();
    const clean = repo.commit({ "app.js": "export const x = 2;\n" }, "clean");
    const pass = spawnSync(process.execPath, [BIN, "run", "--repo", repo.dir, "--base", repo.base, "--head", clean, "--json"], { encoding: "utf8" });
    expect(pass.status, pass.stderr).toBe(0);
    expect(JSON.parse(pass.stdout)).toMatchObject({ conclusion: "success" });

    const dirty = repo.commit({ "app.js": `export const x = 3; // ${MARKER} later\n` }, "marker");
    const fail = spawnSync(process.execPath, [BIN, "run", "--repo", repo.dir, "--base", clean, "--head", dirty, "--json"], { encoding: "utf8" });
    expect(fail.status).toBe(1);
    expect(JSON.parse(fail.stdout)).toMatchObject({ conclusion: "failure" });
  });
});
