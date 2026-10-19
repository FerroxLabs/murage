// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN r3 T4 (run half): the attempt passes its admission stamp to the adapter as `transport.fence`. A forget that lands while the
// HTTP adapter awaits its address check (after every check of the run itself) stops the request before fetch: the family is pending,
// one read move is counted, no transport attempt is charged, and its transport record is gone.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { setMemoryMode } from "./repository.ts";
import { forgetMemory } from "./forget.ts";

import { removeTempDirSync } from "../testing/cleanup.ts";
const gate = vi.hoisted(() => ({ wait: null as null | (() => Promise<void>) }));
vi.mock("../local-address-guard.ts", async original => {
  const real = await original<typeof import("../local-address-guard.ts")>();
  return { ...real, checkLocalServerUrl: async (url: string) => { await gate.wait?.(); return real.checkLocalServerUrl(url); } };
});
const { httpTextOnlyTurn } = await import("../drivers/http-text-only.ts");
const { readReflectState, runPipReflect } = await import("./pip-reflect.ts");
type ReflectDeps = import("./pip-reflect.ts").ReflectDeps;

const T0 = 1_760_000_000_000, MIN = 60_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
const ticket = ownerMemoryTicket();
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
});
afterEach(() => { setMemoryCaptureRoster(null); gate.wait = null; });

it("a forget while the HTTP adapter awaits its address check: fetch is never called, the family is pending, one read move, no attempt charged", async () => {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
  let forgot = false;
  gate.wait = async () => { if (forgot) return; forgot = true; forgetMemory(ticket, { kind: "source", id: "message:private:o1" }); };
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
  expect(forgot).toBe(true);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ status: "uncertain", reason: "read-moved" });
  const family = readReflectState(database(), "moss").run!.families.lived;
  expect(family).toMatchObject({ state: "pending", attempt: 1, readMoves: 1 });
  expect(family.transport).toBeUndefined();
  // no transient refusal was recorded against the route
  expect(readReflectState(database(), "moss").support["fp-http"]?.status).not.toBe("transient");
});

// r2 (Astra pip-build H, external writers): the fence is the linearization point (PIP-REDESIGN 2.9). A commit by another connection
// after the fence's last sample and before the bytes leave is, by definition, after the send: the result it shaped is validated, then
// publication re-reads the window by identity, finds the retired source gone, discards the result (f.result cleared) and re-snapshots.
// The injection point is the dispatch itself: fetchImpl runs after the fence with no await between them, and commits before it answers.
it("a source retired by another connection between the fence and the dispatch: the result is never published, the row never stored, the next request omits it", async () => {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  const bodies: string[] = [];
  const lived = { proposals: [], stance: [], episode: { text: "The owner shared Secret 1 and two more secrets today, asking that each of them be kept safe.", sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
  const empty = { proposals: [], stance: [], episode: null };
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) { other.exec("UPDATE memory_sources SET state='retired' WHERE id='message:private:o1'"); return completion(lived); }
    return completion(empty);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  try {
    const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toContain("Secret 1");
    expect(bodies[1]).not.toContain("Secret 1");
    expect(outcome).toMatchObject({ status: "applied" });
    // the first result (an episode quoting the retired source) was discarded before anything of it was written
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE '%Secret 1%'").get()!.n)).toBe(0);
    const s = readReflectState(database(), "moss");
    expect(s.run).toBeUndefined();
    expect(s.refusals).toEqual([]);
  } finally { other.close(); }
});

// r4 (Astra pip-build r2 H, the deny half): the same window, but the writer is a deleted conversation (a memory_deny row for the thread)
// committed by another connection between the fence's last data_version sample and the dispatch. Publication's re-read of the window by
// identity finds the thread denied, so the digest differs: the result is discarded before anything of it is written, the family
// re-snapshots, the re-snapshot of a denied thread has no sources, and the run is cleared. No second request is sent: there is nothing
// left to show. Nothing of the result is stored anywhere, and no refusal is charged to the route.
it("a conversation deleted by another connection between the fence and the dispatch: the result is never published or stored, the run is cleared", async () => {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  const bodies: string[] = [];
  const lived = { proposals: [], stance: [], episode: { text: "The owner shared Secret 1 and two more secrets today, asking that each of them be kept safe.", sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    // the deny lands after the fence sampled data_version and before the bytes leave: by definition after the send
    other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0);
    return completion(lived);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  try {
    const outcome = await runPipReflect(deps, undefined, new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toContain("Secret 1");
    expect(outcome.status).not.toBe("applied");
    // nothing of the result was written: no record or episode carries its words, and no family holds it
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE '%Secret%'").get()!.n)).toBe(0);
    const s = readReflectState(database(), "moss");
    expect(s.run).toBeUndefined();
    expect(s.refusals).toEqual([]);
    expect(s.support["fp-http"]?.status).not.toBe("transient");
  } finally { other.close(); }
});
