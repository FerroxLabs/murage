// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT 1.0.20 (design r4 3.5): the durable copy of the outside marks, session state, marked turns,
// `outsideSince` and the download registry. One append-only file in the data folder (no new database table, so the
// schema and restore fences stay as they are). Every change is one appended line; load replays them in order. A torn
// last line (a crash mid-write) is skipped; any other unreadable line throws, which leaves the store not ready, so
// every turn reads as marked (fail closed).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { RegistryEntry } from "./download-registry.ts";
import type { MarkedTurnRow, OutsideMarkRow, OutsideSessionRow, OutsideStore } from "./email/external-marks.ts";

type Line =
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
  const registry = new Map<string, RegistryEntry>();
  let outsideSince: number | undefined;
  const ownWrites = new Set<string>();
  if (!existsSync(path)) return { marks: [], sessions: [], markedTurns, registry: [], ownWrites: [] };
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
  return { marks: [...marks.values()], sessions: [...sessions.values()], markedTurns, registry: [...registry.values()], ownWrites: [...ownWrites], ...(outsideSince !== undefined ? { outsideSince } : {}) };
}

/** The store over one file. Writes throw on a disk error; external-marks.ts keeps the in-memory state then (over-marks only). */
export function fileOutsideStore(path: string): OutsideStore {
  const append = (line: Line) => appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  return {
    load: () => {
      const { registry: _registry, ...rest } = replay(path);
      return rest;
    },
    loadRegistry: () => replay(path).registry,
    writeRegistry: (add, drop) => { if (add.length || drop.length) append({ k: "reg", add, drop }); },
    setMark: (row) => append({ k: "mark", row }),
    clearMark: (threadId) => append({ k: "clear", threadId }),
    setSession: (row) => append({ k: "session", row }),
    addMarkedTurn: (row) => append({ k: "turn", row }),
    setOutsideSince: (at) => append({ k: "since", at }),
    addOwnWrite: (key) => append({ k: "own", key }),
  };
}
