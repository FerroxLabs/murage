// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XTHREAD-JUDGE T5 (cost): the reader's rule now judges lines of other threads, so its work is bounded and paid for. Statements are
// counted on the database itself (every get and all of every statement, not deny-read's own meter alone): per line judged at most
// 7 + 17(K + 1), K the statements of one page lookup (K <= 15); a record past the chain or line cap judges no line; a kept verdict
// costs no page lookup; a search whose candidates the rule refuses stops at the allowance; an allowance spent across several affordable
// lookups stops, withholds and keeps nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { database } from "../database.ts";
import { lineageReaderOf, readerWithheldMessage } from "./disclosures.ts";
import { recordRestsOnWithheldMessage } from "./replay-lineage.ts";
import { denyLookup, denyReadMeter } from "./deny-read.ts";
import { ensureScope } from "./policy.ts";
import { searchMemory } from "./search.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { bindHumanThread } from "../human-principals.ts";
import { access, channelPerson, exchange, hits, QUERY, resetWorld, world } from "./testing/xthread-world.ts";

afterEach(() => { vi.restoreAllMocks(); });
const big = () => LineageAllowance.tool(1_000_000_000);

/** Counts every get and all of every statement prepared from now on, while `on`. */
function trace() {
  const db = database(), real = db.prepare.bind(db);
  const state = { on: false, count: 0 };
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = real(sql) as unknown as Record<"get" | "all", (...args: unknown[]) => unknown>;
    for (const method of ["get", "all"] as const) {
      const call = statement[method].bind(statement);
      statement[method] = (...args: unknown[]) => { if (state.on) state.count++; return call(...args); };
    }
    return statement as unknown as ReturnType<typeof real>;
  }) as typeof db.prepare);
  return { state, measure<T>(run: () => T): { value: T; statements: number } { const before = state.count; state.on = true; try { return { value: run(), statements: state.count - before }; } finally { state.on = false; } } };
}
function record(id: string, scope: string, evidence: ReadonlyArray<string>): void {
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','active',0,0,NULL,NULL,0)").run(id, scope, `note ${id}`);
  for (const source of evidence) {
    const row = database().prepare("SELECT s.revision,length(CAST(json_extract(v.payload,'$.text') AS BLOB)) AS n FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?").get(source)!;
    database().prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,0,?)").run(id, source, Number(row.revision), Number(row.n));
  }
}

describe("T5: the cross-thread judge is bounded", () => {
  it("256 lines in 256 threads: at most 256 x (7 + 17(K + 1)) + 3 statements, K <= 15; a second check under the same stamp runs no page lookup; past either cap no line is judged", () => {
    resetWorld();
    const tracer = trace();
    const who = channelPerson();
    for (const thread of ["t1", "t2"]) bindHumanThread(thread, who);
    const reader = access("finch", "t2", { human: who, notOwnerAudience: true });
    for (let n = 0; n < 257; n++) exchange(`x${n}`, `g${n}`);
    const scope = ensureScope("conversation", "t1");
    const sources = Array.from({ length: 257 }, (_, n) => `message:x${n}:g${n}`);
    record("r256", scope, sources.slice(0, 256));
    record("r257", scope, sources);
    for (let n = 0; n <= 64; n++) record(`c${n}`, scope, n === 64 ? [sources[0]!] : []);
    for (let n = 0; n < 64; n++) database().prepare("INSERT INTO memory_derivations VALUES(?,1,?,1)").run(`c${n + 1}`, `c${n}`);

    // K: the statements of one page lookup, seen by the trace (the trace sees at least what deny-read's meter counts)
    const meterBefore = denyReadMeter().statements;
    const lineReader = lineageReaderOf(reader);
    const page = tracer.measure(() => denyLookup(database(), { threadId: "x0", lines: [{ messageId: "g0", author: "generated" }] }, lineReader));
    const K = page.statements;
    expect(page.value.get("g0")!.state).toBe("shown");
    expect(K).toBeGreaterThanOrEqual(denyReadMeter().statements - meterBefore);
    expect(K).toBeLessThanOrEqual(15);

    const rule = readerWithheldMessage(reader)!;
    let calls = 0, statements = 0, pageLookups = 0;
    const counted = (thread: string, message: string, allowance: LineageAllowance) => {
      calls++;
      const before = denyReadMeter().statements;
      const judged = tracer.measure(() => rule(thread, message, allowance));
      statements += judged.statements; pageLookups += denyReadMeter().statements - before;
      return judged.value;
    };
    expect(recordRestsOnWithheldMessage(big(), "r256", 1, counted)).toBe(false);
    expect(calls).toBe(256);
    expect(statements).toBeLessThanOrEqual(256 * (7 + 17 * (K + 1)) + 3);
    expect(pageLookups).toBeGreaterThan(0);
    // the same lines again, nothing changed: only the stamp and gate reads, no page lookup
    calls = 0; statements = 0; pageLookups = 0;
    expect(recordRestsOnWithheldMessage(big(), "r256", 1, counted)).toBe(false);
    expect(calls).toBe(256);
    expect(pageLookups).toBe(0);
    expect(statements).toBeLessThanOrEqual(256 * 7);
    // past the caps: withheld, and the rule is never asked
    calls = 0;
    expect(recordRestsOnWithheldMessage(big(), "r257", 1, counted)).toBe(true);
    expect(recordRestsOnWithheldMessage(big(), "c0", 1, counted)).toBe(true);
    expect(calls).toBe(0);
  }, 120_000);

  it("150 search candidates the rule refuses: the search stops at the allowance, partial, without judging them all", async () => {
    const { person: who } = world({ flipFirst: true });
    const reader = access("finch", "t2", { human: who, notOwnerAudience: true });
    const scope = ensureScope("conversation", "t1");
    const refs = Array.from({ length: 150 }, (_, n) => { record(`w${n}`, scope, ["message:t1:g1"]); return { id: `w${n}`, version: 1 }; });
    const rule = readerWithheldMessage(reader)!;
    let calls = 0;
    const counted = (thread: string, message: string, allowance: LineageAllowance) => { calls++; return rule(thread, message, allowance); };
    const allowance = LineageAllowance.tool(100);
    const answer = await searchMemory(QUERY, reader, hits(refs), { allowance, withheldMessage: counted });
    expect(answer.hits).toEqual([]);
    expect(answer.partial).toBe(true);
    expect(allowance.hit).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(150);
  }, 60_000);

  it("an allowance spent across several individually affordable lookups stops, withholds and keeps nothing", () => {
    const { person: who } = world({ flipFirst: true });
    for (let n = 0; n < 16; n++) exchange("orig", `o${n}`);
    exchange("t3", "copy");
    database().prepare("UPDATE messages SET json=json_set(json,'$.copyOf',json(?)) WHERE thread_id='t3' AND id='copy'").run(JSON.stringify({ threadId: "orig", messageIds: Array.from({ length: 16 }, (_, n) => `o${n}`) }));
    const rule = readerWithheldMessage(access("finch", "t2", { human: who, notOwnerAudience: true }))!;
    const tight = LineageAllowance.tool(38);
    const before = denyReadMeter().statements;
    expect(rule("t3", "copy", tight)).toBe(true);
    expect(denyReadMeter().statements - before).toBeGreaterThan(0); // a page was affordable and read before the allowance ran out
    expect(tight.hit).toBe(true);
    // nothing was kept: with room, the line is judged afresh and shown
    const again = denyReadMeter().statements;
    expect(rule("t3", "copy", big())).toBe(false);
    expect(denyReadMeter().statements - again).toBeGreaterThan(0);
  });
});
