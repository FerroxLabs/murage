// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 share and ask S37: restart cleanup by references. A real receipts table in an in-memory database, a real temp folder for the
// files, and small stand-ins for the send store's table and the message lookup. Deletion fails closed.
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneReceipts, reclaimShareOrphans } from "./phones/receipts.ts";

const DEVICE = "22222222-2222-4222-8222-222222222222";
const U = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), "murage-reclaim-"));
  const root = join(dir, "attachments");
  const outside = join(dir, "outside");
  mkdirSync(root); mkdirSync(outside);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, status TEXT, attachments TEXT)");
  const receipts = new PhoneReceipts(db, { database: () => db });
  const messages = new Set<string>();
  const put = (n: number, ext = ".png") => { const name = `${U(n)}${ext}`; writeFileSync(join(root, name), `file ${n}`); return name; };
  const att = (name: string, kind: "image" | "file" = "image") => ({ kind, path: join(root, name), mime: kind === "image" ? "image/png" : "application/pdf" });
  const receipt = (id: string, state: "received" | "refused" | "committed", o: { files?: string[]; planned?: number[] } = {}) => {
    receipts.receive({ deviceId: DEVICE, kind: "share", id, fingerprint: "f", generation: 1, allocatedThreadId: "t-" + id });
    if (o.planned) receipts.plan(DEVICE, "share", id, o.planned.map((n) => ({ n, uploadId: U(n), ext: ".png", kind: "image" as const, mime: "image/png" })));
    if (o.files) receipts.setFiles(DEVICE, "share", id, o.files.map((f) => att(f)));
    if (state === "committed") receipts.flip(DEVICE, "share", id, { state: "committed", result: { threadId: "t", queueId: "q" } });
    if (state === "refused") receipts.flip(DEVICE, "share", id, { state: "refused", code: "bot_gone" as never });
  };
  const row = (status: string, attachments: string | null) => db.prepare("INSERT INTO owner_sends (status, attachments) VALUES (?, ?)").run(status, attachments);
  const run = () => reclaimShareOrphans(db, { attachmentsDir: root, messageNames: (n) => messages.has(n), remove: (p) => { try { unlinkSync(p); return { ok: true }; } catch { return { ok: false }; } } });
  const has = (name: string) => existsSync(join(root, name));
  return { root, outside, db, receipts, messages, put, att, receipt, row, run, has };
}
afterEach(() => vi.restoreAllMocks());

describe("restart cleanup by references", () => {
  it("reclaims the files of a received receipt that nothing names, and leaves the receipt received", () => {
    const w = world();
    const a = w.put(1), b = w.put(2, ".pdf");
    w.receipt("s1", "received", { files: [a, b], planned: [1] });
    expect(w.run()).toMatchObject({ deleted: 2, skipped: false });
    expect(w.has(a) || w.has(b)).toBe(false);
  });

  it("reclaims every listed file, in files or by identity in planned (a crash before setFiles)", () => {
    const w = world();
    const a = w.put(1), b = w.put(2, ".pdf"), c = w.put(3);
    w.receipt("s1", "received", { files: [b] });
    w.receipt("s2", "refused", { planned: [1, 3] });
    expect(w.run().deleted).toBe(3);
    expect([a, b, c].some((n) => w.has(n))).toBe(false);
    expect(w.receipts.get(DEVICE, "share", "s1")!.state).toBe("received"); // the receipt and its reserved thread stay
    expect(w.receipts.get(DEVICE, "share", "s1")!.allocatedThreadId).toBe("t-s1");
  });

  it("keeps a file that a queued, dispatched, unconfirmed or refused row names (a Send again row too)", () => {
    const w = world();
    const names = [1, 2, 3, 4].map((n) => w.put(n));
    w.receipt("s1", "refused", { files: names });
    ["queued", "dispatched", "unconfirmed", "refused"].forEach((st, i) => w.row(st, JSON.stringify([w.att(names[i]!)])));
    expect(w.run().deleted).toBe(0);
    expect(names.every((n) => w.has(n))).toBe(true);
  });

  it("keeps a file that a committed receipt lists, even when a refused receipt lists it too", () => {
    const w = world();
    const a = w.put(1);
    w.receipt("s1", "committed", { files: [a] });
    w.receipt("s2", "refused", { files: [a] });
    expect(w.run().deleted).toBe(0);
    expect(w.has(a)).toBe(true);
  });

  it("keeps a refused receipt's file that a message later names", () => {
    const w = world();
    const a = w.put(1), b = w.put(2);
    w.receipt("s1", "refused", { files: [a, b] });
    w.messages.add(a);
    expect(w.run().deleted).toBe(1);
    expect(w.has(a)).toBe(true);
    expect(w.has(b)).toBe(false);
  });

  it("never follows a symlink out of the folder", () => {
    const w = world();
    const target = join(w.outside, "precious.txt");
    writeFileSync(target, "user data");
    const name = `${U(1)}.png`;
    symlinkSync(target, join(w.root, name));
    w.receipt("s1", "received", { planned: [1] });
    const result = w.run();
    expect(result.deleted).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("never deletes through a symlinked directory or a path outside the folder", () => {
    const w = world();
    writeFileSync(join(w.outside, `${U(1)}.png`), "elsewhere");
    w.receipts.receive({ deviceId: DEVICE, kind: "share", id: "s1", fingerprint: "f", generation: 1 });
    w.receipts.setFiles(DEVICE, "share", "s1", [{ kind: "image", path: join(w.outside, `${U(1)}.png`), mime: "image/png" }, { kind: "file", path: "/etc/passwd", mime: "text/plain" }]);
    expect(w.run().deleted).toBe(0);
    expect(existsSync(join(w.outside, `${U(1)}.png`))).toBe(true);
  });

  it("deletes nothing and logs once, with no paths or ids, when a receipt does not parse", () => {
    const w = world();
    const a = w.put(1), b = w.put(2);
    w.receipt("s1", "received", { files: [a] });
    w.receipt("s2", "refused", { files: [b] });
    w.db.prepare("UPDATE phone_receipts SET files='{not json' WHERE id='s2'").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(w.run()).toMatchObject({ deleted: 0, skipped: true });
    expect(w.has(a) && w.has(b)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]![0]);
    expect(text).not.toContain(U(1));
    expect(text).not.toContain("s2");
    expect(text).not.toContain(w.root);
  });

  it("deletes nothing when a queue row's attachments do not parse", () => {
    const w = world();
    const a = w.put(1);
    w.receipt("s1", "received", { files: [a] });
    w.row("queued", "[{broken");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(w.run()).toMatchObject({ deleted: 0, skipped: true });
    expect(w.has(a)).toBe(true);
  });

  it("deletes nothing when the message lookup throws", () => {
    const w = world();
    const a = w.put(1);
    w.receipt("s1", "received", { files: [a] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = reclaimShareOrphans(w.db, { attachmentsDir: w.root, messageNames: () => { throw new Error("db"); }, remove: () => ({ ok: true }) });
    expect(r.skipped).toBe(true);
    expect(w.has(a)).toBe(true);
  });

  it("passes over a planned file that no longer exists, and a second run is the same", () => {
    const w = world();
    const b = w.put(2);
    w.receipt("s1", "received", { planned: [1, 2] }); // file 1 was never written
    expect(w.run()).toMatchObject({ deleted: 1, skipped: false });
    expect(w.has(b)).toBe(false);
    expect(w.run()).toMatchObject({ deleted: 0, skipped: false });
  });

  it("keeps a file when the delete fails, and keeps a retry's re-saved file once the receipt commits", () => {
    const w = world();
    const a = w.put(1);
    w.receipt("s1", "received", { planned: [1] });
    const r = reclaimShareOrphans(w.db, { attachmentsDir: w.root, messageNames: () => false, remove: () => ({ ok: false }) });
    expect(r).toMatchObject({ deleted: 0, kept: 1 });
    w.receipts.flip(DEVICE, "share", "s1", { state: "committed", result: { threadId: "t", queueId: "q" } });
    expect(w.run().deleted).toBe(0);
    expect(w.has(a)).toBe(true);
  });
});
