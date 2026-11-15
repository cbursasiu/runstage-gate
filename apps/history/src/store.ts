import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { RunRecord } from "@runstage-gate/core";

export type NewRun = Omit<RunRecord, "id">;

/** In-memory run store, optionally persisted to a JSON file. Stand-in for a real database. */
export class RunStore {
  private runs: RunRecord[] = [];

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) this.runs = JSON.parse(readFileSync(file, "utf8")) as RunRecord[];
  }

  add(run: NewRun): RunRecord {
    const rec: RunRecord = { id: randomUUID(), ...run };
    this.runs.push(rec);
    this.flush();
    return rec;
  }

  list(filter: { repo?: string; pr?: number } = {}): RunRecord[] {
    return this.runs
      .filter((r) => (filter.repo ? r.repoFullName === filter.repo : true))
      .filter((r) => (filter.pr !== undefined ? r.prNumber === filter.pr : true))
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
