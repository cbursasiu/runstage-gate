import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GateConfigError, parseGateConfig } from "../src/index.ts";

describe("parseGateConfig", () => {
  it("parses the example gate.yml with defaults applied", () => {
    const cfg = parseGateConfig(readFileSync(new URL("../../../examples/gate.yml", import.meta.url), "utf8"));
    expect(cfg.version).toBe(1);
    expect(cfg.agents.enabled).toBe(false);
    expect(cfg.checks.map((c) => c.name)).toEqual(["no-todo-in-diff", "unit-tests", "ai-review"]);
    const [todo, , agent] = cfg.checks;
    expect(todo).toMatchObject({ type: "script", required: true, timeout_seconds: 30 });
    expect(agent).toMatchObject({ type: "agent", agent: "claude-code", required: false, timeout_seconds: 300 });
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
