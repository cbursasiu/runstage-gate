import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { GateConclusion, RunRecord } from "@runstage-gate/core";

export type NewRun = Omit<RunRecord, "id">;

/** Soft cap so an accidental huge diff can't blow up the JSON store. */
export const MAX_DIFF_CHARS = 64 * 1024;

export type RunListFilter = {
  repo?: string;
  pr?: number;
  verdict?: GateConclusion;
};

function boundDiff(diff: string | undefined): string | undefined {
  if (typeof diff !== "string" || diff.length === 0) return undefined;
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n…(truncated)`;
}

/** In-memory run store, optionally persisted to a JSON file. Stand-in for a real database. */
export class RunStore {
  private runs: RunRecord[] = [];

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) this.runs = JSON.parse(readFileSync(file, "utf8")) as RunRecord[];
  }

  add(run: NewRun): RunRecord {
    const rec: RunRecord = { ...run, id: randomUUID(), diff: boundDiff(run.diff) };
    if (rec.diff === undefined) delete rec.diff;
    this.runs.push(rec);
    this.flush();
    return rec;
  }

  list(filter: RunListFilter = {}): RunRecord[] {
    return this.runs
      .filter((r) => (filter.repo ? r.repoFullName === filter.repo : true))
      .filter((r) => (filter.pr !== undefined ? r.prNumber === filter.pr : true))
      .filter((r) => (filter.verdict ? r.conclusion === filter.verdict : true))
      .slice()
      .reverse();
  }

  get(id: string): RunRecord | undefined {
    return this.runs.find((r) => r.id === id);
  }

  private flush() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.runs, null, 2));
  }
}
