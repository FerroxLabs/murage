// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra's confirm audit (int102-gate/audit-astra-c/REPORT.md): two privacy leaks, each reproduced here first and fixed after, and two scale
// findings Sean moved to the post-release scale track (it.todo, with Astra's measured numbers).
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup } from "./deny-read.ts";
import { resetLineageBackfillForTest } from "./lineage-backfill.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import type { LineageReader, LineageRef, MemoryRef } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { buildPrompt, ownShownLineIds, promptPart, recordTurnObject, sendFence, turnToolText } from "./prompt-parts.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { markerSlice, setScopeFlowEdgesRecorded } from "./revoke-marker.ts";
import { forgetKeptLineageForTest } from "./testing/legacy-lineage/replay-lineage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const CONTENT: LineageReader = { audience: null };
const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string, extra: Partial<Message> = {}): Message => msg(id, { role: "user", ...extra });
const verdict = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)!;
const inTurn = (thread: string, turnId: string, write: () => void) => {
  const turn = openTurnLineage(database(), { threadId: thread, turnId });
  try { write(); } finally { closeTurnLineage(turn); }
};

beforeEach(() => {
  closeMessageDb(); closeDatabase(); resetLineageBackfillForTest(); forgetKeptLineageForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});

describe("Astra confirm audit", () => {
  it("1. A -> note N1 -> B -> note N2 -> C: C's reply is held from the flow phase on, not only after the marker drained", () => {
    setScopeFlowEdgesRecorded(true);
    const db = database();
    const n1: MemoryRef = { kind: "note", id: "n1" }, n2: MemoryRef = { kind: "note", id: "n2" };
    appendMessage("A", owner("ao1"));
    inTurn("A", "turn-a", () => { appendMessage("A", msg("a1", { parentId: "ao1" })); recordTurnObject(db, "A", n1); });
    appendMessage("B", owner("bo1"));
    inTurn("B", "turn-b", () => { turnToolText("B", "n1's words", [{ kind: "memory", ref: n1 }]); recordTurnObject(db, "B", n2); /* B writes the note and no reply: no thread edge of its own carries N1 on to N2's readers */ });
    appendMessage("C", owner("co1"));
    inTurn("C", "turn-c", () => { turnToolText("C", "n2's words", [{ kind: "memory", ref: n2 }]); appendMessage("C", msg("c1", { parentId: "co1" })); });
    expect(verdict("C", "c1").state).toBe("shown");
    db.prepare("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1").run(); // the certificate is ready: the flow phase may close its '*' window
    commitRevoke(db, { kind: "line", threadId: "A", messageIds: ["a1"], cause: "forget" });
    // the marker's flow phase runs (and nothing past it): the pending window must already reach C
    for (let i = 0; i < 1000; i++) {
      const phase = db.prepare("SELECT phase FROM memory_revoke_jobs ORDER BY revoke_id DESC LIMIT 1").get()?.phase;
      if (phase !== "flow") break;
      if (!markerSlice(db, 1)) break;
    }
    expect(db.prepare("SELECT phase FROM memory_revoke_jobs ORDER BY revoke_id DESC LIMIT 1").get()?.phase).not.toBe("flow");
    expect(verdict("C", "c1").state).not.toBe("shown");
    expect(drainRevokeMarker(db).pending).toBe(false);
    expect(verdict("C", "c1").state).toBe("withheld");
  });

  it("2. the send fence names the reply target a prompt quotes, on a resumed session with no transcript replay", () => {
    const db = database();
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1", text: "the secret target words" })));
    appendMessage("t", owner("o2", { parentId: "r1" }));
    const turn = openTurnLineage(db, { threadId: "t", turnId: "turn-2" });
    try {
      // a resumed session: nothing replayed (inWords empty), the prompt quotes the explicit reply target r1
      const shown = [{ threadId: "t", id: "r1" }, { threadId: "other", id: "x1" }];
      const named = ownShownLineIds("t", [], shown, new Set());
      expect(named).toEqual(["r1"]);
      expect(ownShownLineIds("t", [], shown, new Set(["r1"]))).toEqual([]); // a withheld line is not named
      const prefix: LineageRef = { kind: "prefix", threadId: "t", headLsn: turn.turnLsn, shown: named } as LineageRef;
      const built = buildPrompt(turn, [promptPart("quoting: the secret target words", [prefix])]);
      expect(sendFence(db, built, CONTENT).state).toBe("shown");
      commitRevoke(db, { kind: "line", threadId: "t", messageIds: ["r1"], cause: "forget" });
      expect(drainRevokeMarker(db).pending).toBe(false);
      expect(verdict("t", "r1").state).toBe("withheld");
      expect(sendFence(db, built, CONTENT).state).not.toBe("shown");
    } finally { closeTurnLineage(turn); }
  });

  // Post-release scale track (Sean, 2026-10-13): no code change in this round.
  it.todo("scale 3. object-write inheritance scans the carried interval: revoke-commit.ts ~306 correlated EXISTS; Astra measured 0.32 / 3.06 / 31.23 ms at 10k / 100k / 1M clean rows (a note write at 1M: 31.56 ms), synchronous and proportional to history");
  it.todo("scale 4. the carry-key migration rebuild (schema.ts ~1968, dev-file v10 only) copies the whole carry table in one main-thread transaction; Astra measured 4.7 / 16.8 / 165.1 ms at 10k / 100k / 1M carries in memory, before disk/WAL costs");
});
