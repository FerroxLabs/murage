// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 (designs/CHIEF-TRANSFER-1023.md r3): the real Store, the real journal and the real ChiefTransfer, with the chat apps
// replaced by recording adapters (the channels are not under test here; their own services are in chief-transfer-channels.test.ts).
// Witnesses: W6 W7 W11 W12 W13 W14 W15 W16 W18 W20 W22 W23.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store, type BotRecord } from "./store.ts";
import { ChiefTransfer, routineBotState, type ChannelAdapter, type Fence, type TransferChannel } from "./chief-transfer.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); });

const botsOnDisk = () => JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<BotRecord & { chiefEpoch?: number }>;

/** A recording chat app: the three records it keeps (connection target, cfg target, paused), plus the calls the transfer made. */
function fakeApp(channel: TransferChannel, start: { target: string; paused?: boolean }) {
  const state = { target: start.target, cfg: start.target as string | undefined, paused: start.paused === true, moving: false, runs: 1, live: true };
  const calls: string[] = [];
  const gates: { stopRuns?: Promise<void>; writeFiles?: () => void } = {};
  const adapter: ChannelAdapter = {
    channel,
    pairing: from => state.target === from ? { channel, connectionId: `${channel}-conn`, target: from, live: !state.paused } : null,
    inFlight: () => state.runs,
    quiesce: () => { calls.push("quiesce"); state.moving = true; state.live = false; },
    endMove: () => { calls.push("endMove"); state.moving = false; },
    pause: async () => { calls.push("pause"); if (state.moving) return; state.paused = true; },
    ...(channel === "signal" ? { pauseForChiefChange: () => { calls.push("pauseForChiefChange"); state.paused = true; } } : {}),
    stopRuns: async () => { calls.push("stopRuns"); await gates.stopRuns; const n = state.runs; state.runs = 0; return n; },
    stopOld: async () => { calls.push("stopOld"); state.live = false; },
    savedTarget: () => state.target,
    cfgTarget: () => state.cfg,
    writeFiles: to => { calls.push("writeFiles"); gates.writeFiles?.(); state.target = to; state.paused = false; },
    writeCfg: to => { calls.push("writeCfg"); state.cfg = to; },
    rebuild: async (_to, start) => { calls.push(start ? "rebuild" : "rebuild-only"); if (start) state.live = true; },
    restart: async () => { calls.push("restart"); state.live = true; },
  };
  return { adapter, state, calls, gates };
}

function world() {
  const store = new Store(() => ({ instanceId: "", model: "" }));
  const mk = (name: string) => store.createBot({ name, modelSelection: { instanceId: "fuigo", model: "m" } }, { seedMessages: false });
  const a = mk("Alpha"), b = mk("Bravo"), c = mk("Carol");
  store.setChiefOfStaff(a.id, undefined, "workspace");
  const apps = { telegram: fakeApp("telegram", { target: a.id }), slack: fakeApp("slack", { target: a.id }), signal: fakeApp("signal", { target: a.id }) };
  const events: unknown[] = [];
  const routines = [{ id: "r1", name: "Morning digest", schedule: { kind: "daily" } }, { id: "r2", name: "Weekly review", schedule: { kind: "weekly" } }];
  const make = (s: Store = store) => new ChiefTransfer({ store: s, dataDir: DATA_DIR, adapters: () => Object.values(apps).map(app => app.adapter),
    leadershipError: bot => (bot.name === "Weak" ? "This engine cannot lead." : null), routines: botId => (botId === a.id ? routines : []), emit: outcome => events.push(outcome) });
  const transfer = make();
  const fenceOf = (from: string, to: string) => (transfer.preview(from, to).body as { fence: Fence }).fence;
  return { store, a, b, c, apps, transfer, make, events, fenceOf, mk };
}

describe("chiefEpoch (W18)", () => {
  it("W18 increments on seatChiefOfStaff, on a patchBot that hides the Chief and on the load-time un-hide, survives a restart, and stays out of the records", () => {
    const store = new Store(() => ({ instanceId: "", model: "" }));
    const x = store.createBot({ name: "X", modelSelection: { instanceId: "fuigo", model: "m" } }, { seedMessages: false });
    const y = store.createBot({ name: "Y", modelSelection: { instanceId: "fuigo", model: "m" } }, { seedMessages: false });
    expect(store.chiefEpoch).toBe(0);
    store.setChiefOfStaff(x.id, undefined, "workspace");
    expect(store.chiefEpoch).toBe(1);
    store.setChiefOfStaff(y.id, undefined, "workspace");
    expect(store.chiefEpoch).toBe(2);
    store.patchBot(y.id, { hidden: true });
    expect(store.chiefEpoch).toBe(3);
    // every record carries the same number, in the same write
    expect(botsOnDisk().map(bot => bot.chiefEpoch)).toEqual([3, 3]);
    // no Chief change: a turn-end style save leaves it alone
    store.patchBot(x.id, { title: "renamed" });
    expect(store.chiefEpoch).toBe(3);
    flushCoalesced();
    // load-time normalisation: a hidden record that still carries the Chief role is un-hidden at load, which changes workspaceChief(), so the
    // load itself is one more step (D4: the epoch moves in the write that changes the Chief, whoever the writer is)
    const again = new Store(() => ({ instanceId: "", model: "" }));
    expect(again.workspaceChief()?.id).toBe(y.id);
    expect(again.chiefEpoch).toBe(4);
    expect(botsOnDisk().map(bot => bot.chiefEpoch)).toEqual([4, 4]);
    flushCoalesced();
    expect(new Store(() => ({ instanceId: "", model: "" })).chiefEpoch).toBe(4);
    // never part of an in-memory record, so a package export cannot carry it
    expect(again.bots.some(bot => "chiefEpoch" in bot)).toBe(false);
    expect(JSON.stringify(again.bots)).not.toContain("chiefEpoch");
  });
});

describe("fence and eligibility (W6 W7 W20)", () => {
  it("W6 a permissionRev bump on the target after the preview makes the commit stale, and nothing changes", async () => {
    const w = world();
    const fence = w.fenceOf(w.a.id, w.b.id);
    const epoch = w.store.chiefEpoch;
    w.store.patchBot(w.b.id, { autoApprove: true });
    const result = await w.transfer.commit({ fence, move: ["telegram"] });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("chief-transfer-stale");
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(w.store.chiefEpoch).toBe(epoch);
    expect(w.apps.telegram.calls).toEqual([]);
  });

  it("W7 ABA: A to B preview, A to C lands, C to A lands, then the old fence is stale (only the epoch differs)", async () => {
    const w = world();
    const old = w.fenceOf(w.a.id, w.b.id);
    expect((await w.transfer.commit({ fence: w.fenceOf(w.a.id, w.c.id), move: [] })).status).toBe(200);
    expect((await w.transfer.commit({ fence: w.fenceOf(w.c.id, w.a.id), move: [] })).status).toBe(200);
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    const live = w.fenceOf(w.a.id, w.b.id);
    // everything but the epoch (and the pairings, empty after the pauses above) matches the old fence
    expect({ ...live, epoch: 0, pairings: [] }).toEqual({ ...old, epoch: 0, pairings: [] });
    const result = await w.transfer.commit({ fence: { ...old, pairings: live.pairings }, move: [] });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("chief-transfer-stale");
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(w.apps.telegram.state.target).toBe(w.a.id);
  });

  it("W20 a hidden, staged or non-leading-engine target is refused by the commit and greyed in the preview", async () => {
    const w = world();
    const weak = w.mk("Weak");
    const hidden = w.mk("Hidden"); w.store.patchBot(hidden.id, { hidden: true });
    const preview = w.transfer.preview(w.a.id, null).body as { candidates: Array<{ id: string; eligible: boolean; reason: string | null }> };
    expect(preview.candidates.find(row => row.id === weak.id)).toMatchObject({ eligible: false, reason: "This engine cannot lead." });
    const fence = w.fenceOf(w.a.id, weak.id);
    const result = await w.transfer.commit({ fence, move: [] });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("chief-transfer-ineligible");
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect((await w.transfer.commit({ fence: { ...w.fenceOf(w.a.id, hidden.id) }, move: [] })).status).toBe(409);
  });
});

describe("preview (W5)", () => {
  it("W5 lists both routines as staying with the outgoing Chief, the archive line from the scheduler's own rule, both apps checked, both levels and the higher-level warning", () => {
    const w = world();
    w.store.patchBot(w.a.id, { autoApprove: true, fullAccess: true });
    w.store.patchBot(w.b.id, { autoApprove: true, fullAccess: true, noLimits: true });
    const preview = w.transfer.preview(w.a.id, w.b.id).body as any;
    expect(preview.routines.map((r: { name: string }) => r.name)).toEqual(["Morning digest", "Weekly review"]);
    // the archive line is the scheduler's rule for a hidden bot, read from the same function
    expect(routineBotState({ hidden: true }, () => false)).toBe("missing");
    expect(preview.archiveRoutinesFail).toBe(true);
    expect(preview.pairings.filter((p: { checked: boolean }) => p.checked).map((p: { channel: string }) => p.channel).sort()).toEqual(["signal", "slack", "telegram"]);
    expect(preview.from).toMatchObject({ level: "Full access", rank: 2 });
    expect(preview.to).toMatchObject({ level: "No limits", rank: 3 });
    expect(preview.higherLevelApps.sort()).toEqual(["signal", "slack", "telegram"]);
    // nothing written: the preview never touches the roster or the journal
    expect(w.transfer.read()).toBeNull();
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
  });

  it("W5 a target at the same or a lower level carries no warning", () => {
    const w = world();
    w.store.patchBot(w.a.id, { autoApprove: true, fullAccess: true });
    const preview = w.transfer.preview(w.a.id, w.b.id).body as any;
    expect(preview.higherLevelApps).toEqual([]);
  });
});

describe("authority (W11)", () => {
  it("W11 a commit changes no permission field and no permissionRev on either bot", async () => {
    const w = world();
    w.store.patchBot(w.a.id, { autoApprove: true });
    w.store.patchBot(w.b.id, { autoApprove: true, fullAccess: true });
    const pick = (bot: BotRecord) => JSON.stringify([bot.autoApprove, bot.fullAccess, bot.noLimits, bot.alwaysAllow, bot.permissionRev, bot.fullAccessAcknowledgedAt, bot.noLimitsAcknowledgedAt]);
    const before = [pick(w.store.bot(w.a.id)!), pick(w.store.bot(w.b.id)!)];
    const result = await w.transfer.commit({ fence: w.fenceOf(w.a.id, w.b.id), move: ["telegram"] });
    expect(result.status).toBe(200);
    expect(w.store.workspaceChief()!.id).toBe(w.b.id);
    expect([pick(w.store.bot(w.a.id)!), pick(w.store.bot(w.b.id)!)]).toEqual(before);
  });
});

describe("one outcome, unchecked pairings (W8 shape, W17)", () => {
  it("moves only the checked app, pauses the unchecked ones (Signal through its own durable pause), stops the in-flight run, and emits once", async () => {
    const w = world();
    const result = await w.transfer.commit({ fence: w.fenceOf(w.a.id, w.b.id), move: ["telegram"] });
    expect(result.status).toBe(200);
    const outcome = result.body.outcome as { channels: Array<{ channel: string; result: string }>; stoppedRuns: number };
    expect(outcome.channels).toEqual(expect.arrayContaining([{ channel: "telegram", result: "moved" }, { channel: "slack", result: "paused:left-paused" }, { channel: "signal", result: "paused:left-paused" }]));
    expect(w.apps.telegram.state).toMatchObject({ target: w.b.id, cfg: w.b.id, paused: false });
    expect(w.apps.telegram.calls).toEqual(["quiesce", "stopRuns", "stopOld", "writeFiles", "writeCfg", "endMove", "rebuild"]);
    expect(w.apps.slack.state).toMatchObject({ target: w.a.id, paused: true });
    expect(w.apps.signal.calls).toContain("pauseForChiefChange");
    expect(w.apps.signal.state.paused).toBe(true);
    expect(outcome.stoppedRuns).toBe(1);
    expect(w.events).toHaveLength(1);
    expect(w.transfer.read()).toMatchObject({ state: "done" });
    // the sheet shows the outcome from the response, so a reload does not show it a second time
    expect(w.transfer.takeOutcome()).toBeNull();
  });

  it("a journal write that fails after the role landed does not strand the hand-over: it still finishes and the next commit is not busy", async () => {
    const w = world();
    const fence = w.fenceOf(w.a.id, w.b.id);
    const journal = join(DATA_DIR, "chief-transfer.json");
    // the first write (intent) lands; every later one fails because the journal path becomes a non-empty directory
    const first = w.transfer.commit({ fence, move: ["telegram"] });
    rmSync(journal, { force: true }); mkdirSync(journal); writeFileSync(join(journal, "keep"), "x");
    const result = await first;
    rmSync(journal, { recursive: true, force: true });
    expect(result.status).toBe(200);
    expect(w.apps.telegram.state).toMatchObject({ target: w.b.id, moving: false });
    expect(w.transfer.read()).toMatchObject({ state: "done" });
    const again = await w.transfer.commit({ fence: w.fenceOf(w.b.id, w.c.id), move: [] });
    expect(again.status).toBe(200);
  });
});

describe("failure and rollback (W22)", () => {
  it("W22a a roster write that throws before commit: 500 nothing changed, A is still Chief, epoch unchanged, a later save keeps A, no app moved", async () => {
    const w = world();
    const fence = w.fenceOf(w.a.id, w.b.id);
    const epoch = w.store.chiefEpoch;
    flushCoalesced();
    // a real write fault, before anything commits: bots.json becomes a non-empty directory, so the atomic rename onto it fails
    const file = join(DATA_DIR, "bots.json"), kept = readFileSync(file, "utf8");
    rmSync(file); mkdirSync(file); writeFileSync(join(file, "keep"), "x");
    let result: Awaited<ReturnType<typeof w.transfer.commit>>;
    try { result = await w.transfer.commit({ fence, move: ["telegram"] }); }
    finally { rmSync(file, { recursive: true, force: true }); writeFileSync(file, kept); }
    expect(result.status).toBe(500);
    expect(String(result.body.error)).toContain("Nothing changed");
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(w.store.bot(w.b.id)!.chiefOfStaff).not.toBe(true);
    expect(w.store.chiefEpoch).toBe(epoch);
    w.store.patchBot(w.c.id, { title: "a later unrelated save" });
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(w.store.chiefEpoch).toBe(epoch);
    expect(botsOnDisk().find(bot => bot.chiefOfStaff)?.id).toBe(w.a.id);
    // the quiesced app was not left dead: it is started again on the old Chief, as it was
    expect(w.apps.telegram.state).toMatchObject({ target: w.a.id, moving: false, live: true });
    expect(w.apps.telegram.calls).toEqual(["quiesce", "endMove", "stopOld", "restart"]);
    expect(w.transfer.read()).toMatchObject({ state: "done", outcome: { status: "nothing-changed" } });
  });

  it("W22b RosterPostCommitError means the role landed: 200, B is Chief, the apps are moved", async () => {
    const w = world();
    const fence = w.fenceOf(w.a.id, w.b.id);
    const botEvents: string[] = [];
    w.store.onChange(change => { if (change.type === "bot") botEvents.push(change.botId); });
    vi.spyOn(w.store as unknown as { afterRosterSave: () => void }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("fixture committed fault"); });
    const result = await w.transfer.commit({ fence, move: ["telegram"] });
    expect(result.status).toBe(200);
    expect(w.store.workspaceChief()!.id).toBe(w.b.id);
    expect((result.body.outcome as { channels: unknown[] }).channels).toContainEqual({ channel: "telegram", result: "moved" });
    expect(botsOnDisk().find(bot => bot.chiefOfStaff && bot.chiefScope === "workspace")?.id).toBe(w.b.id);
    expect(botEvents.sort()).toEqual([w.a.id, w.b.id].sort());
  });

  it("W22c a read-only start refuses with chief-transfer-read-only and writes nothing", async () => {
    const w = world();
    const fence = w.fenceOf(w.a.id, w.b.id);
    const readOnly = await import("./read-only-start.ts");
    vi.spyOn(readOnly, "isReadOnly").mockReturnValue(true);
    const result = await w.transfer.commit({ fence, move: ["telegram"] });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("chief-transfer-read-only");
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(existsSync(join(DATA_DIR, "chief-transfer.json"))).toBe(false);
    expect(w.apps.telegram.calls).toEqual([]);
  });
});

describe("single flight (W23)", () => {
  it("W23 a second commit while the first is moving is chief-transfer-busy; the journal keeps the first record and its DONE lists its apps", async () => {
    const w = world();
    let release!: () => void;
    w.apps.telegram.gates.stopRuns = new Promise<void>(resolve => { release = resolve; });
    const first = w.transfer.commit({ fence: w.fenceOf(w.a.id, w.b.id), move: ["telegram"] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(w.transfer.read()).toMatchObject({ state: "role-saved", from: w.a.id, to: w.b.id });
    const second = await w.transfer.commit({ fence: w.fenceOf(w.b.id, w.c.id), move: [] });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("chief-transfer-busy");
    expect(w.transfer.read()).toMatchObject({ from: w.a.id, to: w.b.id });
    release();
    const done = await first;
    expect((done.body.outcome as { channels: unknown[] }).channels).toContainEqual({ channel: "telegram", result: "moved" });
    expect(w.transfer.read()).toMatchObject({ state: "done", from: w.a.id, to: w.b.id });
    expect(w.store.workspaceChief()!.id).toBe(w.b.id);
  });
});

describe("failure inside one channel (W16)", () => {
  it("W16 a save failure in one channel's move leaves the role, pauses that channel (moving cleared), moves the others and answers 200", async () => {
    const w = world();
    w.apps.slack.gates.writeFiles = () => { throw new Error("fixture disk"); };
    const result = await w.transfer.commit({ fence: w.fenceOf(w.a.id, w.b.id), move: ["telegram", "slack"] });
    expect(result.status).toBe(200);
    const channels = (result.body.outcome as { channels: Array<{ channel: string; result: string }> }).channels;
    expect(channels).toContainEqual({ channel: "slack", result: "paused:save-failed" });
    expect(channels).toContainEqual({ channel: "telegram", result: "moved" });
    expect(w.store.workspaceChief()!.id).toBe(w.b.id);
    // the file matches the outcome: paused, and `moving` is cleared so a later pause() writes again
    expect(w.apps.slack.state).toMatchObject({ paused: true, moving: false });
    expect(w.apps.slack.calls.at(-1)).toBe("pause");
  });
});

describe("boot recovery (W12 W13 W14 W15)", () => {
  /** Crash after the roster write: the journal says `role-saved`, the Store (a fresh process) holds B as Chief and the epoch. */
  async function crashedAfterRole(move: TransferChannel[]) {
    const w = world();
    const journalFile = join(DATA_DIR, "chief-transfer.json");
    const epochBefore = w.store.chiefEpoch;
    const fence = w.fenceOf(w.a.id, w.b.id);
    // run the real commit, then rewrite the journal as the crash would have left it
    await w.transfer.commit({ fence, move });
    const done = JSON.parse(readFileSync(journalFile, "utf8"));
    writeFileSync(journalFile, JSON.stringify({ ...done, state: "role-saved", outcome: undefined, shownAt: undefined }));
    for (const app of Object.values(w.apps)) { app.state.target = w.a.id; app.state.cfg = w.a.id; app.state.paused = false; app.state.moving = false; app.calls.length = 0; }
    flushCoalesced();
    const reboot = new Store(() => ({ instanceId: "", model: "" }));
    return { w, reboot, epochBefore, journalFile };
  }

  it("W12 killed after the role save and before any move: boot moves the channels before resume and shows the outcome once", async () => {
    const { w, reboot } = await crashedAfterRole(["telegram", "slack"]);
    const transfer = w.make(reboot);
    const outcome = await transfer.recover();
    expect(outcome?.channels).toEqual(expect.arrayContaining([{ channel: "telegram", result: "moved" }, { channel: "slack", result: "moved" }]));
    // boot recovery rewrites files and builds the instance; the gate-checked boot resume starts it (no network wait before the server listens)
    expect(w.apps.telegram.calls).toContain("rebuild-only");
    expect(w.apps.telegram.calls).not.toContain("rebuild");
    expect(w.apps.telegram.state).toMatchObject({ target: w.b.id, cfg: w.b.id });
    expect(transfer.takeOutcome()?.status).toBe("done");
    expect(transfer.takeOutcome()).toBeNull();
    expect(transfer.read()?.state).toBe("done");
  });

  it("W13 killed after Telegram moved and before Slack: Telegram reports moved (not chief-changed) and Slack is moved", async () => {
    const { w, reboot } = await crashedAfterRole(["telegram", "slack"]);
    w.apps.telegram.state.target = w.b.id; w.apps.telegram.state.cfg = w.b.id;
    const outcome = await w.make(reboot).recover();
    expect(outcome?.channels).toContainEqual({ channel: "telegram", result: "moved" });
    expect(w.apps.telegram.calls).not.toContain("stopOld");
    expect(outcome?.channels).toContainEqual({ channel: "slack", result: "moved" });
    expect(w.apps.slack.state.target).toBe(w.b.id);
  });

  it("W14 role-saved but other elections advanced the epoch before boot (and B is Chief again): nothing moves, pending channels report chief-changed", async () => {
    const { w, reboot } = await crashedAfterRole(["telegram"]);
    // an ABA at boot: C is elected and then B again, so only the epoch (not the Chief's id) says the roster moved on
    reboot.setChiefOfStaff(w.c.id, undefined, "workspace");
    reboot.setChiefOfStaff(w.b.id, undefined, "workspace");
    expect(reboot.workspaceChief()!.id).toBe(w.b.id);
    const outcome = await w.make(reboot).recover();
    expect(w.apps.telegram.state.target).toBe(w.a.id);
    expect(w.apps.telegram.calls).not.toContain("writeFiles");
    expect(outcome?.channels).toContainEqual({ channel: "telegram", result: "paused:chief-changed" });
  });

  it("W15 an intent record whose roster write never landed (epoch unchanged): no role change, outcome nothing changed", async () => {
    const w = world();
    const epoch = w.store.chiefEpoch;
    const file = join(DATA_DIR, "chief-transfer.json");
    writeFileSync(file, JSON.stringify({ id: "ct-x", state: "intent", epochBefore: epoch, epochAfter: epoch + 1, from: w.a.id, to: w.b.id, move: ["telegram"], fenced: ["telegram"] }));
    const outcome = await w.make(w.store).recover();
    expect(outcome).toMatchObject({ status: "nothing-changed" });
    expect(w.store.workspaceChief()!.id).toBe(w.a.id);
    expect(w.apps.telegram.calls).toEqual([]);
  });
});
