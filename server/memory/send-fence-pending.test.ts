// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { denyGeneration, denyLookup, refsLookup, sessionLookup, fenceVerdict, denyReadMeter, resetDenyReadMeter } from "./deny-read.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { assertSendFence, fenceRefusalDiagnosis, setSendFenceDeps } from "./send-fence.ts";
import type { LineageRef } from "./lineage-types.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

const fixtures: WritetimeFixture[] = [];
const make = () => { const f = new WritetimeFixture().cert(true); fixtures.push(f); return f; };
beforeEach(() => setSendFenceDeps(Object.assign({ db: null }, { drain: () => {} })));
afterEach(() => { setSendFenceDeps(Object.assign({ db: null }, { drain: () => {} })); for (const f of fixtures.splice(0)) f.close(); vi.restoreAllMocks(); });
const prefix = (held?: number | null): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 30, shown: ["safe"], ...(held !== undefined ? { held } : {}) });
const built = (ref: LineageRef) => buildPrompt(undefined, [promptPart("safe words", [ref])]);
const refusal = (f: WritetimeFixture, ref: LineageRef) => { try { assertSendFence(built(ref), CONTENT, f.db); } catch (e) { return e; } throw new Error("expected refusal"); };

describe("pending send fence", () => {
  it("R1 fresh listed prefix survives an unrelated generation bump, pending words already withheld", () => {
    const f = make().reply("T", "secret", 10, { turnLsn: 9 }).reply("T", "safe", 25, { turnLsn: 21 }).job(1, 20).pending("*", 10);
    expect(denyLookup(f.db, { threadId: "T", lines: [{ messageId: "secret", author: "generated" }] }, CONTENT).get("secret")).toEqual({ state: "checking", reason: "pending" });
    const prompt = built(prefix(null));
    f.db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
    expect(denyGeneration(f.db)).toBeGreaterThanOrEqual(0);
    expect(() => assertSendFence(prompt, CONTENT, f.db)).not.toThrow();
  });
  it("R2 retained unlisted span remains pending", () => {
    const f = make().reply("T", "safe", 25, { turnLsn: 21 }).job(1, 20).pending("T", 10);
    expect(refusal(f, prefix(15))).toMatchObject({ fence: { state: "checking", reason: "pending" } });
    // A retained bound below the window differs from a legacy wholesale prefix.
    expect(refsLookup(f.db, [prefix(5)], CONTENT)).toEqual({ state: "shown" });
  });
  it("R3 a listed line denied after build refuses even with held null", () => {
    const f = make().reply("T", "safe", 25);
    const prompt = built(prefix(null)); f.denyLine("T", 25);
    f.db.prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
    expect(() => assertSendFence(prompt, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(refusal(f, prefix(null))).toMatchObject({ fence: { state: "withheld", reason: "deny-line" }, counts: { refusedParts: 1 } });
    const error = refusal(f, prefix(null)) as { fence: object };
    expect(fenceRefusalDiagnosis({ verdict: { state: "checking", reason: "private words" } })).toEqual({ refused: "unknown" });
    // EngineInputRevoked retains the verdict while wrapping the original error.
    expect(fenceRefusalDiagnosis({ verdict: error.fence })).toEqual({ refused: "withheld:deny-line", parts: 1 });

    f.sessionLineage("T", "engine", "retained", 1, 20).denySession("T", "engine", "retained");
    f.db.exec("DELETE FROM memory_deny_pending");
    expect(sessionLookup(f.db, { threadId: "T", driverInstance: "engine", nativeSession: "retained" }, CONTENT)).toEqual({ state: "withheld", reason: "deny-session" });
    const memory = buildPrompt(undefined, [promptPart("remembered words", [{ kind: "memory", ref: { kind: "lesson", id: "lesson" } }])]);
    const unchanged = { ...memory, denyGeneration: denyGeneration(f.db) };
    f.denyMemory("lesson", "lesson");
    expect(fenceVerdict(f.db, unchanged, CONTENT)).toEqual({ state: "withheld", reason: "deny-memory" });

  });
  it.each(["lesson", "record", "source"] as const)("B1 unchanged generation refuses %s permanent-mark overflow and lookup failure", kind => {
    const f = make();
    if (kind === "record") f.record("overflow-secret", 1, "s-bot");
    if (kind === "source") f.source("overflow-secret", "s-bot");
    const ref: LineageRef = { kind: "memory", ref: { kind, id: "overflow-secret", ...(kind === "lesson" ? {} : { version: 1 }) } };
    const prompt = { ...built(ref), denyGeneration: denyGeneration(f.db) };
    // The content denial is beyond 256 audience-only marks. The bounded reader
    // cannot establish absence of a content denial and must refuse the write.
    for (let id = 1; id <= 257; id++) {
      f.db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES(?,'overflow-secret',0,?)").run(kind, id);
      if (id <= 256) f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)").run(id);
    }
    expect(denyGeneration(f.db)).toBe(prompt.denyGeneration);
    expect(fenceVerdict(f.db, prompt, CONTENT)).toEqual({ state: "checking", reason: "lookup-error" });
    expect(() => assertSendFence(prompt, CONTENT, f.db)).toThrow("MEMORY_CONTEXT_REVOKED");
    f.db.exec("DROP TABLE memory_deny_memory");
    expect(fenceVerdict(f.db, prompt, CONTENT)).toEqual({ state: "checking", reason: "lookup-error" });
  });
  it("R4 refuses with counts and never invokes an injected legacy drain or writes marker rows", () => {
    const f = make().reply("T", "safe", 25).pending("T", 1);
    const drain = vi.fn(() => { f.db.prepare("DELETE FROM memory_deny_pending").run(); });
    // Runtime regression injection: the public dependency type must also omit drain.
    setSendFenceDeps(Object.assign({ db: () => f.db }, { drain }));
    const before = f.db.prepare("SELECT total_changes() AS n").get();
    expect(refusal(f, prefix())).toMatchObject({ counts: { refusedParts: 1 } });
    expect(drain).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
  it("R5 legacy wholesale prefix stays fail closed", () => {
    const f = make().reply("T", "safe", 25).pending("T", 1);
    expect(refusal(f, prefix())).toMatchObject({ fence: { state: "checking", reason: "pending" }, counts: { refusedParts: 1 } });
  });
  it("R6 missing-session fallback holds the whole unlisted span", () => {
    const f = make().reply("T", "safe", 25).pending("T", 1);
    expect(refusal(f, prefix(30))).toMatchObject({ fence: { state: "checking", reason: "pending" }, counts: { refusedParts: 1 } });
  });
  it("R4 caps raw audience-only candidates and SQL VM work before filtering", () => {
    const work: number[] = [];
    for (const n of [1000, 10000]) {
      const f = make().reply("T", "safe", 25);
      f.db.exec("BEGIN");
      const pending = f.db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES('*',1,?)");
      const audience = f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(?)");
      for (let id = 1; id <= n; id++) { pending.run(id); audience.run(id); }
      f.db.exec("COMMIT");
      resetDenyReadMeter();
      expect(refsLookup(f.db, [prefix(20)], CONTENT)).toEqual({ state: "checking", reason: "pending" });
      const sql = denyReadMeter().sql.find(text => text.startsWith("WITH raw AS MATERIALIZED") && text.includes("FROM memory_deny_pending "));
      expect(sql).toBeTruthy();
      const file = String(f.db.prepare("PRAGMA database_list").all().find(r => r.name === "main")?.file);
      const measured = spawnSync("python3", ["-c", `import sqlite3,sys,json
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
steps=0
def tick():
 global steps
 steps+=1
 return 0
c.set_progress_handler(tick,1)
rows=c.execute(sys.argv[2],('*',257)).fetchall()
print(json.dumps({'steps':steps,'rows':len(rows)}))
`, file, sql!], { encoding: "utf8" });
      expect(measured.status, measured.stderr).toBe(0);
      const result = JSON.parse(measured.stdout);
      expect(result.rows).toBe(257); expect(result.steps).toBeLessThan(20000);
      work.push(result.steps);
      f.db.exec("BEGIN");
      const mark = f.db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('T',25,?,25,'fixture')");
      for (let id = 1; id <= n; id++) mark.run(id);
      f.db.exec("COMMIT");
      resetDenyReadMeter();
      expect(refsLookup(f.db, [prefix(null)], CONTENT)).toEqual({ state: "checking", reason: "lookup-error" });
      const markSql = denyReadMeter().sql.find(text => text.startsWith("SELECT lsn,revoke_id FROM memory_deny_line"));
      expect(markSql).toMatch(/LIMIT \?$/);
      expect(f.db.prepare(markSql!).all("T", "[25]", 257)).toHaveLength(257);

    }
    expect(Math.abs(work[1] - work[0])).toBeLessThan(100);
  });

});
