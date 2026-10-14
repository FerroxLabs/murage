// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 bgwork (Fable r1 P2/P3): the sweep is incremental, a package addition names its own state generation,
// and a cloned run shares no raw object with its consumer.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoutineManager } from "./routines.ts";
import { readRoutinesWithRuns } from "./routine-runs-journal.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const START = new Date(2026, 9, 12, 8, 0, 0).getTime(), HOUR = 60 * 60_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Internals = any;

function make() {
  const dir = mkdtempSync(join(tmpdir(), "murage-sweep-")); dirs.push(dir);
  const file = join(dir, "routines.json"), clock = { now: START };
  let task = 0;
  const m = new RoutineManager({ file, now: () => clock.now, botState: () => "ready", createTask: () => ({ threadId: `thread-${++task}` }), startTurn: async () => {} });
  const schedule = { type: "interval" as const, everyMinutes: 60, anchorAt: START + HOUR };
  const routines = Array.from({ length: 5 }, (_, i) => m.create({ name: `R${i}`, prompt: "Report", botId: "bot-a", target: "bot", runOn: "ember", enabled: true, schedule }));
  for (const r of routines) m.runNow(r.id);
  (m as Internals).save();
  return { m, dir, file, clock, routines };
}

describe("incremental sweep", () => {
  it("a sweep with nothing joined reads no element of either list", () => {
    const { m } = make();
    const i = m as Internals;
    i.sweep(0);
    let reads = 0;
    for (const raw of [i.runsRaw, i.routinesRaw]) for (let k = 0; k < raw.length; k++) { const v = raw[k]; Object.defineProperty(raw, k, { get() { reads++; return v; }, set(x) { raw[k] = x; }, configurable: true }); }
    i.sweep(0);
    expect(reads).toBe(0);
  });

  it("a run pushed in raw is still tracked, saved and forces a full save", () => {
    const { m, file } = make();
    const i = m as Internals;
    const donor = JSON.parse(JSON.stringify(i.runs[0]));
    i.runs.push({ ...donor, id: "run-pushed-raw", status: "completed", finishedAt: START });
    i.save({ runs: [], routines: [] });
    expect(readRoutinesWithRuns(file).runs.map((r: { id: string }) => r.id)).toContain("run-pushed-raw");
    i.runs[i.runs.length - 1].output = "later";
    expect(i.dirtyRuns.size).toBe(1);
  });

  it("a run taken out other than by the history cap forces a full save", () => {
    const { m } = make();
    const i = m as Internals;
    i.save({ runs: [], routines: [] });
    expect(i.fullSave).toBe(false);
    i.runs.splice(0, 1);
    i.sweep(0);
    expect(i.fullSave).toBe(true);
  });
});

describe("preparePackageAddition", () => {
  it("its bytes carry a fresh stateGeneration that publish records, so the next tick cannot clobber a cursor", () => {
    const { m, file, routines } = make();
    const i = m as Internals;
    i.save({ routines: [i.routines[0]] });
    const template = { ...JSON.parse(JSON.stringify(routines[0])), id: "imported-1", name: "Imported", enabled: false, nextRunAt: null };
    delete template.failureStreak;
    const prepared = m.preparePackageAddition([template]);
    const doc = JSON.parse(prepared.bytes.toString("utf8"));
    expect(typeof doc.stateGeneration).toBe("string");
    expect(doc.stateGeneration).not.toBe(i.generation);
    writeFileSync(file, prepared.bytes);
    prepared.publish();
    expect(i.generation).toBe(doc.stateGeneration);
    expect(i.fullSave).toBe(true);
  });
});

describe("cloneRun", () => {
  it("shares no humanPrincipal or channelOrigin object with its consumer", () => {
    const { m } = make();
    const i = m as Internals;
    i.runs[0].humanPrincipal = { kind: "owner", id: "h1", nested: { a: 1 } };
    i.runs[0].channelOrigin = { kind: "telegram", id: "c1", nested: { a: 1 } };
    const out = m.listRuns().find(r => r.id === i.runs[0].id)! as Internals;
    out.humanPrincipal.nested.a = 2; out.channelOrigin.nested.a = 2;
    expect(i.runs[0].humanPrincipal.nested.a).toBe(1);
    expect(i.runs[0].channelOrigin.nested.a).toBe(1);
  });
});

describe("engine start hold", () => {
  it("beginStart is taken inside the try that releases it, so no early throw leaks the hold", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/try \{\s*releaseEngineStart = ownerFirstGate\.beginStart\(threadId\);/);
  });
});
