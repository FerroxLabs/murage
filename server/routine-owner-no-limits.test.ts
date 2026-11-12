import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestStore, type RoutineRequestServiceOptions } from "./routine-requests.ts";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const unlimited = { autoApprove: true, fullAccess: true, noLimits: true };
const owner: AutoContext = { ownerStarted: true, fullAccessOrigin: "owner", outsideRead: ["web page"] };

function fixture(bot: AutoApprover = unlimited, context: AutoContext = owner, options: Partial<RoutineRequestServiceOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-owner-routine-"));
  dirs.push(dir);
  const cards: RoutineRequestMessage[] = [];
  const store: RoutineRequestStore = {
    messagesFor: () => cards,
    appendMessage: (_thread, message) => { const row = { id: `card-${cards.length}`, card: message.card }; cards.push(row); return row; },
    patchMessage: (_thread, id, patch) => { const row = cards.find(row => row.id === id); if (!row) return null; Object.assign(row, patch); return row; },
  };
  const ran: string[] = [];
  const blocked: string[] = [];
  const routines = new RoutineManager({
    file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "routine-thread" }),
    startTurn: async (_bot, _thread, prompt) => {
      // A fake engine asks about its action; nothing executes on the host.
      const command = prompt.includes("deny-fixture") ? "rm -rf /" : "printf routine-witness";
      const verdict = autoVerdict(unlimited, "Bash", command, { fullAccessOrigin: "routine", routineLevel: true, commandText: command, outsideRead: ["web page"] });
      (verdict.approve ? ran : blocked).push(command);
    },
  });
  const service = new RoutineRequestService({ ...options, store, routines });
  const propose = (proposal: unknown) => service.propose({ botId: "bot", threadId: "owner-thread", proposal,
    authority: () => ({ bot, context }),
  });
  return { cards, routines, ran, blocked, propose, service };
}
const create = (instructions = "Report the fixture status") => ({ action: "create", routine: {
  name: "Fixture routine", instructions, schedule: { type: "interval", everyMinutes: 60 },
} });

describe("G-NL owner routine requests after a web read", () => {
  it("creates, edits, runs, pauses, resumes and deletes without any card", async () => {
    const f = fixture();
    const made = await f.propose(create());
    expect(f.routines.listRoutines()).toHaveLength(1);
    expect(made).toMatchObject({ autoApproved: true, action: "create", resultId: f.routines.listRoutines()[0]!.id });
    const routineId = made.resultId;
    await f.propose({ action: "update", routineId, changes: { name: "Updated fixture" } });
    expect(f.routines.listRoutines()[0]!.name).toBe("Updated fixture");
    await f.propose({ action: "run_now", routineId });
    await expect.poll(() => f.ran).toEqual(["printf routine-witness"]);
    await f.propose({ action: "pause", routineId });
    expect(f.routines.listRoutines()[0]!.enabled).toBe(false);
    await f.propose({ action: "resume", routineId });
    expect(f.routines.listRoutines()[0]!.enabled).toBe(true);
    await f.propose({ action: "delete", routineId });
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(0);
  });

  it.each([{ autoApprove: false }, { autoApprove: true }, { autoApprove: true, fullAccess: true }])("keeps confirmation at lower levels: %j", async bot => {
    const f = fixture(bot);
    await f.propose(create());
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(1);
  });

  it.each<AutoContext>([
    { ...owner, ownerStarted: false }, { ...owner, fullAccessOrigin: "other" },
    { ...owner, unattended: true }, { ...owner, automated: true },
    { ...owner, routineLevel: true, fullAccessOrigin: "routine" }, { ...owner, channelOwner: true }, {},
  ])("does not auto-apply a non-owner turn: %j", async context => {
    const f = fixture(unlimited, context);
    await f.propose(create());
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(1);
  });

  it("still stops a routine action in the wipe deny set", async () => {
    const f = fixture();
    const made = await f.propose(create("deny-fixture"));
    expect(f.routines.listRoutines()).toHaveLength(1);
    await f.propose({ action: "run_now", routineId: made.resultId });
    await expect.poll(() => f.blocked).toEqual(["rm -rf /"]);
    expect(f.ran).toHaveLength(0);
    expect(f.cards).toHaveLength(0);
  });

  it("requires server-owned authority even when the model claims No limits", async () => {
    const f = fixture();
    await f.service.propose({ botId: "bot", threadId: "owner-thread", proposal: create() });
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(1);
  });

  it("reads the current level after asynchronous readiness", async () => {
    const bot = { ...unlimited };
    const f = fixture(bot, owner, { cloudReady: async () => { bot.noLimits = false; return { ready: true }; } });
    await f.propose({ ...create(), routine: { ...create().routine, runOn: "cloud" } });
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(1);
  });

  it("revalidates a cross-bot target after asynchronous readiness", async () => {
    let available = true;
    const f = fixture(unlimited, owner, {
      validateTarget: () => available ? null : "Fixture target removed",
      cloudReady: async () => { available = false; return { ready: true }; },
    });
    await expect(f.propose({ ...create(), forBot: { botId: "target", name: "Target" },
      routine: { ...create().routine, runOn: "cloud" } })).rejects.toThrow("Fixture target removed");
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(0);
  });

  it("does not commit after the initiating generation expires", async () => {
    const f = fixture();
    await expect(f.service.propose({ botId: "bot", threadId: "owner-thread", proposal: create(), authority: () => ({ bot: unlimited, context: owner }),
      canCommit: () => { throw new Error("Expired fixture generation"); } })).rejects.toThrow("Expired fixture generation");
    expect(f.routines.listRoutines()).toHaveLength(0);
    expect(f.cards).toHaveLength(0);
  });

  it("does not let the outside mark hold an owner No limits permission request", () => {
    const verdict = autoVerdict(unlimited, "propose_routine", "Create a routine", owner);
    expect(verdict.approve).toBeTruthy();
    for (const command of ["rm -rf /", "rm -rf ~", "printf x > /etc/cron.d/fixture"]) {
      expect(autoVerdict(unlimited, "Bash", command, { ...owner, commandText: command }).approve).toBeNull();
    }
  });
});
