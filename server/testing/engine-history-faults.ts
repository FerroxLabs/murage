// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Fault injection for the engine-history tests. Every read the planner and the executor make goes through `fsOps`
// (engine-fs.ts); this wraps each member to record the call and, at a chosen call, to fail it the way a disk or a store would.
import type { RawDb } from "../engine-fs.ts";
import { fsOps } from "../engine-fs.ts";

export type FaultKind = "EIO" | "EACCES" | "EMFILE" | "truncate" | "zstd" | "sqlite";
export const ERRNO_KINDS: FaultKind[] = ["EIO", "EACCES", "EMFILE"];
export const ALL_KINDS: FaultKind[] = ["EIO", "EACCES", "EMFILE", "truncate", "zstd", "sqlite"];

export interface Instrument {
  /** every read, in order: "lstat <path>", "query <db>"... */
  log: string[];
  /** did the chosen fault actually apply (some kinds only fit some reads)? */
  applied(): boolean;
  restore(): void;
}

const errno = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

/** Wraps `fsOps`. With `at` and `kind` the read with that index fails that way; with `all` every read does (a blackout). */
export function instrument(o: { at?: number; kind?: FaultKind; all?: FaultKind; needles?: string[] } = {}): Instrument {
  const real = { ...fsOps };
  const log: string[] = [];
  let applied = false;
  let n = 0;
  const kindFor = (): FaultKind | null => {
    const index = n++;
    if (o.all) return o.all;
    return o.at === index && o.kind ? o.kind : null;
  };
  const cut = <T extends string | Buffer>(data: T): T => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    for (const needle of o.needles ?? []) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const end = at + needle.length + 1;
      if (end >= text.length) continue;
      applied = true;
      return (typeof data === "string" ? text.slice(0, end) : Buffer.from(text.slice(0, end), "utf8")) as T;
    }
    return data;
  };
  const guard = (op: string, path: string): FaultKind | null => {
    log.push(`${op} ${path}`);
    const kind = kindFor();
    if (kind === "EIO" || kind === "EACCES" || kind === "EMFILE") { applied = true; throw errno(kind); }
    return kind;
  };
  (fsOps as Record<string, unknown>).lstat = (p: string, ...rest: unknown[]) => { guard("lstat", p); return (real.lstat as (...a: unknown[]) => unknown)(p, ...rest); };
  (fsOps as Record<string, unknown>).readdir = (p: string, ...rest: unknown[]) => { guard("readdir", p); return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest); };
  (fsOps as Record<string, unknown>).readlink = (p: string, ...rest: unknown[]) => { guard("readlink", p); return (real.readlink as (...a: unknown[]) => unknown)(p, ...rest); };
  (fsOps as Record<string, unknown>).readFile = (p: string, ...rest: unknown[]) => {
    const kind = guard("readFile", p);
    const data = (real.readFile as (...a: unknown[]) => string | Buffer)(p, ...rest);
    return kind === "truncate" ? cut(data) : data;
  };
  fsOps.readHead = (p: string, bytes: number) => {
    const kind = guard("readHead", p);
    const data = real.readHead(p, bytes);
    return kind === "truncate" ? cut(data) : data;
  };
  fsOps.zstd = (bytes: Buffer) => {
    const kind = guard("zstd", "(frame)");
    if (kind === "zstd") { applied = true; throw new Error("zstd: frame checksum mismatch"); }
    return real.zstd(bytes);
  };
  fsOps.openDb = (p: string): RawDb => {
    const kind = guard("openDb", p);
    if (kind === "sqlite") { applied = true; throw Object.assign(new Error("file is not a database"), { code: "ERR_SQLITE_ERROR" }); }
    const db = real.openDb(p);
    return {
      close: () => db.close(),
      all: (sql, params) => {
        const inner = guard("query", p);
        if (inner === "sqlite") { applied = true; throw Object.assign(new Error("database disk image is malformed"), { code: "ERR_SQLITE_ERROR" }); }
        return db.all(sql, params);
      },
    };
  };
  return {
    log,
    applied: () => applied,
    restore: () => { Object.assign(fsOps, real); },
  };
}
