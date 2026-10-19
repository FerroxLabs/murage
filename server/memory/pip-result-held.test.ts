// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN 2.9 (Astra pip-build r3 High): the model's result is never stored in the reflect binding before admission is revalidated.
// A conversation deleted by another connection inside the dispatch (fetchImpl, after the fence) moves the attempt's stamp, so conclusion
// stores nothing of the result and hands it, in memory only, to publication. The binding row is read at the first hand-back after
// conclusion, before publication's cleanup: it must not carry the result's words then, nor after a crash at that point, nor after a stop.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setMemoryMode } from "./repository.ts";
import { httpTextOnlyTurn } from "../drivers/http-text-only.ts";
import { maintainPip, mutateReflect, pipReadHooks, readReflectState, runPipReflect, type ReflectDeps, type RunRecord } from "./pip-reflect.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const T0 = 1_760_000_000_000, MIN = 60_000;
const WORDS = "kept safe";
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { setMemoryCaptureRoster(null); pipReadHooks.between = undefined; });

const bindingRow = () => String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='pip-reflect:moss'").get()?.intent ?? "");
const family = () => readReflectState(database(), "moss").run?.families.lived;
const recordsWithWords = () => Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE '%Secret%' OR text LIKE ?").get(`%${WORDS}%`)!.n);

async function rig() {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  const lived = { proposals: [], stance: [], episode: { text: `The owner shared three secrets today and asked that each be ${WORDS}.`, sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async () => {
    // the deny lands after the fence's last sample and before the answer: inside the in-flight window
    other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0);
    return completion(lived);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  return { deps, fetchImpl, close: () => other.close() };
}
/** Runs `at` once, at the first hand-back after conclusion (the family validated, publication not yet finished). */
function afterConclusion(at: () => void) {
  let fired = false;
  pipReadHooks.between = () => { if (fired || family()?.state !== "validated") return; fired = true; at(); };
  return () => fired;
}

it("a deny inside the dispatch: right after conclusion, before cleanup, the binding row holds none of the result's words", async () => {
  const r = await rig();
  let row = "";
  const fired = afterConclusion(() => { row = bindingRow(); });
  try {
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fired()).toBe(true);
    expect(row).not.toContain(WORDS);
    expect(JSON.parse(row).run.families.lived.result).toBeUndefined();
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
    expect(readReflectState(database(), "moss").run).toBeUndefined();
  } finally { r.close(); }
});

it("a crash right after conclusion: the durable row holds none of the result's words, and the restart asks again without storing any", async () => {
  const r = await rig();
  let row = "";
  const fired = afterConclusion(() => { row = bindingRow(); });
  try {
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(fired()).toBe(true);
    expect(row).not.toContain(WORDS);
    // the process died at that point: what is on disk is that row
    database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='pip-reflect:moss'").run(row);
    expect(bindingRow()).not.toContain(WORDS);
    await maintainPip(r.deps, { startup: true });
    expect(bindingRow()).not.toContain(WORDS);
    expect(family()).toMatchObject({ state: "pending", attempt: 2 });
    pipReadHooks.between = undefined;
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
    // the re-snapshot of a denied thread has nothing to show: no second request, the run is cleared
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(readReflectState(database(), "moss").run).toBeUndefined();
  } finally { r.close(); }
});

it("a stop right after conclusion: the binding row holds none of the result's words and the family asks again", async () => {
  const r = await rig();
  const stop = new AbortController();
  let row = "";
  const fired = afterConclusion(() => { row = bindingRow(); stop.abort(); });
  try {
    const outcome = await runPipReflect(r.deps, undefined, stop.signal);
    expect(fired()).toBe(true);
    expect(outcome).toMatchObject({ status: "uncertain", reason: "cancelled" });
    expect(row).not.toContain(WORDS);
    expect(bindingRow()).not.toContain(WORDS);
    expect(family()).toMatchObject({ state: "pending", attempt: 2 });
    expect(family()?.result).toBeUndefined();
    expect(recordsWithWords()).toBe(0);
  } finally { r.close(); }
});

it("a result an older build stored before revalidating is cleared at startup, and the family asks again", async () => {
  const r = await rig();
  try {
    mutateReflect("moss", s => {
      s.run = { runId: "old", kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: "o3", toAt: T0 + 3 * MIN, window: { bytes: 1 }, bootEpoch: { pid: 0, startedAt: 0 },
        createdAt: T0, fingerprint: "fp-http", families: { lived: { state: "validated", attempt: 1, snapshotGen: "g",
          result: { proposals: [], stance: [], episode: { text: `Older words to be ${WORDS}.`, sourceIds: ["message:private:o1"] } } as never } } } as RunRecord;
    });
    expect(bindingRow()).toContain(WORDS);
    await maintainPip(r.deps, { startup: true });
    expect(bindingRow()).not.toContain(WORDS);
    expect(family()).toMatchObject({ state: "pending", attempt: 2, reason: "result-cleared" });
  } finally { r.close(); }
});
