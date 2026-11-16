import { readFileSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import { GateConfigError, parseGateConfig } from "../src/index.ts";

const repoRoot = new URL("../../../", import.meta.url);
const readRepo = (rel: string) => readFileSync(new URL(rel, repoRoot), "utf8");

const schema = JSON.parse(readRepo("schema/gate.schema.json")) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function expectSchemaValid(raw: unknown) {
  const ok = validateSchema(raw);
  expect(validateSchema.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

function expectSchemaInvalid(raw: unknown) {
  expect(validateSchema(raw)).toBe(false);
}

describe("parseGateConfig", () => {
  it("parses the example gate.yml with defaults applied", () => {
    const cfg = parseGateConfig(readRepo("examples/gate.yml"));
    expect(cfg.version).toBe(1);
    expect(cfg.agents.enabled).toBe(false);
    expect(cfg.checks.map((c) => c.name)).toEqual(["secret-scan", "lint", "tests", "ai-review"]);
    const [scan, , , agent] = cfg.checks;
    expect(scan).toMatchObject({ type: "script", required: true, timeout_seconds: 60 });
    expect(agent).toMatchObject({ type: "agent", agent: "claude-code", required: false, timeout_seconds: 300 });
  });

  it("parses this repository's gate.yml", () => {
    const cfg = parseGateConfig(readRepo(".runstage/gate.yml"));
    expect(cfg.checks.map((c) => c.name)).toEqual(["secret-scan", "lint", "tests"]);
    expect(cfg.checks.every((c) => c.type === "script" && c.required)).toBe(true);
  });

  it("accepts $schema and strips it from the parsed config", () => {
    const cfg = parseGateConfig(
      "$schema: https://example.com/gate.schema.json\nversion: 1\nchecks:\n  - name: lint\n    type: script\n    run: npm run lint\n",
    );
    expect(cfg).not.toHaveProperty("$schema");
    expect(cfg.checks[0]).toMatchObject({ name: "lint", type: "script" });
  });

  it("defaults agents.enabled to false and required to true for scripts", () => {
    const cfg = parseGateConfig("version: 1\nchecks:\n  - name: lint\n    type: script\n    run: npm run lint\n");
    expect(cfg.agents.enabled).toBe(false);
    expect(cfg.checks[0]).toMatchObject({ required: true, timeout_seconds: 300 });
  });

  it("rejects invalid YAML", () => {
    expect(() => parseGateConfig("version: [1")).toThrow(GateConfigError);
  });

  it("rejects unknown versions, empty checks and unknown keys", () => {
    expect(() => parseGateConfig("version: 2\nchecks: []")).toThrow(/version/);
    expect(() => parseGateConfig("version: 1\nchecks: []")).toThrow(/at least one check/);
    expect(() =>
      parseGateConfig("version: 1\nchecks:\n  - name: a\n    type: script\n    run: x\n    shell: zsh\n"),
    ).toThrow(GateConfigError);
  });

  it("rejects duplicate names and custom agents without a command", () => {
    expect(() =>
      parseGateConfig(
        "version: 1\nchecks:\n  - {name: a, type: script, run: x}\n  - {name: a, type: script, run: y}\n",
      ),
    ).toThrow(/duplicate check name/);
    expect(() =>
      parseGateConfig("version: 1\nchecks:\n  - {name: a, type: agent, agent: custom, prompt: hi}\n"),
    ).toThrow(/custom needs a command/);
  });
});

describe("published JSON Schema", () => {
  for (const rel of [".runstage/gate.yml", "examples/gate.yml"] as const) {
    it(`${rel} validates against the parser and the schema`, () => {
      const text = readRepo(rel);
      expect(() => parseGateConfig(text)).not.toThrow();
      expectSchemaValid(parseYaml(text));
    });
  }

  it("rejects the same structural mistakes as the parser", () => {
    const cases: unknown[] = [
      { version: 2, checks: [{ name: "a", type: "script", run: "x" }] },
      { version: 1, checks: [] },
      { version: 1, checks: [{ name: "a", type: "script", run: "x", shell: "zsh" }] },
      { version: 1, checks: [{ name: "a", type: "agent", agent: "custom", prompt: "hi" }] },
      { version: 1, checks: [{ name: "has space", type: "script", run: "x" }] },
      { version: 1, checks: [{ name: "a", type: "script", run: "x", timeout_seconds: 0 }] },
      { version: 1, extra: true, checks: [{ name: "a", type: "script", run: "x" }] },
    ];
    for (const raw of cases) {
      expect(() => parseGateConfig(yamlFrom(raw))).toThrow(GateConfigError);
      expectSchemaInvalid(raw);
    }
  });

  it("leaves duplicate names and unknown require_checks to the parser", () => {
    const dup = {
      version: 1,
      checks: [
        { name: "a", type: "script", run: "x" },
        { name: "a", type: "script", run: "y" },
      ],
    };
    const unknown = {
      version: 1,
      checks: [{ name: "a", type: "script", run: "x" }],
      ai_detection: { enabled: true, policy: { require_checks: ["missing"] } },
    };
    expectSchemaValid(dup);
    expectSchemaValid(unknown);
    expect(() => parseGateConfig(yamlFrom(dup))).toThrow(/duplicate check name/);
    expect(() => parseGateConfig(yamlFrom(unknown))).toThrow(/unknown check/);
  });
});

describe("secret-scan check script", () => {
  it("always passes --redact so values are not printed", () => {
    const repoScript = readRepo(".runstage/checks/secret-scan.sh");
    const exampleScript = readRepo("examples/checks/secret-scan.sh");
    expect(repoScript).toEqual(exampleScript);
    expect(repoScript).toMatch(/--redact=100/);
    expect(repoScript).not.toMatch(/cat\s+["']?\$\{?RUNSTAGE_DIFF_FILE/);
  });

  it("redacts planted secrets in gitleaks output when gitleaks is installed", async () => {
    try {
      execFileSync("which", ["gitleaks"], { stdio: "ignore" });
    } catch {
      return; // runner machines install gitleaks; unit tests should still pass without it
    }

    const dir = mkdtempSync(join(tmpdir(), "rsg-leaks-"));
    const git = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      git(["config", "commit.gpgsign", "false"]);
      writeFileSync(join(dir, "ok.txt"), "hello\n");
      git(["add", "ok.txt"]);
      git(["commit", "-q", "-m", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      // Construct a high-entropy token at runtime so the pattern is never committed
      // as a single literal in this repo. Parts are joined only in the temp tree.
      const planted = ["sk", "live", "1234567890abcdefghijklmnop"].join("_");
      writeFileSync(join(dir, "leak.txt"), `token=${planted}\n`);
      git(["add", "leak.txt"]);
      git(["commit", "-q", "-m", "add token"]);
      const head = git(["rev-parse", "HEAD"]);

      const script = new URL("../../../.runstage/checks/secret-scan.sh", import.meta.url).pathname;
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync("bash", [script, base, head], {
        cwd: dir,
        env: { ...process.env, RUNSTAGE_BASE: base, RUNSTAGE_HEAD: head, RUNSTAGE_REPO: dir },
      }).then(
        (r) => ({ status: 0, stdout: r.stdout, stderr: r.stderr }),
        (err: { status?: number; stdout?: string; stderr?: string }) => ({
          status: err.status ?? 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        }),
      );

      const output = `${result.stdout}\n${result.stderr}`;
      if (output.includes(planted)) {
        throw new Error("secret-scan printed a secret value");
      }
      expect(result.status).toBe(1);
      expect(output).toMatch(/redact/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function yamlFrom(raw: unknown): string {
  // Compact YAML for fixtures: JSON is valid YAML.
  return JSON.stringify(raw);
}
