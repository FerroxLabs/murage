// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN 2.9 r7 (Astra pip-build r5). Every path that leaves a stored result in place after a move revalidates it against admission
// as it stands: a deny that lands during publication's read, which answers `moved`, clears the stored result. And one family-wide count of
// paid calls, probes and content alike, caps a run at three calls that reach a provider, whatever the fingerprint does.
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
import { pipReadHooks, readReflectState, runPipReflect, type ReflectDeps } from "./pip-reflect.ts";

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
async function rig(inFlight?: (other: import("node:sqlite").DatabaseSync) => void, opts: { probe?: boolean; fingerprint?: () => string; content?: unknown } = {}) {
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
  const content = opts.content ?? lived;
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    inFlight?.(other);
    if (String(init?.body ?? "").includes('Return {\\"ok\\":true}')) return completion({ ok: true });
    return completion(content);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: opts.fingerprint?.() ?? "fp-http", probeRequired: opts.probe, engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
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

it("deny during publication's read, which answers moved: the stored result is cleared, never kept as validated", async () => {
  const r = await rig();
  let stored = false, after = "";
  // the first hand-back of publication's read: the result is stored and admitted; the deny lands inside the read, which then answers moved
  const fired = whileValidated(() => { stored = family()?.resultAdmitted === true && bindingRow().includes(WORDS); r.deny(); });
  try {
    const outcome = await runPipReflect(r.deps, undefined, new AbortController().signal);
    after = bindingRow();
    expect(fired()).toBe(1);
    expect(stored).toBe(true);
    expect(outcome).toMatchObject({ status: "uncertain" });
    // what the move left on disk holds none of the revoked words
    expect(after).not.toContain(WORDS);
    expect(family()?.result).toBeUndefined();
    expect(family()?.state).not.toBe("validated");
    expect(recordsWithWords()).toBe(0);
    pipReadHooks.between = undefined;
    for (let pass = 0; pass < 3; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(bindingRow()).not.toContain(WORDS);
    expect(recordsWithWords()).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  } finally { r.close(); }
});

it("an unrelated move during publication's read keeps a stored result still admitted, published without a second call", async () => {
  let n = 0;
  const r = await rig();
  const fired = whileValidated(() => r.other.prepare("INSERT INTO zz_unrelated VALUES(?)").run(++n));
  try {
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(fired()).toBe(1);
    expect(family()).toMatchObject({ state: "validated", attempt: 1, resultAdmitted: true });
    pipReadHooks.between = undefined;
    await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(family()?.state ?? "settled").not.toBe("validated");
  } finally { r.close(); }
});

it("a successful probe and failing content attempts: three paid calls in all, then refused unstable", async () => {
  const r = await rig(undefined, { probe: true, content: { nope: 1 } });
  try {
    for (let pass = 0; pass < 10; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(3);
    const state = readReflectState(database(), "moss");
    expect(state.run?.families.lived?.state ?? "refused:unstable").toBe("refused:unstable");
    expect(state.refusals.some(x => x.state.startsWith("refused:"))).toBe(true);
  } finally { r.close(); }
});

it("a new fingerprint before every attempt: probes count too, three paid calls in all", async () => {
  let fp = 0;
  const r = await rig(undefined, { probe: true, fingerprint: () => `fp-${++fp}`, content: { nope: 1 } });
  try {
    for (let pass = 0; pass < 12; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(vi.mocked(r.fetchImpl).mock.calls.length).toBeLessThanOrEqual(3);
    expect(vi.mocked(r.fetchImpl).mock.calls.length).toBeGreaterThan(0);
    const state = readReflectState(database(), "moss");
    expect(state.run?.families.lived?.state ?? "refused:unstable").toMatch(/^refused:/);
  } finally { r.close(); }
});

it("a probe then content that succeeds: two paid calls, the cap leaves the normal path alone", async () => {
  const r = await rig(undefined, { probe: true });
  try {
    for (let pass = 0; pass < 4; pass++) await runPipReflect(r.deps, undefined, new AbortController().signal);
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
    const state = readReflectState(database(), "moss");
    expect(state.refusals.some(x => x.reason === "paid-calls")).toBe(false);
    expect(state.run?.families.lived?.state ?? "applied").toBe("applied");
  } finally { r.close(); }
});
