// Settings v10 G1 (owner: core): Move all plan, digest and recovery. Real Store (persisted bots file) and real RoutineManager.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { RosterPostCommitError } from "./store.ts";
import { buildNoLimitsPlan, moveAllNoLimits, noLimitsIntentFile, recoverNoLimitsMove, type NoLimitsMoveDeps } from "./no-limits-review.ts";

const dirs: string[] = [];
const managers: RoutineManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.stop(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function world() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "no-limits-")));
  dirs.push(dir);
  const file = join(dir, "routines.json");
  const openRoutines = () => { const manager = new RoutineManager({ file, botState: () => "ready" as const, createTask: () => ({ threadId: "fixture-thread" }), startTurn: async () => {} }); managers.push(manager); return manager; };
  // Store persists under the shared test DATA_DIR: start every world from an empty roster so an earlier case's lowered bots cannot leak into this plan
  rmSync(join(DATA_DIR, "bots.json"), { force: true });
  let store = new Store();
  let routines = openRoutines();
  const guests = new Set<string>();
  const deps = (): NoLimitsMoveDeps => ({
    dataDir: dir,
    source: { bots: () => store.bots, routines: () => routines.listRoutines(), ownerChat: (id) => !guests.has(id) },
    clearRoutines: () => routines.inheritAllPermissions(),
    clearRoster: () => store.inheritAllPermissions(),
    restoreRoutine: (row) => { routines.update(row.id, { permissionMode: row.levelCleared }); },
  });
  const lowerBot = (name: string, patch: Record<string, unknown> = {}) => {
    const bot = store.createBot({ name }, { seedMessages: false });
    store.patchBot(bot.id, { autoApprove: true, fullAccess: false, noLimits: false, permissionExplicit: true, ...patch } as never);
    return bot.id;
  };
  const lowerRoutine = (botId: string, name = "Brief") => routines.create({ name, prompt: "Report", botId, enabled: false, permissionMode: "full", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } }).id;
  const restart = () => { store = new Store(); routines.stop(); routines = openRoutines(); };
  return { dir, deps, lowerBot, lowerRoutine, restart, store: () => store, routines: () => routines, guests };
}
const clearedEverywhere = (w: ReturnType<typeof world>, botIds: string[], routineIds: string[]) => {
  for (const id of botIds) expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).find((bot: { id: string }) => bot.id === id)?.permissionExplicit).toBe(false);
  for (const id of routineIds) expect(w.routines().routineById(id)?.permissionMode).toBeUndefined();
};

describe("G1 Move all plan and digest", () => {
  it("lists archived bots, routines and chats with the level each would lose, and the digest names exactly that set", () => {
    const w = world();
    const active = w.lowerBot("Ada");
    const archived = w.lowerBot("Ben", { hidden: true });
    const routine = w.lowerRoutine(active);
    const plan = buildNoLimitsPlan(w.deps().source);
    expect(plan.bots.map((bot) => [bot.id, bot.archived, bot.levelCleared])).toEqual(expect.arrayContaining([[active, false, "auto"], [archived, true, "auto"]]));
    expect(plan.routines.find((row) => row.id === routine)).toMatchObject({ botId: active, levelCleared: "full", pendingApprovalWithdrawn: false });
    expect(buildNoLimitsPlan(w.deps().source).digest).toBe(plan.digest);
  });

  it("a bot archived after the review, or a routine created while it was open, is a 409 with the new plan and nothing changed", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const reviewed = buildNoLimitsPlan(w.deps().source).digest;
    w.store().patchBot(bot, { hidden: true });
    const archivedAnswer = moveAllNoLimits(w.deps(), reviewed);
    expect(archivedAnswer.status).toBe(409);
    expect((archivedAnswer.body as any).plan.bots.find((row: { id: string }) => row.id === bot)?.archived).toBe(true);
    expect((archivedAnswer.body as any).settingRef?.id).toBeTruthy();
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).find((row: { id: string }) => row.id === bot).permissionExplicit).toBe(true);
    const second = buildNoLimitsPlan(w.deps().source).digest;
    const routine = w.lowerRoutine(bot, "Late");
    const lateAnswer = moveAllNoLimits(w.deps(), second);
    expect(lateAnswer.status).toBe(409);
    expect(w.routines().routineById(routine)?.permissionMode).toBe("full");
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
  });

  it("the reviewed digest moves every store, writes no intent afterwards, and a second plan is empty", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const routine = w.lowerRoutine(bot);
    const answer = moveAllNoLimits(w.deps(), buildNoLimitsPlan(w.deps().source).digest);
    expect(answer).toMatchObject({ status: 200, body: { result: "moved" } });
    clearedEverywhere(w, [bot], [routine]);
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
    expect(buildNoLimitsPlan(w.deps().source).bots.find((row) => row.id === bot)).toBeUndefined();
  });

  it("a roster write that fails is reported as not moved and leaves no intent to finish it later", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const failing: NoLimitsMoveDeps = { ...w.deps(), clearRoster: () => { throw new Error("disk full"); } };
    const answer = moveAllNoLimits(failing, buildNoLimitsPlan(w.deps().source).digest);
    expect(answer).toMatchObject({ status: 200, body: { result: "notMoved", error: "disk full" } });
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
    expect(buildNoLimitsPlan(w.deps().source).bots.some((row) => row.id === bot)).toBe(true);
  });

  it("a missing or wrong reviewedSetId changes nothing", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    expect(moveAllNoLimits(w.deps(), undefined).status).toBe(409);
    expect(moveAllNoLimits(w.deps(), "not-a-digest").status).toBe(409);
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).find((row: { id: string }) => row.id === bot).permissionExplicit).toBe(true);
  });
});

describe("G1 recovery across a restart", () => {
  const routineOnlyPlan = (w: ReturnType<typeof world>) => { const bot = w.store().createBot({ name: "Cy" }, { seedMessages: false }).id; const routine = w.lowerRoutine(bot); return { routine, plan: buildNoLimitsPlan(w.deps().source) }; };

  it("(e) a routines-only move that died before the routines commit is not widened at restart", () => {
    const w = world();
    const { routine, plan } = routineOnlyPlan(w);
    expect(plan.bots.some((row) => row.name === "Cy")).toBe(false);
    writeFileSync(noLimitsIntentFile(w.dir), JSON.stringify({ digest: plan.digest, plan, startedAt: 1 }));
    w.restart();
    expect(recoverNoLimitsMove(w.deps())).toBe("rolled-back");
    expect(w.routines().routineById(routine)?.permissionMode).toBe("full");
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
  });

  it("(e2) a routines-only move that committed its routines is left committed and the intent dropped", () => {
    const w = world();
    const { routine, plan } = routineOnlyPlan(w);
    writeFileSync(noLimitsIntentFile(w.dir), JSON.stringify({ digest: plan.digest, plan, startedAt: 1 }));
    w.deps().clearRoutines();
    w.restart();
    expect(recoverNoLimitsMove(w.deps())).toBe("already-committed");
    expect(w.routines().routineById(routine)?.permissionMode).toBeUndefined();
  });

  it("a move that stopped after the routines and before the roster is rolled back, never finished: the owner reviews again", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const routine = w.lowerRoutine(bot);
    const reviewed = buildNoLimitsPlan(w.deps().source);
    writeFileSync(noLimitsIntentFile(w.dir), JSON.stringify({ digest: reviewed.digest, plan: reviewed, startedAt: 1 }));
    w.deps().clearRoutines();
    w.restart();
    expect(recoverNoLimitsMove(w.deps())).toBe("rolled-back");
    w.restart();
    expect(w.routines().routineById(routine)?.permissionMode).toBe("full");
    expect(JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).find((row: { id: string }) => row.id === bot).permissionExplicit).toBe(true);
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
  });

  it("when the roster write already committed, the intent is dropped and nothing is redone", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const plan = buildNoLimitsPlan(w.deps().source);
    writeFileSync(noLimitsIntentFile(w.dir), JSON.stringify({ digest: plan.digest, plan, startedAt: 1 }));
    w.store().inheritAllPermissions();
    expect(recoverNoLimitsMove(w.deps())).toBe("already-committed");
    expect(existsSync(noLimitsIntentFile(w.dir))).toBe(false);
    expect(buildNoLimitsPlan(w.deps().source).bots.some((row) => row.id === bot)).toBe(false);
  });

  it("(f) a roster write that committed but failed after the commit is Moved, with the live records and listeners updated", () => {
    const w = world();
    const bot = w.lowerBot("Ada");
    const seen: string[] = [];
    w.store().onChange((change: { type: string; botId?: string }) => { if (change.type === "bot" && change.botId) seen.push(change.botId); });
    const real = (w.store() as any).saveBots.bind(w.store());
    vi.spyOn(w.store() as any, "saveBots").mockImplementation((next: any) => { real(next); throw new RosterPostCommitError(new Error("post-commit"), next); });
    const answer = moveAllNoLimits(w.deps(), buildNoLimitsPlan(w.deps().source).digest);
    expect(answer).toMatchObject({ status: 200, body: { result: "moved" } });
    expect(seen).toContain(bot);
    expect(w.store().bot(bot)?.permissionExplicit).toBe(false);
  });

  it("a draft-only bot is not in the plan, so an unrelated bot's move can finish with an empty plan", () => {
    const w = world();
    const draft = w.lowerBot("Dee", { draftOnly: true });
    expect(buildNoLimitsPlan(w.deps().source).bots.some((row) => row.id === draft)).toBe(false);
  });
});

describe("G1 wiring", () => {
  it("the owner POST hands a reviewedSetId to the reviewed move, and startup recovery runs after the routine manager exists", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("moveAllNoLimits(moving,reviewedBody?.reviewedSetId)");
    // the owner POST handler itself never clears anything: every move goes through moveAllNoLimits (a bare POST is a 409 with the plan)
    const route = index.indexOf('if(!ownerGlobalNoLimits())return json(res,409,{error:"Choose No limits as the owner default first."});');
    expect(route).toBeGreaterThan(0);
    const handler = index.slice(route, index.indexOf("return json(res,200,noLimitsInheritanceStatus());", route));
    expect(handler).toContain("moveAllNoLimits(moving,reviewedBody?.reviewedSetId)");
    expect(handler).not.toContain("inheritAllPermissions");
    const made = index.indexOf("routines = new RoutineManager({");
    const recovered = index.indexOf("recoverNoLimitsMove(pending)");
    expect(made).toBeGreaterThan(0);
    expect(recovered).toBeGreaterThan(made);
  });
});
