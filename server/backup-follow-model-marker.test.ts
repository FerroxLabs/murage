// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K writes `.threads-follow-model-v1` at the data folder's root on the first start (thread-follow-model.ts). A backup refuses
// any top-level name the inventory does not classify (BACKUP_UNCLASSIFIED_COMPONENT), so on int/104 every backup of a folder that had
// started once stopped. The marker proves the one-time drop of chat model copies already ran on this bots.json, so it travels with
// bots.json: a restore without it would run the drop again and erase a chat model the owner picked since, when it equals the bot's.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { stageInstallationState } from "./installation-state-snapshot.ts";
import { Store } from "./store.ts";
import { FOLLOW_MODEL_MARKER, followCleanupDone } from "./thread-follow-model.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const SAME = { instanceId: "fixture", model: "fixture" };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

it("is classified: backed up and restored with bots.json", () => {
  expect(FOLLOW_MODEL_MARKER).toBe(".threads-follow-model-v1");
  expect(classifyDataDirEntry(FOLLOW_MODEL_MARKER)).toMatchObject({ backup: "owner-file" });
  // its atomic write's leftover is left out (writeFileAtomic: `<name>.<pid>.<uuid>.tmp`)
  expect(classifyDataDirEntry(`${FOLLOW_MODEL_MARKER}.4242.0f8e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp`)).toMatchObject({ backup: "excluded" });
});

it("a folder that started once backs up, and the restore keeps the marker so a chat's own pick equal to the bot's model survives", async () => {
  const store = new Store(() => structuredClone(SAME)), bot = store.createBot();
  expect(existsSync(join(DATA_DIR, FOLLOW_MODEL_MARKER)), "the first start wrote the marker").toBe(true);
  // after 1.0.4: the owner picks, in this chat, the same model the bot has
  store.patchTask(bot.id, bot.threadId, { modelSelection: structuredClone(store.bot(bot.id)!.modelSelection) });
  const { manifest } = await stageInstallationState(DATA_DIR, dirname(DATA_DIR));
  expect(manifest.files.map(item => item.path)).toContain(FOLLOW_MODEL_MARKER);
  const archive = join(dirname(DATA_DIR), "follow-model-backup.zip");
  await writeInstallationArchive(DATA_DIR, archive);
  const prepared = await prepareInstallationRestore(archive, dirname(DATA_DIR));
  // the restored folder says the cleanup already ran, so the next start leaves the owner's pick alone
  expect(followCleanupDone(prepared.stateDirectory)).toBe(true);
  const restored = JSON.parse(readFileSync(join(prepared.stateDirectory, "bots.json"), "utf8")) as Array<{ id: string; tasks: Array<{ threadId: string; modelSelection?: unknown }> }>;
  expect(restored.find(row => row.id === bot.id)!.tasks.find(task => task.threadId === bot.threadId)!.modelSelection, "the pick a second cleanup would erase").toEqual(SAME);
});
