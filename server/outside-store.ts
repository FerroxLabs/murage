// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT 1.0.20 (design r4 3.5): the durable copy of the outside marks, session state, marked turns,
// `outsideSince` and the download registry. One append-only file in the data folder (no new database table, so the
// schema and restore fences stay as they are). Every change is one appended line; load replays them in order. A torn
// last line (a crash mid-write) is skipped; any other unreadable line throws, which leaves the store not ready, so
// every turn reads as marked (fail closed).
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import type { RegistryEntry } from "./download-registry.ts";
import { noteOutsideStoreWrite, noteStoreFailure } from "./email/external-marks.ts";
import type { MarkedTurnRow, OutsideMarkRow, OutsideSessionRow, OutsideStore, SessionBinding } from "./email/external-marks.ts";

type Line =
  | ({ k: "open"; runId: string; threadId: string; instanceId: string; at: number } & Partial<SessionBinding>)
  | { k: "seal"; runId: string }
  | { k: "mark"; row: OutsideMarkRow }
  | { k: "clear"; threadId: string }
  | { k: "session"; row: OutsideSessionRow }
  | { k: "turn"; row: MarkedTurnRow }
  | { k: "since"; at: number }
  | { k: "own"; key: string }
  | { k: "reg"; add: RegistryEntry[]; drop: RegistryEntry[] };

type Replayed = ReturnType<OutsideStore["load"]> & { registry: RegistryEntry[] };

function replay(path: string): Replayed {
  const marks = new Map<string, OutsideMarkRow>();
  const sessions = new Map<string, OutsideSessionRow>();
  const markedTurns: MarkedTurnRow[] = [];
  const opens: ReturnType<OutsideStore["load"]>["opens"] = [];
  const registry = new Map<string, RegistryEntry>();
  let outsideSince: number | undefined;
  const ownWrites = new Set<string>();
  if (!existsSync(path)) return { marks: [], sessions: [], markedTurns, opens, registry: [], ownWrites: [] };
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  lines.forEach((text, index) => {
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch (error) {
      if (index === lines.length - 1) return;
      throw error;
    }
    switch (line.k) {
      case "open": {
        const { k: _kind, ...open } = line;
        // A fresh engine session opened after the bound session row of the same key supersedes that row: if its own rows never landed,
        // recovery must taint the new session, not resume the old clean row. A session row later in the file (replayed after this) still wins.
        const key = `${open.threadId}\u0000${open.instanceId}`;
        const row = sessions.get(key);
        if (row?.sessionKey !== undefined && open.sessionKey !== undefined && (row.sessionKey !== open.sessionKey || row.gen !== open.gen || row.birthRunId !== open.birthRunId)) sessions.delete(key);
        opens.push(open);
        break;
      }
      case "seal":
        for (let i = opens.length - 1; i >= 0; i--) if (opens[i]!.runId === line.runId) opens.splice(i, 1);
        break;
      case "mark": marks.set(line.row.threadId, line.row); break;
      case "clear": marks.delete(line.threadId); break;
      case "session": sessions.set(`${line.row.threadId}\u0000${line.row.instanceId}`, line.row); break;
      case "turn": markedTurns.push(line.row); break;
      case "since": outsideSince ??= line.at; break;
      case "own": ownWrites.add(line.key); break;
      case "reg":
        for (const entry of line.drop) registry.delete(JSON.stringify(entry));
        for (const entry of line.add) registry.set(JSON.stringify(entry), entry);
        break;
      default: throw new Error("unknown outside store line");
    }
  });
  return { marks: [...marks.values()], sessions: [...sessions.values()], markedTurns, opens, registry: [...registry.values()], ownWrites: [...ownWrites], ...(outsideSince !== undefined ? { outsideSince } : {}) };
}

/** The store over one file. Writes throw on a disk error; external-marks.ts keeps the in-memory state then (over-marks only). */
export function fileOutsideStore(path: string): OutsideStore {
  const append = (line: Line) => {
    noteOutsideStoreWrite(line.k === "seal");
    try { appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 }); }
    catch (error) { noteStoreFailure(); throw error; }
  };
  const flush = (write?: (fd: number) => void) => {
    try {
      const fd = openSync(path, "a", 0o600);
      try { write?.(fd); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { noteStoreFailure(); throw error; }
  };
  return {
    load: () => {
      const { registry: _registry, ...rest } = replay(path);
      return rest;
    },
    openTurn: (threadId, instanceId, at, runId, binding) => {
      noteOutsideStoreWrite();
      flush((fd) => appendFileSync(fd, `${JSON.stringify({ k: "open", runId, threadId, instanceId, at, ...binding })}\n`));
    },
    seal: (runId) => { noteOutsideStoreWrite(true); flush(); append({ k: "seal", runId }); },
    loadRegistry: () => replay(path).registry,
    writeRegistry: (add, drop) => { if (add.length || drop.length) append({ k: "reg", add, drop }); },
    setMark: (row) => append({ k: "mark", row }),
    clearMark: (threadId) => append({ k: "clear", threadId }),
    setSession: (row) => append({ k: "session", row }),
    addMarkedTurn: (row) => append({ k: "turn", row }),
    setOutsideSince: (at) => append({ k: "since", at }),
    addOwnWrite: (key) => { append({ k: "own", key }); flush(); },
  };
}
