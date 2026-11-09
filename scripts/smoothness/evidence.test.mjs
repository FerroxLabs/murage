// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rig v5.9 round 2: the evidence helpers tested directly (A1, A2) and the scrubber's one-budget / escape grammar (A3, A4, P2-6).
import { describe, expect, it } from "vitest";
import { evidenceLedger, writeEvidence } from "./evidence.mjs";
import { scrubAccounting } from "./smooth-config.mjs";

const ledger = (overrides = {}) => {
  const results = { phase: "running", status: "RUNNING" }, writes = [], exits = [];
  const ledger = evidenceLedger({ results, writeResults: overrides.writeResults ?? (() => writes.push(structuredClone(results))), setExitCode: c => exits.push(c) });
  return { results, writes, exits, ledger };
};
const denied = Object.assign(Error("EACCES: private path /home/x"), { code: "EACCES" });

describe("writeEvidence (A1): append, fsync and close failures each fail the leg with a code-only reason", () => {
  const io = failing => {
    const calls = [], reasons = [];
    const step = name => () => { calls.push(name); if (failing === name) throw denied; };
    return { calls, reasons, options: { open: () => { calls.push("open"); if (failing === "open") throw denied; return 7; },
      append: step("append"), fsync: step("fsync"), close: step("close"), fail: r => reasons.push(r) } };
  };
  it("a clean write returns true, calls open/append/fsync/close in order, never fails", () => {
    const { calls, reasons, options } = io(null);
    expect(writeEvidence({ a: 1 }, options)).toBe(true);
    expect(calls).toEqual(["open", "append", "fsync", "close"]); expect(reasons).toEqual([]);
  });
  it.each(["open", "append", "fsync", "close"])("%s failure returns false with the errno code and no message text", failing => {
    const { calls, reasons, options } = io(failing);
    expect(writeEvidence({ a: 1 }, options)).toBe(false);
    expect(reasons).toEqual(["failed-turn journal write failed: EACCES"]);
    expect(reasons.join()).not.toContain("private");
    if (failing !== "open") expect(calls).toContain("close"); // the descriptor is always closed
  });
  it("a record that does not serialize fails without opening the journal", () => {
    const { calls, reasons, options } = io(null);
    expect(writeEvidence({ a: 1 }, { ...options, serialize: () => undefined })).toBe(false);
    expect(calls).toEqual([]); expect(reasons).toHaveLength(1);
  });
});

describe("evidenceLedger (A1, A2)", () => {
  it("fail() latches, saves synchronously and sets exit code 1", () => {
    const { results, writes, exits, ledger: l } = ledger();
    l.fail("reason one");
    expect(results).toMatchObject({ legFailed: true, status: "FAIL", legFailureReason: "reason one" });
    expect(writes).toHaveLength(1); expect(exits).toContain(1); // no scheduled save: the write already happened
  });
  it("a throwing results write inside fail() records a code-only persistence failure and moves finished to cleanup", () => {
    const { results, ledger: l } = ledger({ writeResults: () => { throw denied; } });
    results.phase = "finished";
    expect(() => l.fail("first")).not.toThrow();
    expect(results).toMatchObject({ evidencePersistenceFailed: true, phase: "cleanup", legFailed: true });
    expect(results.evidenceFailures).toContain("failed-turn results save failed: EACCES");
    expect(JSON.stringify(results)).not.toContain("private");
  });
  it("finish() with a throwing write returns 1 and never leaves phase finished", async () => {
    const { results, exits, ledger: l } = ledger({ writeResults: () => { throw denied; } });
    const code = await l.finish({ shutdown: async () => true, drain: async () => {}, complete: ok => { if (ok) results.phase = "finished"; } });
    expect(code).toBe(1); expect(results.phase).not.toBe("finished"); expect(exits).toContain(1);
  });
  it("the obligation audit is independent of retained rows: a missing first or enrichment record fails", () => {
    const missingFirst = ledger();
    missingFirst.ledger.observe("turn:a"); missingFirst.ledger.audit();
    expect(missingFirst.results.legFailureReason).toBe("failed-turn journal incomplete: 1 first records");
    const missingEnrichment = ledger();
    missingEnrichment.ledger.observe("turn:b", true); missingEnrichment.ledger.written("turn:b", "first"); missingEnrichment.ledger.audit();
    expect(missingEnrichment.results.legFailureReason).toBe("failed-turn enrichment incomplete: 1 pending");
    const complete = ledger();
    complete.ledger.observe("turn:c", true); complete.ledger.written("turn:c", "first"); complete.ledger.written("turn:c", "enriched"); complete.ledger.audit();
    expect(complete.results.legFailed).toBeUndefined();
  });
  it("after finish() the ledger is sealed: no further results write, observation or latch-save", async () => {
    const { writes, ledger: l } = ledger();
    expect(await l.finish({ shutdown: async () => {}, drain: async () => {}, complete: () => {} })).toBe(0);
    const before = writes.length;
    l.fail("late"); l.observe("turn:z", true); l.audit();
    expect(writes).toHaveLength(before);
  });
  it("a rejecting shutdown/drain is not swallowed by finish()", async () => {
    const { ledger: l } = ledger();
    await expect(l.finish({ shutdown: async () => { throw Error("boom"); }, drain: async () => {}, complete: () => {} })).rejects.toThrow("boom");
  });
});

describe("scrubAccounting: one 512-char budget on every branch, fail closed (A3, A4, P2-6)", () => {
  const CUT = "[accounting value cut]";
  it("a quoted value: 512 chars from the opening quote is kept scrubbed, 513 is cut", () => {
    expect(scrubAccounting(`usage="${"a".repeat(510)}" tail`)).toBe('usage="x" tail');
    expect(scrubAccounting(`usage="${"a".repeat(511)}" tail`)).toBe(`usage=${CUT}`);
  });
  it("the cap landing inside a quote drops the whole remainder, never a partial", () => {
    const out = scrubAccounting(`usage="${"S".repeat(700)}" after`);
    expect(out).toBe(`usage=${CUT}`); expect(out).not.toContain("SSS"); expect(out).not.toContain("after");
  });
  it("a container: 512 chars is kept scrubbed, 513 is cut", () => {
    expect(scrubAccounting(`usage={${"a".repeat(510)}} tail`)).toBe('usage="x" tail');
    expect(scrubAccounting(`usage={${"a".repeat(511)}} tail`)).toBe(`usage=${CUT}`);
  });
  it("a scalar: 512 chars is kept scrubbed, 513 is cut", () => {
    expect(scrubAccounting(`usage=${"9".repeat(512)} tail`)).toBe('usage="x" tail');
    expect(scrubAccounting(`usage=${"9".repeat(513)} tail`)).toBe(`usage=${CUT}`);
  });
  it.each([
    ['usage="SECRET', "unterminated quote"], ["usage=[SECRET", "unterminated array"], ["usage={SECRET", "unterminated object"],
    ["usage={a]SECRET}", "mismatched delimiter"], ["usage={\\}SECRET}", "backslash outside quotes"], ["usage=SEC\"RET", "quote inside a scalar"],
  ])("%s (%s) leaks nothing", (text) => {
    const out = scrubAccounting(text);
    expect(out).toContain(CUT); expect(out).not.toContain("SECRET"); expect(out).not.toContain("RET");
  });
});

// G25 guard: enrichment failure after a durable first record must determine the final saved failure.
it("G25 enrichment-only write failure survives shutdown and drain failures", async () => {
  const { results, writes, ledger: l } = ledger();
  l.observe("turn", true);
  const io = { open: () => 7, append: () => {}, fsync: () => {}, close: () => {}, fail: l.fail };
  expect(writeEvidence({ kind: "first" }, io)).toBe(true); l.written("turn", "first");
  expect(writeEvidence({ kind: "enriched" }, { ...io, append: () => { throw denied; } })).toBe(false);
  const code = await l.finish({
    shutdown: async () => l.fail("shutdown failed"),
    drain: async () => l.fail("drain failed"),
    complete: () => { results.phase = "finished"; },
  });
  expect(code).toBe(1); expect(writes.at(-1)).toMatchObject({ status: "FAIL", legFailed: true });
  expect(writes.at(-1).evidenceFailures).toContain("failed-turn enrichment incomplete: 1 pending");
  expect(writes.at(-1).evidenceFailures).toContain("shutdown failed");
  expect(writes.at(-1).evidenceFailures).toContain("drain failed");
});

// F2 fails on 90b8e01c6: call hides the rejection and neither adapter durably latches it.
it.each(["call", "roomCall"])("F2 %s retains the first rejected transport attempt", async path => {
  const { adapterFixture } = await import("./adapter-fixture.mjs");
  const f = adapterFixture();
  await expect(f.send(path)).rejects.toThrow("transport rejected");
  expect(f.attempts()).toBe(1);
  expect(f.results.status).toBe("FAIL");
  expect(f.results.transportFailures).toHaveLength(1);
  expect(f.writes.some(r => r.legFailed && r.transportFailures?.length === 1)).toBe(true);
  const first = structuredClone(f.results.firstSend);
  await f.send(path);
  expect(f.results.firstSend).toEqual(first);
  expect(f.results.status).toBe("FAIL");
  expect(f.events.map(e => e[0])).toEqual(["mark", "network", "network"]);
});
