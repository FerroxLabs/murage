// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// A backup keeps saved prompt blocks, reference packs (rows and pinned
// images), render prompts and model checks, and the restored pack still
// resolves to the same bytes.
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { writeInstallationArchive } from "./installation-archive.ts";
import { prepareInstallationRestore } from "./installation-restore-preparation.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { recordImageProbe, recordRenderPrompt, resolveReferencePack, savePromptBlock, saveReferencePack } from "./image-library.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

it("backs up and restores the image library with its pinned pack images", async () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" })); const bot = store.createBot();
  const db = database();
  savePromptBlock(db, { scope: "bot", botId: bot.id, name: "brand-lock", text: "Identity", createdBy: `bot:${bot.id}` });
  saveReferencePack(db, DATA_DIR, { scope: "workspace", name: "hero-refs", references: [{ bytes: PNG, mime: "image/png" }], createdBy: "owner" });
  recordRenderPrompt(db, { operationId: "op-1", prompt: "Identity\n\nscene", blocks: [{ name: "brand-lock", version: 1, scope: "bot", chars: 8 }] });
  recordImageProbe(db, { connectionId: "flux", model: "flux-image", ok: true, at: 1 });
  const tables = ["image_prompt_blocks", "image_reference_packs", "image_render_prompts", "image_model_probes"];
  const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  const parent = dirname(DATA_DIR), archive = join(parent, "image-library-backup.zip");
  await writeInstallationArchive(DATA_DIR, archive);
  const prepared = await prepareInstallationRestore(archive, parent);
  const restored = new DatabaseSync(join(prepared.stateDirectory, "messages.db"), { readOnly: true });
  try {
    inspectInstallationDatabase(restored);
    for (const table of tables) expect(restored.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before[table]);
    const pack = resolveReferencePack(restored, prepared.stateDirectory, { kind: "bot", botId: bot.id }, "hero-refs");
    expect(pack.references.map(item => item.bytes)).toEqual([PNG]);
  } finally { restored.close(); }
});
