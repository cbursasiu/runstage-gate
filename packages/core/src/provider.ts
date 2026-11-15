import type { ChangeRef, GateResult } from "./types.ts";

/**
 * The only surface the gate needs from a code host.
 * GitHub implements it with Check Runs; GitLab can implement it later with
 * external commit statuses (POST /projects/:id/statuses/:sha) or Ultimate
 * external status checks.
 */
export interface CheckProvider {
  readonly name: ChangeRef["provider"];
  /** Create an in-progress check for the change. Returns the provider's check id. */
  startCheck(change: ChangeRef): Promise<string>;
  /** Mark the check complete with pass/fail and a reason. */
  completeCheck(change: ChangeRef, externalCheckId: string, result: GateResult): Promise<void>;
}

export const CHECK_NAME = "RunStage Gate";
