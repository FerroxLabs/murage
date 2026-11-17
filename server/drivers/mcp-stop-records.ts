// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Durable ownership record of one MCP server generation (design S2, V2): written BEFORE the server starts, so a crash or a restart
// can never forget a bot whose server may still be running.
//   PLANNED  {owner, generation, platform, planned identity}            nothing started yet
//   SPAWNING written and fsynced (file AND directory) BEFORE exec        the spawn may have happened
//   RUNNING  {+ root pair on desktop}
//   STOPPING {+ pre-stop pairs on desktop}
//   deleted only after PROVEN GONE.
// The durable write unit is writeFileAtomic with syncDir (server/atomic.ts): write, file fsync, rename, directory fsync.
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { StopRecord, StopState } from "./mcp-stop-proof.ts";

export interface StopRecordFs {
  /** Durable: file fsync, rename, directory fsync. Throws on failure. */
  write(path: string, data: string): void;
  read(path: string): string;
  list(dir: string): string[];
  remove(path: string): void;
  mkdirp(dir: string): void;
}
export const realStopRecordFs: StopRecordFs = {
  write: (path, data) => writeFileAtomic(path, data, { mode: 0o600, syncDir: true }),
  read: (path) => readFileSync(path, "utf8"),
  list: (dir) => readdirSync(dir),
  remove: (path) => unlinkSync(path),
  mkdirp: (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); },
};

const ORDER: StopState[] = ["PLANNED", "SPAWNING", "RUNNING", "STOPPING"];
const fileFor = (owner: string, generation: number): string => `${Buffer.from(owner, "utf8").toString("base64url")}.${generation}.json`;
const validRecord = (value: unknown): value is StopRecord => {
  const r = value as StopRecord | null;
  return !!r && typeof r === "object" && r.version === 1 && typeof r.owner === "string" && r.owner !== "" && Number.isInteger(r.generation)
    && ORDER.includes(r.state) && ["cloud", "windows", "desktop"].includes(r.platform);
};

/** The owner a record file name belongs to (`<base64url owner>.<generation>.json`), or null when the name is not one of ours. A file that
 *  does not parse still names its owner here, so that owner can be quarantined (fail closed) instead of forgotten. */
export function ownerOfRecordFile(name: string): string | null {
  const match = /^([A-Za-z0-9_-]+)\.(\d+)\.json$/.exec(name);
  if (!match) return null;
  const owner = Buffer.from(match[1]!, "base64url").toString("utf8");
  return owner !== "" && Buffer.from(owner, "utf8").toString("base64url") === match[1] ? owner : null;
}

export class StopRecordStore {
  readonly dir: string;
  readonly #fs: StopRecordFs;
  constructor(dir: string, fs: StopRecordFs = realStopRecordFs) { this.dir = dir; this.#fs = fs; }

  path(record: Pick<StopRecord, "owner" | "generation">): string { return join(this.dir, fileFor(record.owner, record.generation)); }

  /** First write of a generation: PLANNED. Durable before it returns. */
  plan(record: StopRecord): void {
    if (record.state !== "PLANNED") throw new Error("a record is planned in the PLANNED state");
    this.#fs.mkdirp(this.dir);
    this.#fs.write(this.path(record), JSON.stringify(record));
  }
  /** Moves a record forward (never back) and makes the new state durable before it returns. */
  advance(record: StopRecord, to: StopState): StopRecord {
    if (ORDER.indexOf(to) < ORDER.indexOf(record.state)) throw new Error("a record never moves back");
    const next = { ...record, state: to };
    this.#fs.write(this.path(next), JSON.stringify(next));
    return next;
  }
  /** Rewrites a record in its current state (a union update, the containment record, a REPARENTED flag). Durable before it returns. */
  save(record: StopRecord): void { this.#fs.write(this.path(record), JSON.stringify(record)); }
  /** Only after PROVEN GONE. */
  delete(record: Pick<StopRecord, "owner" | "generation">): void {
    try { this.#fs.remove(this.path(record)); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  }
  /** Every undeleted record. A file that does not parse is reported in `corrupt` (never deleted); it is not silently dropped. */
  list(): { records: StopRecord[]; corrupt: string[] } {
    const records: StopRecord[] = [];
    const corrupt: string[] = [];
    let names: string[];
    try { names = this.#fs.list(this.dir); } catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { records, corrupt }; throw error; }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(this.#fs.read(join(this.dir, name))) as unknown;
        if (validRecord(parsed)) records.push(parsed); else corrupt.push(name);
      } catch { corrupt.push(name); }
    }
    return { records, corrupt };
  }
}
