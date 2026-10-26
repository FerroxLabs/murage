// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 104 High 02-A2 and 02-B1, the two restart gaps of a parentless teammate ask made from a direct chat:
//  A2: the closing row in the chat is written before the receipt and the asker's wake, so it alone never settles the owed delivery.
//  B1: a restart ends such an ask as unknown with no wake and no result owed, so the chat it was made in is told.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { sharedDeliveryOnDisk } from "./handoff-boundary.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { insertRoomRequest, markRequestDispatched, parentlessAsksInterruptedByRestart, reconcileRoomRequestsAtBoot, type RoomRequest } from "./room-requests.ts";

const lineage = { rootThreadId: "chat-A", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
let db: DatabaseSync;
beforeEach(() => { db = new DatabaseSync(":memory:"); initializeProjectTables(db); });

describe("02-A2 the owed delivery settles only when the receipt and the asker's wake are on disk", () => {
  const request = (parentId: string | null) => ({ id: "r1", parentId } as unknown as RoomRequest);
  const ports = (over: { written?: boolean; receipt?: boolean; intends?: boolean; durable?: boolean } = {}) => ({
    terminalWritten: () => over.written ?? true, receipt: () => over.receipt ?? true, wakes: { intends: () => over.intends ?? false, durable: () => over.durable ?? true },
  });
  it("the closing row alone is not a delivery", () => {
    expect(sharedDeliveryOnDisk(ports({ receipt: false }), request(null), "chat-A")).toBe(false);
    expect(sharedDeliveryOnDisk(ports({ written: false }), request(null), "chat-A")).toBe(false);
  });
  it("a parentless request also waits for its asker's wake", () => {
    expect(sharedDeliveryOnDisk(ports({ intends: true }), request(null), "chat-A")).toBe(false);
    expect(sharedDeliveryOnDisk(ports({ durable: false }), request(null), "chat-A")).toBe(false);
    expect(sharedDeliveryOnDisk(ports(), request(null), "chat-A")).toBe(true);
  });
  it("a request with a parent owes no wake of its own", () => {
    expect(sharedDeliveryOnDisk(ports({ intends: true }), request("p1"), "chat-A")).toBe(true);
  });
  it("the pass asks the complete-on-disk question", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).toContain("delivered: (request, destination) => sharedDeliveryOnDisk(");
    expect(source).not.toContain("delivered: (request, destination) => requestTerminalWritten(destination, request),");
  });
});

describe("02-B1 a restart tells the chat of a parentless ask it ended", () => {
  const ask = (key: string, extra: Record<string, unknown> = {}) => {
    const q = insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", fromBotId: "A", toBotId: "B", admissionKey: key, lineage, payloadText: "can you check?", targetThreadId: "desk-B", now: 1000, ...extra }).request;
    markRequestDispatched(db, q.id, { now: 1001 });
    return q;
  };
  it("lists a running ask with no parent and no return thread, with the chat it was made in", () => {
    const q = ask("ask:1");
    expect(parentlessAsksInterruptedByRestart(db)).toEqual([{ id: q.id, toBotId: "B", threadId: "chat-A" }]);
  });
  it("leaves out an ask that returns somewhere, and one that has finished", () => {
    ask("ask:2", { returnThreadId: "chat-A", returnBotId: "A" });
    expect(parentlessAsksInterruptedByRestart(db)).toEqual([]);
  });
  it("is empty once the boot sweep has ended the ask", () => {
    ask("ask:3");
    reconcileRoomRequestsAtBoot(db, 5000);
    expect(parentlessAsksInterruptedByRestart(db)).toEqual([]);
  });
  it("boot writes the line into that chat", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).toContain("const interruptedAsks = parentlessAsksInterruptedByRestart(db);");
    expect(source).toContain("for (const ask of interruptedAsks) {");
  });
});
