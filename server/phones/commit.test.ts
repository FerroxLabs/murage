// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseSendId, parsePhoneSendId, sendFingerprint } from "../send-idempotency.ts";
import { SendStore, type SendRow } from "../send-store.ts";
import { commitPhoneLine, PhoneCommitConflict } from "./commit.ts";
import { PhoneReceipts, phoneSendId } from "./receipts.ts";

const file = { kind: "image" as const, path: "a.png", mime: "image/png" };
const ID = "s".repeat(16);

function world(target: () => { ok: true } | { ok: false; code: "revoked" | "target_gone" } = () => ({ ok: true })) {
  const db = new DatabaseSync(":memory:");
  const sendStore = new SendStore(() => db);
  const receipts = new PhoneReceipts(db, sendStore);
  const deleted: NonNullable<SendRow["attachments"]> = [];
  const deps = (over: { target?: typeof target } = {}) => ({
    target: over.target ?? target, sendStore, receipts, deleteFiles: (f: SendRow["attachments"]) => { deleted.push(...(f ?? [])); }, now: () => 5_000,
  });
  return { db, sendStore, receipts, deleted, deps };
}
const recv = (w: ReturnType<typeof world>, over: Record<string, unknown> = {}) =>
  w.receipts.receive({ deviceId: "d1", kind: "share", id: ID, fingerprint: "f", generation: 2, allocatedThreadId: "t1", ...over } as never);
const line = (receipt: ReturnType<typeof recv>, text = "x") => ({ receipt, botId: "b1", threadId: "t1", text, via: "share" as const, files: [file] });

describe("commitPhoneLine", () => {
  it("the check that decides runs inside the section (Astra A3, U25)", () => {
    let hidden = false;
    const w = world();
    const target = () => (hidden ? { ok: false as const, code: "target_gone" as const } : { ok: true as const });
    const r = recv(w);
    hidden = true;
    const out = commitPhoneLine(line(r), w.deps({ target }));
    expect(out).toEqual({ ok: false, code: "target_gone" });
    expect(w.sendStore.queuedRows("t1", "bot")).toHaveLength(0);
    expect(w.receipts.get("d1", "share", ID)?.state).toBe("refused");
    expect(w.receipts.get("d1", "share", ID)?.code).toBe("target_gone");
    expect(w.deleted).toEqual([file]);
  });
  it("a revocation applied before the section refuses; one applied after does not undo a committed line (cutoff)", () => {
    const w = world();
    const r = recv(w);
    let revoked = true;
    const target = () => (revoked ? { ok: false as const, code: "revoked" as const } : { ok: true as const });
    expect(commitPhoneLine(line(r), w.deps({ target }))).toEqual({ ok: false, code: "revoked" });
    const w2 = world();
    const r2 = recv(w2);
    revoked = false;
    const out = commitPhoneLine(line(r2), w2.deps({ target }));
    expect(out.ok).toBe(true);
    revoked = true;
    expect(w2.sendStore.queuedRows("t1", "bot")).toHaveLength(1);
    expect(w2.receipts.get("d1", "share", ID)?.state).toBe("committed");
  });
  it("commits one queue-only unproven via row and flips the receipt", () => {
    const w = world();
    const r = recv(w);
    const out = commitPhoneLine(line(r), w.deps());
    expect(out.ok).toBe(true);
    const rows = w.sendStore.queuedRows("t1", "bot");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ via: "share", queueOnly: true, origin: "unproven", viaDevice: "d1", sendId: phoneSendId("share", "d1", ID), attachments: [file], ownerId: "b1" });
    if (out.ok) expect(out.result).toEqual({ threadId: "t1", queueId: rows[0]!.queueId });
    expect(w.receipts.get("d1", "share", ID)).toMatchObject({ state: "committed", result: { threadId: "t1", queueId: rows[0]!.queueId } });
    expect(w.deleted).toEqual([]);
  });
  it("a retry of a committed receipt returns the first result and writes no second row (U6)", () => {
    const w = world();
    const r = recv(w);
    const first = commitPhoneLine(line(r), w.deps());
    const again = commitPhoneLine(line(r), w.deps({ target: () => ({ ok: false, code: "revoked" }) }));
    expect(again).toEqual(first);
    expect(w.sendStore.queuedRows("t1", "bot")).toHaveLength(1);
  });
  it("a retry of a refused receipt returns its code", () => {
    const w = world();
    const r = recv(w);
    commitPhoneLine(line(r), w.deps({ target: () => ({ ok: false, code: "revoked" }) }));
    expect(commitPhoneLine(line(r), w.deps())).toEqual({ ok: false, code: "revoked" });
    expect(w.sendStore.queuedRows("t1", "bot")).toHaveLength(0);
  });
  it("send ids are namespaced: same id from two phones, share and ask, and a client send id never collide (AS5)", () => {
    const w = world();
    const X = "X".repeat(16);
    const mk = (deviceId: string, kind: "share" | "ask") => w.receipts.receive({ deviceId, kind, id: X, fingerprint: "f", generation: 1 });
    const outs = ([["d1", "share"], ["d2", "share"], ["d1", "ask"]] as const).map(([d, k]) =>
      commitPhoneLine({ receipt: mk(d, k), botId: "b1", threadId: "t1", text: "x", via: k === "ask" ? "ask-intent" : "share", files: [] }, w.deps()));
    expect(outs.every((o) => o.ok)).toBe(true);
    const rows = w.sendStore.queuedRows("t1", "bot");
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.sendId!);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) { expect(parsePhoneSendId(id)).toBe(id); expect(() => parseSendId(id)).toThrow(); }
    const hash = ids[0]!.split(":")[2]!;
    for (const sid of [hash, X]) {
      const res = w.sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "o", fingerprint: sendFingerprint("o"), sendId: sid, status: "queued" });
      expect(res.kind).toBe("new");
    }
    expect(w.sendStore.queuedRows("t1", "bot")).toHaveLength(5);
  });
  it("each accept outcome flips the receipt as specified (AS5)", () => {
    const w = world();
    const sid = phoneSendId("share", "d1", ID);
    const seed = (text: string) => w.sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text, fingerprint: sendFingerprint(text), sendId: sid, status: "queued", origin: "unproven", via: "share", queueOnly: true, viaDevice: "d1" });
    const existing = seed("x");
    const r = recv(w);
    const out = commitPhoneLine(line(r, "x"), w.deps());
    expect(out).toEqual({ ok: true, result: { threadId: "t1", queueId: existing.row.queueId } });
    expect(w.sendStore.queuedRows("t1", "bot")).toHaveLength(1);
    expect(w.receipts.get("d1", "share", ID)?.state).toBe("committed");
    expect(w.deleted).toEqual([]);

    const w2 = world();
    const sid2 = phoneSendId("share", "d1", ID);
    w2.sendStore.accept({ kind: "bot", ownerId: "b1", threadId: "t1", text: "other", fingerprint: sendFingerprint("other"), sendId: sid2, status: "queued", origin: "unproven", via: "share", queueOnly: true, viaDevice: "d1" });
    const r2 = recv(w2);
    expect(() => commitPhoneLine(line(r2, "x"), w2.deps())).toThrow(PhoneCommitConflict);
    expect(w2.receipts.get("d1", "share", ID)?.state).toBe("received");
    expect(w2.sendStore.queuedRows("t1", "bot")).toHaveLength(1);
    expect(w2.deleted).toEqual([]);
  });
  it("a database error in accept rolls back and leaves the receipt received", () => {
    const w = world();
    const r = recv(w);
    const deps = w.deps();
    deps.sendStore = { ...w.sendStore, within: w.sendStore.within.bind(w.sendStore), accept: () => { throw new Error("disk full"); } } as never;
    expect(() => commitPhoneLine(line(r), deps)).toThrow("disk full");
    expect(w.receipts.get("d1", "share", ID)?.state).toBe("received");
  });
  it("commit.ts has no await and no async (source read)", () => {
    const src = readFileSync(new URL("./commit.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/\bawait\b|\basync\b/);
  });
});
