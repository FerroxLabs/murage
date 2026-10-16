// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 4 #2: a stored result leaves a bot through ONE function (server/result-egress.ts). This file proves the gate's order, and
// scans the server source for every place that moves a result's text or its id so a new way out cannot be added without calling the gate or
// writing down, in this list, why it cannot carry shared work.
import type { WorkerMessage } from "./worker-message.ts";
import { describe, expect, it } from "vitest";
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { releaseAskReply, releaseMessage, releaseStoredResult, type EgressMessage, type ReleasedAskReply, type ReleasedResult, type ResultEgressDeps, type StoredResultRef } from "./result-egress.ts";
import { ReleasedText, WorkerText } from "./released-text.ts";
/** A stored row as the boundary reads it: its words sealed. */
const sealRow = (row: { id: string; role: string; kind: string; at?: number; text?: string; tool?: { name: string; ok?: boolean }; failure?: "retrying" | "error" }): WorkerMessage => ({
  id: row.id, at: row.at ?? 0, role: row.role, kind: row.kind, ...(row.text !== undefined ? { text: new WorkerText(row.text) } : {}),
  ...(row.tool ? { tool: { name: new WorkerText(row.tool.name), ...(row.tool.ok === undefined ? {} : { ok: row.tool.ok }) } } : {}), ...(row.failure ? { failure: row.failure } : {}),
});

const ReleasedTextClaim = () => ReleasedText.claim();
import { outboundWords } from "./murage-status.ts";
import { released as releasedText, words } from "./testing/released.ts";

const SECRET = "The secret figure is 41.";
const world = (message: EgressMessage | undefined, over: Partial<ResultEgressDeps> = {}): ResultEgressDeps => ({
  message: () => message,
  authorize: () => ({ ok: true }),
  copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false,
  partitionAllowed: () => true, ownUnsharedWork: () => false, withheldLine: "[withheld]", ...over,
});
const ref: StoredResultRef = { requestId: "r1", origin: { threadId: "work", messageIds: ["m1"] } };
// results read back as plain values: released words and status lines become their strings
type Plain = { kind: "text"; text: string; copyOf?: { threadId: string; messageIds: string[] } } | { kind: "withheld"; line: string } | { kind: "refused"; line: string; code: string } | { kind: "status" } | { kind: "gone" };
const plain = (result: ReleasedResult): Plain => result.kind === "text" ? { kind: "text", text: words(result.text), ...(result.copyOf ? { copyOf: result.copyOf } : {}) }
  : result.kind === "withheld" ? { kind: "withheld", line: outboundWords(result.line) } : result.kind === "refused" ? { kind: "refused", line: outboundWords(result.line), code: result.code } : result;
const release = (deps: ResultEgressDeps, over: Partial<StoredResultRef> = {}, notOwner = false, text?: string): Plain =>
  plain(releaseStoredResult({ ...ref, ...over }, "worker", "asker-thread", { fromBotId: "asker" }, notOwner, text === undefined ? undefined : new WorkerText(text), deps));

describe("the one gate for a stored result", () => {
  it("hands the text on when the request is authorized and nothing withholds the message", () => {
    expect(release(world({ id: "m1", text: SECRET }))).toEqual({ kind: "text", text: SECRET, copyOf: ref.origin });
  });

  it("asks the delivery check first, and a refusal returns the reason with no text", () => {
    const asked: string[] = [];
    const deps = world({ id: "m1", text: SECRET }, { authorize: (id, worker, destination) => { asked.push(`${id}/${worker}/${destination}`); return { ok: false, code: "shared_paused", line: "Sharing was turned off for this team." }; } });
    const released = release(deps);
    expect(released).toEqual({ kind: "refused", line: "Sharing was turned off for this team.", code: "shared_paused" });
    expect(JSON.stringify(released)).not.toContain("41");
    expect(asked).toEqual(["r1/worker/asker-thread"]);
  });

  it("fails closed when nothing proves whose work it was: no request, a mismatched request, or a non-owner audience", () => {
    const stored = { id: "m1", text: SECRET };
    expect(release(world(stored), { requestId: undefined })).toEqual({ kind: "refused", line: RECEIPT_ORIGIN_UNCONFIRMED_LINE, code: "origin_unconfirmed" });
    expect(release(world(stored, { ownUnsharedWork: () => true }), { binding: "mismatch" }).kind).toBe("refused");
    expect(release(world(stored, { ownUnsharedWork: () => true }), { requestId: undefined }, true).kind).toBe("refused");
    expect(release(world(stored, { ownUnsharedWork: () => true }), { requestId: undefined })).toMatchObject({ kind: "text", text: SECRET });
  });

  // 1.0.2 R1: a turn started from the phone or browser door asks a teammate. The peer's turn ran with the same not-owner audience, so its reply
  // comes back; anything owner-only on its lines is still withheld from that reader, and nothing else about the refusal changes.
  it("a not-owner turn's own direct ask gets its peer's reply back, and owner-only material on it stays hidden", () => {
    const stored = { id: "m1", text: SECRET };
    const unbound = { requestId: undefined, peerTurnNotOwner: true as const };
    expect(release(world(stored, { ownUnsharedWork: () => true }), unbound, true)).toMatchObject({ kind: "text", text: SECRET });
    // the flag alone proves nothing about whose work it is
    expect(release(world(stored), unbound, true)).toMatchObject({ kind: "refused", code: "origin_unconfirmed" });
    expect(release(world(stored, { ownUnsharedWork: () => true }), { ...unbound, binding: "mismatch" }, true).kind).toBe("refused");
    expect(release(world(stored, { ownUnsharedWork: () => true }), { ...unbound, recordedNotOwner: true }, true).kind).toBe("refused");
    // owner-only material is judged for the not-owner reader: memory, write-time lines, a captured or forgotten source
    const audiences: boolean[] = [];
    for (const over of [
      { messageMadeWithMemory: () => true },
      { linesShown: (_thread: string, _ids: readonly string[], notOwner: boolean) => { audiences.push(notOwner); return !notOwner; } },
      { capturedMessageWithheld: () => true },
      { messageSourceForgotten: () => true },
    ] satisfies Array<Partial<ResultEgressDeps>>) {
      const released = release(world(stored, { ownUnsharedWork: () => true, ...over }), unbound, true);
      expect(released).toEqual({ kind: "withheld", line: "[withheld]" });
      expect(JSON.stringify(released)).not.toContain("41");
    }
    expect(audiences).toEqual([true]);
    // the same memory-made reply still reaches the owner's own reader
    expect(release(world(stored, { ownUnsharedWork: () => true, messageMadeWithMemory: () => true }), { requestId: undefined })).toMatchObject({ kind: "text", text: SECRET });
  });

  it.each([
    ["a source forgotten after the request settled", { messageSourceForgotten: () => true }],
    ["a captured message", { capturedMessageWithheld: () => true }],
    ["a partition that no longer allows it", { partitionAllowed: () => false }],
    ["a copy whose origin is withheld", { copyOriginWithheld: () => true }],
  ])("%s is withheld, with the line and never the words", (_label, over) => {
    const released = release(world({ id: "m1", text: SECRET }, over));
    expect(released).toEqual({ kind: "withheld", line: "[withheld]" });
    expect(JSON.stringify(released)).not.toContain("41");
  });

  it("a message flagged withheld from bots, and memory a non-owner audience may not see, are withheld", () => {
    expect(release(world({ id: "m1", text: SECRET, withheldFromBots: "forgotten" })).kind).toBe("withheld");
    expect(release(world({ id: "m1", text: SECRET }, { messageMadeWithMemory: () => true }), {}, true).kind).toBe("withheld");
    expect(release(world({ id: "m1", text: SECRET }, { messageMadeWithMemory: () => true }), {}, false).kind).toBe("text");
  });

  it("a receipt's recorded text is withheld when its lineage is unknown or it was made as the owner for a reader who is not", () => {
    const none = world(undefined);
    expect(release(none, { origin: undefined, lineageUnknown: true }, false, SECRET)).toEqual({ kind: "withheld", line: "[withheld]" });
    expect(release(none, { origin: undefined, recordedNotOwner: false }, true, SECRET).kind).toBe("withheld");
  });

  it("worker text with no stored message behind it is withheld, whether the origin is missing or names nothing", () => {
    const none = world(undefined);
    expect(release(none, { origin: undefined, recordedNotOwner: false }, false, SECRET)).toEqual({ kind: "withheld", line: "[withheld]" });
    expect(release(none, { origin: { threadId: "work", messageIds: [] }, recordedNotOwner: false }, false, SECRET)).toEqual({ kind: "withheld", line: "[withheld]" });
    expect(release(world({ id: "m1", text: SECRET }), { origin: ref.origin }, false, SECRET)).toMatchObject({ kind: "text", copyOf: ref.origin });
  });

  it("a result that is gone is gone, and a request that finished without one is gone", () => {
    expect(release(world(undefined)).kind).toBe("gone");
    expect(release(world(undefined), { origin: undefined }).kind).toBe("gone");
  });

  it("every question the gate asks is asked again on every call", () => {
    let forgotten = false;
    const deps = world({ id: "m1", text: SECRET }, { messageSourceForgotten: () => forgotten });
    expect(release(deps).kind).toBe("text");
    forgotten = true;
    expect(release(deps).kind).toBe("withheld");
  });
});


// ── review round 5 ─────────────────────────────────────────────────────────────────────────────────
describe("R5-01: a recorded receipt text never outlives or outranks the originals it came from", () => {
  const two = (second: Partial<EgressMessage>, over: Partial<ResultEgressDeps> = {}): ResultEgressDeps =>
    world(undefined, { message: (_thread, id) => id === "m1" ? { id, text: "clean" } : id === "m2" ? { id, text: SECRET, ...second } : undefined, ...over });
  const both = { origin: { threadId: "work", messageIds: ["m1", "m2"] } };

  it("a receipt whose original conversation was deleted releases nothing, whatever text the receipt kept", () => {
    const released = release(world(undefined), {}, false, "DELETED ANSWER");
    expect(released.kind).toBe("gone");
    expect(JSON.stringify(released)).not.toContain("DELETED");
  });

  it("every referenced message is read: a clean first message does not vouch for a flagged second one", () => {
    const released = release(two({ withheldFromBots: "forgotten" }), both, false, `clean\n${SECRET}`);
    expect(released).toEqual({ kind: "withheld", line: "[withheld]" });
  });

  it("every referenced message must still exist", () => {
    const released = release(two({}, { message: (_thread, id) => id === "m1" ? { id, text: "clean" } : undefined }), both, false, `clean\n${SECRET}`);
    expect(released.kind).toBe("gone");
  });

  it("a copy whose origin is withheld, in any of the messages, withholds the whole result", () => {
    const deps = two({ copyOf: { threadId: "elsewhere", messageIds: ["o2"] } }, { copyOriginWithheld: copy => copy.messageIds[0] === "o2" });
    const read = deps.message; deps.message = (thread, id) => id === "o2" ? { id, text: "origin" } : read(thread, id);
    expect(release(deps, both, false, "x").kind).toBe("withheld");
  });

  it("a partition that disallows any one message's origin withholds the result", () => {
    const deps = two({ copyOf: { threadId: "elsewhere", messageIds: ["o2"] } }, { partitionAllowed: (_worker, _thread, ids) => ids[0] !== "o2" });
    const read = deps.message; deps.message = (thread, id) => id === "o2" ? { id, text: "origin" } : read(thread, id);
    expect(release(deps, both, false, "x").kind).toBe("withheld");
  });

  it("a status-only receipt is Murage's own words: it needs no original, but is still refused when its delivery was", () => {
    // it carries no worker text through the gate: after authorization the caller writes its own status line
    expect(release(world(undefined), { origin: undefined, statusOnly: true }, false, "free provider detail that must never reach a bot")).toEqual({ kind: "status" });
    const refusing = world(undefined, { authorize: () => ({ ok: false, code: "shared_paused", line: "Sharing was turned off for this team." }) });
    expect(release(refusing, { origin: undefined, statusOnly: true }, false, "stopped").kind).toBe("refused");
  });
});

describe("R5-02: an ordinary ask's answer, its partial reply and its mirror copy come from one release of the stored reply", () => {
  const asked = (deps: ResultEgressDeps, text: string, ref: Partial<StoredResultRef> = {}) => {
    const reply: ReleasedAskReply = releaseAskReply({ ...ref, origin: { threadId: "work", messageIds: ["m1"] } }, "worker", "asker-thread", { fromBotId: "asker" }, false, new WorkerText(text), deps);
    return reply.ok ? { ok: true as const, text: outboundWords(reply.text), ...("copyOf" in reply && reply.copyOf ? { copyOf: reply.copyOf } : {}), withheld: reply.withheld } : { ok: false as const, line: outboundWords(reply.line), code: reply.code };
  };

  it("the answer is the stored text when nothing withholds it, with its link for the mirrored copy", () => {
    expect(asked(world({ id: "m1", text: SECRET }), SECRET, { requestId: "r1" })).toEqual({ ok: true, text: SECRET, copyOf: { threadId: "work", messageIds: ["m1"] }, withheld: false });
  });

  it("a reply that became ineligible while the ask was outstanding comes back as the withheld line, with no link and none of the words", () => {
    for (const over of [{ messageSourceForgotten: () => true }, { capturedMessageWithheld: () => true }, { partitionAllowed: () => false }]) {
      const reply = asked(world({ id: "m1", text: SECRET }, over), SECRET, { requestId: "r1" });
      expect(reply).toEqual({ ok: true, text: "[withheld]", withheld: true });
    }
    expect(asked(world({ id: "m1", text: SECRET, withheldFromBots: true }), SECRET, { requestId: "r1" })).toMatchObject({ text: "[withheld]", withheld: true });
  });

  it("a stopped turn's partial reply is the same stored words and goes the same way", () => {
    expect(asked(world({ id: "m1", text: "partial" }, { messageSourceForgotten: () => true }), "partial")).toMatchObject({ ok: false });
    expect(asked(world({ id: "m1", text: "partial" }, { messageSourceForgotten: () => true, ownUnsharedWork: () => true }), "partial")).toEqual({ ok: true, text: "[withheld]", withheld: true });
  });

  it("a refused delivery is the reason and nothing else", () => {
    const refusing = world({ id: "m1", text: SECRET }, { authorize: () => ({ ok: false, code: "shared_paused", line: "Sharing was turned off for this team." }) });
    expect(asked(refusing, SECRET, { requestId: "r1" })).toEqual({ ok: false, line: "Sharing was turned off for this team.", code: "shared_paused" });
  });

  it("a running delegation's recent activity quotes only the rows the gate would release now, tool rows included", () => {
    const rows = [
      { id: "u1", role: "user", kind: "text", text: "do the thing" },
      { id: "m1", role: "bot", kind: "text", text: "visible" },
      { id: "m2", role: "bot", kind: "text", text: SECRET },
      { id: "a1", role: "bot", kind: "activity", tool: { name: "Read /private/FORGOTTEN-PLAN.txt" } },
      { id: "a2", role: "bot", kind: "activity", tool: { name: "Bash ls" } },
    ];
    const stored = new Map<string, EgressMessage>([["u1", { id: "u1", text: "do the thing" }], ["m1", { id: "m1", text: "visible" }], ["m2", { id: "m2", text: SECRET, withheldFromBots: true }],
      ["a1", { id: "a1", text: "Read /private/FORGOTTEN-PLAN.txt" }], ["a2", { id: "a2", text: "Bash ls" }]]);
    const asked: string[] = [];
    const deps = world(undefined, { message: (_thread, id) => stored.get(id), ownUnsharedWork: () => true, messageSourceForgotten: (_thread, id) => id === "a1" });
    const kept = rows.flatMap(row => {
      const out = releaseMessage(sealRow(row), field => { asked.push(row.id); return releaseStoredResult({ origin: { threadId: "work", messageIds: [row.id] } }, "worker", "asker-thread", { fromBotId: "asker" }, false, field.text, deps); });
      return out ? [{ id: row.id, text: out.text ? words(out.text) : undefined, tool: out.tool ? words(out.tool) : undefined }] : [];
    });
    expect(kept.map(row => row.id)).toEqual(["u1", "m1", "a2"]);
    expect(JSON.stringify(kept)).not.toContain("FORGOTTEN");
    // the gate was asked once per row, whatever kind it is
    expect(asked).toEqual(["u1", "m1", "m2", "a1", "a2"]);
  });
});

describe("R6-01: the whole copy chain is read before any word leaves", () => {
  type Row = EgressMessage;
  const chain = (rows: Row[], over: Partial<ResultEgressDeps> = {}) => world(undefined, { message: (_thread, id) => rows.find(row => row.id === id), ownUnsharedWork: () => true, ...over });
  const at = (id: string, copyOf?: string, extra: Partial<Row> = {}): Row => ({ id, text: id === "m0" ? "ANSWER" : undefined, ...(copyOf ? { copyOf: { threadId: "t", messageIds: [copyOf] } } : {}), ...extra });
  const run = (deps: ResultEgressDeps, first = "m0") => plain(releaseStoredResult({ origin: { threadId: "t", messageIds: [first] } }, "worker", "asker-thread", { fromBotId: "asker" }, false, new WorkerText("ANSWER"), deps));

  it("a mirror whose original conversation was deleted is gone, not replayed from the mirror", () => {
    const mirror = { id: "mirror", text: "DELETED ANSWER", copyOf: { threadId: "t", messageIds: ["original"] } };
    expect(run(chain([mirror]), "mirror")).toEqual({ kind: "gone" });
  });
  it("an original that still exists lets the copy through", () => {
    expect(run(chain([at("m0"), at("mirror", "m0")]), "mirror")).toMatchObject({ kind: "text", text: "ANSWER" });
  });
  it("a copy that points back at itself (a to b to a) is withheld", () => {
    expect(run(chain([at("a", "b"), at("b", "a")]), "a")).toMatchObject({ kind: "withheld" });
  });
  it("a chain nine copies deep is withheld, eight is allowed", () => {
    const deep = (n: number) => Array.from({ length: n + 1 }, (_, i) => at(`c${i}`, i < n ? `c${i + 1}` : undefined));
    expect(run(chain(deep(9)), "c0")).toMatchObject({ kind: "withheld" });
    expect(run(chain(deep(8)), "c0")).toMatchObject({ kind: "text" });
  });
  it("a flagged message two copies back withholds the result", () => {
    expect(run(chain([at("m0", "m1"), at("m1", "m2"), at("m2", undefined, { withheldFromBots: "forgotten" })]), "m0")).toMatchObject({ kind: "withheld" });
  });
  it("a chain with more than 64 messages is withheld", () => {
    const wide = [{ id: "root", copyOf: undefined as undefined, text: "x" }, ...Array.from({ length: 70 }, (_, i) => ({ id: `n${i}`, text: "x" }))];
    const group = { threadId: "t", messageIds: wide.slice(1).map(row => row.id) };
    const deps = chain(wide.map(row => ({ ...row })), { message: (_thread, id) => id === "root" ? { id, text: "x", copyOf: group } : wide.find(row => row.id === id) });
    expect(run(deps, "root")).toMatchObject({ kind: "withheld" });
  });
  it("an error while reading is withheld, not thrown", () => {
    expect(run(chain([at("m0")], { message: () => { throw new Error("db"); } }), "m0")).toMatchObject({ kind: "withheld" });
  });
  it("cached receipt words are used only when every message on the chain passes", () => {
    const deps = chain([at("m0", "m1"), at("m1")], { messageSourceForgotten: (_thread, id) => id === "m1" });
    expect(run(deps, "m0")).toMatchObject({ kind: "withheld" });
  });
});

describe("worker words are sealed", () => {
  it("cannot be read as a string, joined, or serialised", () => {
    const sealed = new WorkerText("secret words");
    expect(() => `${sealed}`).toThrow();
    expect(() => String(sealed)).toThrow();
    expect(() => JSON.stringify({ text: sealed })).toThrow();
    expect(() => "" + sealed).toThrow();
  });
  it("released text cannot be made outside the gate and cannot be joined", () => {
    expect(() => ReleasedTextClaim()).toThrow();
    const out = releasedText("fine");
    expect(() => `${out}`).toThrow();
    expect(() => JSON.stringify(out)).toThrow();
  });
});
