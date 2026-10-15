// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §4: this run's numbered removals, the roster's `removed[]` filters (M6, H-r6-1), the per-bot DELETE
// serialisation and the re-check made at the commit (P11), and the ten-minute window (P7, server half).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANSWER_TTL_MS, commitRefusal, createBotDeletionLedger, createPerKeySerialiser } from "./bot-deletion-ledger.ts";

describe("bot removal ledger", () => {
  it("P7: removed[] holds only removals younger than the answer life; a deletion past it falls out", () => {
    let now = 1_000;
    const ledger = createBotDeletionLedger({ now: () => now });
    ledger.deleted("old", 4, "e1");
    now += ANSWER_TTL_MS - 1;
    ledger.deleted("young", 7, "e1");
    expect(ledger.removedFor("owner-desktop")!.map((entry) => entry.id).sort()).toEqual(["old", "young"]);
    now += 2;
    expect(ledger.removedFor("owner-desktop")).toEqual([{ id: "young", tasksSeq: 7, tasksEpoch: "e1", kind: "deleted" }]);
    expect(ledger.deletion("old")).toBeUndefined();
    expect(ledger.deletion("young")).toMatchObject({ tasksSeq: 7, tasksEpoch: "e1" });
  });

  it("H-r6-1: the owner's desktop roster gets deletions only, never a hide (it keeps archived bots as hidden records)", () => {
    const ledger = createBotDeletionLedger();
    ledger.hidden("archived", 5, "e1");
    ledger.deleted("gone", 9, "e1");
    expect(ledger.removedFor("owner-desktop")).toEqual([{ id: "gone", tasksSeq: 9, tasksEpoch: "e1", kind: "deleted" }]);
  });

  it("P12: the scoped owner roster gets hides and only the deletions the phone could see; anyone else gets no field", () => {
    const ledger = createBotDeletionLedger();
    ledger.hidden("archived", 5, "e1");
    ledger.deleted("seen", 9, "e1");
    ledger.markCompanionVisible("seen", true);
    ledger.deleted("unseen", 11, "e1");
    ledger.markCompanionVisible("unseen", false);
    ledger.deleted("other-path", 12, "e1");
    const scoped = ledger.removedFor("owner-scoped")!;
    expect(scoped.map((entry) => [entry.id, entry.kind]).sort()).toEqual([["archived", "hidden"], ["seen", "deleted"]]);
    expect(ledger.removedFor("other")).toBeUndefined();
  });

  it("a hide keeps its first number, a restore withdraws it, and a deletion replaces it", () => {
    const ledger = createBotDeletionLedger();
    ledger.hidden("x", 5, "e1");
    ledger.hidden("x", 6, "e1");
    expect(ledger.removedFor("owner-scoped")).toEqual([{ id: "x", tasksSeq: 5, tasksEpoch: "e1", kind: "hidden" }]);
    ledger.shown("x");
    expect(ledger.removedFor("owner-scoped")).toEqual([]);
    ledger.hidden("x", 8, "e1");
    ledger.deleted("x", 9, "e1");
    expect(ledger.removedFor("owner-desktop")).toEqual([{ id: "x", tasksSeq: 9, tasksEpoch: "e1", kind: "deleted" }]);
    ledger.shown("x"); // a deletion is never withdrawn by a visible frame
    expect(ledger.deletion("x")).toBeDefined();
  });
});

describe("per-bot DELETE serialisation", () => {
  it("P11: a second DELETE waits for the first and then runs its own route from the top", async () => {
    const serial = createPerKeySerialiser();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let exists = true;
    const first = serial.run("x", async () => { order.push("first:start"); await held; exists = false; order.push("first:end"); return "deleted"; });
    // the waiter re-reads the state when it runs: it never inherits the first one's outcome
    const second = serial.run("x", async () => { order.push(`second:${exists ? "held" : "gone"}`); return exists ? "deleted" : "alreadyDeleted"; });
    const other = serial.run("y", async () => { order.push("other"); return "deleted"; });
    await other;
    expect(order).toEqual(["first:start", "other"]);
    expect(serial.busy("x")).toBe(true);
    release();
    expect(await first).toBe("deleted");
    expect(await second).toBe("alreadyDeleted");
    expect(order).toEqual(["first:start", "other", "first:end", "second:gone"]);
    expect(serial.busy("x")).toBe(false);
  });

  it("a failed DELETE releases the lock for the next one", async () => {
    const serial = createPerKeySerialiser();
    const failing = serial.run("x", async () => { throw new Error("journal unreadable"); });
    const next = serial.run("x", async () => "ran");
    await expect(failing).rejects.toThrow("journal unreadable");
    expect(await next).toBe("ran");
  });

  it("three waiters run one at a time, in turn", async () => {
    const serial = createPerKeySerialiser();
    let inside = 0, most = 0;
    const body = async () => { inside++; most = Math.max(most, inside); await new Promise((resolve) => setTimeout(resolve, 5)); inside--; };
    await Promise.all([serial.run("x", body), serial.run("x", body), serial.run("x", body)]);
    expect(most).toBe(1);
  });
});

describe("the re-check at the commit", () => {
  it("P11: a restore during the awaits defeats an ifArchived delete; a plain delete of the same bot proceeds", () => {
    expect(commitRefusal({ hidden: false }, { ifArchived: true, running: false })).toBe("restored");
    expect(commitRefusal({ hidden: false }, { ifArchived: false, running: false })).toBeNull();
    expect(commitRefusal({ hidden: true }, { ifArchived: true, running: false })).toBeNull();
  });
  it("a turn started meanwhile defeats any delete; a bot already gone is reported as gone", () => {
    expect(commitRefusal({ hidden: true }, { ifArchived: true, running: true })).toBe("running");
    expect(commitRefusal({}, { ifArchived: false, running: true })).toBe("running");
    expect(commitRefusal(null, { ifArchived: false, running: false })).toBe("gone");
  });
});

describe("the DELETE route answers a refusal thrown inside the serialiser", () => {
  // The route's own try/catch turns a thrown refusal (an unreadable browser cleanup journal's 503, a busy database) into an
  // answer. A bare `return serial.run(...)` inside that try returns the promise unawaited, so its rejection escapes the catch
  // and the request is never answered (index-3 "rejects bot deletion with no teardown when the cleanup journal is unreadable").
  it("a rejection reaches the caller's catch only when the run is awaited", async () => {
    const serial = createPerKeySerialiser();
    const refusal = Object.assign(new Error("journal unreadable"), { status: 503 });
    const route = async (awaited: boolean): Promise<string> => {
      try {
        if (awaited) return await serial.run("bot", async () => { throw refusal; });
        return serial.run("bot", async () => { throw refusal; });
      } catch (error) {
        return `answered ${(error as { status: number }).status}`;
      }
    };
    await expect(route(true)).resolves.toBe("answered 503");
    await expect(route(false)).rejects.toBe(refusal);
  });

  it("server/index.ts awaits the per-bot DELETE run", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/return await botDeleteSerial\.run\(deleteBotId, /);
    expect(source).not.toMatch(/return botDeleteSerial\.run\(/);
  });
});
