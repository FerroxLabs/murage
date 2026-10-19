// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-REDESIGN 2.9 r8 (Astra pip-build r6). The paid-call cap holds across an upgrade or a restart: a family an older build wrote, with no
// stored count, is charged with what the durable record shows was sent, and an unknown is counted as sent. And no terminal state ever
// commits with result words: every write of the reflect state clears them in the same transaction.
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
import * as reflect from "./pip-reflect.ts";
import { mutateReflect, pipReadHooks, readReflectState, runPipReflect, type FamilyStateName, type ReflectDeps } from "./pip-reflect.ts";

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
const lived = { proposals: [], stance: [], episode: { text: `The owner shared three secrets today and asked that each be ${WORDS}.`, sourceIds: ["message:private:o1", "message:private:o2", "message:private:o3"] } };

async function rig(opts: { probe?: boolean; content?: unknown } = {}) {
  const db = database();
  for (let i = 1; i <= 3; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * MIN, role: "user", kind: "text", text: `Secret ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * MIN + 1000, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
  const { DatabaseSync } = await import("node:sqlite");
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  const content = opts.content ?? lived;
  const completion = (v: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(v) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (String(init?.body ?? "").includes('Return {\\"ok\\":true}')) return completion({ ok: true });
    return completion(content);
  }) as unknown as typeof fetch;
  const bot = { id: "moss", name: "Moss", threadIds: ["private"], continuity: true, options: { reflect: true as const } };
  const deps: ReflectDeps = {
    now: () => T0 + 60 * MIN, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", probeRequired: opts.probe, engine: "Stub http", kind: "http", model: "m", textOnlyTurn: input => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  };
  // what an older build (r5) persisted: the family without its stored count, written by another connection as a restart would find it
  const asOlderBuild = () => other.prepare("UPDATE memory_scope_bindings SET intent=json_remove(intent,'$.run.families.lived.paidCalls') WHERE id='pip-reflect:moss'").run();
  const deny = () => other.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','private',1,?)").run(T0);
  return { deps, fetchImpl, other, asOlderBuild, deny, close: () => other.close() };
}
/** The rule under test, stated here so the test reads the same on a build without the export. */
const isTerminalFamilyState = (s: FamilyStateName) => s.startsWith("refused:") || s === "applied" || s === "off";
const pass = (deps: ReflectDeps, signal = new AbortController().signal) => runPipReflect(deps, undefined, signal);

it("an older build's family after one successful probe and one failed content call: one more call at most, three in all", async () => {
  const r = await rig({ probe: true, content: { nope: 1 } });
  let stripped = 0;
  pipReadHooks.between = () => { if (!stripped && family()?.attempt === 2) { stripped++; r.asOlderBuild(); } };
  try {
    for (let i = 0; i < 10; i++) await pass(r.deps);
    expect(stripped).toBe(1);
    expect(r.fetchImpl).toHaveBeenCalledTimes(3);
    expect(family()?.state ?? "refused:unstable").toMatch(/^refused:/);
  } finally { r.close(); }
});

it("an older build's family with no record of what its attempt sent counts that attempt as sent", async () => {
  const r = await rig({ content: { nope: 1 } });
  let stripped = 0;
  pipReadHooks.between = () => { if (!stripped && family()?.attempt === 2) { stripped++; r.asOlderBuild(); } };
  try {
    for (let i = 0; i < 10; i++) await pass(r.deps);
    expect(stripped).toBe(1);
    // attempt 1 sent one call; the stripped attempt 2 is counted as sent, so its own call reaches the cap
    expect(vi.mocked(r.fetchImpl).mock.calls.length).toBeLessThanOrEqual(2);
    expect(family()?.state ?? "refused:unstable").toMatch(/^refused:/);
  } finally { r.close(); }
});

// Every terminal state a family can reach. A refusal's reason is open (`refused:${verdict.reason}`), so any refused:* is terminal.
const TERMINAL: FamilyStateName[] = ["applied", "off", "refused:off", "refused:unstable", "refused:cap", "refused:transient", "refused:unsupported", "refused:bad-output", "refused:schema", "refused:some-future-reason"];
const LIVE: FamilyStateName[] = ["pending", "requested", "uncertain-transport", "validated", "catch-up"];

it("every terminal state commits without result words, whatever path wrote it; live states keep theirs", () => {
  const exported = (reflect as { isTerminalFamilyState?: (s: FamilyStateName) => boolean }).isTerminalFamilyState;
  for (const s of TERMINAL) expect(exported?.(s), s).toBe(true);
  for (const s of LIVE) expect(exported?.(s), s).toBe(false);
  for (const state of [...TERMINAL, ...LIVE]) {
    mutateReflect("moss", s => {
      s.run = { runId: "r-" + state, kind: "reflect", threadId: "private", fromMessageId: null, toMessageId: null, toAt: T0, window: { bytes: 0 }, bootEpoch: { pid: 1, startedAt: 1 }, createdAt: T0, fingerprint: "fp",
        families: { lived: { state, attempt: 3, paidCalls: 3, snapshotGen: "g", result: lived as never, resultAdmitted: true } } };
    });
    if (isTerminalFamilyState(state)) {
      expect(bindingRow(), state).not.toContain(WORDS);
      expect(family()?.result, state).toBeUndefined();
      expect(family()?.resultAdmitted, state).toBeUndefined();
    } else expect(family()?.result, state).toBeDefined();
  }
});

it("a stored result on the last attempt, denied before publication's stamp: refused unstable commits without the words", async () => {
  const r = await rig();
  // a log of every committed reflect state, from any connection
  r.other.exec("CREATE TABLE zz_log(intent TEXT); CREATE TRIGGER zz_t AFTER UPDATE ON memory_scope_bindings WHEN NEW.id='pip-reflect:moss' BEGIN INSERT INTO zz_log VALUES(NEW.intent); END;");
  try {
    // pass 1 stops during publication's read: the result stays stored and admitted
    const stop = new AbortController();
    let fired = 0;
    pipReadHooks.between = () => { if (!fired && family()?.state === "validated") { fired++; stop.abort(); } };
    await pass(r.deps, stop.signal);
    pipReadHooks.between = undefined;
    expect(fired).toBe(1);
    expect(family()).toMatchObject({ state: "validated", resultAdmitted: true });
    // the stored result is on its last attempt; the deny lands before the next publication takes its stamp
    r.other.prepare("UPDATE memory_scope_bindings SET intent=json_set(intent,'$.run.families.lived.attempt',3) WHERE id='pip-reflect:moss'").run();
    r.deny();
    await pass(r.deps);
    const committed = r.other.prepare("SELECT intent FROM zz_log").all().map(x => JSON.parse(String(x.intent)) as { run?: { families: Record<string, { state: FamilyStateName; result?: unknown }> } });
    const terminalWithWords = committed.filter(s => Object.values(s.run?.families ?? {}).some(f => isTerminalFamilyState(f.state) && f.result !== undefined));
    expect(committed.some(s => Object.values(s.run?.families ?? {}).some(f => f.state === "refused:unstable"))).toBe(true);
    expect(terminalWithWords).toEqual([]);
    expect(bindingRow()).not.toContain(WORDS);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  } finally { r.close(); }
});
