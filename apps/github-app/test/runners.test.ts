import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerRegistry, hashToken, mintRunnerToken, revokeRunner } from "../src/index.ts";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "rsg-runners-")), "runners.json");

describe("runner tokens", () => {
  it("mints a token, stores only its SHA-256, and authenticates it", () => {
    const file = tmpFile();
    const token = mintRunnerToken(file, "cristian-mbp", ["acme/demo-app"]);
    expect(token).toMatch(/^rsg_[A-Za-z0-9_-]{43}$/);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(token);
    expect(text).toContain(hashToken(token));
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const reg = RunnerRegistry.fromFile(file);
    expect(reg.authenticate(token)).toEqual({ id: "cristian-mbp", repos: ["acme/demo-app"] });
    expect(reg.authenticate("rsg_wrong")).toBeUndefined();
    expect(reg.authenticate("")).toBeUndefined();
    expect(reg.authenticate(undefined)).toBeUndefined();
  });

  it("picks up rotation and revocation without a restart", () => {
    const file = tmpFile();
    const old = mintRunnerToken(file, "r1");
    const reg = RunnerRegistry.fromFile(file);
    expect(reg.authenticate(old)?.id).toBe("r1");
    const fresh = mintRunnerToken(file, "r1");
    expect(reg.authenticate(old)).toBeUndefined();
    expect(reg.authenticate(fresh)).toEqual({ id: "r1", repos: null });
    expect(revokeRunner(file, "r1")).toBe(true);
    expect(reg.authenticate(fresh)).toBeUndefined();
  });

  it("rejects bad runner ids and repos", () => {
    const file = tmpFile();
    expect(() => mintRunnerToken(file, "bad id")).toThrow(/bad runner id/);
    expect(() => mintRunnerToken(file, "ok", ["not-a-repo"])).toThrow(/bad repo/);
  });
});
