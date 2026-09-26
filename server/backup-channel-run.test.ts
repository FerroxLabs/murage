// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 audit A-04: one Telegram, Slack or Discord message to a bot is
// saved as a routine run (server/index.ts, RoutineManager.enqueueWebhook) with
// triggerSource "channel" and routineId "<platform>:<connection>". The backup
// kept its own hand-written list of allowed values, which had neither, so
// every later backup failed with INVALID_INSTALLATION_RECORDS and the page
// said "Murage couldn't say why". The allowed values now come from
// shared/record-values.ts, the list the runtime types are derived from.
//
// These runs are written by the real RoutineManager, then backed up through
// the real stage + fidelity path, and (with the age tools) encrypted,
// restored into a new folder and checked.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RoutineManager } from "./routines.ts";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { writeEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { reviewInstallation } from "./installation-activation.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { ROUTINE_RUN_STATUSES, ROUTINE_RUN_TRIGGERS } from "../shared/record-values.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";

const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
const now = Date.UTC(2026, 8, 26);

function manager(data: string) {
  return new RoutineManager({
    file: join(data, "routines.json"), now: () => now, automaticPaused: () => false,
    botState: () => "busy", createTask: () => ({ threadId: "task-1" }), channelThread: id => ({ threadId: `channel-${id}` }),
    startTurn: async () => {}, interruptTurn: async () => {},
    // The paired Slack and Discord bindings are current, as in the app.
    isChannelCurrent: () => true,
  } as ConstructorParameters<typeof RoutineManager>[0]);
}
function channelMessage(routines: RoutineManager, platform: "telegram" | "slack" | "discord", index: number) {
  const connectionId = `paired-owner-${platform}`;
  routines.enqueueWebhook({
    webhookId: `${platform}:${connectionId}`, webhookName: `${platform} message`,
    ...(platform === "telegram" ? { telegramConnectionId: connectionId } : { channelOrigin: { platform, connectionId } }),
    prompt: "What is on today?", botId: "bot", runOn: "ember", deliveryId: `update-${index}`, receivedAt: now,
    humanPrincipal: { personId: "workspace-owner", bindingId: "local", revision: 1 },
  } as Parameters<RoutineManager["enqueueWebhook"]>[0]);
}

it("backs up after messages from Telegram, Slack and Discord reached a bot", async () => {
  const f = backupFixture();
  const routines = manager(f.data);
  (["telegram", "slack", "discord"] as const).forEach((platform, index) => channelMessage(routines, platform, index));
  const runs = JSON.parse(readFileSync(join(f.data, "routines.json"), "utf8")).runs;
  expect(runs.map((run: { triggerSource: string }) => run.triggerSource)).toEqual(["channel", "channel", "channel"]);
  try {
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      await inventoryFidelity(installation, stage, selection);
      rmSync(stage.directory, { recursive: true, force: true });
    });
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});

it("backs up while a routine run sits at needs-you (a closed-app backup reads the file as the app left it)", async () => {
  const f = backupFixture();
  writeFileSync(join(f.data, "routines.json"), JSON.stringify({ version: 1, routines: [], runs: [{
    id: "run-1", routineId: "routine-1", routineName: "Wait check", botId: "bot", scheduledFor: 1, status: "needs-you", manual: true, createdAt: 1, triggerSource: "manual",
  }] }));
  try {
    await withOfflineInstallation(f.data, async installation => {
      const stage = await stageInstallationStateWhileOwned(installation, f.parent);
      await inventoryFidelity(installation, stage, selection);
      rmSync(stage.directory, { recursive: true, force: true });
    });
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
});

// One source of truth: every value the runtime may write is one the backup accepts.
it("accepts every run status and trigger the runtime declares", () => {
  const runs = ROUTINE_RUN_STATUSES.flatMap((status, index) => ROUTINE_RUN_TRIGGERS.map((trigger, other) => ({
    id: `run-${index}-${other}`, routineId: `${trigger}:source-${index}`, routineName: "Any", botId: "bot", scheduledFor: 1, status, manual: trigger === "manual", createdAt: 1, triggerSource: trigger,
  })));
  expect(() => assertInstallationRecords("routines.json", { version: 1, routines: [], runs })).not.toThrow();
});

it.skipIf(!process.env.MURAGE_BACKUP_TEST_AGE_DIR)("a channel run survives an encrypted backup and restore, paused", async () => {
  const f = backupFixture(), keys = testAgeKeys();
  const routines = manager(f.data);
  channelMessage(routines, "telegram", 1);
  try {
    const archive = join(f.parent, "b.age");
    const saved = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    const restored = join(f.parent, "restored");
    await restoreEncryptedInstallationNew(restored, archive, saved.sha256, keys);
    const run = JSON.parse(readFileSync(join(restored, "routines.json"), "utf8")).runs[0];
    expect({ trigger: run.triggerSource, routineId: run.routineId, status: run.status }).toEqual({ trigger: "channel", routineId: "telegram:paired-owner-telegram", status: "cancelled" });
    expect(reviewInstallation(restored).status).toBe("ready-for-review");
  } finally { f.db.close(); rmSync(f.parent, { recursive: true, force: true }); }
}, 60_000);
