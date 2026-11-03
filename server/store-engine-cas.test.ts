// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.14 FIRST-ENGINE-DESKTOP-REPICK-1014-R3b sections 3, 4 and 8 on a real Store: the mark and engineRev, every engine writer's rule,
// the owner tap's compare and set, and the commit boundary (live, a held task reference, bots.json and a reload agree after a failure).
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { RosterPostCommitError, Store, type BotRecord } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { acpToolKey } from "../shared/mount-identity.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => { flushCoalesced(); vi.restoreAllMocks(); });

const EMPTY = { instanceId: "", model: "" };
const FUIGO = { instanceId: "fuigo", model: "login/m1" };
const CLAUDE = { instanceId: "claude", model: "sonnet" };
const onDisk = (id: string) => (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as BotRecord[]).find(bot => bot.id === id)!;
const reloaded = (id: string) => new Store(() => EMPTY).bot(id)!;
const marked = (store: Store, selection = EMPTY) => store.createBot({ name: "Chief", modelSelection: selection }, { seedMessages: false, engineAutoPicked: true });
const tap = (store: Store, id: string, expectRev: number) => store.casEngineMove(id, { expectRev, selection: FUIGO, mark: "clear", requireMark: false, predicate: () => true });

describe("the mark and engineRev", () => {
  it("only the trusted create option sets the mark; a patch body never sets the mark or the revision", () => {
    const store = new Store(() => EMPTY);
    const plain = store.createBot({ name: "Plain" }, { seedMessages: false });
    expect(plain.engineAutoPicked).toBeUndefined();
    store.patchBot(plain.id, { engineAutoPicked: true, engineRev: 40 } as Partial<BotRecord>);
    expect(store.bot(plain.id)!.engineAutoPicked).toBeUndefined();
    expect(store.bot(plain.id)!.engineRev).toBeUndefined();
    const chief = marked(store);
    expect(chief.engineAutoPicked).toBe(true);
    expect(onDisk(chief.id).engineAutoPicked).toBe(true);
    expect(reloaded(chief.id).engineAutoPicked).toBe(true);
  });

  it("followBotModel, patchBot tasks array and failover writes clear the mark and bump engineRev", () => {
    const store = new Store(() => EMPTY);
    const a = marked(store, CLAUDE);
    store.patchBot(a.id, { tasks: a.tasks!.map(task => ({ ...task, modelSelection: FUIGO })) });
    expect(store.bot(a.id)!.engineAutoPicked).toBeUndefined();
    expect(store.bot(a.id)!.engineRev).toBe(1);

    const b = marked(store, CLAUDE);
    store.patchTask(b.id, b.threadId, { modelSelection: FUIGO, limitFailover: "row-1" }); // a limit failover write
    expect(store.bot(b.id)!.engineAutoPicked).toBeUndefined();
    expect(store.bot(b.id)!.engineRev).toBe(1);
    expect(onDisk(b.id).engineRev).toBe(1);

    const c = marked(store, CLAUDE);
    store.patchTask(c.id, c.threadId, { modelSelection: FUIGO });
    const revBefore = store.bot(c.id)!.engineRev!;
    store.followBotModel(c.id, () => false);
    expect(store.bot(c.id)!.engineRev).toBe(revBefore + 1);
    expect(onDisk(c.id).engineRev).toBe(revBefore + 1);
    expect(onDisk(c.id).engineAutoPicked).toBeUndefined();
  });

  it("adoption clears the mark and bumps engineRev live and on disk", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store);
    store.patchTask(chief.id, chief.threadId, { modelSelection: CLAUDE });
    const live = store.bot(chief.id)!;
    expect(live.modelSelection).toEqual(CLAUDE);
    expect(live.engineAutoPicked).toBeUndefined();
    expect(live.engineRev).toBe(1);
    expect(onDisk(chief.id).engineAutoPicked).toBeUndefined();
    expect(onDisk(chief.id).engineRev).toBe(1);
  });
});

describe("the owner tap (section 6)", () => {
  it("a tap carrying an older engineRev answers stale and writes nothing", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    const drawnWith = bot.engineRev ?? 0;
    store.patchBot(bot.id, { modelSelection: { instanceId: "codex", model: "gpt" } }); // an owner pick after the card was drawn
    const before = onDisk(bot.id);
    expect(tap(store, bot.id, drawnWith)).toBe("stale");
    expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "codex", model: "gpt" });
    expect(onDisk(bot.id)).toEqual(before);
    expect(tap(store, bot.id, store.bot(bot.id)!.engineRev!)).toBe("moved");
    expect(store.bot(bot.id)!.modelSelection).toEqual(FUIGO);
    expect(reloaded(bot.id).modelSelection).toEqual(FUIGO);
  });

  it("a tap on a marked bot clears the mark", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store, CLAUDE);
    expect(tap(store, chief.id, 0)).toBe("moved");
    expect(store.bot(chief.id)!.engineAutoPicked).toBeUndefined();
    expect(onDisk(chief.id).engineAutoPicked).toBeUndefined();
  });
});

describe("repairStaleModel (section 4, GrokBuild R3 M3)", () => {
  it("repairStaleModel on Cloud and desktop keeps an existing mark and never sets one", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store, { instanceId: "cursor", model: "old" });
    expect(store.repairStaleModel(chief.id, chief.threadId, { instanceId: "cursor", model: "old" }, "new")).toBe(true);
    expect(store.bot(chief.id)!.engineAutoPicked).toBe(true);
    expect(store.bot(chief.id)!.modelSelection).toEqual({ instanceId: "cursor", model: "new" });
    expect(store.bot(chief.id)!.engineRev).toBe(1);
    const owner = store.createBot({ name: "Owner", modelSelection: { instanceId: "cursor", model: "old" } }, { seedMessages: false });
    store.repairStaleModel(owner.id, owner.threadId, { instanceId: "cursor", model: "old" }, "new");
    expect(store.bot(owner.id)!.engineAutoPicked).toBeUndefined();
    expect(onDisk(owner.id).engineAutoPicked).toBeUndefined();
  });

  it("writes only the selection that owns the chat, and nothing when that selection changed", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: { instanceId: "cursor", model: "old" } }, { seedMessages: false });
    store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "cursor", model: "own" } });
    expect(store.repairStaleModel(bot.id, bot.threadId, { instanceId: "cursor", model: "old" }, "new")).toBe(false);
    expect(store.repairStaleModel(bot.id, bot.threadId, { instanceId: "cursor", model: "own" }, "new")).toBe(true);
    expect(store.taskByThread(bot.id, bot.threadId)!.modelSelection).toEqual({ instanceId: "cursor", model: "new" });
    expect(store.bot(bot.id)!.modelSelection).toEqual({ instanceId: "cursor", model: "old" });
  });
});

describe("the commit boundary (section 8)", () => {
  it("pre-commit failure: live, held ref, disk, reload equal, mark set", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store);
    const held = store.taskByThread(chief.id, chief.threadId)!;
    const heldBefore = structuredClone(held);
    vi.spyOn(store as unknown as { rosterJson: () => never }, "rosterJson").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.casEngineMove(chief.id, { expectRev: 0, selection: FUIGO, mark: "keep", requireMark: true, predicate: () => true })).toThrow("disk full");
    const live = store.bot(chief.id)!;
    expect(live.modelSelection).toEqual(EMPTY);
    expect(live.engineAutoPicked).toBe(true);
    expect(live.engineRev ?? 0).toBe(0);
    expect(held).toEqual(heldBefore);
    expect(onDisk(chief.id).modelSelection).toEqual(EMPTY);
    expect(reloaded(chief.id).modelSelection).toEqual(EMPTY);
  });

  it("post-commit failure publishes the normalized record bots.json holds", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store);
    const held = store.taskByThread(chief.id, chief.threadId)!;
    vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("channels write failed"); });
    expect(store.casEngineMove(chief.id, { expectRev: 0, selection: FUIGO, mark: "keep", requireMark: true, predicate: () => true })).toBe("moved");
    const live = store.bot(chief.id)!;
    expect(live.modelSelection).toEqual(FUIGO);
    expect(live.engineRev).toBe(1);
    expect(live.engineAutoPicked).toBe(true);
    expect(store.taskByThread(chief.id, chief.threadId)).toBe(held);
    const disk = onDisk(chief.id);
    expect(disk.modelSelection).toEqual(FUIGO);
    expect(disk.engineRev).toBe(1);
    expect(reloaded(chief.id).modelSelection).toEqual(FUIGO);
  });

  it("setPermissionLevel and raiseTaskPermissions publish after a post-commit groups failure", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("channels write failed"); });
    expect(() => store.setPermissionLevel(bot.id, { flags: { autoApprove: true, fullAccess: false, noLimits: false } })).toThrow(RosterPostCommitError);
    expect(store.bot(bot.id)!.autoApprove).toBe(true);
    expect(onDisk(bot.id).autoApprove).toBe(true);
    vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("channels write failed"); });
    expect(() => store.raiseTaskPermissions(bot.id, [bot.threadId], { autoApprove: true, fullAccess: true, noLimits: false })).toThrow(RosterPostCommitError);
    expect(store.taskByThread(bot.id, bot.threadId)!.fullAccess).toBe(true);
    expect(onDisk(bot.id).tasks!.find(task => task.threadId === bot.threadId)!.fullAccess).toBe(true);
  });
});

describe("writer inventory (section 4)", () => {
  function serverSources(dir = join(process.cwd(), "server")): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "testing" && name !== "node_modules") out.push(...serverSources(path)); continue; }
      if (name.endsWith(".ts") && !name.includes(".test.") && !name.startsWith("._")) out.push([path.slice(process.cwd().length + 1).replace(/\\/g, "/"), readFileSync(path, "utf8")]);
    }
    return out;
  }

  it("every modelSelection and engineAutoPicked writer in server/ is in the inventory", () => {
    const sources = serverSources();
    const where = (pattern: RegExp) => sources.filter(([, text]) => pattern.test(text)).map(([path]) => path).sort();
    // The mark is set only by createBot's trusted option and its callers.
    expect(where(/engineAutoPicked\s*(=|:)\s*true\b/)).toEqual(["server/index.ts", "server/store.ts"]);
    // The compare and set is called only by the engine pass and the owner tap.
    expect(where(/\.casEngineMove\(/)).toEqual(["server/engine-repick.ts", "server/index.ts"]);
    // The old movers are gone, and the pass reads no sign-in.
    expect(where(/moveChiefToShippedEngine|repickAutoPicked|useEngineAfterSignIn|engineSeeded/)).toEqual([]);
    const pass = sources.find(([path]) => path === "server/engine-repick.ts")![1];
    expect(pass).not.toMatch(/\.authenticated\b|pickDefaultEngine|probeAuth|botEngineSignIn/);
    // An automatic patchBot of a selection would bypass the compare and set; the stale-model repair is the store's own CAS now.
    const index = sources.find(([path]) => path === "server/index.ts")![1];
    expect(index).not.toMatch(/store\.patchBot\(bot\.id, \{ modelSelection: switched \}\)/);
  });
});

describe("Astra 1015 review fixes", () => {
  it("an owner re-picking the same engine clears the mark and makes an older tap stale", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store, CLAUDE);
    store.patchBot(chief.id, { modelSelection: { ...CLAUDE } });
    expect(store.bot(chief.id)!.engineAutoPicked).toBeUndefined();
    expect(store.bot(chief.id)!.engineRev).toBe(1);
    expect(tap(store, chief.id, 0)).toBe("stale");
    const other = marked(store, CLAUDE);
    store.patchTask(other.id, other.threadId, { modelSelection: { ...CLAUDE } });
    expect(store.bot(other.id)!.engineAutoPicked).toBeUndefined();
  });

  it("a chat back to following its bot loses its pick and failover marker live, on the held task too", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    store.patchTask(bot.id, bot.threadId, { modelSelection: FUIGO, limitFailover: "row-1" });
    const held = store.taskByThread(bot.id, bot.threadId)!;
    store.patchTask(bot.id, bot.threadId, { modelSelection: undefined, limitFailover: undefined });
    expect(held.modelSelection).toBeUndefined();
    expect(held.limitFailover).toBeUndefined();
    expect(onDisk(bot.id).tasks!.find(task => task.threadId === bot.threadId)!.modelSelection).toBeUndefined();
  });
});

describe("1.0.15 Astra M2: patchBot and the grant writers stage, commit, then publish", () => {
  const revisionOf = (store: Store) => (store as unknown as { recordRevision: number }).recordRevision;

  it("patchBot pre-commit failure: live, held task, revision, disk and reload are as they were", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store, CLAUDE);
    const held = store.taskByThread(chief.id, chief.threadId)!;
    const liveBefore = structuredClone(store.bot(chief.id)!), heldBefore = structuredClone(held), revision = revisionOf(store);
    vi.spyOn(store as unknown as { rosterJson: () => never }, "rosterJson").mockImplementationOnce(() => { throw new Error("disk full"); });
    expect(() => store.patchBot(chief.id, { modelSelection: FUIGO, name: "Renamed", autoApprove: true })).toThrow("disk full");
    expect(store.bot(chief.id)).toEqual(liveBefore);
    expect(store.bot(chief.id)!.engineAutoPicked).toBe(true);
    expect(held).toEqual(heldBefore);
    expect(revisionOf(store)).toBe(revision);
    expect(onDisk(chief.id).modelSelection).toEqual(CLAUDE);
    expect(reloaded(chief.id).modelSelection).toEqual(CLAUDE);
    expect(reloaded(chief.id).engineAutoPicked).toBe(true);
  });

  it("patchBot post-commit failure publishes what bots.json holds into the live bot and its held task, then throws", () => {
    const store = new Store(() => EMPTY);
    const chief = marked(store, CLAUDE);
    const held = store.taskByThread(chief.id, chief.threadId)!;
    vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("channels write failed"); });
    expect(() => store.patchBot(chief.id, { modelSelection: FUIGO, unread: true })).toThrow(RosterPostCommitError);
    const live = store.bot(chief.id)!;
    expect(live.modelSelection).toEqual(FUIGO);
    expect(live.engineAutoPicked).toBeUndefined();
    expect(live.engineRev).toBe(1);
    expect(store.taskByThread(chief.id, chief.threadId)).toBe(held);
    // the held task shows what bots.json holds for it
    expect(held.unread ?? false).toBe(onDisk(chief.id).tasks!.find(task => task.threadId === chief.threadId)!.unread ?? false);
    expect(onDisk(chief.id).modelSelection).toEqual(FUIGO);
    expect(reloaded(chief.id).engineRev).toBe(1);
  });

  it("a successful patchBot writes into the held task objects and drops removed keys", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    const held = store.taskByThread(bot.id, bot.threadId)!;
    store.patchBot(bot.id, { tasks: bot.tasks!.map(task => ({ ...task, title: "Picked", modelSelection: FUIGO })) });
    expect(store.taskByThread(bot.id, bot.threadId)).toBe(held);
    expect(held.title).toBe("Picked");
    expect(held.modelSelection).toEqual(FUIGO);
    const { modelSelection: _drop, ...following } = held;
    store.patchBot(bot.id, { tasks: [following] });
    expect(store.taskByThread(bot.id, bot.threadId)).toBe(held);
    expect(held.modelSelection).toBeUndefined();
    expect(store.bot(bot.id)!.engineRev).toBe(2);
  });

  it("dropMountGrants after a post-commit failure leaves the removed grants out of memory too", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    const gone = acpToolKey("custom:github", "create_issue");
    store.patchBot(bot.id, { alwaysAllow: [gone, "Grep"] }, { preserveTaskSettings: true });
    store.patchTask(bot.id, bot.threadId, { alwaysAllow: [gone, "Read"] });
    const held = store.taskByThread(bot.id, bot.threadId)!;
    vi.spyOn(store as unknown as { afterRosterSave: () => never }, "afterRosterSave").mockImplementationOnce(() => { throw new Error("channels write failed"); });
    expect(() => store.dropMountGrants("custom:github")).toThrow(RosterPostCommitError);
    expect(store.bot(bot.id)!.alwaysAllow).toEqual(["Grep"]);
    expect(held.alwaysAllow).toEqual(["Read"]);
    expect(onDisk(bot.id).alwaysAllow).toEqual(["Grep"]);
    const revision = revisionOf(store);
    store.patchBot(bot.id, { alwaysAllow: [gone, "Grep"] }, { preserveTaskSettings: true });
    vi.spyOn(store as unknown as { rosterJson: () => never }, "rosterJson").mockImplementationOnce(() => { throw new Error("disk full"); });
    const before = revisionOf(store);
    expect(() => store.dropMountGrants("custom:github")).toThrow("disk full");
    expect(store.bot(bot.id)!.alwaysAllow).toEqual([gone, "Grep"]);
    expect(revisionOf(store)).toBe(before);
    expect(before).toBeGreaterThan(revision);
  });
});

describe("1.0.15 Astra M4: the tap moves the chat it was drawn in", () => {
  it("a chat with its own pick follows the bot onto Fuigo in the same write; another chat's pick stays", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: { instanceId: "codex", model: "gpt" } }, { seedMessages: false });
    const second = store.createTask(bot.id, undefined, false)!;
    store.patchTask(bot.id, bot.threadId, { modelSelection: CLAUDE, limitFailover: "row-9", resumeCursors: {} });
    store.patchTask(bot.id, second.threadId, { modelSelection: CLAUDE });
    const held = store.taskByThread(bot.id, bot.threadId)!;
    const rev = store.bot(bot.id)!.engineRev!;
    expect(store.casEngineMove(bot.id, { expectRev: rev, selection: FUIGO, mark: "clear", requireMark: false, predicate: () => true, ownerThreadId: bot.threadId })).toBe("moved");
    expect(store.bot(bot.id)!.modelSelection).toEqual(FUIGO);
    expect(store.taskByThread(bot.id, bot.threadId)).toBe(held);
    expect(held.modelSelection).toBeUndefined();
    expect(held.limitFailover).toBeUndefined();
    expect(store.taskByThread(bot.id, second.threadId)!.modelSelection).toEqual(CLAUDE);
    expect(store.bot(bot.id)!.engineRev).toBe(rev + 1);
    const disk = onDisk(bot.id);
    expect(disk.tasks!.find(task => task.threadId === bot.threadId)!.modelSelection).toBeUndefined();
    expect(disk.tasks!.find(task => task.threadId === bot.threadId)!.limitFailover).toBeUndefined();
    expect(reloaded(bot.id).tasks!.find(task => task.threadId === second.threadId)!.modelSelection).toEqual(CLAUDE);
  });

  it("a tap drawn before that chat's own pick changed answers stale and the chat keeps its pick", () => {
    const store = new Store(() => EMPTY);
    const bot = store.createBot({ name: "B", modelSelection: CLAUDE }, { seedMessages: false });
    store.createTask(bot.id, undefined, false);
    const drawnWith = store.bot(bot.id)!.engineRev ?? 0;
    store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "codex", model: "gpt" } });
    expect(store.casEngineMove(bot.id, { expectRev: drawnWith, selection: FUIGO, mark: "clear", requireMark: false, predicate: () => true, ownerThreadId: bot.threadId })).toBe("stale");
    expect(store.taskByThread(bot.id, bot.threadId)!.modelSelection).toEqual({ instanceId: "codex", model: "gpt" });
  });
});

describe("1.0.15 Astra M8: every selection writer in server/ is inventoried", () => {
  it("assignments, deletions and store writer calls of a selection appear only where they are reviewed", () => {
    const sources = new Map<string, string>();
    const walk = (dir: string) => { for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "testing" && name !== "node_modules") walk(path); continue; }
      if (name.endsWith(".ts") && !name.includes(".test.") && !name.startsWith("._")) sources.set(path.slice(process.cwd().length + 1).replace(/\\/g, "/"), readFileSync(path, "utf8"));
    } };
    walk(join(process.cwd(), "server"));
    const count = (pattern: RegExp) => {
      const out: Record<string, number> = {};
      for (const [path, text] of sources) { const n = text.split("\n").reduce((sum, line) => sum + [...line.matchAll(pattern)].length, 0); if (n) out[path] = n; }
      return out;
    };
    // Direct writes of a selection: patch builders that feed patchBot/patchTask (bot-management, two index routes), followBotModel's
    // publish (store), and the one-time boot cleanup that drops a chat pin equal to its bot's (thread-follow-model: no engine changes).
    expect(count(/\.modelSelection\s*=[^=]|delete [\w.!]+\.modelSelection\b/g)).toEqual({
      "server/bot-management.ts": 1, "server/index.ts": 2, "server/store.ts": 1, "server/thread-follow-model.ts": 1,
    });
    // Store writes that carry a selection literal: the limit failover apply, its boot re-apply and its restore (index.ts).
    expect(count(/\.(patchTask|patchBot)\([^;]{0,160}modelSelection/g)).toEqual({ "server/index.ts": 3 });
    // The engine-only writers: the pass (casEngineMove), the owner tap (casEngineMove), the stale-model repair and Use the bot's model.
    expect(count(/\.(followBotModel|repairStaleModel|casEngineMove)\(/g)).toEqual({ "server/engine-repick.ts": 1, "server/index.ts": 3 });
  });
});
