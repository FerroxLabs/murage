import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { startupMark } from "./startup-trace.ts";

const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
// The Chief move and the re-pick pass live in cloud-home/engine-repick.ts; index.ts keeps thin wrappers.
const repick = readFileSync(new URL("./cloud-home/engine-repick.ts", import.meta.url), "utf8");
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
    expect(index).toContain('new Store({ fuigo: () => registry.instances().filter(instance => instance.driverKind === "fuigoAgent"), copyChief: birthOnDesktop, eligible: id => liveForBirth(id) !== null, ...(birthOnDesktop ? { firstBot: () => bootSelection, signedIn: source => birthCandidate({ reading: registry.scanReading(), paidOnly: ENGINE_DEFAULT_PAID_ONLY, live: liveForBirth, source }) } : { homeFallback: homeBirthFallback(() => lastProbeReadings, pickDefaultEngine, currentBirthReadings) }) }');
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const birth = store.slice(store.indexOf("  birthSelection(): ModelSelection {"), store.indexOf("  workspaceChief(): BotRecord | null {"));
    expect(birth).toMatch(/if \(!source && this\.birth\.copyChief && this\.birth\.firstBot\)/);
    expect(birth).toContain("!allFuigo.includes(probed.instanceId)");
  });

  it("a Cloud home re-picks Murage's own engine picks when the Flux key lands, from the credentials path", () => {
    expect(index).toContain('onServerCredentialsUpdated(keys => { if (keys.includes("fluxApiKey")) void repickAutoPickedBots()');
    // C1: on a home the hello card never stands in for the mark, so an owner's own pick is not put back on Fuigo.
    expect(repick).toContain("if (!setupMayMoveChief(chief, () => view.conversationLive())) return;");
    expect(index).toContain("conversationLive: () => conversationLive(view, present)");
    expect(index + repick).not.toContain("if (!murageOwnPick && !conversationLive(view, present)) return;");
    // int/1016-cloud: a stale model swap is a compare-and-set that keeps the mark as it is (1.0.14 FIRST-ENGINE-REPICK section 4).
    expect(index).toContain("store.repairStaleModel(bot.id, threadId, owning, replacement)");
  });

  it("the Murage-pick engine move rechecks the owner's choice after its awaits (H1)", () => {
    const body = repick.slice(repick.indexOf("export async function moveChiefToShippedEngine"), repick.indexOf("export async function repickAutoPickedBotsOnce"));
    const pick = body.indexOf("await botEngineReadings(");
    const recheck = body.indexOf("fresh.engineAutoPicked !== true || JSON.stringify(fresh.modelSelection) !== startedSelection");
    const patch = body.indexOf("store.patchBot(chief.id");
    expect(body.indexOf("const startedSelection = JSON.stringify(chief.modelSelection);")).toBeLessThan(body.indexOf("await deps.described("));
    expect(pick).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(pick);
    expect(patch).toBeGreaterThan(recheck);
  });

  it("both move paths leave an engine only on a definite signed-out read of it, after the pick, and skip while any read is unknown (C2)", () => {
    const chiefBody = repick.slice(repick.indexOf("export async function moveChiefToShippedEngine"), repick.indexOf("export async function repickAutoPickedBotsOnce"));
    const skip = chiefBody.indexOf("if (unanswered.length > 0) return;");
    const gate = chiefBody.indexOf("await mayMoveOffEngine(registry.get(chief.modelSelection.instanceId)?.driverKind, chief.id, deps.source)");
    expect(skip).toBeGreaterThan(chiefBody.indexOf("await botEngineReadings("));
    expect(gate).toBeGreaterThan(skip);
    expect(chiefBody.indexOf("fresh.engineAutoPicked !== true")).toBeGreaterThan(gate);
    expect(chiefBody.indexOf("store.patchBot(chief.id")).toBeGreaterThan(gate);
    const once = repick.slice(repick.indexOf("export async function repickAutoPickedBotsOnce"));
    const repickSkip = once.indexOf("if (!move || unanswered.length > 0) continue;");
    const repickGate = once.indexOf("if (!(await mayMoveOffEngine(currentKind, bot.id, deps.source)) || store.bot(bot.id)?.engineAutoPicked !== true) continue;");
    expect(repickSkip).toBeGreaterThan(once.indexOf("await botEngineReadings("));
    expect(repickGate).toBeGreaterThan(repickSkip);
    expect(once.indexOf("store.patchBot(bot.id")).toBeGreaterThan(repickGate);
  });

  it("index.ts runs the extracted passes with its own store and registry, and keeps the listener and catch-up after the store", () => {
    const wrappers = index.slice(index.indexOf("const engineRepickDeps = (): RepickDeps =>"), index.indexOf("if (process.env.MURAGE_CLOUD_ROLE === \"home\") {\n  onServerCredentialsUpdated"));
    expect(wrappers).toContain("({ store, registry, described: describedInstances,");
    expect(wrappers).toContain("await moveChiefOntoShippedEngine({ fluxReady: view.fluxReady, chiefBotId: view.chiefBotId, conversationLive: () => conversationLive(view, present) }, engineRepickDeps());");
    expect(wrappers).toContain("await repickAutoPickedBotsPass(engineRepickDeps());");
    expect(at("const engineRepickDeps = (): RepickDeps =>")).toBeGreaterThan(at("const store = new Store("));
  });

  it("a sign-in or sign-out that ended drops that bot's polled read before anything reads it again", () => {
    const ended = index.slice(at("onEnded: (engine, action, extra) => {"), at("attachCloudUpgradeGate(server, cloudAuth"));
    const forget = ended.indexOf("forgetBotSignIns(extra.bot);");
    expect(forget).toBeGreaterThan(-1);
    // for login AND logout: the drop comes before the login-only branch
    expect(forget).toBeLessThan(ended.indexOf('action === "login"'));
    expect(forget).toBeLessThan(ended.indexOf("useEngineAfterSignIn("));
  });

  it("a Flux key already held at boot gets one catch-up re-pick, and runs never overlap (H2)", () => {
    const listener = index.indexOf("onServerCredentialsUpdated(keys =>");
    const catchUp = index.indexOf("if (readServerSecrets()?.credentials?.fluxApiKey) void repickAutoPickedBots()");
    expect(listener).toBeGreaterThan(-1);
    expect(catchUp).toBeGreaterThan(listener);
    expect(index).toContain("if (repickRunning) { repickAgain = true; return; }");
    expect(index).toContain("do { repickAgain = false; await repickAutoPickedBotsOnce(); } while (repickAgain);");
  });

  it("one bot's failed save does not abandon the remaining bots in the re-pick (M4)", () => {
    const once = repick.slice(repick.indexOf("export async function repickAutoPickedBotsOnce"));
    const tryAt = once.indexOf("try {\n        store.patchBot(bot.id, { modelSelection: move, engineAutoPicked: true });");
    expect(tryAt).toBeGreaterThan(once.indexOf("for (const bot of candidates)"));
    expect(once).toContain("} catch (error) {");
    expect(once).not.toMatch(/warn\?\.\([^)]*(apiKey|fluxApiKey|credentials)/);
  });

  it("a chat set to another unsigned engine is refused by the guard, shown in the thread, and the turn ends idle", () => {
    // the turn runs on the chat's own pick, and the guard sees that engine's driver
    expect(index).toContain("const bot={...projected,modelSelection:turnSelection.selection};");
    expect(index).toContain("if (bot) await assertBotEngineSignedIn(instance.driverKind, { id: bot.id, name: bot.name });");
    // the refusal is appended to the thread and the task goes idle (not left running)
    const failure = index.slice(index.indexOf("const message = pinnedMemoryFailure(failure"));
    expect(failure.slice(0, 4000)).toContain("tool: { name: `error: ${message.slice(0, 160)}`, ok: false");
    expect(failure.slice(0, 5000)).toContain('store.setTaskActivity(bot.id,threadId, "idle");');
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
