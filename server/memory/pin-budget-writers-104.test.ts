// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 pin allowance, the correction writers: a correction that takes over a
// pinned memory's pin (approve with "transfer", and review-edit with keep and
// "transfer") is measured with its NEW words inside the same transaction. When
// the scope's pins would not fit the 2,048-byte share, the press is refused
// with 409 MEMORY_PIN_BUDGET and nothing changes: the old pinned memory stays
// current and the correction stays waiting.
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ensureScope, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

function world() {
  const roster = { bots: [{ id: "bot", name: "Sable", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "m0", at: 1, role: "user", kind: "text", text: "Invoices go out on the 1st of every month" });
  const work = claimMemoryJob("fixture")!; publishMemoryWork(work, "fixture", captureWork(work));
  setMemoryMode("active");
  const db = database(), owner = ownerMemoryTicket(), scope = ensureScope("bot", "bot");
  let tick = Date.now();
  function insert(text: string, state: "active" | "candidate", pinned: boolean, supersedes: string | null = null) {
    const id = randomUUID();
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,?,?,?,?,NULL,?,?)").run(id, scope, text, state === "active" ? "owner-statement" : "assistant-inference", state, pinned ? 1 : 0, ++tick, supersedes, tick);
    db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)").run(id, work.sourceId);
    return id;
  }
  /** A pinned memory, another pin filling most of the share, and a waiting correction of the first. */
  function pinnedWithCorrection(replacement: string) {
    insert("y".repeat(1700), "active", true);
    const target = insert("Invoices go out on the 1st", "active", true);
    const fix = insert(replacement, "candidate", false, target);
    db.prepare("INSERT INTO memory_derivations VALUES(?,1,?,1)").run(target, fix);
    return { target, fix };
  }
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster) as Promise<any>;
  const row = (id: string, version = 1) => db.prepare("SELECT state,text,owner_pinned FROM memory_records WHERE id=? AND version=?").get(id, version) as { state: string; text: string; owner_pinned: number } | undefined;
  return { db, insert, pinnedWithCorrection, act, row };
}
const budgetRefusal = { message: expect.stringMatching(/^MEMORY_PIN_BUDGET: \d+\/2048$/), status: 409, allowed: 2048 };

it("approve with transfer: new words that would not fit with the other pins are refused and nothing changes", async () => {
  const w = world();
  const { target, fix } = w.pinnedWithCorrection(`Invoices go out on the 5th. ${"z".repeat(600)}`);
  await expect(w.act({ action: "approve", id: fix, version: 1, correctionPin: "transfer" })).rejects.toMatchObject(budgetRefusal);
  expect(w.row(target)).toMatchObject({ state: "active", owner_pinned: 1 });
  expect(w.row(fix)).toMatchObject({ state: "candidate", owner_pinned: 0 });
  // Unpin is never measured: the same correction is kept without its pin.
  await expect(w.act({ action: "approve", id: fix, version: 1, correctionPin: "unpin" })).resolves.toBeTruthy();
  expect(w.row(fix)).toMatchObject({ state: "active", owner_pinned: 0 });
});

it("approve with transfer: a correction that fits takes the pin", async () => {
  const w = world();
  const { target, fix } = w.pinnedWithCorrection("Invoices go out on the 5th");
  await expect(w.act({ action: "approve", id: fix, version: 1, correctionPin: "transfer" })).resolves.toBeTruthy();
  expect(w.row(fix)).toMatchObject({ state: "active", owner_pinned: 1 });
  expect(w.row(target)?.state).toBe("superseded");
});

it("review-edit with keep and transfer measures the NEW text: a short proposal edited past the share is refused", async () => {
  const w = world();
  const { target, fix } = w.pinnedWithCorrection("Invoices go out on the 5th");
  const text = `Invoices go out on the 5th. ${"z".repeat(600)}`;
  await expect(w.act({ action: "review-edit", actionId: randomUUID(), id: fix, version: 1, text, keep: true, correctionPin: "transfer" })).rejects.toMatchObject(budgetRefusal);
  expect(w.row(target)).toMatchObject({ state: "active", owner_pinned: 1 });
  expect(w.row(fix)).toMatchObject({ state: "candidate" });
  expect(w.row(fix, 2)).toBeUndefined();
  // The same press with words that fit keeps them, pin and all.
  const kept = await w.act({ action: "review-edit", actionId: randomUUID(), id: fix, version: 1, text: "Invoices go out on the 5th, by noon", keep: true, correctionPin: "transfer" });
  expect(kept.result.status).toBe("kept");
  expect(w.row(fix, 2)).toMatchObject({ state: "active", owner_pinned: 1 });
});
