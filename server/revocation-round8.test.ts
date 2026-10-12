// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 lane D (revocation, round 8): the resume cursor is never published without its roots, staged images survive a failed
// patch, a project card's result delivery retries before the claim is released (the bus queue bound is in revocation-round9.test.ts).
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DatabaseBusyError } from "./database.ts";
import { adoptStagedImages, retainSession } from "./fold-steps.ts";
import { createProjectCardExecutor } from "./project-card-executor.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { createProjectCard, enqueueCardRun } from "./project-cards.ts";
import { applyCardRunEffect, cardGenerationCurrent } from "./project-turn-engine.ts";
import { createWorkAdmission } from "./work-admission.ts";

afterEach(() => { vi.restoreAllMocks(); });
const busy = () => new DatabaseBusyError("x", 0);

it("a failed root write withholds the cursor, drops the older one and propagates; success saves roots before the cursor", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const log: string[] = [];
  expect(() => retainSession({ recordRoots: () => { log.push("roots"); throw busy(); }, saveCursor: () => log.push("cursor"), dropCursor: () => log.push("drop") })).toThrow(DatabaseBusyError);
  expect(log).toEqual(["roots", "drop"]);
  log.length = 0;
  retainSession({ recordRoots: () => log.push("roots"), saveCursor: () => log.push("cursor"), dropCursor: () => log.push("drop") });
  expect(log).toEqual(["roots", "cursor"]);
});

it("staged images survive a failed patch and attach exactly once on the redelivery", () => {
  const staged = new Map([["t:1", [{ kind: "image", path: "a.png", mime: "image/png" }]]]) as any;
  const reply = { id: "m1", attachments: [] as any[] };
  let fail = true; const patches: any[][] = [];
  const patch = (_id: string, attachments: any[]) => { if (fail) { fail = false; throw busy(); } patches.push(attachments); reply.attachments = attachments; };
  const args = { staged, key: "t:1", reply, patch, push: () => { throw new Error("no push"); } };
  expect(() => adoptStagedImages(args)).toThrow(DatabaseBusyError);
  expect(staged.get("t:1")).toHaveLength(1);
  adoptStagedImages({ ...args, reply });
  expect(patches).toHaveLength(1); expect(patches[0]).toHaveLength(1); expect(staged.has("t:1")).toBe(false);
  // a redelivery after the commit adds nothing twice
  staged.set("t:1", [{ kind: "image", path: "a.png", mime: "image/png" }]);
  adoptStagedImages({ ...args, reply });
  expect(reply.attachments).toHaveLength(1);
});

it("an image-only turn keeps its staging until the pushed message commits", () => {
  const staged = new Map([["t:1", [{ kind: "image", path: "a.png", mime: "image/png" }]]]) as any;
  let fail = true;
  const push = () => { if (fail) { fail = false; throw busy(); } };
  const args = { staged, key: "t:1", reply: undefined, patch: () => {}, push };
  expect(() => adoptStagedImages(args)).toThrow();
  expect(staged.get("t:1")).toHaveLength(1);
  adoptStagedImages(args);
  expect(staged.has("t:1")).toBe(false);
});

function cardFixture() {
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  db.exec("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES('g','ongoing','lead',1)");
  let now = 10000;
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
    speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
    askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => now });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const hooks = { restartCards: vi.fn(), cardGenerationCurrent, cardEffect: (d: DatabaseSync, r: any) => applyCardRunEffect(d, r, { memberIds: ["lead", "jax"], now }), returnThread: () => "room" };
  const executor = createProjectCardExecutor({ db: () => db, admission, now: () => now, open: () => true,
    context: () => ({ groupId: "g", isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: "lead", boardOn: true, parallelCards: 1 }),
    usable: () => true, desk: (r) => `desk-${r.toBotId}`, writerRoot: () => undefined, start: vi.fn(), hooks, changed: vi.fn() });
  const made = createProjectCard(db, { groupId: "g", title: "Reconcile", assigneeBotId: "jax", actor: { kind: "owner" }, memberIds: ["lead", "jax"], now });
  if (!made.ok) throw new Error(made.reason);
  const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now });
  if (!queued.ok) throw new Error(queued.reason);
  db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
  return { db, executor, admission, requestId: queued.requestId };
}

it("a locked room write retries the result delivery and holds the claim until it went through", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = cardFixture();
  try {
    f.executor.pump();
    const claimsBefore = JSON.stringify(f.admission);
    let calls = 0;
    const deliver = vi.fn(() => { calls++; if (calls < 3) throw busy(); });
    f.executor.finish(f.requestId, { ok: true, resultMessageId: "r", deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(JSON.stringify(f.admission)).toBe(claimsBefore);
  } finally { f.executor.stop(); f.db.close(); }
});

it("a delivery that fails for a reason a retry cannot cure is reported once and not retried", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = cardFixture();
  try {
    f.executor.pump();
    const deliver = vi.fn(() => { throw new Error("boom"); });
    f.executor.finish(f.requestId, { ok: true, resultMessageId: "r", deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
  } finally { f.executor.stop(); f.db.close(); }
});
