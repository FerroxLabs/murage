// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The WebAssembly helper's first search after an idle exit, through searchMemory with its production deadlines (150 ms turn
// cutoff, 1 s tool cutoff): the real controller forks the real helper (WebAssembly forced), the real model loads. After the
// helper has left for being idle, a turn starts; once the helper reports its model loaded and warmed (about 2 s), a search
// finds a meaning-only match. A search made before that still answers from words. Runs only where the pinned model is prepared
// and RESPAWN_BENCH is set (the hz-test lane).
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeDatabase, database } from "../database.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { clearMemorySearchCache, searchMemory } from "./search.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import type { ModelManifest } from "./embeddings.ts";
import { accessFor, captureAndPublish, freshDataDir } from "./testing/recall-fixture.ts";

const manifest = JSON.parse(readFileSync(resolve("shared/memory-model-manifest.json"), "utf8")) as ModelManifest;
const modelDirectory = resolve(".planning/memory-evidence/model");
const prepared = manifest.files.every(file => existsSync(join(modelDirectory, file.path)));
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
let controller: MemoryWorkerController | undefined;
beforeEach(() => { process.env.MURAGE_MEMORY_BACKEND = "wasm"; freshDataDir("active"); });
afterEach(async () => { await controller?.stop(); controller = undefined; closeMemoryIndexReader(); closeDatabase(); delete process.env.MURAGE_MEMORY_BACKEND; });
async function until(what: string, ok: () => boolean, ms = 120_000) { const by = Date.now() + ms; while (!ok()) { if (Date.now() > by) throw new Error(`timed out: ${what}`); await sleep(50); } }

it.runIf(prepared && process.env.RESPAWN_BENCH)("after an idle exit, a turn's start warms the helper and a search two seconds later finds the meaning-only match", { timeout: 300_000 }, async () => {
  captureAndPublish("Orchidneedle. The vehicle needs gasoline to travel.");
  for (let n = 0; n < 12; n++) captureAndPublish(`Note ${n}: the team agreed on item ${n} for the quarterly plan and moved the review to Thursday.`);
  controller = new MemoryWorkerController({ modelDirectory, wasmIdleExitMs: 4000 });
  controller.start();
  await until("every record indexed", () => Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE embedding_status!='indexed' OR lexical_status!='indexed'").get()!.n) === 0);
  const { access } = accessFor();
  const run = (caller: "turn" | "tool") => searchMemory("car fuel", access, controller!, { allowance: LineageAllowance.tool(1_000_000_000), caller });
  // The helper leaves for being idle.
  await until("the helper left", () => !controller!.status().running, 60_000);
  // Before the turn: nothing is warm, a search is words only (and still answers).
  const cold = await run("turn");
  expect(cold.hits.some(hit => /Orchidneedle/.test(String((hit as { text?: string }).text ?? "")))).toBe(false);
  await until("the helper left again", () => !controller!.status().running, 60_000);
  const turnStart = performance.now();
  const release = controller.holdForTurn();
  await until("model warm", () => controller!.modelWarm, 30_000);
  const warmMs = performance.now() - turnStart;
  console.log(`WARM-TIMING ${JSON.stringify({ warmMs: Math.round(warmMs) })}`);
  await sleep(Math.max(0, 2000 - warmMs));
  for (const caller of ["turn", "tool"] as const) {
    clearMemorySearchCache();
    const answer = await run(caller);
    expect(answer.degradedReason, caller).toBeUndefined();
    expect(answer.hits.some(hit => /Orchidneedle/.test(String((hit as { text?: string }).text ?? ""))), caller).toBe(true);
  }
  release();
});
