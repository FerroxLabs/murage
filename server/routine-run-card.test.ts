// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), row E2: a failure between the unread mark and the card loses nothing, for a group and for a task.
// The unread write is made to fail for real (the data directories are read-only, which a uid other than root honours; the file is skipped for root), on a
// real Store. The card is only written after the unread mark, so a refused first call writes no card and the retry writes the card, sets the unread in the
// right store and sends one notification. Both writers are covered: the source-chat card (routine-run-card.ts) and the delivery card (routine-delivery.ts).
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { deliverRoutineRun, routineResultId, type DeliveryBot, type RoutineDeliveryDeps } from "./routine-delivery.ts";
import { writeRoutineRunCard, type RoutineCardDeps, type RoutineCardSource } from "./routine-run-card.ts";
import type { RoutineRun } from "./routines.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const root = typeof process.getuid === "function" && process.getuid() === 0;
const selection = () => ({ instanceId: "fixture", model: "fixture" });
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); });
afterEach(() => { setDirs(0o755); closeMessageDb(); removeTempDirSync(DATA_DIR); });

/** Every directory under the data dir (and it), read-only or writable again. Files already open (the message database) stay writable. */
function setDirs(mode: number, dir = DATA_DIR): void {
  try { statSync(dir); } catch { return; }
  chmodSync(dir, mode);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) setDirs(mode, join(dir, entry.name));
}

function world(kind: "group" | "task") {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Painter" });
  const task = store.createTask(bot.id, "Chat")!;
  const group = kind === "group" ? store.createGroup("Room", [bot.id])! : undefined;
  const threadId = group ? group.threadId! : task.threadId;
  const run = {
    id: "run-1", routineId: "routine-1", routineName: "Morning picture", target: "bot", botId: bot.id, status: "completed", manual: false, scheduledFor: 0,
    createdAt: Date.now(), sourceThreadId: threadId, output: "done", delivery: { state: "pending" }, watch: { outcome: "changed" },
  } as unknown as RoutineRun;
  const unread = () => group ? store.group(group.id)?.unread === true : store.taskByThread(bot.id, threadId)?.unread === true;
  const cards = () => { const found: string[] = []; store.scanSince(threadId, 0, m => { if (m.kind === "routine.run") found.push(m.id); return false; }); return found; };
  return { store, bot, group, threadId, run, unread, cards };
}

describe.skipIf(root)("E2 a failure between the unread mark and the card loses nothing", () => {
  for (const kind of ["group", "task"] as const) {
    it(`source-chat card, ${kind}: no card when the unread mark fails, then card + unread + one notification`, () => {
      const w = world(kind);
      const notified: string[] = [];
      const source: RoutineCardSource = { threadId: w.threadId, bot: { id: w.bot.id, name: w.bot.name, color: w.bot.color }, ...(w.group ? { group: { id: w.group.id } } : {}) };
      const deps: RoutineCardDeps = {
        newestSince: (threadId, at, test) => { let found; w.store.scanSince(threadId, at, m => (test(m) ? ((found = m), true) : false)); return found; },
        patchMessage: (t, id, patch) => w.store.patchMessage(t, id, patch),
        appendMessage: (t, message) => w.store.appendMessage(t, message),
        patchGroup: (id, patch) => w.store.patchGroup(id, patch),
        patchTask: (b, t, patch) => w.store.patchTask(b, t, patch),
        notifyChanged: (_s, summary) => { notified.push(summary); },
      };
      setDirs(0o555);
      expect(() => writeRoutineRunCard(w.run, source, deps)).toThrow();
      expect(w.cards()).toEqual([]);
      expect(notified).toEqual([]);
      setDirs(0o755);
      expect(writeRoutineRunCard(w.run, source, deps)).toBe(w.threadId);
      expect(w.cards()).toHaveLength(1);
      expect(w.unread()).toBe(true);
      expect(notified).toHaveLength(1);
    });

    it(`delivery card, ${kind}: no card when the unread mark fails, then card + unread`, () => {
      const w = world(kind);
      const bot: DeliveryBot = { id: w.bot.id, name: w.bot.name, color: w.bot.color };
      const deps: RoutineDeliveryDeps = {
        owner: () => ({ bot, ...(w.group ? { group: { id: w.group.id } } : {}) }),
        mainChat: () => null, isMainChat: () => null, threadExists: () => true,
        messageById: (t, id) => w.store.messageById(t, id),
        appendMessage: (t, message, stableId) => w.store.appendMessage(t, message, stableId),
        patchMessage: (t, id, patch) => { w.store.patchMessage(t, id, patch); },
        markUnread: target => { if (target.group) w.store.patchGroup(target.group.id, { unread: true }); else w.store.patchTask(target.bot.id, target.threadId, { unread: true }); },
        runFiles: () => [], recordDelivery: () => {},
      };
      setDirs(0o555);
      expect(() => deliverRoutineRun(w.run, deps, true)).toThrow();
      expect(w.store.messageById(w.threadId, routineResultId(w.run.id))).toBeUndefined();
      setDirs(0o755);
      expect(deliverRoutineRun(w.run, deps, true)).toBe(w.threadId);
      expect(w.store.messageById(w.threadId, routineResultId(w.run.id))).toBeDefined();
      expect(w.unread()).toBe(true);
    });
  }
});
