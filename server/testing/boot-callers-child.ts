// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child of server/boot-step-callers.test.ts (D5) and server/venue-post-held.test.ts (E1): a NORMAL start on a small filesystem, rows written, then the disk
// taken below the worker's floor (ballast) until the worker publishes its refusal; then one real boot caller runs. One JSON line comes back.
// Usage: boot-callers-child.ts <sends|venue|composed> <ballast file>
const [scenario, ballast = ""] = process.argv.slice(2);
const dataDir = process.env.MURAGE_DATA_DIR;
if (!dataDir || !process.env.BOOT_CALLERS_CHILD) { process.stderr.write("refusing: not started by a boot caller test\n"); process.exit(2); }
const { closeSync, mkdirSync, openSync, statfsSync, unlinkSync, writeSync } = await import("node:fs");
const { closeDatabase, database, transaction } = await import("../database.ts");
const { DiskFloorRefusal } = await import("../db-busy.ts");
const { isReadOnly, readOnlyState, skippedAtStart, startMode } = await import("../read-only-start.ts");
const { assertWalWriteAdmission, walMaintenanceReady } = await import("../wal-maintenance.ts");
const { recoverOwnerSends, recoverVenuePostsAtBoot } = await import("../boot-recoveries.ts");
const { sendStore } = await import("../send-store.ts");
const { sendFingerprint } = await import("../send-idempotency.ts");
const { Store } = await import("../store.ts");
const held = await import("../venue-post-held.ts");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const MiB = 1024 * 1024;
const run = (fn: () => unknown) => { try { fn(); return undefined; } catch (error) { return error; } };

mkdirSync(dataDir, { recursive: true });
const mode = startMode(dataDir);
const db = database();
for (let i = 0; i < 400 && !walMaintenanceReady(); i++) await sleep(25);
const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
sendStore.use(() => database());

// rows a previous run left behind: a send in flight, and a venue post cut short with its card
const send = sendStore.accept({ kind: "bot", ownerId: "bot-1", threadId: "t-send", text: "in flight", fingerprint: sendFingerprint("in flight") }).row;
sendStore.markDispatched(send.seq);
const card = store.appendMessage("t-1to1", { role: "bot", kind: "activity", text: "wants to post", card: { title: "Post it?" } } as never);
held.holdVenuePost(db, { id: "vpost-a", botId: "b1", threadId: "t-1to1", origin: "desktop", requestMessageId: "m1", requestHash: "h", venueId: "g1", targetThreadId: "t-room", text: "Hello room", stableId: "vpost-a", lineage: "[]" });
held.setVenuePostCard(db, "vpost-a", card.id);
held.moveVenuePost(db, "vpost-a", "held", "posting");

const settle = (row: import("../venue-post-held.ts").VenuePostHeldRow) => {
  const message = store.messageById(row.threadId, row.cardMessageId!);
  if (message?.card) store.patchMessage(row.threadId, row.cardMessageId!, { card: { ...message.card, answered: held.VENUE_POST_CARD_POST } });
  store.appendMessage(row.threadId, { role: "bot", kind: "activity", tool: { name: "Posted", ok: true } } as never);
};
const cardAnswered = () => (store.messageById("t-1to1", card.id)?.card as { answered?: string } | undefined)?.answered ?? null;
const out: Record<string, unknown> = { scenario, startMode: mode };

const fd = openSync(ballast, "a"); const buf = Buffer.alloc(MiB, 1);
try { for (;;) { const s = statfsSync(dataDir); const left = s.bavail * s.bsize - 40 * MiB; if (left <= 0) break; writeSync(fd, buf, 0, Math.min(MiB, left)); } } finally { closeSync(fd); }
let verdict: unknown;
for (let i = 0; i < 400 && !(verdict = run(() => assertWalWriteAdmission())); i++) await sleep(50);
out.verdict = verdict instanceof DiskFloorRefusal ? "DiskFloorRefusal" : String(verdict);
out.readOnlyBefore = isReadOnly();

const sendRow = () => sendStore.bySeq(send.seq)?.status;
const venueRow = () => held.heldVenuePost(db, "vpost-a")?.state;
if (scenario === "sends") {
  recoverOwnerSends({
    database: () => database(), live: () => true, threadIsLive: () => true, broadcastSends: () => {},
    io: { landed: () => undefined, appendReceipt: () => {} },
  });
  Object.assign(out, { sendRow: sendRow() });
} else if (scenario === "venue") {
  recoverVenuePostsAtBoot(db, op => transaction(op), () => true, settle);
  Object.assign(out, { venueRow: venueRow(), cardAnswered: cardAnswered() });
} else {
  const first = run(() => held.recoverAndSettleVenuePosts(db, op => transaction(op), () => true, settle));
  Object.assign(out, { first: first instanceof DiskFloorRefusal ? "DiskFloorRefusal" : String(first), rowAfterRefusal: venueRow(), cardAfterRefusal: cardAnswered() });
  unlinkSync(ballast);
  let clear = false;
  for (let i = 0; i < 600 && !clear; i++) { clear = run(() => assertWalWriteAdmission()) === undefined; if (!clear) await sleep(50); }
  const second = run(() => held.recoverAndSettleVenuePosts(db, op => transaction(op), () => true, settle));
  Object.assign(out, { cleared: clear, second: second === undefined ? "ok" : String(second), rowAfterRetry: venueRow(), cardAfterRetry: cardAnswered() });
}
Object.assign(out, { readOnlyAfter: isReadOnly(), reason: readOnlyState()?.reason ?? null, skipped: [...skippedAtStart] });
closeDatabase();
process.stdout.write(`BCRESULT ${JSON.stringify(out)}\n`);
process.exit(0);
