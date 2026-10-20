// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 rule 22: no Murage-voice row ever becomes a memory source again, and a turn's authored text never includes one.
import { beforeEach, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { database, closeDatabase } from "../database.ts";
import { DATA_DIR } from "../config.ts";
import { captureMessage } from "./capture.ts";
import { authoredTurnPieces } from "../reply-action-guard.ts";
import type { Message } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const murageShapes: Array<[string, Partial<Message>]> = [
  ["murageLine", { murageLine: true } as Partial<Message>],
  ["actorKind", { actorKind: "murage" } as Partial<Message>],
  ["murage offer", { murage: { kind: "murage" } } as unknown as Partial<Message>],
];

it.each(murageShapes)("captures no Murage-voice text row (%s), in a turn or outside one", (_name, shape) => {
  const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  captureMessage(db, "thread", { id: "a", at: 1, role: "bot", kind: "text", text: "Murage line", ...shape } as Message);
  captureMessage(db, "thread", { id: "b", at: 2, role: "bot", kind: "text", text: "Murage line", turnId: "t", turnTerminal: true, ...shape } as Message);
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()!.n).toBe(0);
  // a plain bot reply outside a turn is still captured
  captureMessage(db, "thread", { id: "c", at: 3, role: "bot", kind: "text", text: "plain reply" } as Message);
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()!.n).toBe(1);
});

it("a lifecycle card (routine.run) is never a source", () => {
  const db = database(); db.exec("UPDATE memory_meta SET mode='active'");
  captureMessage(db, "thread", { id: "r", at: 1, role: "bot", kind: "routine.run", text: "ran" } as unknown as Message);
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()!.n).toBe(0);
});

it.each(murageShapes)("authoredTurnPieces leaves out a Murage-voice row of the same turn (%s)", (_name, shape) => {
  const from = { botId: "b1", name: "Ada" };
  const path = [
    { id: "p1", at: 1, role: "bot", kind: "text", text: "first", turnId: "t", from },
    { id: "m", at: 2, role: "bot", kind: "text", text: "Murage says", turnId: "t", from, ...shape },
    { id: "p2", at: 3, role: "bot", kind: "text", text: "second", turnId: "t", from },
  ] as Message[];
  expect(authoredTurnPieces(path, path[2]!).map(piece => piece.id)).toEqual(["p1", "p2"]);
});
