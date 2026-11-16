import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { jobSigningKeyFromHash } from "@runstage-gate/core";
import { writeJsonAtomic } from "./fsutil.ts";

/** One registered runner. Only the SHA-256 of its token is stored. */
export interface RunnerEntry {
  id: string;
  tokenSha256: string;
  /** Optional allowlist of "owner/name" repos this runner may claim jobs for. */
  repos?: string[];
  createdAt?: string;
}

export interface RunnersFile {
  version: 1;
  runners: RunnerEntry[];
}

export interface RunnerIdentity {
  id: string;
  repos: string[] | null;
  /** Key for signing jobs handed to this runner (derived from its token hash; see core/signing.ts). */
  signingKey: Buffer;
}

const RUNNER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new random runner token: `rsg_` + 32 random bytes, base64url. */
export function generateToken(): string {
  return `rsg_${randomBytes(32).toString("base64url")}`;
}

/** Resolves a bearer token to a runner. Compares SHA-256 hashes in constant time. */
export class RunnerRegistry {
  constructor(private readonly load: () => RunnerEntry[]) {}

  static fromEntries(entries: RunnerEntry[]): RunnerRegistry {
    validateEntries(entries);
    return new RunnerRegistry(() => entries);
  }

  /** Reads the file, and re-reads it whenever it changes, so minting or revoking needs no restart. */
  static fromFile(file: string): RunnerRegistry {
    let cache: { mtimeMs: number; size: number; ino: number; entries: RunnerEntry[] } | undefined;
    const read = (): RunnerEntry[] => {
      const st = statSync(file);
      if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size || cache.ino !== st.ino) {
        cache = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, entries: readRunnersFile(file).runners };
      }
      return cache.entries;
    };
    read(); // fail fast at startup on a missing or broken file
    return new RunnerRegistry(read);
  }

  authenticate(bearer: string | undefined): RunnerIdentity | undefined {
    if (!bearer) return undefined;
    const got = Buffer.from(hashToken(bearer), "hex");
    let match: RunnerEntry | undefined;
    // Check every entry (no early exit) so timing doesn't reveal which entry matched.
    for (const e of this.load()) {
      const want = Buffer.from(e.tokenSha256, "hex");
      if (want.length === got.length && timingSafeEqual(want, got)) match = e;
    }
    return match
      ? { id: match.id, repos: match.repos?.length ? [...match.repos] : null, signingKey: jobSigningKeyFromHash(match.tokenSha256) }
      : undefined;
  }

  list(): RunnerEntry[] {
    return this.load();
  }
}

/**
 * The App's runner registry. The runners file is required: the old shared-token fallback
 * (RUNSTAGE_RUNNER_TOKEN on the App as runner "legacy-shared") was removed.
 */
export function loadRunnerRegistry(file: string): RunnerRegistry {
  if (!existsSync(file)) {
    throw new Error(
      `no runners registered: ${file} not found. Mint a per-runner token with ` +
        "`npm run -s runner-token -- mint --id <runner-id>` and set it as RUNSTAGE_RUNNER_TOKEN on that runner. " +
        "(The App no longer accepts a shared RUNSTAGE_RUNNER_TOKEN.)",
    );
  }
  const registry = RunnerRegistry.fromFile(file);
  if (registry.list().length === 0) throw new Error(`no runners registered in ${file}. Mint one with \`npm run -s runner-token -- mint --id <runner-id>\`.`);
  return registry;
}

export function readRunnersFile(file: string): RunnersFile {
  if (!existsSync(file)) return { version: 1, runners: [] };
  let raw: RunnersFile;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as RunnersFile;
  } catch (err) {
    throw new Error(`runners file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (raw.version !== 1 || !Array.isArray(raw.runners)) throw new Error(`runners file ${file} has an unknown format`);
  validateEntries(raw.runners);
  return raw;
}

function validateEntries(entries: RunnerEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!RUNNER_ID.test(e.id)) throw new Error(`bad runner id "${e.id}" (letters, digits, . _ -, max 64)`);
    if (!/^[0-9a-f]{64}$/.test(e.tokenSha256)) throw new Error(`runner "${e.id}": tokenSha256 must be 64 hex chars`);
    if (seen.has(e.id)) throw new Error(`duplicate runner id "${e.id}"`);
    for (const r of e.repos ?? []) if (!REPO.test(r)) throw new Error(`runner "${e.id}": bad repo "${r}" (use owner/name)`);
    seen.add(e.id);
  }
}

/** Create or rotate a runner's token. Returns the plaintext token; only its hash is written. */
export function mintRunnerToken(file: string, id: string, repos: string[] = [], now = new Date()): string {
  const data = readRunnersFile(file);
  const token = generateToken();
  const entry: RunnerEntry = { id, tokenSha256: hashToken(token), ...(repos.length ? { repos } : {}), createdAt: now.toISOString() };
  validateEntries([entry]);
  data.runners = [...data.runners.filter((r) => r.id !== id), entry];
  writeJsonAtomic(file, data);
  return token;
}

export function revokeRunner(file: string, id: string): boolean {
  const data = readRunnersFile(file);
  const before = data.runners.length;
  data.runners = data.runners.filter((r) => r.id !== id);
  if (data.runners.length === before) return false;
  writeJsonAtomic(file, data);
  return true;
}
