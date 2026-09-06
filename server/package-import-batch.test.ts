import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store, type BotRecord, type GroupRecord } from "./store.ts";
import { RoutineManager, type Routine } from "./routines.ts";

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
  const existing = store.createBot();
  store.patchBot(existing.id, { chiefOfStaff: true, chiefScope: "workspace", autoApprove: false });
  store.appendMessage(existing.threadId, { role: "user", kind: "text", text: "Keep this original history" });
  const added: BotRecord = { ...existing, id: "imported-bot", threadId: "imported-thread", name: "Imported", chiefOfStaff: false, chiefScope: undefined, tasks: [], autoApprove: false, alwaysAllow: [], composio: false, browser: false, computer: "off" };
  const group: GroupRecord = { id: "imported-room", threadId: "imported-room-thread", name: "Imported room", memberIds: [added.id], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 };
  const emitted = vi.fn(); store.onChange(emitted);
  const file = join(DATA_DIR, "routines.json");
  const routineEvents = vi.fn();
  const manager = new RoutineManager({ file, emit: routineEvents, botState: () => "ready", createTask: () => ({ threadId: "fixture-task" }), startTurn: async () => {} });
  const oldRoutine = manager.create({ name: "Existing", botId: existing.id, prompt: "Existing work", enabled: true, runOn: "ember", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 15 });
  routineEvents.mockClear();
  const routine: Routine = { ...oldRoutine, id: "imported-routine", botId: added.id, enabled: false, nextRunAt: null };
  return { store, existing, added, group, emitted, file, manager, routineEvents, routine, oldRoutine };
}

describe("package batch preparation seams", () => {
  it("prepares old and inert new records without publishing or changing durable files", () => {
    const f = fixture();
    const oldBots = readFileSync(join(DATA_DIR, "bots.json"));
    const oldRoutines = readFileSync(f.file);
    const oldGroups = existsSync(join(DATA_DIR, "groups.json")) ? readFileSync(join(DATA_DIR, "groups.json")) : null;
    const history = structuredClone(f.store.messagesFor(f.existing.threadId));
    const oldRole = structuredClone(f.existing);
    const bots = f.store.preparePackageAddition([f.added], [f.group]);
    const routines = f.manager.preparePackageAddition([f.routine]);
    expect(f.store.bots).toHaveLength(1); expect(f.store.groups).toHaveLength(0);
    expect(f.manager.listRoutines()).toHaveLength(1);
    expect(f.emitted).not.toHaveBeenCalled(); expect(f.routineEvents).not.toHaveBeenCalled();
    expect(readFileSync(join(DATA_DIR, "bots.json"))).toEqual(oldBots);
    expect(readFileSync(f.file)).toEqual(oldRoutines);
    expect(existsSync(join(DATA_DIR, "groups.json")) ? readFileSync(join(DATA_DIR, "groups.json")) : null).toEqual(oldGroups);
    expect(JSON.parse(bots.files.get("bots.json")!.toString()).map((bot: BotRecord) => bot.id)).toEqual([f.existing.id, f.added.id]);
    expect(JSON.parse(routines.bytes.toString()).routines).toEqual([f.oldRoutine, f.routine]);
    // Simulate the caller's completed durable writes. This is not an atomic
    // journal/crash-recovery test; that belongs to the integration package.
    for (const [name, bytes] of bots.files) writeFileSync(join(DATA_DIR, name), bytes);
    writeFileSync(f.file, routines.bytes);
    bots.publish(); routines.publish();
    expect(f.store.bots.map(bot => bot.id)).toEqual([f.existing.id, f.added.id]);
    expect(f.store.groups.map(group => group.id)).toEqual([f.group.id]);
    expect(f.manager.listRoutines()).toEqual([f.oldRoutine, f.routine]);
    expect(f.store.bot(f.existing.id)).toEqual(oldRole);
    expect(f.store.messagesFor(f.existing.threadId)).toEqual(history);
    expect(f.emitted).toHaveBeenCalledTimes(2);
  });
  it("rejects reused bot identities and imported permission grants", () => {
    const f = fixture();
    for (const patch of [
      { id: f.existing.id }, { threadId: f.existing.threadId }, { chiefOfStaff: true },
      { autoApprove: true }, { composio: true }, { browser: true }, { computer: "local" as const },
      { alwaysAllow: ["Bash:*"] },
    ]) expect(() => f.store.preparePackageAddition([{ ...f.added, ...patch }], [])).toThrow("Unsafe package bot addition");
    expect(f.emitted).not.toHaveBeenCalled();
    expect(f.store.bots).toHaveLength(1);
  });
  it("rejects reused or scheduled routine records and rooms reaching existing bots", () => {
    const f = fixture();
    for (const patch of [{ id: f.oldRoutine.id }, { enabled: true }, { nextRunAt: Date.now() }]) {
      expect(() => f.manager.preparePackageAddition([{ ...f.routine, ...patch }])).toThrow("Unsafe package routine addition");
    }
    expect(() => f.store.preparePackageAddition([f.added], [{ ...f.group, memberIds: [f.existing.id] }])).toThrow("Unsafe package group addition");
    expect(f.manager.listRoutines()).toEqual([f.oldRoutine]);
    expect(f.routineEvents).not.toHaveBeenCalled();
  });
});
