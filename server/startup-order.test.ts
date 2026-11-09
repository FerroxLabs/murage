import { readFileSync } from "node:fs";
import ts from "typescript";
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

  it("scans a bot's skills in the background after the port opens and, at the latest, on that bot's first turn", () => {
    // the scan used to read every skill of every bot before the port opened (78 s on a heavy install)
    expect(at("sweepBotSkills(bot.id)", at("async function sweepSkillsInBackground"))).toBeGreaterThan(at("async function sweepSkillsInBackground"));
    // and no sweep runs anywhere else: every call is in the background sweep or in a turn's own setup (1.0.4 06-A1/06-B1 3c8c08904: a turn
    // sweeps its own bot before it reuses or makes a skill pin), never at module level before the port opens
    const sweptIn = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "sweepBotSkills") {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !(ts.isFunctionDeclaration(owner) && owner.name)) owner = owner.parent;
        sweptIn.add(owner && ts.isFunctionDeclaration(owner) && owner.name ? owner.name.text : "<module>");
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile("index.ts", index, ts.ScriptTarget.Latest, true));
    expect([...sweptIn].sort()).toEqual(["runGroupMemberTurn", "startTurnAdmitting", "sweepSkillsInBackground"]);
    // rc13: the sweep is an after-listen step of its own (STALLS-FINAL-DESIGN 3.4), started from inside the listen callback
    expect(at("startRecovery(() => sweepSkillsInBackground()", listen)).toBeGreaterThan(listen);
    expect(at("startRecovery(() => sweepSkillsInBackground()", listen)).toBeLessThan(callbackEnd);
    expect(at('startupMark("skillSweep.done")')).toBeLessThan(listen);
    const skills = readFileSync(new URL("./skills.ts", import.meta.url), "utf8");
    // 1.0.2: skillsSystemPrompt delegates to skillsIndex, which sweeps first.
    expect(skills).toMatch(/export function skillsSystemPrompt\(botId: string\): string \{\s*return skillsIndex\(botId\)\.text;/);
    expect(skills).toMatch(/function skillsIndex\(botId: string\): \{ text: string; listed: SkillListing\[\] \} \{(?:\s*\/\/[^\n]*)*\s*sweepBotSkills\(botId\)/);
    expect(skills).toMatch(/export function syncSkillLinks\(botId: string\): void \{\s*sweepBotSkills\(botId\)/);
    // Nothing that starts turns may run before the port: the room queue and memory worker start in the callback.
    // (the Cloud line: a Cloud home sets it from its execution gate, `roomEngine.ready = !homeExecutionGate || homeExecutionGate.open();`)
    expect(at("roomEngine.ready =", listen)).toBeGreaterThan(listen);
    expect(at("roomEngine.ready =", listen)).toBeLessThan(callbackEnd);
  });

  it("does not hold startup on the engine probe when bots exist", () => {
    expect(index).not.toContain("bootSelection = await defaultSelection()");
    expect(at("await bootEngineChoice({ hasBots: store.bots.length > 0")).toBeLessThan(listen);
  });

  it("a remembered Fuigo/flux-auto choice with the key removed never reaches a new bot (1.0.15 BIRTH-FUIGO)", () => {
    // The remembered file is read only when bots exist (default-engine.ts bootEngineChoice), and then no new bot is a first bot: birth
    // copies the Chief and never reads bootSelection. The desktop first-bot fallback (r3) gets the WHOLE Fuigo list, so birth refuses a
    // reading that names a Fuigo which cannot answer (Store row: birth-selection.test.ts "a probe reading that names a Fuigo ...").
    // ENGINE-DEFAULT-1018 (handoffs/designs/ENGINE-DEFAULT-1018.md:57-62): the Store also takes `eligible` (live catalogue check) and `signedIn`, the desktop
    // birth candidate from the account-mapped scan, which returns the FINAL validated selection or null; the Chief copy and the Fuigo refusal stay as pinned below.
    const engine = readFileSync(new URL("./default-engine.ts", import.meta.url), "utf8");
    expect(engine).toContain("const saved = opts.hasBots ? readRememberedEngine(opts.file) : null;");
    expect(index).toContain('new Store({ fuigo: () => registry.instances().filter(instance => instance.driverKind === "fuigoAgent"), copyChief: birthOnDesktop, eligible: id => liveForBirth(id) !== null, ...(birthOnDesktop ? { firstBot: () => bootSelection, signedIn: source => birthCandidate({ reading: registry.scanReading(), paidOnly: ENGINE_DEFAULT_PAID_ONLY, live: liveForBirth, source }) } : {}) }');
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const birth = store.slice(store.indexOf("  birthSelection(): ModelSelection {"), store.indexOf("  workspaceChief(): BotRecord | null {"));
    expect(birth).toMatch(/if \(!source && this\.birth\.copyChief && this\.birth\.firstBot\)/);
    expect(birth).toContain("!allFuigo.includes(probed.instanceId)");
  });

  it("starts the jobs that do not gate correctness after listen, not before", () => {
    for (const call of ["startModelCatalogRefresh(async", "calendarCalls.start();", "cleanupStaleAttachmentPartials(Date.now(), { startup: true });", "sweepArtifactCandidates(join(DATA_DIR, \"artifact-files\"));", "void trackBootJob(resumePendingPublicationsInSlices())", "sweepBackupWork(DATA_DIR)"]) {
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
