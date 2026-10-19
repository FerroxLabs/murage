// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN 2.9 r6 (Astra pip-build r4). A result conclusion stored as admitted is kept across a stop or a restart only while its window
// is still admitted: a deny that lands after conclusion and before publication clears it at the stop and at the startup sweep. And every
// paid model call counts toward the three attempts: a held result dropped because publication's read moved spends its attempt.
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
import { maintainPip, pipReadHooks, readReflectState, runPipReflect, type ReflectDeps } from "./pip-reflect.ts";

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
const recordsWithWords = () => Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE ?").get(`%${WORDS}%`)!.n);

/** `inFlight` runs on a second connection inside the dispatch (after the fence, before the answer). */
async function rig(inFlight?: (other: import("node:sqlite").DatabaseSync) => void) {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  other.exec("CREATE TABLE IF NOT EXISTS zz_unrelated(x)");
  const lived = { proposals: [], stance: [], episode: { text: `The owner shared three secrets today and asked that each be ${WORDS}.`, sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async () => { inFlight?.(other); return completion(lived); }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  const deny = () => other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0);
  return { deps, fetchImpl, other, deny, close: () => other.close() };
}
/** Runs `at` at every hand-back while the family is validated (after conclusion, before publication's transaction). */
function whileValidated(at: () => void, once = true) {
  let fired = 0;
  pipReadHooks.between = () => { if ((once && fired) || family()?.state !== "validated") return; fired++; at(); };
  return () => fired;
}

it("deny then stop: a stored admitted result is cleared by the stop, and the family asks again", async () => {
  const r = await rig();
  const stop = new AbortController();
  let stored = false;
  const fired = whileValidated(() => { stored = family()?.resultAdmitted === true && bindingRow().includes(WORDS); r.deny(); stop.abort(); });
  try {
    const outcome = await runPipReflect(r.deps, undefined, stop.signal);
    expect(fired()).toBe(1);
    expect(stored).toBe(true);
    expect(outcome).toMatchObject({ status: "uncertain", reason: "cancelled" });
    expect(bindingRow()).not.toContain(WORDS);
    expect(family()).toMatchObject({ state: "pending", attempt: 2, reason: "result-revoked" });
    expect(family()?.result).toBeUndefined();
    expect(recordsWithWords()).toBe(0);
  } finally { r.close(); }
});

it("deny then restart: the startup sweep revalidates a stored admitted result and clears it", async () => {
  const r = await rig();
  const stop = new AbortController();
  let row = "";
  const fired = whileValidated(() => { r.deny(); row = bindingRow(); stop.abort(); });
  try {
    await runPipReflect(r.deps, undefined, stop.signal);
    expect(fired()).toBe(1);
    // the process died after the deny and before anything else ran: what is on disk is the row as conclusion left it
    expect(JSON.parse(row).run.families.lived.resultAdmitted).toBe(true);
    database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id='pip-reflect:moss'").run(row);
    expect(bindingRow()).toContain(WORDS);
    pipReadHooks.between = undefined;
    await maintainPip(r.deps, { startup: true });
    expect(bindingRow()).not.toContain(WORDS);
    expect(family()).toMatchObject({ state: "pending", attempt: 2, reason: "result-revoked" });
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  } finally { r.close(); }
});

it("no deny: a stored result still admitted survives a stop and the startup sweep, and is published without a second call", async () => {
  const r = await rig();
  const stop = new AbortController();
  whileValidated(() => stop.abort());
  try {
    await runPipReflect(r.deps, undefined, stop.signal);
    expect(family()).toMatchObject({ state: "validated", attempt: 1, resultAdmitted: true });
    pipReadHooks.between = undefined;
    await maintainPip(r.deps, { startup: true });
    expect(family()).toMatchObject({ state: "validated", attempt: 1, resultAdmitted: true });
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(family()?.state ?? "settled").not.toBe("validated");
    expect(family()?.result).toBeUndefined();
  } finally { r.close(); }
});

it("three read moves of held results: at most three paid calls, then refused unstable", async () => {
  let n = 0;
  // an unrelated commit elsewhere inside the dispatch moves the stamp: conclusion holds the result in memory
  const r = await rig(other => other.prepare("INSERT INTO zz_unrelated VALUES(?)").run(++n));
  // and another before publication's transaction moves its read too
  whileValidated(() => r.other.prepare("INSERT INTO zz_unrelated VALUES(?)").run(++n), false);
  try {
    for (let pass = 0; pass < 8; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(3);
    // the third paid call's words were dropped too: the family is refused unstable (the run then settles) with the cooldown
    const state = readReflectState(database(), "moss");
    expect(state.refusals.some(x => x.state === "refused:unstable" && x.reason === "read-moved")).toBe(true);
    expect(state.run?.families.lived?.state ?? "refused:unstable").toBe("refused:unstable");
    expect(state.cooldownUntil).toBeGreaterThan(T0 + 60 * MIN);
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
  } finally { r.close(); }
});
