import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.14 FIRST-ENGINE-DESKTOP-REPICK-1014-R3b section 7: the engine pass is the only automatic engine mover. It reads no sign-in,
// moves only a marked bot, only to Fuigo, only from Empty (E) or Gone (G), and every write is a compare and set checked at the write.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import type { EngineReading } from "./default-engine.ts";
import { REPICK_LADDER_MS, branchHolds, createEngineRepick, decideEngineMove, type LiveInstance, type RepickRegistry } from "./engine-repick.ts";
import { Store, type BotRecord } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); });

type Spec = { driverKind: string; models?: string[]; named?: string | null; enabled?: boolean; state?: string; authenticated?: boolean | "missing" | "throws" };

/** A fleet the pass reads: live instances (registry.get) and the scan readings (describe), with a generation that moves on change. */
function fleet(initial: Record<string, Spec>) {
  let specs = { ...initial };
  let generation = 1, tickets = 0;
  let hold: Promise<void> | null = null;
  const live = (spec: Spec): LiveInstance => {
    const options = (spec.models ?? []).map(id => ({ id }));
    return { driverKind: spec.driverKind, enabled: spec.enabled !== false, models: { default: spec.named === null ? "" : spec.named ?? options[0]?.id ?? "", options } };
  };
  const reading = (instanceId: string, spec: Spec): EngineReading => {
    const snapshot: { state: string; authenticated?: boolean } = { state: spec.state ?? "available" };
    if (spec.authenticated === "throws") Object.defineProperty(snapshot, "authenticated", { enumerable: true, get() { throw new Error("the engine pass read authenticated"); } });
    else if (spec.authenticated !== undefined && spec.authenticated !== "missing") snapshot.authenticated = spec.authenticated;
    const models = live(spec).models;
    return { instanceId, driverKind: spec.driverKind, snapshot, models: { default: models.default || undefined, options: models.options } };
  };
  const registry: RepickRegistry & { describe: (o: { catalogs: "fresh" | "due"; startedAfter: number }) => Promise<EngineReading[]> } = {
    get generation() { return generation; },
    scanTicket: () => tickets,
    get: id => (specs[id] && specs[id]!.enabled !== false ? live(specs[id]!) : null),
    describe: async () => {
      tickets++;
      const snapshot = Object.entries(specs).map(([id, spec]) => reading(id, spec));
      if (hold) await hold;
      return snapshot;
    },
  };
  return {
    registry,
    set(next: Record<string, Spec>) { specs = { ...next }; generation++; },
    /** The next scan reads now and returns only when `release` is called (an await the world can change during). */
    holdScan() { let release!: () => void; hold = new Promise<void>(r => { release = r; }); return () => { hold = null; release(); }; },
  };
}

const FUIGO: Spec = { driverKind: "fuigoAgent", models: ["login/m1", "login/m2"] };
const FUIGO_NO_KEY: Spec = { driverKind: "fuigoAgent", models: [] };
const CLAUDE_SIGNED_IN: Spec = { driverKind: "claudeAgent", models: ["sonnet"], authenticated: true };

function world(specs: Record<string, Spec>, timing: { ladder?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}) {
  const store = new Store(() => ({ instanceId: "", model: "" }));
  const f = fleet(specs);
  const repick = createEngineRepick({ store, registry: f.registry, describe: o => f.registry.describe(o), sleep: timing.sleep ?? (async () => {}), log: () => {}, ladder: timing.ladder ?? [0] });
  const marked = (selection: { instanceId: string; model: string }, name = "Chief") => store.createBot({ name, modelSelection: selection }, { seedMessages: false, engineAutoPicked: true });
  const onDisk = (id: string) => (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as BotRecord[]).find(bot => bot.id === id)!;
  return { store, f, repick, marked, onDisk };
}

const EMPTY = { instanceId: "", model: "" };
const AUTH_VALUES: Spec["authenticated"][] = [true, false, "missing"];

describe("no sign-in reading drives a move (Astra R3 H1, GrokBuild R3 H1)", () => {
  it("decideEngineMove gives the same answer for every authenticated value (true, false, missing) on every engine", () => {
    const bots = [{ modelSelection: EMPTY }, { modelSelection: { instanceId: "gone", model: "x" } }, { modelSelection: { instanceId: "claude", model: "sonnet" } }, { modelSelection: { instanceId: "fuigo", model: "" } }];
    for (const bot of bots) {
      const answers = new Set<string>();
      for (const fuigoAuth of AUTH_VALUES) for (const claudeAuth of AUTH_VALUES) {
        const readings = syncReadings({ fuigo: { ...FUIGO, authenticated: fuigoAuth }, claude: { ...CLAUDE_SIGNED_IN, authenticated: claudeAuth } }, []);
        answers.add(JSON.stringify(decideEngineMove(bot, readings)));
      }
      expect(answers.size, JSON.stringify(bot)).toBe(1);
    }
  });

  it("only a key save asks for a fresh scan; boot and the setup poll scan due, so a host the owner added is left alone", async () => {
    const modes: string[] = [];
    const store = new Store(() => ({ instanceId: "", model: "" }));
    const f = fleet({ fuigo: FUIGO_NO_KEY });
    const repick = createEngineRepick({ store, registry: f.registry, describe: o => { modes.push(o.catalogs); return f.registry.describe(o); }, sleep: async () => {}, log: () => {}, ladder: [0] });
    store.createBot({ name: "Chief", modelSelection: EMPTY }, { seedMessages: false, engineAutoPicked: true });
    await repick.request("boot");
    await repick.request("setup");
    await repick.request("key");
    await repick.request("setup");
    expect(modes).toEqual(["due", "due", "fresh", "due"]);
  });

  it("the engine pass never reads authenticated", async () => {
    const { store, repick, marked } = world({ fuigo: { ...FUIGO, authenticated: "throws" }, claude: { ...CLAUDE_SIGNED_IN, authenticated: "throws" } });
    const chief = marked(EMPTY);
    await repick.request("key");
    expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });
});

/** The readings a scan of `specs` returns, built synchronously. */
function syncReadings(specs: Record<string, Spec>, _unused: EngineReading[]): EngineReading[] {
  return Object.entries(specs).map(([instanceId, spec]) => {
    const options = (spec.models ?? []).map(id => ({ id }));
    const snapshot: { state: string; authenticated?: boolean } = { state: spec.state ?? "available" };
    if (spec.authenticated !== undefined && spec.authenticated !== "missing" && spec.authenticated !== "throws") snapshot.authenticated = spec.authenticated;
    return { instanceId, driverKind: spec.driverKind, snapshot, models: { default: spec.named === null ? undefined : spec.named ?? options[0]?.id, options } };
  });
}

describe("N2: only to Fuigo, only from Empty or Gone", () => {
  it("an empty marked bot moves to Fuigo when the key lands, with a signed-in Claude present", async () => {
    const { store, f, repick, marked, onDisk } = world({ fuigo: FUIGO_NO_KEY, claude: CLAUDE_SIGNED_IN });
    const chief = marked(EMPTY);
    await repick.request("boot");
    expect(store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
    f.set({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
    await repick.request("key");
    const moved = store.bot(chief.id)!;
    expect(moved.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
    expect(moved.engineAutoPicked).toBe(true);
    expect(moved.engineRev).toBe(1);
    expect(onDisk(chief.id).modelSelection).toEqual(moved.modelSelection);
    expect(new Store(() => EMPTY).bot(chief.id)!.modelSelection).toEqual(moved.modelSelection);
  });

  it("a Gone bot moves to Fuigo only when no other engine has a catalogue", async () => {
    const blocked = world({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
    const a = blocked.marked({ instanceId: "removed", model: "m" });
    await blocked.repick.request("key");
    expect(blocked.store.bot(a.id)!.modelSelection).toEqual({ instanceId: "removed", model: "m" });
    const alone = world({ fuigo: FUIGO, claude: { ...CLAUDE_SIGNED_IN, models: [] } });
    const b = alone.marked({ instanceId: "removed", model: "m" });
    await alone.repick.request("key");
    expect(alone.store.bot(b.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("two Fuigo instances move nothing", async () => {
    const { store, repick, marked } = world({ fuigo: FUIGO, fuigo2: FUIGO });
    const chief = marked(EMPTY);
    await repick.request("key");
    expect(store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
  });

  it("a marked bot on any live non-Fuigo instance never moves, for every sign-in state, desktop and Cloud", async () => {
    for (const authenticated of AUTH_VALUES) for (const driverKind of ["claudeAgent", "codexAgent", "cursorAgent"]) {
      const { store, repick, marked } = world({ fuigo: FUIGO, other: { driverKind, models: ["m"], authenticated } });
      const bot = marked({ instanceId: "other", model: "m" });
      const blank = marked({ instanceId: "other", model: "" }, "Blank");
      await repick.request("key");
      expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "other", model: "m" });
      expect(store.bot(blank.id)!.modelSelection).toEqual({ instanceId: "other", model: "" });
    }
  });

  it("a marked Chief on live Claude is never moved (N1), even with a key and Fuigo ready", async () => {
    const { store, repick, marked } = world({ fuigo: FUIGO, claude: { ...CLAUDE_SIGNED_IN, authenticated: false } });
    const chief = marked({ instanceId: "claude", model: "sonnet" });
    for (const trigger of ["boot", "key", "setup", "setup"]) await repick.request(trigger);
    expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
    expect(store.bot(chief.id)!.engineRev ?? 0).toBe(0);
  });

  it("a bot that copied the Chief's Claude is never moved when the key lands", async () => {
    const { store, f, repick, marked } = world({ fuigo: FUIGO_NO_KEY, claude: CLAUDE_SIGNED_IN });
    const teammate = marked({ instanceId: "claude", model: "sonnet" }, "Teammate");
    f.set({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
    await repick.request("key");
    expect(store.bot(teammate.id)!.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
  });

  it("a marked Fuigo bot with a blank model takes that instance's default and never another instance", async () => {
    const one = world({ fuigo: FUIGO });
    const bot = one.marked({ instanceId: "fuigo", model: "" });
    await one.repick.request("key");
    expect(one.store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
    // the blank-model bot is on fuigo-old, the one usable Fuigo is another instance: no move
    const other = world({ "fuigo-old": { ...FUIGO_NO_KEY }, fuigo: FUIGO });
    const stuck = other.marked({ instanceId: "fuigo-old", model: "" });
    await other.repick.request("key");
    expect(other.store.bot(stuck.id)!.modelSelection).toEqual({ instanceId: "fuigo-old", model: "" });
  });

  it("an unmarked bot is never moved, empty or gone", async () => {
    const { store, repick } = world({ fuigo: FUIGO });
    const owner = store.createBot({ name: "Owner", modelSelection: EMPTY }, { seedMessages: false });
    await repick.request("key");
    expect(store.bot(owner.id)!.modelSelection).toEqual(EMPTY);
  });
});

describe("the shared target check T (Astra R3 M4)", () => {
  async function duringScan(change: (f: ReturnType<typeof fleet>) => void) {
    const w = world({ fuigo: FUIGO });
    const chief = w.marked(EMPTY);
    const release = w.f.holdScan();
    const pending = w.repick.request("key");
    await Promise.resolve();
    change(w.f);
    release();
    await pending;
    return w.store.bot(chief.id)!;
  }

  it("Fuigo removed, disabled or replaced during the scan writes nothing", async () => {
    expect((await duringScan(f => f.set({}))).modelSelection).toEqual(EMPTY);
    expect((await duringScan(f => f.set({ fuigo: { ...FUIGO, enabled: false } }))).modelSelection).toEqual(EMPTY);
    expect((await duringScan(f => f.set({ fuigo: FUIGO }))).modelSelection).toEqual(EMPTY);
  });

  it("a Fuigo model gone from the live catalogue writes nothing", async () => {
    const w = world({ fuigo: FUIGO });
    const chief = w.marked(EMPTY);
    const release = w.f.holdScan();
    const pending = w.repick.request("key");
    await Promise.resolve();
    // the live catalogue changes without a fleet change (a catalogue refresh): T's membership check still holds the line
    const get = w.f.registry.get;
    w.f.registry.get = id => { const live = get(id); return live && { ...live, models: { default: "login/m2", options: [{ id: "login/m2" }] } }; };
    release();
    await pending;
    expect(w.store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
  });

  it("an id reused by another driver writes nothing", async () => {
    expect((await duringScan(f => f.set({ fuigo: { driverKind: "claudeAgent", models: ["login/m1"] } }))).modelSelection).toEqual(EMPTY);
  });
});

describe("branch G with the real nullable registry contract (Astra R3 M5, BR1)", () => {
  it("a genuinely removed instance moves after restart", async () => {
    const first = world({ fuigo: FUIGO, old: { driverKind: "claudeAgent", models: ["m"] } });
    const bot = first.marked({ instanceId: "old", model: "m" });
    await first.repick.request("boot");
    expect(first.store.bot(bot.id)!.modelSelection.instanceId).toBe("old");
    // restart: the roster reloads from disk, the engine is gone from the fleet
    const store = new Store(() => EMPTY);
    const f = fleet({ fuigo: FUIGO });
    await createEngineRepick({ store, registry: f.registry, describe: o => f.registry.describe(o), sleep: async () => {}, log: () => {}, ladder: [0] }).request("boot");
    expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("an instance re-added mid-scan stops a G move", async () => {
    const w = world({ fuigo: FUIGO });
    const bot = w.marked({ instanceId: "old", model: "m" });
    const release = w.f.holdScan();
    const pending = w.repick.request("key");
    await Promise.resolve();
    w.f.set({ fuigo: FUIGO, old: { driverKind: "claudeAgent", models: ["m"] } });
    release();
    await pending;
    expect(w.store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "old", model: "m" });
  });

  it("a Gone bot does not move to Fuigo while another engine has a catalogue, even when decideEngineMove is bypassed", () => {
    const f = fleet({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
    const readings = syncReadings({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN }, []);
    const bot = { modelSelection: { instanceId: "removed", model: "m" } } as BotRecord;
    const forced = { branch: "G" as const, selection: { instanceId: "fuigo", model: "login/m1" } };
    expect(decideEngineMove(bot, readings)).toBeNull();
    expect(branchHolds(f.registry, f.registry.generation, bot, forced, readings)).toBe(false);
    const alone = syncReadings({ fuigo: FUIGO }, []);
    expect(branchHolds(fleet({ fuigo: FUIGO }).registry, 1, bot, forced, alone)).toBe(true);
  });
});

describe("BR2: usable means a named default or a first listed model", () => {
  it("a Fuigo catalogue with no named default still counts and moves an empty bot to its first model", async () => {
    const { store, repick, marked } = world({ fuigo: { ...FUIGO, named: null } });
    const chief = marked(EMPTY);
    await repick.request("key");
    expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("another engine with no named default still blocks a Gone move", async () => {
    const { store, repick, marked } = world({ fuigo: FUIGO, claude: { ...CLAUDE_SIGNED_IN, named: null } });
    const bot = marked({ instanceId: "removed", model: "m" });
    await repick.request("key");
    expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "removed", model: "m" });
  });
});

describe("writes and races", () => {
  it("a failed write on one of two bots moves the other", async () => {
    const { store, repick, marked } = world({ fuigo: FUIGO });
    const a = marked(EMPTY, "A"), b = marked(EMPTY, "B");
    const real = store.casEngineMove.bind(store);
    vi.spyOn(store, "casEngineMove").mockImplementation((id, move) => { if (id === a.id) throw new Error("disk full"); return real(id, move); });
    await repick.request("key");
    expect(store.bot(a.id)!.modelSelection).toEqual(EMPTY);
    expect(store.bot(b.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("an owner pick, a task pick, an adoption or followBotModel during the scan await is never overwritten", async () => {
    const writes: Array<[string, (store: Store, bot: BotRecord) => void]> = [
      ["owner pick", (store, bot) => { store.patchBot(bot.id, { modelSelection: { instanceId: "claude", model: "sonnet" } }); }],
      ["task pick (adoption)", (store, bot) => { store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "claude", model: "sonnet" } }); }],
      ["followBotModel", (store, bot) => { store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "claude", model: "sonnet" } }); store.followBotModel(bot.id, () => false); }],
    ];
    for (const [label, write] of writes) {
      const w = world({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
      const chief = w.marked(EMPTY);
      const release = w.f.holdScan();
      const pending = w.repick.request("key");
      await Promise.resolve();
      write(w.store, w.store.bot(chief.id)!);
      const before = structuredClone(w.store.bot(chief.id)!.modelSelection);
      release();
      await pending;
      const after = w.store.bot(chief.id)!;
      expect(after.modelSelection, label).toEqual(before);
      expect(after.engineAutoPicked, label).toBeUndefined();
      expect(w.onDisk(chief.id).modelSelection, label).toEqual(before);
      expect(new Store(() => EMPTY).bot(chief.id)!.modelSelection, label).toEqual(before);
    }
  });

  it("after an owner pick, repeated setup reads never move the Chief", async () => {
    const { store, repick, marked } = world({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
    const chief = marked(EMPTY);
    store.patchBot(chief.id, { modelSelection: { instanceId: "", model: "" } });
    store.patchBot(chief.id, { modelSelection: { instanceId: "claude", model: "sonnet" } });
    store.patchBot(chief.id, { modelSelection: EMPTY });
    for (let i = 0; i < 5; i++) await repick.request("setup");
    expect(store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
  });

  it("a key saved while a scan is in flight still moves the empty Chief", async () => {
    const { store, f, repick, marked } = world({ fuigo: FUIGO_NO_KEY });
    const chief = marked(EMPTY);
    const release = f.holdScan();
    const older = repick.request("boot");
    await Promise.resolve();
    // the key lands while the boot scan (which read the empty catalogue) is still in flight
    f.set({ fuigo: FUIGO });
    const afterKey = repick.request("key");
    release();
    await older;
    await afterKey;
    expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("a request resolves only after attempt 0 of a pass that started after it", async () => {
    const { f, repick, marked } = world({ fuigo: FUIGO_NO_KEY });
    marked(EMPTY);
    const scans = vi.spyOn(f.registry, "describe");
    const release = f.holdScan();
    const first = repick.request("boot");
    await Promise.resolve();
    const second = repick.request("key");
    release();
    await first; await second;
    expect(scans).toHaveBeenCalledTimes(2);
  });
});

describe("1.0.15 Astra M8 and MurageMain ruling 2", () => {
  it("two usable Fuigo engines move nothing, Empty or Gone, over the whole ladder (FIRST-ENGINE-TWO-FUIGO-NOMOVE)", async () => {
    const sleeps: number[] = [];
    const w = world({ fuigo: FUIGO, fuigo2: FUIGO }, { ladder: REPICK_LADDER_MS, sleep: async ms => { sleeps.push(ms); } });
    const empty = w.marked(EMPTY, "Empty"), gone = w.marked({ instanceId: "removed", model: "m" }, "Gone");
    const scans = vi.spyOn(w.f.registry, "describe");
    const writes = vi.spyOn(w.store, "casEngineMove");
    await w.repick.request("key");
    await w.repick.idle();
    expect(w.store.bot(empty.id)!.modelSelection).toEqual(EMPTY);
    expect(w.store.bot(gone.id)!.modelSelection).toEqual({ instanceId: "removed", model: "m" });
    expect(w.store.bot(empty.id)!.engineRev ?? 0).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    expect(scans).toHaveBeenCalledTimes(REPICK_LADDER_MS.length);
    expect(sleeps).toEqual([2000, 4000, 9000]);
  });

  it("the full ladder: a catalogue that lands before attempt 2 moves the empty bot there and the ladder stops", async () => {
    const sleeps: number[] = [];
    let w!: ReturnType<typeof world>;
    w = world({ fuigo: FUIGO_NO_KEY }, { ladder: REPICK_LADDER_MS, sleep: async ms => { sleeps.push(ms); if (sleeps.length === 2) w.f.set({ fuigo: FUIGO }); } });
    const chief = w.marked(EMPTY);
    const scans = vi.spyOn(w.f.registry, "describe");
    await w.repick.request("boot");
    // attempt 0 has finished and found nothing; the rest of the ladder runs on its own
    expect(w.store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
    await w.repick.idle();
    expect(w.store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
    expect(sleeps).toEqual([2000, 4000]);
    expect(scans).toHaveBeenCalledTimes(3);
    expect(w.onDisk(chief.id).modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  });

  it("a catalogue that never lands runs every attempt at 0, 2, 6 and 15 seconds and writes nothing", async () => {
    let clock = 0;
    const at: number[] = [];
    const w = world({ fuigo: FUIGO_NO_KEY }, { ladder: REPICK_LADDER_MS, sleep: async ms => { clock += ms; } });
    const chief = w.marked(EMPTY);
    const real = w.f.registry.describe.bind(w.f.registry);
    vi.spyOn(w.f.registry, "describe").mockImplementation(options => { at.push(clock); return real(options); });
    await w.repick.request("boot");
    await w.repick.idle();
    expect(at).toEqual([0, 2000, 6000, 15000]);
    expect(w.store.bot(chief.id)!.modelSelection).toEqual(EMPTY);
    expect(w.store.bot(chief.id)!.engineRev ?? 0).toBe(0);
  });

  it("repairStaleModel or a limit failover write during the scan await is never overwritten", async () => {
    const writes: Array<[string, { instanceId: string; model: string }, (store: Store, bot: BotRecord) => void]> = [
      ["repairStaleModel", { instanceId: "fuigo", model: "" }, (store, bot) => { expect(store.repairStaleModel(bot.id, bot.threadId, bot.modelSelection, "login/m2")).toBe(true); }],
      ["limit failover", EMPTY, (store, bot) => { store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "claude", model: "sonnet" }, limitFailover: "row-1", resumeCursors: {} }); }],
    ];
    for (const [label, start, write] of writes) {
      const w = world({ fuigo: FUIGO, claude: CLAUDE_SIGNED_IN });
      const chief = w.marked(start);
      const release = w.f.holdScan();
      const pending = w.repick.request("key");
      await Promise.resolve();
      write(w.store, w.store.bot(chief.id)!);
      const before = structuredClone(w.store.bot(chief.id)!);
      release();
      await pending;
      const after = w.store.bot(chief.id)!;
      expect(after.modelSelection, label).toEqual(before.modelSelection);
      expect(after.tasks, label).toEqual(before.tasks);
      expect(after.engineRev, label).toBe(before.engineRev);
      expect(w.onDisk(chief.id).modelSelection, label).toEqual(before.modelSelection);
      expect(new Store(() => EMPTY).bot(chief.id)!.modelSelection, label).toEqual(before.modelSelection);
    }
  });

  it("an owner pick landing between two bots' writes stops the second bot's move", async () => {
    const { store, repick, marked, onDisk } = world({ fuigo: FUIGO });
    const a = marked(EMPTY, "A"), b = marked(EMPTY, "B");
    const real = store.casEngineMove.bind(store);
    vi.spyOn(store, "casEngineMove").mockImplementation((id, move) => {
      const result = real(id, move);
      if (id === a.id) store.patchBot(b.id, { modelSelection: { instanceId: "claude", model: "sonnet" } });
      return result;
    });
    await repick.request("key");
    expect(store.bot(a.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
    expect(store.bot(b.id)!.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
    expect(store.bot(b.id)!.engineAutoPicked).toBeUndefined();
    expect(onDisk(b.id).modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
  });
});

it("E1: a published birth reading does not move Claude and still permits empty-to-Fuigo", async () => {
  const fake = makeFakeDriver();
  const registry = new ProviderRegistry([fake.driver]);
  await registry.load({ claude: { driver: "fake" }, fuigo: { driver: "fake" } });
  Object.assign(registry.get("claude")!, { driverKind: "claudeAgent", models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }] }, snapshot: async () => ({ state: "available", authenticated: true, billing: "subscription" }) });
  Object.assign(registry.get("fuigo")!, { driverKind: "fuigoAgent", models: { default: "login/m1", options: [{ id: "login/m1", label: "M1" }] } });
  // The unchanged engine pass is also exercised on the build base, which has no birth-reading API.
  if (typeof registry.describeFlight === "function") {
    const flight = registry.describeFlight();
    registry.publishScan(flight, await flight.run);
    expect(registry.scanReading()?.rows.find(row => row.instanceId === "claude")?.billing).toBe("subscription");
  } else await registry.describe();
  const store = new Store(() => EMPTY);
  const chief = store.createBot({ modelSelection: { instanceId: "claude", model: "sonnet" } }, { seedMessages: false, engineAutoPicked: true });
  const empty = store.createBot({ modelSelection: EMPTY }, { seedMessages: false, engineAutoPicked: true });
  const repick = createEngineRepick({ store, registry, describe: opts => registry.describe(opts), sleep: async () => {}, log: () => {}, ladder: [0] });
  await repick.request("key");
  expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "claude", model: "sonnet" });
  expect(store.bot(empty.id)!.modelSelection).toEqual({ instanceId: "fuigo", model: "login/m1" });
  await registry.disposeAll();
});
