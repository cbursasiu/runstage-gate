/**
 * Plan entitlements for the history service. No billing integration: the plan is a local
 * config flag, `RUNSTAGE_PLAN=free|plus` (default `free`).
 *
 * - free: the fleet dashboard shows exactly one repo.
 * - plus: the fleet dashboard shows every repo.
 *
 * Anything other than `plus` (unset, empty, a typo) resolves to `free`, so a misconfiguration
 * never unlocks more than the free plan.
 */
export type Plan = "free" | "plus";

export interface Entitlements {
  plan: Plan;
  /** Most repos the fleet dashboard may show. `null` means no limit. */
  maxFleetRepos: number | null;
}

export const FREE_FLEET_REPOS = 1;

export function parsePlan(value: string | undefined | null): Plan {
  return (value ?? "").trim().toLowerCase() === "plus" ? "plus" : "free";
}

export function entitlementsFor(plan: Plan): Entitlements {
  return plan === "plus" ? { plan, maxFleetRepos: null } : { plan, maxFleetRepos: FREE_FLEET_REPOS };
}

/** Reads the plan from the environment (`RUNSTAGE_PLAN`). */
export function entitlements(env: Record<string, string | undefined> = process.env): Entitlements {
  return entitlementsFor(parsePlan(env.RUNSTAGE_PLAN));
}

/** True when the raw env value was set but isn't a known plan (main.ts logs a warning). */
export function isUnknownPlan(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  const v = value.trim().toLowerCase();
  return v !== "free" && v !== "plus";
}
