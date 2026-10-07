import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startupMark } from "./startup-trace.ts";

const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const at = (needle: string, from = 0): number => {
  const i = index.indexOf(needle, from);
  expect(i, `index.ts contains ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("cold start ordering in server/index.ts", () => {
  const listen = at('server.listen(PORT, "127.0.0.1", () => {');
  const callbackEnd = at("const gracefulShutdown = createGracefulShutdown", listen);

  it("finishes the skill sweep before the port opens, so before any bot turn", () => {
    const sweep = at("sweepSkillScans(store.bots.map(");
    expect(sweep).toBeLessThan(listen);
    expect(at('startupMark("skillSweep.done")')).toBeGreaterThan(sweep);
    expect(at('startupMark("skillSweep.done")')).toBeLessThan(listen);
    // Nothing that starts turns may run before the sweep: the room queue and memory worker start in the callback.
    expect(at("roomEngine.ready = true;", listen)).toBeGreaterThan(listen);
  });

  it("does not hold startup on the engine probe when bots exist", () => {
    expect(index).not.toContain("bootSelection = await defaultSelection()");
    expect(at("await bootEngineChoice({ hasBots: store.bots.length > 0")).toBeLessThan(listen);
  });

  it("starts the jobs that do not gate correctness after listen, not before", () => {
    for (const call of ["startModelCatalogRefresh(async", "calendarCalls.start();", "cleanupStaleAttachmentPartials();", "imageOperations.resumePendingPublications()", "sweepBackupWork(DATA_DIR)"]) {
      const first = at(call, index.indexOf("const store = new Store("));
      expect(first, call).toBeGreaterThan(listen);
      expect(first, call).toBeLessThan(callbackEnd);
    }
  });

  it("marks module load, store, skill sweep and listen", () => {
    for (const step of ["module.loaded", "store.ready", "skillSweep.done", "listen"]) at(`startupMark("${step}")`);
  });
});

describe("startupMark", () => {
  const saved = process.env.MURAGE_TURN_TRACE;
  afterEach(() => { if (saved === undefined) delete process.env.MURAGE_TURN_TRACE; else process.env.MURAGE_TURN_TRACE = saved; });

  it("is silent unless MURAGE_TURN_TRACE=1", () => {
    delete process.env.MURAGE_TURN_TRACE;
    const lines: string[] = [];
    startupMark("listen", line => lines.push(line), () => 1234.6);
    expect(lines).toEqual([]);
  });

  it("logs a fixed phase name and rounded ms when on", () => {
    process.env.MURAGE_TURN_TRACE = "1";
    const lines: string[] = [];
    startupMark("listen", line => lines.push(line), () => 1234.6);
    expect(lines).toEqual(["[turn-trace] phase=startup.listen ms=1235"]);
  });

  it("tells the parent each real stage, with or without the trace, and only for known stages", () => {
    delete process.env.MURAGE_TURN_TRACE;
    const sent: object[] = [];
    for (const step of ["module.loaded", "database.open", "store.ready", "skillSweep.done", "listen", "deferred.done", "database.begin"])
      startupMark(step, () => {}, () => 10.4, message => sent.push(message));
    expect(sent.map((m: any) => m.stage)).toEqual(["module.loaded", "database.open", "store.ready", "skillSweep.done", "listen"]);
    expect(sent[0]).toEqual({ type: "startup-stage", stage: "module.loaded", ms: 10 });
    expect(() => startupMark("listen", () => {}, () => 1, () => { throw new Error("closed"); })).not.toThrow();
  });
});
