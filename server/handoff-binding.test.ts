// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 5 #3: an unbound reply (a direct ask or delegation with no room or card request above it) is proven to be this conversation's own
// answer by the turn that wrote it, never by what other requests once did in the same conversation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ownUnsharedWorkCheck, resultBoundToHandoff } from "./handoff-binding.ts";
import { WorkerText } from "./released-text.ts";
import { plain } from "./testing/released.ts";
import { releaseStoredResult, type EgressMessage, type ResultEgressDeps } from "./result-egress.ts";

type Row = { id: string; role: "user" | "bot"; kind: string; text: string; parentId?: string | null; steered?: boolean; handoffFrom?: string };
// "work" is the worker's home conversation. An earlier room-originated ask ran there (u0/b0, no hand-off record); later the owner's own
// conversation ("owner") delegated unrelated work to the same bot (u1/b1); a second delegation was steered a line into its running turn (u2/b2).
const thread: Row[] = [
  { id: "u0", role: "user", kind: "text", text: "room ask" },
  { id: "b0", role: "bot", kind: "text", text: "room answer", parentId: "u0" },
  { id: "u1", role: "user", kind: "text", text: "delegated", parentId: "b0", handoffFrom: "owner" },
  { id: "t1", role: "bot", kind: "activity", text: "", parentId: "u1" },
  { id: "b1", role: "bot", kind: "text", text: "LEGIT ANSWER", parentId: "t1" },
  { id: "s1", role: "user", kind: "text", text: "also this", parentId: "b1", steered: true },
  { id: "b2", role: "bot", kind: "text", text: "late answer", parentId: "s1" },
];
const byId = new Map(thread.map(row => [row.id, row]));
const message = (_thread: string, id: string): Row | undefined => byId.get(id);

describe("a reply belongs to the hand-off its turn was started by", () => {
  it("proves a reply by the user message it follows, through tool rows", () => {
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b1"] }, "owner")).toBe(true);
  });
  it("does not prove a reply to a different conversation, nor an earlier unbound turn", () => {
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b1"] }, "someone-else")).toBe(false);
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b0"] }, "owner")).toBe(false);
  });
  it("does not let a message steered into the turn stand in for its prompt, and needs every message to be proven", () => {
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b2"] }, "owner")).toBe(true);
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b2"] }, "work")).toBe(false);
    expect(resultBoundToHandoff(id => byId.get(id), { messageIds: ["b1", "b0"] }, "owner")).toBe(false);
  });
  it("has nothing to prove for a result with no stored original", () => {
    expect(resultBoundToHandoff(() => undefined, { messageIds: [] }, "owner")).toBe(true);
  });
});

describe("R5-03: an earlier room ask in the worker's home conversation no longer fails later owner delegations", () => {
  const own = new Set(["owner", "work"]);
  const deps = (): ResultEgressDeps => ({
    message: (threadId, id) => message(threadId, id) as EgressMessage | undefined,
    authorize: () => ({ ok: true }),
    copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false,
    partitionAllowed: () => true,
    ownUnsharedWork: ownUnsharedWorkCheck({ bot: id => ({ id }), isOwnUnsharedThread: (_bot, threadId) => own.has(threadId), message }),
    withheldLine: "[withheld]",
  });
  const finalize = (ids: string[], text: string, sourceThread = "owner") =>
    plain(releaseStoredResult({ origin: { threadId: "work", messageIds: ids } }, "worker", sourceThread, { fromBotId: "owner-bot" }, false, text === undefined ? undefined : new WorkerText(text), deps()));

  it("the owner's direct delegation is released and copied although a room request once targeted the same conversation", () => {
    expect(finalize(["b1"], "LEGIT ANSWER")).toEqual({ kind: "text", text: "LEGIT ANSWER", copyOf: { threadId: "work", messageIds: ["b1"] } });
  });
  it("the room-originated answer in that conversation is still not the owner's to read through a direct hand-off", () => {
    expect(finalize(["b0"], "room answer")).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
  });
  it("another conversation's delegation to the same bot reads nothing of it", () => {
    expect(finalize(["b1"], "LEGIT ANSWER", "work")).toMatchObject({ kind: "refused" });
  });
});

describe("the hand-off is recorded where it is dispatched", () => {
  it("the ask and the delegation turns both name their source conversation", () => {
    const source = readFileSync(join(__dirname, "index.ts"), "utf8");
    for (const kind of ["ask", "delegation"]) {
      const at = source.indexOf(`automation:{kind:"${kind}"}`);
      expect(at, kind).toBeGreaterThan(0);
      expect(source.slice(at, at + 200), kind).toContain("handoffSourceThreadId: sourceThreadId");
    }
    expect(source).toContain("handoffFrom: opts.handoffSourceThreadId");
  });
});
