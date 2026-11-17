// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json" with { type: "json" };
import { turnOutsideRead, beginOutsideTurn, markTurnOutside, restartOutsideForTests, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { OWN_HOLD_EXEMPT, OWN_WRITERS, OUTSIDE_WRITE_REFUSAL, ownToolGate } from "./outside-own.ts";
import { RoutineRequestService, type RoutineRequestMessage, type RoutineRequestStore } from "./routine-requests.ts";
import { routineServiceFixture, serviceQueueFixture } from "./testing/service-queue-fixture.ts";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let dir: string;
let rows: RoutineRequestMessage[];
let routines: RoutineManager;
let store: RoutineRequestStore;
const owner = { botId: "fixture-bot", threadId: "chat" };
const gate = (tool: string) => ownToolGate({ ...owner, tool, lane: true });
const note = en["noLimits.v1.callOutside"].replace("{source}", "web page");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routine-outside-card-"));
  restartOutsideForTests();
  wireOutsideStore(fileOutsideStore(join(dir, "outside.jsonl")));
  beginOutsideTurn(owner.threadId, "fixture", undefined, false);
  rows = [];
  store = {
    messagesFor: () => rows,
    appendMessage: (_thread, message) => { const row = { id: `card-${rows.length}`, card: message.card }; rows.push(row); return row; },
    patchMessage: (_thread, id, patch) => { const row = rows.find(row => row.id === id); if (!row) return null; Object.assign(row, patch); return row; },
  };
  routines = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "busy", createTask: () => null, startTurn: async () => {} });
});
afterEach(() => { restartOutsideForTests(); removeTempDirSync(dir); });
const service = () => routineServiceFixture({ turnOutsideRead, store, routines, timeZone: () => "UTC" });
const routine = () => routines.create({ botId: owner.botId, name: "Morning pictures", prompt: "Draw the sunrise", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 } });

describe("marked routine cards require the owner's click", () => {
  it("exempts exactly the two routine tools and keeps every other writer's gate", () => {
    markTurnOutside(owner.threadId, "web page");
    const exempt = ["ask_user", "generate_image", "email_send", "email_reply", "email_trust_offer", "needs_owner_now", "propose_routine", "propose_routine_action"];
    expect([...OWN_HOLD_EXEMPT].sort()).toEqual(exempt.sort());
    for (const tool of OWN_WRITERS) expect(gate(tool), tool).toEqual(exempt.includes(tool) ? null : { refuse: OUTSIDE_WRITE_REFUSAL });
  });

  it("files one delete card with the server's routine name and outside note; only an owner click deletes", async () => {
    const target = routine();
    markTurnOutside(owner.threadId, "web page");
    expect(gate("propose_routine_action")).toBeNull();
    const request = await service().propose({ ...owner, proposal: { action: "delete", routineId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].card?.routineRequest).toMatchObject({ outsideRead: true, outsideSource: "web page" });
    expect(rows[0].card?.subtitle).toContain(note);
    expect(rows[0].card?.title).toBe('Delete “Morning pictures”?');
    expect(routines.listRoutines()).toHaveLength(1);
    // A new service and a clean later turn must still honour the persisted filing mark.
    beginOutsideTurn(owner.threadId, "fixture", undefined, false);
    const args = { ...owner, requestId: request.requestId, behavior: "allow" };
    expect(service().resolve(args).state).toBe("invalid");
    expect(rows[0].card?.answered).toBeUndefined();
    expect(routines.listRoutines()).toHaveLength(1);
    expect(service().resolve({ ...args, ownerConfirmed: true }).state).toBe("applied");
    expect(routines.listRoutines()).toHaveLength(0);
  });

  it("create also stays pending without an owner click", async () => {
    markTurnOutside(owner.threadId, "web page");
    expect(gate("propose_routine")).toBeNull();
    const proposed = await service().propose({ ...owner, proposal: { action: "create", routine: { name: "Evening pictures", instructions: "Draw the sunset", schedule: { type: "interval", everyMinutes: 60 } } } });
    const args = { ...owner, requestId: proposed.requestId, behavior: "allow" };
    expect(service().resolve(args).state).toBe("invalid");
    expect(routines.listRoutines()).toHaveLength(0);
    expect(service().resolve({ ...args, ownerConfirmed: true }).state).toBe("applied");
  });

  it("names the existing target even when an edit calls it a different routine, and shows every changed field", async () => {
    const target = routine();
    markTurnOutside(owner.threadId, "web page");
    const proposed = await service().propose({ ...owner, proposal: { action: "update", routineId: target.id, changes: {
      name: "Evening pictures", instructions: "Draw the moon", schedule: { type: "weekly", time: "22:00", weekdays: ["monday"] },
      runOn: "ember", durationMinutes: 45, timeoutMinutes: 10,
    } } });
    expect(proposed.title).toBe('Update “Morning pictures”?');
    for (const detail of ["Morning pictures", "Evening pictures", "Draw the moon", "Monday", "22:00", "45", "10", "Bot's current setup"]) expect(proposed.detail).toContain(detail);
    expect(routines.listRoutines()[0].name).toBe("Morning pictures");
  });

  it("a pause remains pending, and denying it leaves the routine unchanged", async () => {
    const target = routine();
    routines.update(target.id, { enabled: true });
    markTurnOutside(owner.threadId, "web page");
    const proposed = await service().propose({ ...owner, proposal: { action: "pause", routineId: target.id } });
    expect(proposed.title).toBe('Pause “Morning pictures”?');
    expect(service().resolve({ ...owner, requestId: proposed.requestId, behavior: "allow" }).state).toBe("invalid");
    expect(routines.listRoutines()[0].enabled).toBe(true);
    expect(service().resolve({ ...owner, requestId: proposed.requestId, behavior: "deny" }).state).toBe("denied");
    expect(routines.listRoutines()[0].enabled).toBe(true);
  });

  it("binds the filing mark into the reviewed card so clearing it cannot enable automatic apply", async () => {
    const target = routine();
    markTurnOutside(owner.threadId, "web page");
    const proposed = await service().propose({ ...owner, proposal: { action: "delete", routineId: target.id } });
    delete rows[0].card!.routineRequest!.outsideRead;
    delete rows[0].card!.routineRequest!.outsideSource;
    expect(service().resolve({ ...owner, requestId: proposed.requestId, behavior: "allow" }).state).toBe("invalid");
    expect(routines.listRoutines()).toHaveLength(1);
  });

  it.each(["before", "during"])("captures outside reads %s an asynchronous readiness probe", async when => {
    let ready!: () => void;
    const pending = new Promise<void>(resolve => { ready = resolve; });
    const requests = routineServiceFixture({ turnOutsideRead, store, routines, cloudReady: async () => { await pending; return { ready: true }; } });
    if (when === "before") markTurnOutside(owner.threadId, "web page");
    const proposed = requests.propose({ ...owner, proposal: { action: "create", routine: {
      name: "Cloud pictures", instructions: "Draw the sky", runOn: "cloud", schedule: { type: "interval", everyMinutes: 60 },
    } } });
    if (when === "before") beginOutsideTurn(owner.threadId, "fixture", undefined, false);
    else markTurnOutside(owner.threadId, "web page");
    ready();
    await proposed;
    expect(rows[0].card?.routineRequest).toMatchObject({ outsideRead: true, outsideSource: "web page" });
  });

  it("clean requests retain automatic confirmation and reject bot-supplied mark overrides", async () => {
    const target = routine();
    const proposed = await service().propose({ ...owner, proposal: { action: "pause", routineId: target.id } });
    expect(rows[0].card?.routineRequest?.outsideRead).not.toBe(true);
    expect(proposed.detail).not.toContain("outside content");
    expect(service().resolve({ ...owner, requestId: proposed.requestId, behavior: "allow" }).state).toBe("applied");
    await expect(service().propose({ ...owner, proposal: { action: "delete", routineId: target.id, outsideRead: false } as never })).rejects.toThrow();
  });
});

// Producer and owner-answer consumer owner: salv-l8; permission/provenance owner: decision registry.
it.each([
  { label: "owner Ask", level: "ask", owner: true },
  { label: "owner Full access", level: "full", owner: true },
  { label: "guest at a No limits bot", level: "unlimited", owner: false },
] as const)("keeps a marked $label proposal pending without owner authority", async policy => {
  const fixture = serviceQueueFixture(store);
  const requests = new RoutineRequestService({ store, routines, turnOutsideRead });
  fixture.queue(requests.approvalQueue());
  const target = routine();
  markTurnOutside(owner.threadId, "web page");
  const proposed = await requests.propose({ ...owner,
    authority: fixture.authorityFor(owner.threadId, owner.botId, policy),
    proposal: { action: "delete", routineId: target.id },
  });
  expect(proposed.autoApproved).not.toBe(true);
  expect(rows).toHaveLength(1);
  expect(rows[0].card?.routineRequest?.outsideRead).toBe(true);
  expect(routines.routineById(target.id)).not.toBeNull();
  expect(requests.resolve({ ...owner, requestId: proposed.requestId, behavior: "allow" })).toMatchObject({ state: "invalid", status: 403 });
  expect(routines.routineById(target.id)).not.toBeNull();
});

it("owner No limits applies a marked routine directly, with no confirmation card", async () => {
  const fixture = serviceQueueFixture(store);
  const requests = new RoutineRequestService({ store, routines, turnOutsideRead });
  fixture.queue(requests.approvalQueue());
  const target = routine();
  markTurnOutside(owner.threadId, "web page");
  const proposed = await requests.propose({ ...owner,
    authority: fixture.authorityFor(owner.threadId, owner.botId, { level: "unlimited" }),
    proposal: { action: "delete", routineId: target.id },
  });
  // MAIN RULING NL-WIPE-ONLY-FIXTURES: eligible owner No limits never holds an ordinary routine mutation after an outside read.
  expect(proposed.autoApproved).toBe(true);
  expect(rows).toHaveLength(0);
  expect(routines.routineById(target.id)).toBeNull();
});

it("unknown outside state still requires owner confirmation and uses the unnamed note", async () => {
  // Fault injection keeps a runtime-invalid missing value distinct from the normal typed reader contract.
  const missingRead = vi.fn().mockReturnValue(undefined);
  const requests = routineServiceFixture({ store, routines, turnOutsideRead: missingRead });
  const target = routine();
  const proposed = await requests.propose({ ...owner, proposal: { action: "delete", routineId: target.id } });
  expect(rows[0].card?.routineRequest?.outsideRead).toBe(true);
  expect(rows[0].card?.subtitle).toContain("Earlier, this chat read outside content.");
  expect(rows[0].card?.subtitle).not.toContain("null");
  expect(requests.resolve({ ...owner, requestId: proposed.requestId, behavior: "allow" })).toMatchObject({ state: "invalid", status: 403 });
  expect(routines.routineById(target.id)).not.toBeNull();
});
