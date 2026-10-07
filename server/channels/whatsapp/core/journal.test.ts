// Copyright 2026 Ferrox Labs
// Pending-retention regression follows OpenClaw 4e5bf66fb18 (451 accepted records), MIT, OpenClaw Foundation.
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { compactJournal, foldJournal, hasMessage, JOURNAL_DONE_MAX, JOURNAL_DONE_TTL_MS, JOURNAL_REPLAY_BATCH, parseJournal, pendingBatch, type JournalRow } from "./journal.ts";

const NOW = 1_800_000_000_000;
const row = (seq: number, patch: Partial<JournalRow> = {}): JournalRow => ({ seq, receivedAt: NOW - 1000, remoteJid: "1@s.whatsapp.net", id: `M${seq}`, done: false, ...patch });

describe("compactJournal", () => {
  it("never deletes pending rows: not the 451st, not a 31-day-old one", () => {
    const rows = Array.from({ length: 451 }, (_, i) => row(i + 1, { receivedAt: NOW - 31 * 24 * 3_600_000 }));
    const kept = compactJournal(rows, NOW);
    expect(kept).toHaveLength(451);
    expect(kept.map((r) => r.seq)).toEqual(rows.map((r) => r.seq));
  });
  it("drops done rows after 7 days", () => {
    const rows = [row(1, { done: true, doneAt: NOW - JOURNAL_DONE_TTL_MS - 1 }), row(2, { done: true, doneAt: NOW - JOURNAL_DONE_TTL_MS + 1 }), row(3)];
    expect(compactJournal(rows, NOW).map((r) => r.seq)).toEqual([2, 3]);
  });
  it("keeps the newest 5000 done rows and every pending row among them", () => {
    const rows = [...Array.from({ length: JOURNAL_DONE_MAX + 10 }, (_, i) => row(i + 1, { done: true, doneAt: NOW - 5 })), row(99_999)];
    const kept = compactJournal(rows, NOW);
    expect(kept.filter((r) => r.done)).toHaveLength(JOURNAL_DONE_MAX);
    expect(kept.filter((r) => r.done)[0].seq).toBe(11);
    expect(kept.at(-1)?.seq).toBe(99_999);
  });
  it("honours smaller limits for tests", () => {
    const rows = [row(1, { done: true, doneAt: NOW }), row(2, { done: true, doneAt: NOW }), row(3)];
    expect(compactJournal(rows, NOW, { doneMax: 1 }).map((r) => r.seq)).toEqual([2, 3]);
  });
});

describe("pendingBatch", () => {
  it("returns the first 450 pending rows in arrival order and says more are waiting", () => {
    const rows = [...Array.from({ length: 460 }, (_, i) => row(460 - i)), row(1000, { done: true })];
    const batch = pendingBatch(rows);
    expect(batch.rows).toHaveLength(JOURNAL_REPLAY_BATCH);
    expect(batch.rows[0].seq).toBe(1);
    expect(batch.truncated).toBe(true);
    expect(pendingBatch(rows.slice(0, 5)).truncated).toBe(false);
  });
});

describe("parseJournal and hasMessage", () => {
  it("reads ndjson, ignoring a torn last line and garbage", () => {
    const text = [JSON.stringify(row(1)), "not json", JSON.stringify({ seq: "x" }), JSON.stringify(row(2, { done: true, doneAt: 5 })), '{"seq":3,"recei'].join("\n");
    const { rows, skipped } = parseJournal(text);
    expect(rows.map((r) => [r.seq, r.done])).toEqual([[1, false], [2, true]]);
    expect(skipped).toBe(3);
  });
  it("finds a redelivered message by chat and id", () => {
    const rows = [row(1)];
    expect(hasMessage(rows, "1@s.whatsapp.net", "M1")).toBe(true);
    expect(hasMessage(rows, "2@s.whatsapp.net", "M1")).toBe(false);
  });
});

describe("foldJournal", () => {
  it("lets a later done line win while keeping the earlier payload, in sequence order", () => {
    const rows = [row(2, { payload: { a: 1 } }), row(1, { payload: { b: 2 } }), row(2, { done: true, doneAt: NOW })];
    const folded = foldJournal(rows);
    expect(folded.map((r) => [r.seq, r.done])).toEqual([[1, false], [2, true]]);
    expect(folded[1].payload).toEqual({ a: 1 });
  });
});
