// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1024-memrecall (ASTRA-MEMCLAIMS row 5): notes that apply to every team (GENERAL.md) are rendered into the prompt only up to
// 16,000 bytes, while the notebook load cap is 24,000. Recall skips the imported chunks of a notebook the prompt "carries whole";
// judged by the load cap, a 20 KB GENERAL.md's tail was in neither the prompt nor recall. The turn builds both exactly as
// index.ts does: standingContextParts for the prompt and standingContextSourceIds as the bundle's excludeSourceIds.
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { resetDataRootsForTest } from "./data-roots.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { teamIdFor } from "./team-identities.ts";
import { partitionRoots } from "./execution-audience.ts";
import { standingContextParts, standingContextSourceIds } from "./standing-context.ts";
import { reconcileMemoryRoster } from "./memory/policy.ts";
import { fixtureMemoryAccess } from "./testing/recall-access-fixture.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { previewMemoryImport, commitMemoryImport } from "./memory/import.ts";
import { buildMemoryBundleAfterReset } from "./memory/dispatch.ts";
import { closeMemoryIndexReader } from "./memory/index-reader.ts";
import { emptyBridge, indexPendingRecords } from "./memory/testing/recall-fixture.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

useOutsideStoreFixture();
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); });
afterEach(() => closeMemoryIndexReader());

const TAIL = "Storage unit gate code is 4417 zebra";
function generalNotes(bytes: number): string {
  const lines: string[] = [];
  for (let n = 0; Buffer.byteLength(lines.join("\n")) < bytes; n++) lines.push(`- Note ${n}: keep the shared folders tidy, label every box with its owner and date, archive anything older than a year, and tell the team in the weekly thread.`);
  const text = `${lines.join("\n")}\n- ${TAIL}\n`;
  // under the notebook's 200-line load cap, so only the byte limits decide
  expect(text.split("\n").length).toBeLessThan(200);
  return text;
}

for (const size of [20_000, 8_000] as const)
it(`W2 a GENERAL.md fact at byte ~${size} reaches the turn: in the prompt or in recall, never in neither`, async () => {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const iris = store.createBot(); store.patchBot(iris.id, { name: "Iris", section: "Design" });
  const sales = teamIdFor("Sales");
  iris.partitionedAt = 1; iris.sharedWith = { mode: "list", teams: [{ id: sales, name: "Sales" }] };
  const work = store.createSharedWorkTask(iris.id, sales)!;
  const partition = { kind: "team" as const, teamId: sales };
  const general = partitionRoots(iris, { kind: "general" })[0]; mkdirSync(general, { recursive: true });
  writeFileSync(join(general, "GENERAL.md"), generalNotes(size));
  reconcileMemoryRoster(store);
  database().exec("UPDATE memory_meta SET mode='active'");
  const ticket = ownerMemoryTicket();
  const preview = previewMemoryImport(ticket, [{ kind: "partition", botId: iris.id, partition: { kind: "general" } }], store);
  expect(commitMemoryImport(ticket, preview.previewId, store).recordIds.length).toBeGreaterThan(0);
  await indexPendingRecords();
  const registry = new InternalCapabilities(); registry.begin(iris.id, work.threadId, "generation");
  const token = registry.mint({ botId: iris.id, threadId: work.threadId, generation: "generation", depth: 0, kind: "memory", skillAuthoring: false });
  const access = fixtureMemoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => store);
  const prompt = standingContextParts(iris, { ownerAudience: true, fileTools: false, partition }).memory;
  const bundle = await buildMemoryBundleAfterReset("storage unit gate code", access, emptyBridge, undefined,
    { allowance: LineageAllowance.tool(), excludeSourceIds: standingContextSourceIds(iris, true, partition) });
  const seen = { inPrompt: prompt.includes(TAIL), inRecall: bundle.text.includes(TAIL) };
  expect(seen).not.toEqual({ inPrompt: false, inRecall: false });
  // a notebook the prompt carries whole is still not sent twice
  if (size === 8_000) expect(seen).toEqual({ inPrompt: true, inRecall: false });
});
