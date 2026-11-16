import { describe, expect, it } from "vitest";
import { entitlements, entitlementsFor, isUnknownPlan, parsePlan } from "../src/entitlements.ts";

describe("entitlements", () => {
  it("defaults to the free plan with one fleet repo", () => {
    expect(entitlements({})).toEqual({ plan: "free", maxFleetRepos: 1 });
    expect(entitlements({ RUNSTAGE_PLAN: "" })).toEqual({ plan: "free", maxFleetRepos: 1 });
    expect(entitlements({ RUNSTAGE_PLAN: "free" })).toEqual({ plan: "free", maxFleetRepos: 1 });
  });

  it("unlocks every repo on plus (case and whitespace insensitive)", () => {
    expect(entitlements({ RUNSTAGE_PLAN: "plus" })).toEqual({ plan: "plus", maxFleetRepos: null });
    expect(entitlements({ RUNSTAGE_PLAN: " PLUS " }).plan).toBe("plus");
  });

  it("fails closed: unknown values are the free plan", () => {
    for (const v of ["pro", "enterprise", "plus1", "1", "true"]) expect(parsePlan(v)).toBe("free");
    expect(isUnknownPlan("pro")).toBe(true);
    expect(isUnknownPlan("Plus")).toBe(false);
    expect(isUnknownPlan(undefined)).toBe(false);
    expect(isUnknownPlan("  ")).toBe(false);
  });

  it("entitlementsFor maps plans to limits", () => {
    expect(entitlementsFor("free").maxFleetRepos).toBe(1);
    expect(entitlementsFor("plus").maxFleetRepos).toBeNull();
  });
});
